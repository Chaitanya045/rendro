import { expect, it } from "vitest";
import { validateEndpoint } from "../cli/src/endpoint";

it.each([
  "https://rendro.app", "https://rendro.app/", "https://docs.example.com:8443/base", "HTTPS://Rendro.App",
  "http://localhost", "http://localhost:3000", "http://LOCALHOST:8787/", "http://127.0.0.1:8787", "http://[::1]:8787/",
])("accepts %s unchanged", endpoint => {
  expect(validateEndpoint(endpoint)).toBe(endpoint);
});

it.each([
  "http://rendro.app", "http://example.com:80", "http://10.0.0.5:3000", "http://192.168.1.2", "http://127.0.0.2", "http://localhost.example.com",
  "http://127.0.0.1.example.com", "http://[::2]/", "http://0.0.0.0:3000", "http://user:secret@evil.example/", "http://localhost@evil.example/",
  "ftp://rendro.app", "file:///etc/passwd", "ws://localhost:3000", "javascript:alert(1)",
])("rejects %s without echoing credentials", endpoint => {
  let message = "";
  try { validateEndpoint(endpoint); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/^Refusing endpoint /);
  expect(message).toContain("https://");
  expect(message).not.toContain("secret");
});

it.each(["", "rendro.app", "//rendro.app", "https://", "http://[::1", "http://user:secret@"])("rejects the unparseable endpoint %j", endpoint => {
  expect(() => validateEndpoint(endpoint)).toThrow("Invalid --endpoint: expected an https:// URL");
});
