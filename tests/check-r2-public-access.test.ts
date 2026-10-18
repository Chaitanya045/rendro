import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, wranglerBuckets } from "../scripts/check-r2-public-access";

const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token-never-printed" };
const ok = (result: unknown) => Response.json({ success: true, result });

/** Cloudflare answers keyed by bucket name; a function result means a custom response. */
function api(buckets: Record<string, { managed?: unknown; custom?: unknown } | ((url: string) => Response)>) {
  return vi.fn<typeof fetch>((input) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /\/buckets\/([^/]+)\/domains\/(managed|custom)$/.exec(url)!;
    const entry = buckets[decodeURIComponent(match[1]!)]!;
    if (typeof entry === "function") return Promise.resolve(entry(url));
    return Promise.resolve(ok(match[2] === "managed" ? entry.managed : entry.custom));
  });
}
async function run(argv: string[], fetchMock: typeof fetch, settings: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await main(argv, { env, fetch: fetchMock, log: line => lines.push(line), ...settings });
  return { code, lines, text: lines.join("\n") };
}
afterEach(() => vi.restoreAllMocks());

describe("R2 bucket exposure check", () => {
  it("reads every bucket bound in wrangler.toml, once", () => {
    expect(wranglerBuckets(readFileSync("wrangler.toml", "utf8"))).toEqual(["rendro-docs", "dev-rendro"]);
    expect(wranglerBuckets('# bucket_name = "commented"\n[[r2_buckets]]\nbucket_name = "a"\n[[x]]\nbucket_name = "a"\nbucket_name = "b"')).toEqual(["a", "b"]);
  });

  it("passes private buckets, with no r2.dev URL and no custom domain", async () => {
    const fetchMock = api({ "rendro-docs": { managed: { enabled: false, domain: "pub-x.r2.dev" }, custom: { domains: [] } }, "dev-rendro": { managed: { enabled: false }, custom: { domains: [] } } });
    const { code, lines } = await run([], fetchMock);
    expect(code).toBe(0);
    expect(lines).toEqual(["ok   rendro-docs: no r2.dev URL and no custom domain", "ok   dev-rendro: no r2.dev URL and no custom domain"]);
    expect(fetchMock.mock.calls.map(([input]) => (input as string))).toContain("https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/rendro-docs/domains/managed");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer token-never-printed" } });
  });

  it.each([
    ["an enabled r2.dev URL", { managed: { enabled: true }, custom: { domains: [] } }, "r2.dev public URL is enabled"],
    ["an unreadable r2.dev state", { managed: {}, custom: { domains: [] } }, "r2.dev public URL is in an unknown state"],
    ["a null r2.dev state", { managed: null, custom: { domains: [] } }, "r2.dev public URL is in an unknown state"],
    ["a public custom domain", { managed: { enabled: false }, custom: { domains: [{ domain: "files.example.com", enabled: true }] } }, "custom domain files.example.com is attached"],
    ["a disabled custom domain", { managed: { enabled: false }, custom: { domains: [{ domain: "old.example.com", enabled: false }] } }, "custom domain old.example.com is attached (disabled; remove it)"],
    ["an unnamed custom domain", { managed: { enabled: false }, custom: { domains: [{}] } }, "custom domain (unnamed) is attached"],
    ["an unreadable custom domain list", { managed: { enabled: false }, custom: {} }, "custom domains are in an unknown state"],
    ["a null custom domain list", { managed: { enabled: false }, custom: null }, "custom domains are in an unknown state"],
  ])("fails a bucket with %s", async (_name, state, message) => {
    const { code, text } = await run(["--bucket", "rendro-docs"], api({ "rendro-docs": state }));
    expect(code).toBe(1);
    expect(text).toContain(`FAIL rendro-docs: ${message}`);
  });

  it("checks the remaining buckets after one fails, and fails closed when a bucket cannot be verified", async () => {
    const fetchMock = api({
      "rendro-docs": url => url.endsWith("/managed") ? Response.json({ success: false, errors: [{ message: "private token detail" }] }, { status: 403 }) : ok({ domains: [] }),
      "dev-rendro": url => url.endsWith("/managed") ? new Response("not json", { status: 200 }) : ok({ domains: [] }),
      third: { managed: { enabled: false }, custom: { domains: [] } },
    });
    const { code, text } = await run(["--bucket", "rendro-docs", "--bucket", "dev-rendro", "--bucket", "third"], fetchMock);
    expect(code).toBe(1);
    expect(text).toContain("FAIL rendro-docs: could not be verified (Cloudflare API answered 403 for /accounts/acct/r2/buckets/rendro-docs/domains/managed)");
    expect(text).toContain("FAIL dev-rendro: could not be verified (Cloudflare API answered 200");
    expect(text).toContain("ok   third");
    expect(text).not.toContain("private token detail");
    expect(text).not.toContain("token-never-printed");
  });

  it("describes a non-Error failure generically", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a thrown non-Error is the case under test
    const { code, text } = await run(["--bucket", "b"], vi.fn<typeof fetch>(() => Promise.reject("secret-in-a-string")));
    expect(code).toBe(1);
    expect(text).toBe("FAIL b: could not be verified (unknown error)");
  });

  it("encodes bucket names in the request path", async () => {
    const fetchMock = api({ "odd/name": { managed: { enabled: false }, custom: { domains: [] } } });
    expect((await run(["--bucket", "odd/name"], fetchMock)).code).toBe(0);
    expect((fetchMock.mock.calls[0]![0] as string)).toContain("/buckets/odd%2Fname/domains/managed");
  });

  it.each([[{ CLOUDFLARE_ACCOUNT_ID: "acct" }], [{ CLOUDFLARE_API_TOKEN: "t" }], [{}]])("reports itself unconfigured, never as a pass, without credentials %j", async partial => {
    const fetchMock = api({});
    const { code, text } = await run(["--bucket", "b"], fetchMock, { env: partial });
    expect(code).toBe(2);
    expect(text).toContain("was NOT verified");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-runs without credentials or network, listing each request", async () => {
    const fetchMock = api({});
    const { code, lines } = await run(["--dry-run"], fetchMock, { env: {} });
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "GET https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/r2/buckets/rendro-docs/domains/managed",
      "GET https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/r2/buckets/rendro-docs/domains/custom",
      "GET https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/r2/buckets/dev-rendro/domains/managed",
      "GET https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/r2/buckets/dev-rendro/domains/custom",
      "Dry run: no request was made.",
    ]);
    const named = await run(["--dry-run", "--bucket", "only"], fetchMock, { env });
    expect(named.lines[0]).toBe("GET https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/only/domains/managed");
  });

  it("has nothing to check without a bucket", async () => {
    const settings = { wrangler: new URL("fixtures/empty-wrangler.toml", import.meta.url).pathname };
    const { code, text } = await run([], api({}), settings);
    expect(code).toBe(2);
    expect(text).toBe("No R2 bucket to check.");
  });

  it("defaults to the real console, process environment and global fetch", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["--bucket", "b"])).resolves.toBe(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("was NOT verified"));
    vi.unstubAllEnvs();
  });

  it.each([new Error("cannot read"), "cannot read"])("reports an unexpected failure when run as a script", async failure => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [argv[0]!, new URL("../scripts/check-r2-public-access.ts", import.meta.url).pathname];
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a thrown non-Error is one of the cases under test
    vi.doMock("node:fs/promises", () => ({ readFile: vi.fn(() => Promise.reject(failure)) }));
    try {
      vi.resetModules();
      await import("../scripts/check-r2-public-access");
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(error).toHaveBeenCalledWith("cannot read");
    } finally { process.argv = argv; process.exitCode = exitCode; vi.doUnmock("node:fs/promises"); }
  });

  it("sets a zero exit status when run as a script and the bucket is private", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [argv[0]!, new URL("../scripts/check-r2-public-access.ts", import.meta.url).pathname, "--dry-run"];
    process.exitCode = undefined;
    try {
      vi.resetModules();
      await import("../scripts/check-r2-public-access");
      await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith("Dry run: no request was made."));
      await vi.waitFor(() => expect(process.exitCode).toBe(0));
    } finally { process.argv = argv; process.exitCode = exitCode; }
  });

  it("is importable without an executable path", async () => {
    const argv = process.argv;
    process.argv = [argv[0]!];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { vi.resetModules(); await import("../scripts/check-r2-public-access"); } finally { process.argv = argv; }
    expect(log).not.toHaveBeenCalled();
  });
});
