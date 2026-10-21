import { randomBytes } from "node:crypto";
import { createServer, request, type IncomingMessage, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { run } from "./backend";

export async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}
export type Mail = { to: string; subject: string; text: string };
/** The HTTPS hosts Convex reaches through the identity fixture: mail, and GitHub's OAuth and API hosts (#338). */
const TLS_HOSTS = ["api.resend.com", "github.com", "api.github.com"];

/** Outage the Worker's Convex requests meet; see `startFaults`. */
export type FaultRule = { origin: "convex"; includes: string[]; status: number };

/**
 * Backend outage injection for the Worker's outbound requests. A rule answers every request to the Convex fixture
 * whose URL contains all of `includes` with `status`, for as long as the rule exists, and nothing else.
 * Specs scope a rule to their own data so parallel specs never see it, and delete it when done
 * (`e2e/faults.ts`). The control server listens on loopback only.
 */
export async function startFaults(convex: string[]) {
  const rules = new Map<string, FaultRule>();
  const control = await listen((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && url.pathname === "/faults") {
        const rule = JSON.parse(await body(req)) as FaultRule;
        const id = randomBytes(8).toString("hex");
        rules.set(id, rule);
        res.end(JSON.stringify({ id })); return;
      }
      const match = /^\/faults\/([0-9a-f]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && match) { rules.delete(match[1]); res.end("{}"); return; }
      res.writeHead(404).end("{}");
    })().catch(() => { res.writeHead(500).end("{}"); });
  });
  return {
    control: control.origin,
    close: () => control.close(),
    /** The injected response for a Worker request, or undefined to forward it. */
    intercept(request: Request): Response | undefined {
      const target = request.url;
      const origin = new URL(target).origin;
      for (const rule of rules.values()) {
        if (convex.includes(origin) && rule.includes.every(part => target.includes(part))) {
          return new Response("Injected backend outage", { status: rule.status });
        }
      }
      return undefined;
    },
  };
}

/** A request the Worker made to the fake external image host. */
export type ImageHostRequest = { url: string; headers: Record<string, string> };

export const imageHostOrigin = "https://images.e2e.example";
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/**
 * A third-party image host for the image proxy (#224), answered inside the Worker's outbound fetch: nothing leaves the
 * machine. It records what the Worker sent so specs can check that readers' cookies, IPs and user agents never reach it.
 * Paths: `/pixel.png` (sets a cookie), `/scripted.svg`, `/page.html` (not an image) and `/to-private` (redirects to a
 * loopback address). Any query is ignored, so specs add a unique one to stay clear of the Worker's cache.
 */
export async function startImageHost() {
  const requests: ImageHostRequest[] = [];
  const control = await listen((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/requests") { res.end(JSON.stringify(requests)); return; }
    res.writeHead(404).end("{}");
  });
  return {
    control: control.origin,
    close: () => control.close(),
    /** The fixture's response for a Worker request, or undefined if it is not for the image host. */
    intercept(request: Request): Response | undefined {
      const url = new URL(request.url);
      if (url.origin !== imageHostOrigin) return undefined;
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      if (url.pathname === "/pixel.png") return new Response(pixel, { headers: { "Content-Type": "image/png", "Set-Cookie": "tracker=1; Path=/", "Cache-Control": "max-age=600" } });
      if (url.pathname === "/scripted.svg") {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="teal"/><script>document.documentElement.setAttribute("data-ran","1")</script></svg>', { headers: { "Content-Type": "image/svg+xml" } });
      }
      if (url.pathname === "/page.html") return new Response("<p>not an image</p>", { headers: { "Content-Type": "text/html" } });
      if (url.pathname === "/to-private") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:9/pixel.png" } });
      return new Response("Not found", { status: 404 });
    },
  };
}

/** No external forwarding: HTTPS mail requests terminate in this fixture, and so do GitHub's (#338): Better Auth's
 * GitHub provider calls github.com and api.github.com, which `github` answers (the harness's fake GitHub).
 * The only forwarded HTTP origins are the harness's own Worker and Convex.
 */
export async function startIdentityFixtures(directory: string) {
  const key = join(directory, "fixture.key");
  const certificate = join(directory, "fixture.crt");
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const csr = join(directory, "fixture.csr");
  const extensions = join(directory, "fixture.ext");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert,
    "-days", "1", "-subj", "/CN=Rendro disposable E2E CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  await run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=api.resend.com"]);
  await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${TLS_HOSTS.map(host => `DNS:${host}`).join(",")}\n`);
  await run("openssl", ["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", certificate, "-days", "1", "-extfile", extensions]);
  const mail: Mail[] = [];
  const allowedOrigins = new Set<string>();
  const blocked = new Set<string>();
  const github: { fetch: ((request: Request) => Promise<Response>) | null } = { fetch: null };
  const handle: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host}`);
      if (url.origin === "https://api.resend.com" && url.pathname === "/emails" && req.method === "POST") {
        mail.push(JSON.parse(await body(req)) as Mail);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: `mail-${mail.length}` }));
      } else if ((url.origin === "https://github.com" || url.origin === "https://api.github.com") && github.fetch) {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
        const payload = req.method === "GET" || req.method === "HEAD" ? undefined : await body(req);
        const response = await github.fetch(new Request(url, { method: req.method, headers, body: payload }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } else {
        blocked.add(url.origin); res.writeHead(403).end("Blocked fixture destination");
      }
    })().catch(() => { res.writeHead(500).end("Identity fixture failed"); });
  };
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(certificate) }, handle);
  const sockets = new Set<Duplex>();
  const proxy = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (!allowedOrigins.has(url.origin)) {
      blocked.add(url.origin); res.writeHead(403).end("External access blocked"); return;
    }
    const upstream = request(url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502).end(); });
    req.pipe(upstream);
  });
  proxy.server.on("connect", (req, socket, head) => {
    if (!TLS_HOSTS.some(host => req.url === `${host}:443`)) {
      blocked.add(req.url ?? "unknown"); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    tls.emit("connection", socket);
  });
  const control = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/mail") { res.end(JSON.stringify(mail.filter(item => item.to === url.searchParams.get("to")))); return; }
    res.writeHead(404).end("{}");
  });
  return {
    origin: proxy.origin, certificate: caCert, control: control.origin, allowedOrigins, mail, github,
    async close() {
      for (const socket of sockets) socket.destroy();
      tls.close();
      await control.close(); await proxy.close();
      if (blocked.size) throw new Error(`Blocked Convex outbound destinations: ${[...blocked].join(", ")}`);
    },
  };
}

