import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";

const app = new Hono();

// The generic session proxy intentionally drops Authorization. Forward the
// operator secret only to the dedicated, secret-gated migration action.
app.post("/api/rendro/migration/project", async (c) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization = c.req.header("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  return fetch(`${CONVEX_SITE_URL}/api/rendro/migration/project`, {
    method: "POST",
    headers,
    body: await c.req.text(),
    redirect: "manual",
  });
});

export default app;
