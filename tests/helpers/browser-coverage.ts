import { mergeScriptCovs } from "@bcoe/v8-coverage";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Profiler } from "node:inspector";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import { build, transform, type BuildOptions } from "esbuild";
import type { CoverageMapData, FileCoverageData } from "istanbul-lib-coverage";
import type { BrowserContext, CDPSession, Frame, Page, Request as BrowserRequest } from "playwright";
import { parseAstAsync } from "vitest/node";
import { canonicalPath, sourceManifest } from "../../scripts/coverage-gate";

const manifest = new Map<string, Promise<string[]>>();
const functionMaps = new Map<string, Promise<Map<string, string>>>();
const bundles = new Map<string, string>();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Test builds retain unused branches and original locations; production builds are untouched. */
export async function buildBrowserBundle(options: BuildOptions) {
  const result = await build({ ...options, bundle: true, write: false, format: "iife", platform: "browser",
    sourcemap: "inline", sourcesContent: true, treeShaking: false, minify: false, target: "esnext" });
  const code = result.outputFiles![0].text;
  bundles.set(digest(code), code);
  return result;
}

type Script = Profiler.ScriptCoverage & { source?: string };
type CloseBrowser = (action: () => Promise<void>) => Promise<void>;

export async function convertBrowserCoverage(entries: Script[], root = process.cwd(), include?: Set<string>, scriptUrls = new Set<string>()) {
  if (!include && !manifest.has(root)) manifest.set(root, sourceManifest(root));
  const included = include ?? new Set(await manifest.get(root));
  const result: CoverageMapData = {};
  const grouped = new Map<string, { code: string; entries: Script[] }>();
  const urlSources = new Map<string, Set<string>>();
  for (const { url, source } of entries) {
    if (source !== undefined) urlSources.set(url, (urlSources.get(url) ?? new Set()).add(source));
  }
  for (const entry of entries) {
    // A reload can report a transient script in a delta without a debugger
    // scriptParsed event; its id is already gone. Recover only a URL whose
    // retained samples agree on one source, and whose ranges fit inside it.
    const recovered = entry.source === undefined && urlSources.get(entry.url)?.size === 1 ? [...urlSources.get(entry.url)!][0] : undefined;
    if (recovered !== undefined && entry.functions.some(fn => fn.ranges.some(range => range.endOffset > recovered.length))) {
      throw new Error(`Incompatible browser script source: ${entry.url}`);
    }
    const code = entry.source ?? recovered;
    const requiresMap = scriptUrls.has(entry.url) || (/\.(?:[cm]?js|ts)(?:[?#]|$)/.test(entry.url) && !entry.url.startsWith("__playwright"));
    if (code === undefined && requiresMap) throw new Error(`Missing browser script source: ${entry.url}`);
    if (!code) continue;
    const registered = bundles.has(digest(code));
    if (!registered) {
      // Rendered inline controllers are strings, owned by #105/#106. Playwright
      // evaluations, publisher fixtures and explicitly mocked scripts are not bundles.
      if (requiresMap) {
        throw new Error(`Unmapped browser script: ${entry.url}`);
      }
      continue;
    }
    const key = digest(code);
    const group = grouped.get(key) ?? { code, entries: [] };
    group.entries.push(entry);
    grouped.set(key, group);
  }
  for (const { code, entries: samples } of grouped.values()) {
    // V8 ranges differ across deltas; use Vitest's range-tree merger rather
    // than adding offset ranges or converting the same AST at every snapshot.
    const entry = mergeScriptCovs(samples.map(sample => ({
      scriptId: sample.scriptId, url: pathToFileURL(resolve(root, "browser-bundle.js")).href,
      functions: structuredClone(sample.functions),
    })))!;
    const match = /\/\/# sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(code);
    if (!match) throw new Error(`Missing source map: ${entry.url}`);
    const map = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
      sources: string[]; sourcesContent: string[]; version: number; mappings: string; names: string[];
    };
    // Build output is in the repository root, independently of the served URL.
    for (let index = 0; index < map.sources.length; index++) {
      const name = map.sources[index];
      if (!included.has(name)) continue;
      if (readFileSync(resolve(root, name), "utf8") !== map.sourcesContent[index]) throw new Error(`Stale browser source: ${name}`);
    }
    const converted = await convert({ code, sourceMap: map, ast: parseAstAsync(code),
      ignoreNode: (node, type) => type === "statement" && node.type === "VariableDeclarator" && node.init?.type === "ClassExpression",
      coverage: { ...entry, url: pathToFileURL(resolve(root, "browser-bundle.js")).href } });
    for (const [path, file] of Object.entries(converted)) {
      const name = canonicalPath(root, path);
      // Filter dependencies, fixture transports and generated APIs AFTER remapping.
      if (included.has(name)) {
        // esbuild disambiguates colliding bundle symbols (replace -> replace2).
        // Names are display metadata; recover them from the same unbundled AST
        // transform as the gate, matching exact declaration and body locations.
        if (!functionMaps.has(path)) functionMaps.set(path, canonicalFunctionNames(path));
        const names = await functionMaps.get(path)!;
        for (const fn of Object.values(file.fnMap)) {
          const original = names.get(JSON.stringify([fn.decl, fn.loc]));
          if (original === undefined) throw new Error(`Unmapped browser function: ${name}:${fn.line}`);
          fn.name = original;
        }
        mergeBrowserFile(result, { ...file, path: name });
      }
    }
  }
  return result;
}

async function canonicalFunctionNames(path: string) {
  const output = await transform(readFileSync(path, "utf8"), {
    loader: path.endsWith(".ts") ? "ts" : "js", sourcefile: path, sourcemap: "external", target: "esnext",
  });
  const converted = await convert({ code: output.code, sourceMap: JSON.parse(output.map), ast: parseAstAsync(output.code),
    coverage: { url: pathToFileURL(path).href, functions: [] } });
  return new Map(Object.values(converted[path]?.fnMap ?? {}).map(fn => [JSON.stringify([fn.decl, fn.loc]), fn.name]));
}

/** Match the gate's exact source-map identities, including duplicate branch locations. */
export function mergeBrowserFile(report: CoverageMapData, file: FileCoverageData) {
  const data = structuredClone(file);
  for (const [counter, map] of [["s", "statementMap"], ["f", "fnMap"], ["b", "branchMap"]] as const) {
    const ids = Object.keys(data[map]).sort((a, b) => JSON.stringify(data[map][a]).localeCompare(JSON.stringify(data[map][b])));
    Object.assign(data, {
      [map]: Object.fromEntries(ids.map((id, i) => [String(i), data[map][id]])),
      [counter]: Object.fromEntries(ids.map((id, i) => [String(i), data[counter][id]])),
    });
  }
  for (const id of Object.keys(data.b)) data.b[id] = data.b[id].map(count => Math.max(0, count));
  const previous = report[data.path];
  if (!previous) { report[data.path] = data; return; }
  for (const map of ["statementMap", "fnMap", "branchMap"] as const) {
    if (JSON.stringify(previous[map]) !== JSON.stringify(data[map])) throw new Error(`Incompatible browser maps: ${data.path} ${map}`);
  }
  for (const counter of ["s", "f"] as const) {
    for (const id of Object.keys(data[counter])) previous[counter][id] += data[counter][id];
  }
  for (const id of Object.keys(data.b)) previous.b[id] = previous.b[id].map((count, index) => count + data.b[id][index]);
}

/** One collector per context. Script response routing is the pre-execution barrier. */
export async function collectBrowserContext(context: BrowserContext, suite: string, origin: string, onReport?: (report: CoverageMapData) => void) {
  const pages = new Map<Page, Promise<void>>();
  const frames = new Map<Frame, Promise<CDPSession | undefined>>();
  const sources = new Map<CDPSession, Map<string, Promise<string | undefined>>>();
  const collected: Script[] = [];
  const scriptUrls = new Set<string>();
  const errors: unknown[] = [];
  const finished = new Set<Page>();
  let closing = false;
  const flushing = new Set<Promise<void>>();
  const flushes = new Map<CDPSession, Promise<void>>();
  const wrappedFrames = new WeakSet<Frame>();

  async function takeFrame(session: CDPSession) {
    const { result } = await session.send("Profiler.takePreciseCoverage");
    for (const entry of result) {
      const source = await sources.get(session)?.get(entry.scriptId);
      collected.push({ ...entry, source });
    }
  }

  function flushFrame(session: CDPSession) {
    // Lifecycle pauses and explicit test barriers can overlap. Drain deltas in
    // order, and await their source reads before permitting target destruction.
    const pending = (flushes.get(session) ?? Promise.resolve()).then(() => takeFrame(session));
    flushes.set(session, pending);
    return pending;
  }

  async function flush(page?: Page) {
    await Promise.all([...pages].filter(([target]) => !page || target === page).map(([, ready]) => ready));
    await Promise.all([...frames].filter(([frame]) => !page || frame.page() === page).map(async ([frame, ready]) => {
      const session = await ready;
      if (session && !frame.isDetached() && !finished.has(frame.page())) await flushFrame(session);
    }));
  }

  async function startFrame(frame: Frame) {
    let session: CDPSession;
    try { session = await context.newCDPSession(frame); }
    catch (error) {
      // Same-process child frames share the page's profiler. Only this precise
      // protocol response is an exemption; unexpected attach failures fail tests.
      if (String(error).includes("does not have a separate CDP session")) return;
      throw error;
    }
    const scripts = new Map<string, Promise<string | undefined>>();
    sources.set(session, scripts);
    session.on("Debugger.scriptParsed", event => {
      scripts.set(event.scriptId, session.send("Debugger.getScriptSource", { scriptId: event.scriptId })
        .then(result => result.scriptSource).catch(() => undefined));
    });
    session.on("Profiler.preciseCoverageDeltaUpdate", event => {
      for (const entry of event.result) {
        const pending = Promise.resolve(scripts.get(entry.scriptId)).then(source => { collected.push({ ...entry, source }); });
        flushing.add(pending);
      }
    });
    await session.send("Profiler.enable");
    await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true, allowTriggeredUpdates: true });
    await session.send("Debugger.enable");
    await session.send("Debugger.setSkipAllPauses", { skip: false });
    // beforeunload is the last pausable lifecycle event. Chromium suppresses
    // debugger pauses during pagehide/unload; polling loses the final interval.
    session.on("Debugger.paused", () => {
      const pending = flush(frame.page()).catch(error => { errors.push(error); }).finally(async () => {
        await session.send("Debugger.resume").catch(error => { errors.push(error); });
        flushing.delete(pending);
      });
      flushing.add(pending);
    });
    await session.send("DOMDebugger.setEventListenerBreakpoint", { eventName: "beforeunload" });
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: 'addEventListener("beforeunload", () => {})' });
    await session.send("Runtime.evaluate", { expression: 'addEventListener("beforeunload", () => {})' });
    session.on("close", () => {
      void frames.get(frame)?.then(current => { if (current === session) frames.delete(frame); });
    });
    return session;
  }

  function wrapFrameNavigation(frame: Frame) {
    if (wrappedFrames.has(frame)) return;
    wrappedFrames.add(frame);
    const goto = frame.goto.bind(frame);
    frame.goto = async (url, options) => { await flush(frame.page()); return goto(url, options); };
  }

  function startPage(page: Page) {
    if (pages.has(page)) return pages.get(page)!;
    const ready = page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true }).then(async () => {
      // Playwright auto-resumes every debugger pause, racing a child target's
      // destruction. Hand off while navigation/script responses are still held;
      // CDP owns the profiler and lifecycle breakpoints from here to teardown.
      collected.push(...await page.coverage.stopJSCoverage());
      const frame = page.mainFrame();
      const pending = startFrame(frame);
      frames.set(frame, pending);
      await pending;
    });
    pages.set(page, ready);
    void ready.catch(error => errors.push(error));
    // Parent reload/history can destroy a child realm without giving its
    // lifecycle breakpoint a reliable final pause. Collect before initiating
    // the operation, while every attached target is still alive.
    page.frames().forEach(wrapFrameNavigation);
    page.on("frameattached", wrapFrameNavigation);
    const reload = page.reload.bind(page);
    page.reload = async options => { await flush(page); return reload(options); };
    const goBack = page.goBack.bind(page);
    page.goBack = async options => { await flush(page); return goBack(options); };
    const goForward = page.goForward.bind(page);
    page.goForward = async options => { await flush(page); return goForward(options); };
    page.on("framenavigated", frame => {
      const previous = frames.get(frame);
      void previous?.then(session => {
        if (!session && frames.get(frame) === previous) frames.delete(frame);
      });
    });
    const routePage = page.route.bind(page);
    page.route = (url, handler, options) => routePage(url, async (route, request) => {
      await ensureScript(request);
      await handler(route, request);
    }, options);
    const close = page.close.bind(page);
    page.close = async options => { await finishPage(page); await close(options); };
    return ready;
  }

  async function finishPage(page: Page) {
    if (finished.has(page)) return;
    await flush(page);
    finished.add(page);
    await pages.get(page);
    for (const [frame, pending] of frames) {
      if (frame.page() !== page) continue;
      const session = await pending;
      if (session && !frame.isDetached()) {
        await session.send("Profiler.stopPreciseCoverage");
        await session.send("Debugger.disable");
        await session.detach();
      }
    }
    await Promise.all(flushing);
  }

  async function ensureScript(request: BrowserRequest) {
    if (request.resourceType() !== "script") return;
    if (new URL(request.url()).origin === origin) scriptUrls.add(request.url());
    const frame = request.frame();
    await startPage(frame.page());
    if (!frames.has(frame)) frames.set(frame, startFrame(frame));
    await frames.get(frame);
  }

  context.on("page", startPage);
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    await startPage(page);
    return page;
  };
  // Both page and context fixture routes must pass the pre-execution barrier,
  // including a popup's first script and assets fulfilled directly by tests.
  const routeContext = context.route.bind(context);
  context.route = (url, handler, options) => routeContext(url, async (route, request) => {
    await ensureScript(request);
    await handler(route, request);
  }, options);
  await context.route("**/*", route => route.fallback());

  const close = context.close.bind(context);
  async function closeContext(options?: Parameters<BrowserContext["close"]>[0], closeBrowser: CloseBrowser = action => action()) {
    if (closing) return;
    closing = true;
    await closeBrowser(async () => {
      try {
        // Flush every attached target before stopping/detaching even the first
        // profiler: parent teardown must not race its OOPIF's final collection.
        await flush();
        for (const page of context.pages()) await finishPage(page);
      } finally { await close(options); }
    });
    if (errors.length) throw new AggregateError(errors, "Browser coverage collection failed");
    // Source-map conversion is CPU work after the browser has closed. The
    // harness hook bounds reporting separately from its short browser deadline.
    const report = await convertBrowserCoverage(collected, process.cwd(), undefined, scriptUrls);
    onReport?.(report);
    if (process.env.RENDRO_BROWSER_COVERAGE_DIR) {
      mkdirSync(process.env.RENDRO_BROWSER_COVERAGE_DIR, { recursive: true });
      writeFileSync(resolve(process.env.RENDRO_BROWSER_COVERAGE_DIR, `${basename(suite)}-${randomUUID()}.json`), JSON.stringify(report));
    }
  }
  context.close = options => closeContext(options);
  return {
    close: (closeBrowser: CloseBrowser) => closeContext(undefined, closeBrowser),
    flush,
    async targets() {
      const types: string[] = [];
      for (const pending of frames.values()) {
        const session = await pending;
        if (session) types.push((await session.send("Target.getTargetInfo")).targetInfo.type);
      }
      return types;
    },
    ready: (page: Page) => pages.get(page),
    async snapshot(include?: Set<string>): Promise<CoverageMapData> {
      for (const page of context.pages()) await finishPage(page);
      return convertBrowserCoverage(collected, process.cwd(), include, scriptUrls);
    },
  };
}
