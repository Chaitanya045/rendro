const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API key travels in a bearer header, so only https:// (or loopback http://) is accepted. */
export function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Do not echo the value: it may embed credentials.
    throw new Error("Invalid --endpoint: expected an https:// URL");
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname))) return value;
  throw new Error(
    `Refusing endpoint ${url.protocol}//${url.host}: API keys must not be sent over plaintext or unsupported schemes. `
    + "Use https://, or http:// only for localhost, 127.0.0.1 or [::1].",
  );
}
