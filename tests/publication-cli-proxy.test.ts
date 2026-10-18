import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/storage", () => ({ getObjectText: vi.fn() }));
import app from "../src/routes/publication-api";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ publications: [] }))));
});

it("preserves CLI bearer identity and encoded project query when listing publications", async () => {
  const query = "?organizationId=org%2Fqa&projectId=project";
  const response = await app.request(`/api/rendro/publications${query}`, { headers: { Authorization: "Bearer disposable-test-key" } });
  expect(response.status).toBe(200);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe(`http://127.0.0.1:3211/api/rendro/publications${query}`);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer disposable-test-key");
  expect(init?.redirect).toBe("manual");
});

it("preserves CLI bearer identity and complete project/publication removal identity", async () => {
  const body = JSON.stringify({ organizationId: "org", projectId: "project", publicationId: "publication" });
  await app.request("/api/rendro/publications/remove", { method: "POST", headers: { Authorization: "Bearer disposable-test-key", "Content-Type": "application/json" }, body });
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe("http://127.0.0.1:3211/api/rendro/publications/remove");
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe(body);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer disposable-test-key");
});

it("retains browser session credentials without inventing a CLI authorization header", async () => {
  await app.request("/api/rendro/publications?organizationId=org&projectId=project", { headers: { cookie: "better-auth.session_token=disposable-session" } });
  const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
  expect(headers.get("cookie")).toBe("better-auth.session_token=disposable-session");
  expect(headers.has("authorization")).toBe(false);
});

it.each([401, 403])("does not turn upstream authorization rejection %i into success", async status => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Not authorized" }, { status }));
  const response = await app.request("/api/rendro/publications?organizationId=org&projectId=project");
  expect(response.status).toBe(status);
});

it.each(["application/json; charset=utf-8", "text/plain", null])("preserves browser admission headers and original content type %s", async contentType => {
  const source = new Headers({ origin: "https://rendro.test", "sec-fetch-site": "same-site", cookie: "session=test" });
  if (contentType) source.set("content-type", contentType);
  // A byte body avoids Request automatically inserting text/plain.
  await app.request("/api/rendro/publications/remove", { method: "POST", headers: source, body: new TextEncoder().encode("{}") });
  const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
  expect(headers.get("origin")).toBe("https://rendro.test");
  expect(headers.get("sec-fetch-site")).toBe("same-site");
  expect(headers.get("content-type")).toBe(contentType);
});
