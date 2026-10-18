import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type IncomingMessage, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { run } from "./backend";

export const publicationSlug = "workerd-smoke";
/** Where the storage wrapper asks whether a bucket operation should fail; answered inside the E2E harness, never on a network. */
export const storageProbeOrigin = "http://r2-faults.invalid";
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

/** Outage the Worker's own storage or Convex requests meet; see `startFaults`. */
export type FaultRule = { origin: "storage" | "convex"; includes: string[]; status: number };

/**
 * Backend outage injection for the Worker's outbound requests. A rule answers every request to the storage or Convex
 * fixture whose URL contains all of `includes` with `status`, for as long as the rule exists, and nothing else.
 * Specs scope a rule to their own organization/project ids so parallel specs never see it, and delete it when done
 * (`e2e/faults.ts`). The control server listens on loopback only.
 */
export async function startFaults(origins: { storage: string; convex: string[] }) {
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
        const matches = rule.origin === "storage" ? origin === origins.storage : origins.convex.includes(origin);
        if (matches && rule.includes.every(part => target.includes(part))) {
          return new Response("Injected backend outage", { status: rule.status });
        }
      }
      return undefined;
    },
  };
}

/** No external forwarding: HTTPS mail/Google requests terminate in this fixture.
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
  await writeFile(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.resend.com,DNS:oauth2.googleapis.com,DNS:www.googleapis.com\n");
  await run("openssl", ["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", certificate, "-days", "1", "-extfile", extensions]);
  const mail: Mail[] = [];
  const allowedOrigins = new Set<string>();
  const blocked = new Set<string>();
  const codes = new Map<string, { challenge: string; redirect: string; email: string }>();
  const signing = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...await exportJWK(signing.publicKey), alg: "RS256", kid: "fixture-google" };
  const handle: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host}`);
      if (url.origin === "https://api.resend.com" && url.pathname === "/emails" && req.method === "POST") {
        mail.push(JSON.parse(await body(req)) as Mail);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: `mail-${mail.length}` }));
      } else if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token" && req.method === "POST") {
        const params = new URLSearchParams(await body(req));
        const code = params.get("code") ?? "";
        const stored = codes.get(code);
        codes.delete(code);
        if (!stored || stored.redirect !== params.get("redirect_uri") || params.get("client_id") !== "e2e-google"
          || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== stored.challenge) {
          res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return;
        }
        const idToken = await new SignJWT({ email: stored.email, email_verified: true, name: "OAuth Fixture" })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(`e2e-google-${stored.email}`).setAudience("e2e-google")
          .setIssuer("https://accounts.google.com").setIssuedAt().setExpirationTime("1h").sign(signing.privateKey);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ access_token: "local-access", token_type: "Bearer", expires_in: 3600, id_token: idToken }));
      } else if (url.origin === "https://www.googleapis.com" && url.pathname === "/oauth2/v3/certs") {
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [jwk] }));
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
    if (!["api.resend.com:443", "oauth2.googleapis.com:443", "www.googleapis.com:443"].includes(req.url ?? "")) {
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
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (!URL.canParse(redirect) || !allowedOrigins.has(new URL(redirect).origin) || url.searchParams.get("client_id") !== "e2e-google"
        || !url.searchParams.get("state") || !url.searchParams.get("code_challenge")) { res.writeHead(400).end("{}"); return; }
      const code = randomBytes(24).toString("hex");
      codes.set(code, { redirect, challenge: url.searchParams.get("code_challenge") ?? "", email: url.searchParams.get("fixture_email") ?? "oauth@example.test" });
      const callback = new URL(redirect);
      callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (url.searchParams.get("fixture_mode") === "denial") { callback.searchParams.delete("code"); callback.searchParams.set("error", "access_denied"); codes.delete(code); }
      if (url.searchParams.get("fixture_mode") === "state-mismatch") callback.searchParams.set("state", "tampered-state");
      res.end(JSON.stringify({ location: callback.href })); return;
    }
    res.writeHead(404).end("{}");
  });
  return {
    origin: proxy.origin, certificate: caCert, control: control.origin, allowedOrigins, mail,
    async close() {
      for (const socket of sockets) socket.destroy();
      tls.close();
      await control.close(); await proxy.close();
      if (blocked.size) throw new Error(`Blocked Convex outbound destinations: ${[...blocked].join(", ")}`);
    },
  };
}

/** The slice of the Worker's R2 binding (Miniflare's simulation) that seeding needs. */
type Bucket = {
  list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
  delete(key: string): Promise<void>;
};

/** Deletes one already-uploaded object, leaving its manifest intact, as the missing-object control. */
export async function removeSmokeAsset(bucket: Bucket, organizationId: string, projectId: string) {
  const objects = await bucket.list({ prefix: `tenants/${organizationId}/projects/${projectId}/` });
  const key = objects.objects.find(object => object.key.endsWith("/files/deleted.svg"))?.key;
  if (!key) throw new Error("Seed missing-object control was not uploaded");
  await bucket.delete(key);
}
