import type { Frame, Locator, Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { securityHeaders } from "@/middleware/security-headers";
import { viewerScript } from "@/viewer/markup";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { repoShell } from "./helpers/repo-shell";

/** A repository's docs shell (#234) with its lazy tree, and document frames that run the real navigation bridge. */
const privateBase = "/r/acme/docs";
const documents = ["guide/page.html", "guide/other.html"];
const requests: string[] = [];
const violations: string[] = [];
const consoleCsp: string[] = [];
const harness = createBrowserHarness();
let publisherBase = "";
let navigationAttack = false;
let chainedNavigation = false;
let missingActivationAttack = false;
const activationModes = [privateBase].flatMap(base =>
  [false, true].map(missing => ({ base, missing })));


// Fragment text a hostile publisher could put in a link: markup, selector syntax and script text.
const hostileFragments = [
  '#<img src=x onerror="parent.pwned=1;window.pwned=1">',
  '#x"][onclick="parent.pwned=1;window.pwned=1',
  "#' onmouseover='parent.pwned=1;window.pwned=1",
  "#%3Cscript%3Eparent.pwned=1%3C/script%3E",
  "#\\\"; parent.pwned=1; //",
];
const hostileLinks = hostileFragments.map((fragment, index) => `<a id="hostile-${index}" href="${fragment.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Hostile ${index}</a>`).join("");

function publisherHtml(path: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${publisherBase}<title>Fragment fixture</title>
    <style>body{margin:0}nav{position:fixed;top:0;background:white}section{height:900px}h2{margin:0}</style>
    </head><body data-path="${path}"><nav>
    <a href="#details">Bare fragment</a><a href="page.html#details">Explicit same page</a>
    <a href="page.html?v=1#details">Query one</a><a href="page.html?v=2#section">Query two</a>
    <a href="page.html?#details">Empty query</a><a href="page.html?doc=publisher&v=3#section">Publisher doc query</a>
    <a href="other.html#section">Other page</a><a href="#日本語">Unicode</a>
    <a href="#caf%C3%A9">Encoded</a><a href="#legacy">Legacy name</a>
    <a href="#">Empty hash</a><a href="#ToP">Top</a><a href="#missing">Missing</a>
    </nav>
    <div style="position:fixed;bottom:0;left:0;right:0;background:white"><a id="external" href="https://outside.test/page?q=1#top">External</a>
    <a id="external-later" href="https://later.test/">Later</a>${hostileLinks}</div><section><textarea>Comment draft</textarea></section>
    <h2 id="details">Details</h2><section></section><h2 id="section">Section</h2>
    <section></section><h2 id="日本語">Unicode target</h2><section></section>
    <h2 id="café">Encoded target</h2><section></section><a name="legacy">Named target</a><section></section>
    <script>document.body.dataset.initializedQuery = location.search;
    addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'fixture-navigate') {
        parent.postMessage({type:'doc-navigate',path:'guide/other.html',search:event.data.search,fragment:'#section'},location.origin);
      }
    });
    ${navigationAttack ? `
      function flood(){for(let i=0;i<100;i++) {
        parent.postMessage({type:'doc-navigate',path:'guide/other.html',search:'?forged='+i,fragment:'#section'},location.origin);
        parent.postMessage({type:'doc-loaded',path:'guide/other.html'},location.origin);
      }}
      flood();
      window.addEventListener('click', flood);
    ` : ""}
    ${chainedNavigation ? `
      // Every replacement document tries the next hop, beyond the old 1s gate.
      if (location.search) {
        let hop = Number(new URLSearchParams(location.search).get('hop') || 0);
        let attempts = 0;
        const timer = setInterval(() => {
          parent.postMessage({type:'doc-navigate',path:'guide/other.html',search:'?hop='+ ++hop},location.origin);
          if (++attempts >= 5 && navigator.userActivation?.isActive !== true) {
            clearInterval(timer);
            parent.postMessage({type:'fixture-chain-complete'},location.origin);
          }
        }, 1100);
      }
    ` : ""}
    ${missingActivationAttack ? `
      let attempt = 0;
      setInterval(() => {
        parent.postMessage({type:'doc-navigate',path:'guide/other.html',search:attempt++ ? '?later' : '?value=<img src=x onerror=alert(1)>',fragment:'#section'},location.origin);
        parent.postMessage({type:'shell-toggle'},location.origin);
      }, 200);
    ` : ""}
    </script>
    </body></html>`;
}

beforeAll(async () => {
  const viewer = await bundleBrowserAsset("src/viewer/entry.ts");
  const tree = await bundleBrowserAsset("src/lazy-tree/lazy-tree.ts");
  const app = new Hono();
  app.use("*", securityHeaders);
  app.get("/private-viewer.js", c => c.body(viewer, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/lazy-tree.js", c => c.body(tree, 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get(privateBase, c => {
    const selected = c.req.query("doc") ?? documents[0];
    return documents.includes(selected) ? c.html(repoShell({ selectedPath: selected })) : c.html("Not found", 404);
  });
  app.get(`${privateBase}/tree`, c => c.json({ children: c.req.query("dir") === "guide/"
    ? documents.map(path => ({ name: path.slice("guide/".length), type: "file" }))
    : [{ name: "guide", type: "folder" }] }));
  app.get(`${privateBase}/files/*`, c => {
    const path = decodeURIComponent(c.req.path.slice(`${privateBase}/files/`.length));
    if (!documents.includes(path)) return c.body(null, 404);
    const head = viewerScript("navigation", { prefix: `${privateBase}/files/`, documentPath: path }, c.req.url);
    return c.html(publisherHtml(path).replace("<head>", `<head>${head}`));
  });
  await harness.start((request, response) => {
    void (async () => {
      const url = new URL(request.url!, harness.origin);
      // Record no ticket capabilities, only canonical document loads.
      if (url.pathname.includes("/view/")) requests.push("ticket-request");
      else requests.push(url.pathname);
      const result = await app.request(url.href);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => response.destroy(error as Error));
  });
});

beforeEach(() => { navigationAttack = false; chainedNavigation = false; missingActivationAttack = false; publisherBase = ""; requests.length = 0; violations.length = 0; consoleCsp.length = 0; });

afterEach(() => {
  expect(violations, "securitypolicyviolation events across shell and publisher frames").toEqual([]);
  expect(consoleCsp, "CSP console errors during fragment navigation").toEqual([]);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function newPage(): Promise<Page> {
  const page = await harness.newPage();
  await page.exposeFunction("recordViolation", (value: string) => { violations.push(value); });
  await page.addInitScript(() => {
    const state = window as unknown as { activations: boolean[]; chainComplete: boolean };
    state.activations = [];
    state.chainComplete = false;
    addEventListener("message", event => {
      if (event.data?.type === "doc-navigate") state.activations.push(navigator.userActivation?.isActive ?? false);
      if (event.data?.type === "fixture-chain-complete"
        && event.source === document.querySelector<HTMLIFrameElement>("#content-frame")?.contentWindow) {
        state.chainComplete = true;
      }
    });
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { recordViolation: (value: string) => void }).recordViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  page.on("console", message => { if (/content security policy|violates.*policy/i.test(message.text())) consoleCsp.push(message.text()); });
  return page;
}

async function readyFrame(page: Page, { path = documents[0], search = "" }: { path?: string; search?: string } = {}): Promise<Frame> {
  // The shell can finish parsing before its tree starts the document request.
  // Wait for the canonical iframe and publisher initialization, not a load event
  // that may already have fired or unrelated shell resources.
  await browserStep("wait for canonical iframe source", () => page.waitForFunction(() => {
    const src = document.querySelector<HTMLIFrameElement>("#content-frame")?.getAttribute("src");
    return Boolean(src && src !== "about:blank");
  }));
  const frame = await (await page.locator("#content-frame").elementHandle())!.contentFrame();
  if (!frame) throw new Error("Missing document frame");
  await browserStep("wait for publisher initialization", () => frame.waitForFunction(expected => document.readyState === "complete"
    && document.body?.dataset.path === expected.path
    && document.body.dataset.initializedQuery === expected.search
    && Boolean(document.getElementById("details")), { path, search }));
  // A restored scroll position can be visible before the parent's load handler
  // finishes. aria-busy is cleared by that handler; doc-loading only keeps the
  // sidebar animation visible for 520ms and does not block document interaction.
  await browserStep("wait for viewer load acknowledgement", () => page.waitForFunction(() => document.querySelector("#content-frame")?.getAttribute("aria-busy") !== "true"));
  return frame;
}

// Unlike Playwright's evaluated scripts, these fixture operations must not grant
// activation. Keep CDP local to this Chromium test and release each session.
async function withoutActivation<T>(page: Page, action: () => T | Promise<T>, label: string): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await browserStep(label, async () => {
      const result = await session.send("Runtime.evaluate", {
        expression: `(${action.toString()})()`, userGesture: false, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value as T;
    });
  } finally {
    await session.detach();
  }
}

function readHistoryLength(page: Page): Promise<number> {
  return withoutActivation(page, () => history.length, "read history without activation");
}

// Document readiness is not a history assertion. Wait for the expected joint
// session history state without granting activation during the observation.
async function expectHistoryLength(page: Page, expected: number): Promise<void> {
  await expect.poll(() => readHistoryLength(page)).toBe(expected);
}

// Observe the native getter without a gesture, and resolve only after the shell
// has read false. Polling isActive ourselves could beat the gate's observer.
async function waitForObservedActivationExpiry(page: Page): Promise<void> {
  await withoutActivation(page, () => new Promise<void>(resolve => {
    const activation = navigator.userActivation;
    if (!activation) { resolve(); return; }
    const read = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), "isActive")!.get!.bind(activation);
    Object.defineProperty(activation, "isActive", {
      configurable: true,
      get() {
        const active = read() as boolean;
        if (!active) {
          Reflect.deleteProperty(activation, "isActive");
          // The gate finishes resetting its reservation in this same task.
          queueMicrotask(resolve);
        }
        return active;
      },
    });
  }), "wait for shell to observe native activation expiry");
}

async function open(base: string, hash = ""): Promise<{ page: Page; frame: Frame }> {
  const page = await newPage();
  const response = (await browserStep("navigate to fixture", () => page.goto(harness.origin + base + hash, { waitUntil: "domcontentloaded" })))!;
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("frame-src 'self'");
  expect(csp).toContain("script-src-attr 'none'");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const nonce = csp.match(/'nonce-([^']+)'/)![1];
  const nonces = await page.locator('script[data-viewer], script[src^="/lazy-tree.js"]').evaluateAll(elements => elements.map(element => (element as HTMLScriptElement).nonce));
  expect(nonces.length).toBeGreaterThan(0);
  expect(nonces.every(value => value === nonce)).toBe(true);
  return { page, frame: await readyFrame(page) };
}

async function atTarget(frame: Frame, id: string) {
  // Native history restoration can adjust scroll after the first target paint.
  // Do not issue the next traversal/reload from that transient position.
  await browserStep(`scroll to fragment ${id}`, () => frame.waitForFunction(async id => {
    const aligned = () => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -1) === 0;
    if (!aligned()) return false;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!aligned()) return false;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return aligned();
  }, id));
}

// Uses the actual route injectors, shell, and bundled bridge/tree in Chromium's
// opaque-origin sandbox; DOM mocks cannot detect ticket-base navigations.
describe("viewer fragment navigation in Chromium", () => {
  const confinedPaths = [
    { path: "../outside.html", rejected: true },
    { path: "guide/../../outside.html", rejected: true },
    { path: "guide\\..\\outside.html", rejected: true },
    { path: "https://outside.test/page.html", rejected: true },
    { path: "//outside.test/page.html", rejected: true },
    { path: "/organizations/other/projects/other/docs/files/page.html", rejected: true },
    { path: "%2e%2e/outside.html", rejected: false },
    { path: "%2E%2E%2Foutside.html", rejected: false },
    { path: "%252e%252e%252foutside.html", rejected: false },
    { path: "%2f%2foutside.test/page.html", rejected: false },
    { path: "javascript:alert(1)", rejected: false },
    { path: "data:text/html,outside", rejected: false },
    { path: "organizations/other/projects/other/docs/files/page.html", rejected: false },
    { path: "other-project/guide/page.html", rejected: false },
  ];

  it.each(activationModes.flatMap(mode => confinedPaths.map(path => ({ ...mode, ...path }))))(
    "confines frame-requested $path in $base (missing activation API: $missing)", async ({ base, missing, path, rejected }) => {
      const page = await newPage();
      if (missing) await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
      await page.goto(harness.origin + base);
      const frame = await readyFrame(page);
      const initialUrl = page.url();
      const initialSrc = await page.locator("#content-frame").getAttribute("src");
      const navigations: string[] = [];
      page.on("request", request => { if (request.isNavigationRequest()) navigations.push(request.url()); });
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const expectedPath = `${base}/files/${encoded}`;
      const response = rejected ? undefined : page.waitForResponse(response => new URL(response.url()).pathname === expectedPath);
      await frame.locator("textarea").click();
      await frame.evaluate(path => parent.postMessage({
        type: "doc-navigate", path, search: "?doc=outside&next=https://outside.test/", fragment: "#section",
        // Extra frame-controlled URL/target fields must never choose the parent route.
        url: "https://outside.test/", target: "_top",
      }, location.origin), path);
      await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length === 1);
      if (rejected) {
        expect(page.url()).toBe(initialUrl);
        expect(await page.locator("#content-frame").getAttribute("src")).toBe(initialSrc);
        expect(await page.locator("#document-navigation-notice").count()).toBe(0);
        expect(navigations).toEqual([]);
      } else {
        // These strings can be literal filenames, but may never be interpreted
        // as traversal, a scheme, or an alternate route/namespace.
        if (missing) {
          expect(page.url()).toBe(initialUrl);
          await page.getByRole("button", { name: "Open linked document", exact: true }).click();
        }
        expect((await response)!.status()).toBe(404);
        const shell = new URL(page.url());
        expect(shell.origin).toBe(harness.origin);
        expect(shell.pathname).toBe(base);
        expect(shell.searchParams.get("doc")).toBe(path);
        expect(shell.searchParams.get("docQuery")).toBe("?doc=outside&next=https://outside.test/");
        expect(shell.hash).toBe("#section");
        expect(navigations.length).toBeGreaterThan(0);
        expect(navigations.every(url => new URL(url).origin === harness.origin && new URL(url).pathname === expectedPath)).toBe(true);
        expect(new URL((await page.locator("#content-frame").getAttribute("src"))!, harness.origin).pathname).toBe(expectedPath);
      }
      await page.close();
    });

  it.each([privateBase])("blocks native parent/top navigation even with a document gesture in %s", async base => {
    const { page, frame } = await open(base);
    const initialUrl = page.url();
    await frame.locator("textarea").click();
    expect(await frame.evaluate(() => {
      return [parent, top!].map(target => {
        try { target.location.href = "/outside-viewer"; return "navigated"; }
        catch (error) { return (error as DOMException).name; }
      });
    })).toEqual(["SecurityError", "SecurityError"]);
    expect(page.url()).toBe(initialUrl);
    expect(await page.locator("#content-frame").getAttribute("sandbox")).not.toMatch(/allow-top-navigation/);
    await page.close();
  });

  it.each([privateBase])("ignores forged navigation and load-report loops without a gesture in %s", async base => {
    navigationAttack = true;
    // Playwright's evaluate (including the nonce checks in open()) grants
    // activation. Let the publisher attack run before any evaluated assertions.
    const page = await newPage();
    await page.goto(harness.origin + base);
    const url = page.url();
    const loads = requests.filter(path => path.includes("/files/")).length;
    // No evaluate-generated input occurs until all unsolicited messages settle.
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe(new URL(url).pathname);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    expect(requests.filter(path => path.includes("/files/")).length).toBe(loads);
    expect(await readHistoryLength(page)).toBe(2);
    await page.close();
  });

  it.each([privateBase])("propagates real opaque-frame click activation and bounds its message burst in %s", async base => {
    navigationAttack = true;
    const page = await newPage();
    await page.goto(harness.origin + base);
    await page.waitForTimeout(600);
    // Count only the click's navigation: on a loaded host the first document can still be committing here. A frame's
    // URL is Playwright's own state, so waiting on it (unlike an evaluate) grants the shell no activation.
    const documentFrame = () => page.frames().find(candidate => candidate.parentFrame() === page.mainFrame());
    await expect.poll(() => documentFrame()?.url() ?? "").toContain("/files/");
    const frame = documentFrame()!;
    let navigations = 0;
    page.on("framenavigated", navigated => { if (navigated === frame) navigations++; });
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    await readyFrame(page, { search: "?v=1" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=1");
    expect(navigations).toBe(1);
    await expectHistoryLength(page, 3);
    expect(await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations.includes(true))).toBe(true);
    navigationAttack = false;
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    await page.close();
  });

  it.each([privateBase])("allows only one navigation across delayed replacement-frame requests in %s", async base => {
    chainedNavigation = true;
    const page = await newPage();
    await page.goto(harness.origin + base);
    const frame = await readyFrame(page);
    expect(await readHistoryLength(page)).toBe(2);
    let navigations = 0;
    page.on("framenavigated", candidate => { if (candidate === frame) navigations++; });
    const destinations: string[] = [];
    const requestsAfterCommit: string[] = [];
    page.on("request", request => {
      if (!request.isNavigationRequest() || request.frame() !== frame) return;
      destinations.push(request.url());
      if (navigations) requestsAfterCommit.push(request.url());
    });
    const targets = new Set<string>();
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.pathname.startsWith(`${base}/files/`)) targets.add(url.pathname + url.search);
    });
    const initialUrl = page.url();
    const loads = requests.filter(path => path.includes("/files/")).length;
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    // A passive completion signal follows at least five attempts and native
    // expiry. Drain the fixture stream before Back so it cannot reopen a notice
    // during history restoration. Do not grant any further automation activation.
    await withoutActivation(page, () => new Promise<void>(resolve => {
      if ((window as unknown as { chainComplete: boolean }).chainComplete) { resolve(); return; }
      const complete = (event: MessageEvent) => {
        if (event.data?.type !== "fixture-chain-complete"
          || event.source !== document.querySelector<HTMLIFrameElement>("#content-frame")?.contentWindow) return;
        window.removeEventListener("message", complete);
        resolve();
      };
      window.addEventListener("message", complete);
    }), "wait for replacement-frame requests beyond activation expiry");
    expect(navigations).toBe(1);
    // The pending src request can reach the server before location.replace
    // cancels it. Both attempts must target the approved URL, with no later fetch.
    expect(new Set(destinations)).toEqual(new Set([`${harness.origin}${base}/files/${documents[0]}?v=1`]));
    expect(requestsAfterCommit).toEqual([]);
    expect([...targets]).toEqual([`${base}/files/${documents[0]}?v=1`]);
    expect(new Set(requests.filter(path => path.includes("/files/")).slice(loads)))
      .toEqual(new Set([`${base}/files/${documents[0]}`]));
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=1");
    // Inspect all state passively: even a locator count can grant activation.
    const state = await withoutActivation(page, () => ({
      historyLength: history.length,
      notices: document.querySelectorAll("#document-navigation-notice").length,
      active: navigator.userActivation.isActive,
    }), "read replacement-frame navigation state without activation");
    expect(state).toEqual({ historyLength: 3, notices: 1, active: false });
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    expect(page.url()).toBe(initialUrl);
    expect(new URL(frame.url()).pathname).toBe(`${base}/files/${documents[0]}`);
    expect(await page.locator("#document-navigation-notice").count()).toBe(0);
    await page.close();
  });

  it.each([privateBase])("uses deduplicated text-only parent confirmation without userActivation in %s", async base => {
    missingActivationAttack = true;
    const search = "?value=<img src=x onerror=alert(1)>";
    const page = await newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
    let committedLoads = 0;
    page.on("framenavigated", frame => {
      if (frame.parentFrame() && new URL(frame.url()).pathname.includes("/files/")) committedLoads++;
    });
    await page.goto(harness.origin + base);
    await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length >= 8);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    const notice = page.locator("#document-navigation-notice");
    expect(await notice.count()).toBe(1);
    expect(await notice.locator("p").textContent()).toBe(`Open linked document guide/other.html${search}#section?`);
    expect(await notice.locator("img").count()).toBe(0);
    expect(await page.locator("html").getAttribute("class")).not.toContain("shell-hidden");
    expect(requests.filter(path => path.includes("/files/")).length).toBe(1);
    // Parent native button supports keyboard activation even without the API.
    await notice.getByRole("button", { name: "Open linked document", exact: true }).press("Enter");
    await readyFrame(page, { path: documents[1], search: new URL(search, "https://fixture.test").search });
    expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[1]);
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe(search);
    expect(new URL(page.url()).hash).toBe("#section");
    // src + location.replace can issue an aborted request before the one
    // committed navigation. Count commits, and forbid any later fetches.
    const loadsAfterOpen = requests.filter(path => path.includes("/files/")).length;
    await notice.waitFor();
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    const attempts = await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations.length);
    await page.waitForFunction(before => (window as unknown as { activations: boolean[] }).activations.length >= before + 3, attempts);
    expect(await notice.count()).toBe(0);
    expect(committedLoads).toBe(2);
    expect(requests.filter(path => path.includes("/files/")).length).toBe(loadsAfterOpen);
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    await page.close();
  });

  it.each([privateBase])("recovers later document and query links through parent Review after dismissal in %s", async base => {
    const page = await newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
    await page.goto(harness.origin + base);
    let frame = await readyFrame(page);
    const notice = page.locator("#document-navigation-notice");
    const review = page.getByRole("button", { name: "Review linked document", exact: true });
    for (const link of ["Other page", "Query two"]) {
      await frame.getByRole("link", { name: "Query one", exact: true }).click();
      await notice.waitFor();
      // Document requests must not move focus into the parent notice.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("content-frame");
      await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
      await frame.getByRole("link", { name: link, exact: true }).click();
      // Drain posted messages before the parent-owned reopen action.
      await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length >= 2);
      expect(await notice.count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("content-frame");
      expect((await new AxeBuilder({ page }).include("#document-navigation-review").options({ preload: false }).analyze()).violations).toEqual([]);
      await review.press("Enter");
      const destination = link === "Other page" ? "guide/other.html#section" : "guide/page.html?v=2#section";
      expect(await notice.locator("p").textContent()).toBe(`Open linked document ${destination}?`);
      expect((await new AxeBuilder({ page }).include("#document-navigation-notice").options({ preload: false }).analyze()).violations).toEqual([]);
      await notice.getByRole("button", { name: "Open linked document", exact: true }).press("Enter");
      frame = await readyFrame(page, { path: link === "Other page" ? documents[1] : documents[0], search: link === "Other page" ? "" : "?v=2" });
      expect(new URL(page.url()).searchParams.get("doc")).toBe(link === "Other page" ? documents[1] : documents[0]);
      expect(new URL(page.url()).searchParams.get("docQuery")).toBe(link === "Other page" ? null : "?v=2");
      expect(new URL(page.url()).hash).toBe("#section");
      expect(await review.count()).toBe(0);
      await page.evaluate(() => { (window as unknown as { activations: boolean[] }).activations = []; });
    }
    await page.close();
  });

  it.each([privateBase])("never reopens or mutates dismissed UI under duplicate and changing-target floods in %s", async base => {
    const page = await newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
    await page.goto(harness.origin + base);
    const frame = await readyFrame(page);
    const initialUrl = page.url();
    const notice = page.locator("#document-navigation-notice");
    const review = page.getByRole("button", { name: "Review linked document", exact: true });
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    for (let round = 0; round < 3; round++) {
      await review.evaluate(element => {
        const state = window as unknown as { reviewMutations: number };
        state.reviewMutations = 0;
        new MutationObserver(records => { state.reviewMutations += records.length; })
          .observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      await frame.getByRole("textbox").focus();
      const before = await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations.length);
      await frame.evaluate(() => {
        for (let i = 0; i < 1000; i++) {
          parent.postMessage({ type: "doc-navigate", path: "guide/other.html", search: `?v=${i}`, fragment: "#section" }, location.origin);
          parent.postMessage({ type: "doc-navigate", path: "guide/other.html", search: `?v=${i}`, fragment: "#section" }, location.origin);
        }
      });
      await page.waitForFunction(count => (window as unknown as { activations: boolean[] }).activations.length === count, before + 2000);
      expect(await notice.count()).toBe(0);
      expect(await review.count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { reviewMutations: number }).reviewMutations)).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("content-frame");
      expect(page.url()).toBe(initialUrl);
      expect(requests.filter(path => path.includes("/files/")).length).toBe(1);
      // A genuine later link remains available on every reader-driven reopening.
      await frame.getByRole("link", { name: "Query two", exact: true }).click();
      await page.waitForFunction(count => (window as unknown as { activations: boolean[] }).activations.length === count, before + 2001);
      await review.click();
      expect(await notice.locator("p").textContent()).toBe("Open linked document guide/page.html?v=2#section?");
      if (round < 2) await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    }
    await notice.getByRole("button", { name: "Open linked document", exact: true }).click();
    await readyFrame(page, { search: "?v=2" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=2");
    await page.close();
  });

  it.each(activationModes)("reserves expired Review, Dismiss and Open activation in $base (missing API: $missing)", async ({ base, missing }) => {
    const page = await newPage();
    if (missing) await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
    await page.goto(harness.origin + base);
    const frame = await readyFrame(page);
    const initialUrl = page.url();
    const notice = page.locator("#document-navigation-notice");
    // Keep sending and observing in one passive evaluation: a subsequent
    // Playwright locator wait can grant activation before the message arrives.
    const session = await page.context().newCDPSession(page);
    try {
      await browserStep("show unsolicited navigation notice without activation", async () => {
        const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
          expression: `(async () => {
            const waitFor = predicate => new Promise(resolve => {
              const timer = setInterval(() => {
                if (predicate()) { clearInterval(timer); resolve(); }
              }, 25);
            });
            await waitFor(() => navigator.userActivation?.isActive !== true);
            document.querySelector('#content-frame').contentWindow.postMessage({ type: 'fixture-navigate', search: '?shown' }, '*');
            await waitFor(() => document.querySelector('#document-navigation-notice'));
            return navigator.userActivation?.isActive === true;
          })()`,
          userGesture: false, returnByValue: true, awaitPromise: true,
        });
        expect(exceptionDetails).toBeUndefined();
        expect(result.value).toBe(false);
      });
    } finally {
      await session.detach();
    }
    await notice.waitFor();
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    await frame.waitForFunction(() => {
      parent.postMessage({ type: "doc-navigate", path: "guide/other.html", search: "?reviewed", fragment: "#section" }, location.origin);
      return true;
    });
    await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length === 2);
    expect(page.url()).toBe(initialUrl);
    expect(await notice.count()).toBe(0);
    const review = page.getByRole("button", { name: "Review linked document", exact: true });
    // Schedule a real frame message as soon as Review receives input.
    await review.evaluate(button => button.addEventListener("click", () => {
      document.querySelector<HTMLIFrameElement>("#content-frame")!.contentWindow!.postMessage({ type: "fixture-navigate", search: "?attack-review" }, "*");
    }, { once: true }));
    await waitForObservedActivationExpiry(page);
    await review.click();
    await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length === 3);
    expect(page.url()).toBe(initialUrl);
    expect(await notice.locator("p").textContent()).toBe("Open linked document guide/other.html?reviewed#section?");
    expect(await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations.at(-1))).toBe(!missing);
    // Attack on pointerdown, before Open's click, and again from the replacement.
    const open = notice.getByRole("button", { name: "Open linked document", exact: true });
    await open.evaluate(button => button.addEventListener("pointerdown", () => {
      document.querySelector<HTMLIFrameElement>("#content-frame")!.contentWindow!.postMessage({ type: "fixture-navigate", search: "?attack-open" }, "*");
    }, { once: true }));
    await open.hover();
    await page.mouse.down();
    await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length === 4);
    expect(page.url()).toBe(initialUrl);
    expect(await notice.locator("p").textContent()).toBe("Open linked document guide/other.html?reviewed#section?");
    await page.mouse.up();
    const replacement = await readyFrame(page, { path: documents[1], search: "?reviewed" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?reviewed");
    expect(new URL(page.url()).hash).toBe("#section");
    await replacement.waitForFunction(() => {
      parent.postMessage({ type: "doc-navigate", path: "guide/other.html", search: "?attack-replacement" }, location.origin);
      return true;
    });
    await notice.waitFor();
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?reviewed");
    await expectHistoryLength(page, 3);
    await page.close();
  });

  it.each(activationModes.flatMap(mode => ["tree", "theme", "comment"].map(control => ({ ...mode, control }))))(
    "reserves $control input before same-gesture frame messages in $base (missing API: $missing)", async ({ base, missing, control }) => {
      const page = await newPage();
      if (missing) await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
      await page.goto(harness.origin + base);
      await readyFrame(page);
      const initialUrl = page.url();
      // The deployed comment toolbar lives inside the document. Model a parent
      // comment surface in a shadow root to exercise composed parent input too.
      if (control === "comment") await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "parent-comment-fixture";
        host.style.cssText = "position:fixed;top:60px;right:10px;z-index:1000";
        const button = document.createElement("button");
        button.textContent = "Comment";
        host.attachShadow({ mode: "open" }).append(button);
        document.body.append(host);
      });
      const target = page.locator(control === "tree" ? ".tree-folder > .tree-item" : control === "theme" ? "#theme-toggle" : "#parent-comment-fixture button").first();
      await target.evaluate(element => element.addEventListener("pointerdown", () => {
        document.querySelector<HTMLIFrameElement>("#content-frame")!.contentWindow!.postMessage({ type: "fixture-navigate", search: "?parent-attack" }, "*");
      }, { once: true }));
      await waitForObservedActivationExpiry(page);
      await target.hover();
      await page.mouse.down();
      await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length === 1);
      expect(page.url()).toBe(initialUrl);
      expect(await page.locator("#document-navigation-notice").count()).toBe(1);
      await page.mouse.up();
      expect(await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations)).toEqual([!missing]);
      expect(await readHistoryLength(page)).toBe(2);
      await page.close();
    });

  it.each(["click", "Enter", "Space"] as const)("operates Dismiss, Review and Open the same way by %s", async mode => {
    const page = await newPage();
    // Without the activation API every unsolicited link needs the reader, so the three controls are the only way through.
    await page.addInitScript(() => { Object.defineProperty(navigator, "userActivation", { value: undefined }); });
    await page.goto(harness.origin + privateBase);
    const frame = await readyFrame(page);
    const press = (button: Locator) => mode === "click" ? button.click() : button.press(mode === "Space" ? " " : "Enter");
    const notice = page.locator("#document-navigation-notice");
    const review = page.getByRole("button", { name: "Review linked document", exact: true });
    const focused = () => page.evaluate(() => document.activeElement?.textContent ?? null);
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    await notice.waitFor();
    expect(await notice.locator("p").textContent()).toBe("Open linked document guide/page.html?v=1#details?");

    await press(notice.getByRole("button", { name: "Dismiss", exact: true }));
    expect(await notice.count()).toBe(0);
    expect(await focused()).toBe("Review linked document");
    // A later request while dismissed is only remembered.
    await frame.getByRole("link", { name: "Query two", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { activations: boolean[] }).activations.length >= 2);
    expect(await notice.count()).toBe(0);

    await press(review);
    expect(await review.count()).toBe(0);
    expect(await notice.locator("p").textContent()).toBe("Open linked document guide/page.html?v=2#section?");
    expect(await focused()).toBe("Open linked document");
    // Dismiss, a remembered request and Review load nothing: only the first open document was fetched (the list names a stray one).
    expect(requests.filter(path => path.includes("/files/"))).toEqual([`${privateBase}/files/${documents[0]}`]);

    await press(notice.getByRole("button", { name: "Open linked document", exact: true }));
    await readyFrame(page, { search: "?v=2" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=2");
    expect(new URL(page.url()).hash).toBe("#section");
    expect(await notice.count()).toBe(0);
    expect(await review.count()).toBe(0);
    await expectHistoryLength(page, 3);
    await page.close();
  });

  it("coalesces a rapid legitimate confirmed link so one Back returns before the burst", async () => {
    const { page, frame } = await open(privateBase);
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    await readyFrame(page, { search: "?v=1" });
    await frame.getByRole("link", { name: "Query two", exact: true }).click();
    await page.getByRole("button", { name: "Open linked document", exact: true }).click();
    await readyFrame(page, { search: "?v=2" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=2");
    await expectHistoryLength(page, 3);
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    await page.goForward();
    await readyFrame(page, { search: "?v=2" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=2");
    await page.goBack();
    await readyFrame(page);
    await frame.getByRole("link", { name: "Query two", exact: true }).click();
    await page.getByRole("button", { name: "Open linked document", exact: true }).click();
    await readyFrame(page, { search: "?v=2" });
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    await page.close();
  });

  it("allows two legitimate sequential clicks after observing activation expiry", async () => {
    const { page, frame } = await open(privateBase);
    await frame.getByRole("link", { name: "Query one", exact: true }).click();
    await readyFrame(page, { search: "?v=1" });
    await expectHistoryLength(page, 3);
    await waitForObservedActivationExpiry(page);
    await frame.getByRole("link", { name: "Query two", exact: true }).click();
    await readyFrame(page, { search: "?v=2" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=2");
    expect(await page.locator("#document-navigation-notice").count()).toBe(0);
    await expectHistoryLength(page, 4);
    await page.goBack();
    await readyFrame(page, { search: "?v=1" });
    expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=1");
    await page.goBack();
    await readyFrame(page);
    expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    await page.close();
  });

  it.each([privateBase])("propagates keyboard Enter activation from an opaque-frame link in %s", async base => {
    const page = await newPage();
    await page.goto(harness.origin + base);
    const frame = await readyFrame(page);
    await frame.getByRole("link", { name: "Other page", exact: true }).press("Enter");
    await readyFrame(page, { path: documents[1] });
    expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[1]);
    expect(new URL(page.url()).hash).toBe("#section");
    expect(await page.evaluate(() => (window as unknown as { activations: boolean[] }).activations)).toEqual([true]);
    await expectHistoryLength(page, 3);
    await page.close();
  });

  it.each([privateBase])("treats hostile fragment text as data, never as a selector or markup, in %s", async base => {
    const { page, frame } = await open(base);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const dialogs: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    try {
      const loads = requests.filter(path => path === `${base}/files/${documents[0]}`).length;
      const historyLength = await readHistoryLength(page);
      const scroll = await frame.evaluate(() => scrollY);
      const inspect = (target: Page | Frame) => target.evaluate(() => ({
        injected: document.querySelectorAll('img[src="x"], script:not([src]):not([data-viewer]):not([nonce]), [onerror], [onclick], [onmouseover]').length,
        pwned: "pwned" in window,
      }));
      const baseline = { shell: await inspect(page), frame: await inspect(frame) };
      for (const [index, fragment] of hostileFragments.entries()) {
        await frame.locator(`#hostile-${index}`).click();
        // The shell learns the fragment as the URL parser spells it: text, never evaluated.
        const spelled = new URL(`https://fragment.test/${fragment}`).hash;
        await browserStep(`synchronize hostile fragment ${index}`, () => expect.poll(() => new URL(page.url()).hash).toBe(spelled));
        expect({ shell: await inspect(page), frame: await inspect(frame) }, fragment).toEqual(baseline);
      }
      // No target matched, so the document did not move, reload or grow history.
      expect(await frame.evaluate(() => scrollY)).toBe(scroll);
      expect(requests.filter(path => path === `${base}/files/${documents[0]}`).length).toBe(loads);
      expect(await readHistoryLength(page)).toBe(historyLength);
      expect(dialogs).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([privateBase])("coalesces fragment floods without history growth in %s", async base => {
    const { page, frame } = await open(base);
    const historyLength = await page.evaluate(() => {
      const replace = history.replaceState.bind(history);
      (window as unknown as { replaces: number }).replaces = 0;
      history.replaceState = (...args) => { (window as unknown as { replaces: number }).replaces++; replace(...args); };
      return history.length;
    });
    await frame.evaluate(() => {
      for (let i = 0; i < 1000; i++) parent.postMessage({ type: "doc-fragment", path: "guide/page.html", fragment: `#flood-${i}` }, location.origin);
    });
    await expect.poll(() => new URL(page.url()).hash).toBe("#flood-999");
    expect(await page.evaluate(() => (window as unknown as { replaces: number }).replaces)).toBeLessThanOrEqual(3);
    expect(await readHistoryLength(page)).toBe(historyLength);
    await page.close();
  });

  it.each([privateBase])("scrolls without a reload and restores Unicode deep links in %s", async base => {
    const { page, frame } = await open(base);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await frame.locator("textarea").fill("Unsent comment draft");
      const loads = requests.filter(path => path === `${base}/files/${documents[0]}`).length;
      const historyLength = await readHistoryLength(page);
      for (const label of ["Bare fragment", "Explicit same page"]) {
        await frame.getByRole("link", { name: label, exact: true }).click();
        await atTarget(frame, "details");
        await browserStep("synchronize shell fragment", () => expect.poll(() => new URL(page.url()).hash).toBe("#details"));
      }
      expect(await frame.locator("textarea").inputValue()).toBe("Unsent comment draft");
      expect(requests.filter(path => path === `${base}/files/${documents[0]}`).length).toBe(loads);
      expect(await readHistoryLength(page)).toBe(historyLength);
      expect(frame.url()).toBe(`${harness.origin}${base}/files/${documents[0]}`);
      await frame.getByRole("link", { name: "Unicode", exact: true }).click();
      await atTarget(frame, "日本語");
      await browserStep("synchronize shell fragment", () => expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#日本語"));
      await browserStep("reload document", () => page.reload({ waitUntil: "domcontentloaded" }));
      const reloaded = await readyFrame(page);
      await atTarget(reloaded, "日本語");
      await reloaded.getByRole("link", { name: "Encoded", exact: true }).click();
      await browserStep("synchronize shell fragment", () => expect.poll(() => new URL(page.url()).hash).toBe("#caf%C3%A9"));
      await atTarget(reloaded, "café");
      await reloaded.getByRole("link", { name: "Legacy name", exact: true }).click();
      await browserStep("scroll to legacy named anchor", () => expect.poll(() => reloaded.evaluate(() => Math.round(document.getElementsByName("legacy")[0].getBoundingClientRect().top))).toBe(0));
      const position = await reloaded.evaluate(() => scrollY);
      await reloaded.getByRole("link", { name: "Missing", exact: true }).click();
      expect(await reloaded.evaluate(() => scrollY)).toBe(position);
      for (const label of ["Empty hash", "Top"]) {
        await reloaded.getByRole("link", { name: "Bare fragment", exact: true }).click();
        await atTarget(reloaded, "details");
        await reloaded.getByRole("link", { name: label, exact: true }).click();
        await browserStep("scroll to document top", () => expect.poll(() => reloaded.evaluate(() => scrollY)).toBe(0));
      }
      expect(requests).not.toContain("ticket-request");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([privateBase])("preserves cross-page fragments, back/forward and tree navigation in %s", async base => {
    const { page, frame } = await open(base, "#details");
    try {
      await atTarget(frame, "details");
      await frame.getByRole("link", { name: "Other page", exact: true }).click();
      await browserStep("wait for canonical document navigation", () => frame.waitForFunction(url => location.href === url && document.readyState === "complete", `${harness.origin}${base}/files/${documents[1]}`));
      await atTarget(frame, "section");
      expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[1]);
      expect(new URL(page.url()).hash).toBe("#section");
      await browserStep("reload document", () => page.reload({ waitUntil: "domcontentloaded" }));
      let current = await readyFrame(page, { path: documents[1] });
      await atTarget(current, "section");
      await page.evaluate(() => history.back());
      await browserStep("restore canonical document frame", () => expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${harness.origin}${base}/files/${documents[0]}`));
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await atTarget(current, "details");
      expect(new URL(page.url()).hash).toBe("#details");
      await page.evaluate(() => history.forward());
      await browserStep("restore canonical document frame", () => expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${harness.origin}${base}/files/${documents[1]}`));
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await atTarget(current, "section");
      await page.locator('.tree-item[data-path$="/guide/page.html"] .tree-link').click();
      await browserStep("restore canonical document frame", () => expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${harness.origin}${base}/files/${documents[0]}`));
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await browserStep("scroll to document top", () => expect.poll(() => current.evaluate(() => scrollY)).toBe(0));
      expect(new URL(page.url()).hash).toBe("");
    } finally { await page.close(); }
  });

  it.each([privateBase])("reloads changed queries and preserves publisher initialization in %s", async base => {
    const { page, frame } = await open(base);
    const fileUrl = `${harness.origin}${base}/files/${documents[0]}`;
    // loadDoc replaces its pending src navigation. Observe the committed document
    // instead of a navigation event that Chromium can report as ERR_ABORTED.
    const initialized = async (query: string) => {
      await browserStep("wait for canonical document navigation", () => frame.waitForFunction(url => location.origin + location.pathname + location.search === url
        && document.readyState === "complete", fileUrl + query));
      await browserStep("wait for publisher initialization", () => frame.waitForFunction(query => document.body?.dataset.initializedQuery === query, query));
    };
    try {
      await frame.locator("textarea").fill("Old document");
      await frame.getByRole("link", { name: "Query one", exact: true }).click();
      await initialized("?v=1");
      await atTarget(frame, "details");
      expect(await frame.locator("textarea").inputValue()).toBe("Comment draft");
      await frame.locator("textarea").fill("Keep same query draft");
      const loads = requests.filter(path => path === `${base}/files/${documents[0]}`).length;
      await frame.getByRole("link", { name: "Query one", exact: true }).click();
      await atTarget(frame, "details");
      expect(await frame.locator("textarea").inputValue()).toBe("Keep same query draft");
      expect(requests.filter(path => path === `${base}/files/${documents[0]}`).length).toBe(loads);
      await waitForObservedActivationExpiry(page);
      await frame.getByRole("link", { name: "Query two", exact: true }).click();
      await initialized("?v=2");
      await atTarget(frame, "section");
      expect(await frame.locator("textarea").inputValue()).toBe("Comment draft");
      await browserStep("reload document", () => page.reload({ waitUntil: "domcontentloaded" }));
      const restored = await readyFrame(page, { search: "?v=2" });
      expect(await restored.locator("body").getAttribute("data-initialized-query")).toBe("?v=2");
      await atTarget(restored, "section");
      await browserStep("restore previous history entry", () => page.goBack({ waitUntil: "domcontentloaded" }));
      await browserStep("wait for publisher initialization", () => restored.waitForFunction(() => document.body?.dataset.initializedQuery === "?v=1"));
      await atTarget(restored, "details");
      await browserStep("restore next history entry", () => page.goForward({ waitUntil: "domcontentloaded" }));
      await browserStep("wait for publisher initialization", () => restored.waitForFunction(() => document.body?.dataset.initializedQuery === "?v=2"));
      await atTarget(restored, "section");
      await waitForObservedActivationExpiry(page); // Back/Forward also consumes authorization.
      await restored.getByRole("link", { name: "Publisher doc query", exact: true }).click();
      await browserStep("wait for publisher initialization", () => restored.waitForFunction(() => document.body?.dataset.initializedQuery === "?doc=publisher&v=3"));
      expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[0]);
      await page.locator('.tree-item[data-path$="/guide/other.html"] .tree-link').click();
      await browserStep("wait for canonical document navigation", () => restored.waitForFunction(url => location.href === url && document.readyState === "complete", `${harness.origin}${base}/files/${documents[1]}`));
      expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
    
      expect(requests).not.toContain("ticket-request");
    } finally { await page.close(); }
  });

  it.each([privateBase])("restores the destination fragment through query Back/Forward and reload in %s", async base => {
    const { page, frame } = await open(base);
    const assertDestination = async (query: string, target: string) => {
      await browserStep("wait for publisher initialization", () => frame.waitForFunction(query => document.readyState === "complete"
        && document.body?.dataset.initializedQuery === query, query));
      await browserStep("synchronize shell fragment", () => expect.poll(() => new URL(page.url()).hash).toBe("#" + target));
      await atTarget(frame, target);
      expect(new URL(frame.url()).search).toBe(query);
      expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[0]);
      expect(new URL(page.url()).searchParams.get("docQuery")).toBe(query);
    };
    try {
      await frame.getByRole("link", { name: "Query one", exact: true }).click();
      await assertDestination("?v=1", "details");
      await waitForObservedActivationExpiry(page);
      await frame.getByRole("link", { name: "Query two", exact: true }).click();
      await assertDestination("?v=2", "section");
      await page.evaluate(() => history.back());
      await assertDestination("?v=1", "details");
      await page.evaluate(() => history.forward());
      await assertDestination("?v=2", "section");
      await page.evaluate(() => history.back());
      await assertDestination("?v=1", "details");
      await browserStep("reload document", () => page.reload({ waitUntil: "domcontentloaded" }));
      const restored = await readyFrame(page, { search: "?v=1" });
      expect(await restored.locator("body").getAttribute("data-initialized-query")).toBe("?v=1");
      expect(new URL(page.url()).searchParams.get("docQuery")).toBe("?v=1");
      await browserStep("synchronize shell fragment", () => expect.poll(() => new URL(page.url()).hash).toBe("#details"));
      await atTarget(restored, "details");
      expect(requests).not.toContain("ticket-request");
    } finally { await page.close(); }
  });

  it.each([privateBase])("reopens query document state after reload and a copied URL in %s", async base => {
    const { page, frame } = await open(base);
    await frame.getByRole("link", { name: "Query two", exact: true }).click();
    await browserStep("synchronize query destination", () => expect.poll(() => new URL(page.url()).hash).toBe("#section"));
    const copiedUrl = page.url();
    expect(new URL(copiedUrl).searchParams.get("doc")).toBe(documents[0]);
    expect(new URL(copiedUrl).searchParams.get("docQuery")).toBe("?v=2");
    await browserStep("reload query destination", () => page.reload({ waitUntil: "domcontentloaded" }));
    const restored = await readyFrame(page, { search: "?v=2" });
    expect(new URL(restored.url()).pathname).toBe(`${base}/files/${documents[0]}`);
    expect(await restored.locator("body").getAttribute("data-initialized-query")).toBe("?v=2");
    await atTarget(restored, "section");
    const copied = await newPage(); // The shared harness creates a fresh context.
    await browserStep("open copied URL", () => copied.goto(copiedUrl, { waitUntil: "domcontentloaded" }));
    const copiedFrame = await readyFrame(copied, { search: "?v=2" });
    expect(new URL(copiedFrame.url()).pathname).toBe(`${base}/files/${documents[0]}`);
    expect(await copiedFrame.locator("body").getAttribute("data-initialized-query")).toBe("?v=2");
    await atTarget(copiedFrame, "section");
    expect(new URL(copied.url()).hash).toBe("#section");
    expect(requests).not.toContain("ticket-request");
  });

  it("treats an empty query as the current query without reloading", async () => {
    const { page, frame } = await open(privateBase);
    try {
      await frame.locator("textarea").fill("Keep draft");
      await frame.getByRole("link", { name: "Empty query", exact: true }).click();
      await atTarget(frame, "details");
      expect(await frame.locator("textarea").inputValue()).toBe("Keep draft");
      expect(requests.filter(path => path === `${privateBase}/files/${documents[0]}`)).toHaveLength(1);
    } finally { await page.close(); }
  });

  it.each(["../", "https://publisher.test/docs/"])("keeps bare fragments local with publisher base %s", async href => {
    publisherBase = `<base href="${href}">`;
    const { page, frame } = await open(privateBase);
    try {
      await frame.getByRole("link", { name: "Bare fragment", exact: true }).click();
      await atTarget(frame, "details");
      await browserStep("synchronize shell fragment", () => expect.poll(() => new URL(page.url()).hash).toBe("#details"));
      expect(frame.url()).toBe(`${harness.origin}${privateBase}/files/${documents[0]}`);
      expect(requests.filter(path => path === `${privateBase}/files/${documents[0]}`)).toHaveLength(1);
      expect(requests).not.toContain("ticket-request");
    } finally { await page.close(); }
  });

  it("rejects forged sources/origins, malformed hashes and stale-document messages", async () => {
    const { page } = await open(privateBase);
    try {
      const url = page.url();
      await page.evaluate(() => {
        const frame = document.getElementById("content-frame") as HTMLIFrameElement;
        const data = { type: "doc-fragment", path: "guide/page.html", fragment: "#details" };
        for (const event of [
          { data, source: window, origin: "null" },
          { data, source: frame.contentWindow, origin: location.origin },
          { data: { ...data, path: "guide/other.html" }, source: frame.contentWindow, origin: "null" },
          ...[null, {}, "x", "#" + "x".repeat(4096)].flatMap(fragment => ["doc-fragment", "doc-navigate"].map(type => ({
            data: { ...data, type, fragment }, source: frame.contentWindow, origin: "null",
          }))),
          ...[null, {}, "v=2", "?v=2#injected", "?" + "x".repeat(4096)].map(search => ({
            data: { ...data, type: "doc-navigate", search }, source: frame.contentWindow, origin: "null",
          })),
        ]) window.dispatchEvent(new MessageEvent("message", event));
      });
      expect(page.url()).toBe(url);
    } finally { await page.close(); }
  });
});

// A link to another site cannot load in the sandboxed frame: the shell asks, then opens a new tab with no handle back.
describe("external link confirmation in Chromium", () => {
  const external = "https://outside.test/page?q=1#top";
  const notice = (page: Page) => page.locator("#document-navigation-notice");
  const label = (page: Page) => page.locator("#document-navigation-destination");
  // The test never leaves the fixture origin: window.open is observed, not performed.
  const spyOpen = (page: Page) => page.evaluate(() => {
    const calls: unknown[][] = [];
    (window as unknown as { opened: unknown[][] }).opened = calls;
    window.open = (...args: unknown[]) => { calls.push(args); return null; };
  });
  const opened = (page: Page) => page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened);

  it("asks first, then opens a new tab without a handle back, leaving the document, its URL and history alone", async () => {
    const { page, frame } = await open(privateBase);
    try {
      await spyOpen(page);
      const url = page.url();
      const history = await readHistoryLength(page);
      const loads = requests.filter(path => path.includes("/files/")).length;
      await frame.locator("#external").click();
      await notice(page).waitFor();
      expect(await label(page).textContent()).toBe(`Open external link ${external}?`);
      expect(await notice(page).getByRole("button", { name: "Open external link", exact: true }).getAttribute("aria-describedby")).toBe("document-navigation-destination");
      // Nothing opens until the reader says so, however often the document asks, and the prompt keeps its address.
      await frame.locator("#external").click();
      await frame.locator("#external-later").click();
      expect(await notice(page).count()).toBe(1);
      expect(await label(page).textContent()).toBe(`Open external link ${external}?`);
      expect(await opened(page)).toEqual([]);
      // The sandbox and the grant are as strict as before.
      expect(await page.locator("#content-frame").getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-downloads");
      expect(frame.url()).toBe(`${harness.origin}${privateBase}/files/${documents[0]}`);

      await notice(page).getByRole("button", { name: "Open external link", exact: true }).click();
      expect(await opened(page)).toEqual([[external, "_blank", "noopener,noreferrer"]]);
      expect(await notice(page).count()).toBe(0);
      expect(page.url()).toBe(url);
      expect(frame.url()).toBe(`${harness.origin}${privateBase}/files/${documents[0]}`);
      expect(await readHistoryLength(page)).toBe(history);
      expect(requests.filter(path => path.includes("/files/")).length).toBe(loads);
      // The prompt is free for the next link.
      await frame.locator("#external-later").click();
      await notice(page).waitFor();
      expect(await label(page).textContent()).toBe("Open external link https://later.test/?");
    } finally { await page.close(); }
  });

  it("can be dismissed and reviewed, keeping only the latest address, and opens nothing until confirmed", async () => {
    const { page, frame } = await open(privateBase);
    try {
      await spyOpen(page);
      await frame.locator("#external").click();
      await notice(page).waitFor();
      await notice(page).getByRole("button", { name: "Dismiss", exact: true }).click();
      const review = page.getByRole("button", { name: "Review external link", exact: true });
      await review.waitFor();
      expect(await notice(page).count()).toBe(0);
      // A dismissed prompt is not reopened by the document; it only remembers the latest address.
      await frame.locator("#external-later").click();
      expect(await notice(page).count()).toBe(0);
      await review.click();
      await notice(page).waitFor();
      expect(await label(page).textContent()).toBe("Open external link https://later.test/?");
      expect(await opened(page)).toEqual([]);
      await notice(page).getByRole("button", { name: "Open external link", exact: true }).click();
      expect(await opened(page)).toEqual([["https://later.test/", "_blank", "noopener,noreferrer"]]);
    } finally { await page.close(); }
  });

  it("drops forged and unsupported external-link messages from the document", async () => {
    const { page, frame } = await open(privateBase);
    try {
      await spyOpen(page);
      await frame.evaluate(() => {
        const send = (message: unknown) => parent.postMessage(message, location.origin);
        const path = "guide/page.html";
        for (const href of ["/organizations", `${location.origin}/r/acme/other`, "mailto:someone@outside.test", "javascript:alert(1)", 5, undefined, `https://outside.test/${"x".repeat(2100)}`]) {
          send({ type: "doc-external", path, href });
        }
        send({ type: "doc-fragment", path, fragment: "#sentinel" });
      });
      await browserStep("wait for the sentinel fragment", () => page.waitForFunction(() => location.hash === "#sentinel"));
      expect(await notice(page).count()).toBe(0);
      expect(await opened(page)).toEqual([]);
    } finally { await page.close(); }
  });
});
