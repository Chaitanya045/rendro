import { Hono, type Context } from "hono";
import type { User } from "better-auth/types";
import { validateApiKey } from "@/api-keys";
import { emailToOrgSlug } from "@/orgs";
import {
  listPublications,
  PublicationError,
  removePublication,
  savePublication,
  type Publication,
} from "@/publications";

const app = new Hono<{ Variables: { user?: User } }>();

async function authenticatedOrg(c: Context<{ Variables: { user?: User } }>): Promise<string | null> {
  const authorization = c.req.header("Authorization");
  if (authorization !== undefined) {
    if (!authorization.startsWith("Bearer ")) return null;
    return validateApiKey(authorization.slice("Bearer ".length));
  }
  const user = c.get("user");
  return user ? emailToOrgSlug(user.email) : null;
}

function publicUrl(c: Context, publication: Publication): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/public/${encodeURIComponent(publication.orgSlug)}/${encodeURIComponent(publication.slug)}`;
}

function serialize(c: Context, publication: Publication, documentCount?: number) {
  return {
    ...publication,
    url: publicUrl(c, publication),
    ...(documentCount === undefined ? {} : { documentCount }),
  };
}

app.get("/api/publications", async (c) => {
  const orgSlug = await authenticatedOrg(c);
  if (!orgSlug) return c.text("Unauthorized", 401);
  const publications = await listPublications(orgSlug);
  return c.json({ publications: publications.map((publication) => serialize(c, publication)) });
});

app.post("/api/publications", async (c) => {
  const orgSlug = await authenticatedOrg(c);
  if (!orgSlug) return c.text("Unauthorized", 401);

  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.text("Invalid JSON", 400);
  }
  if (!body || typeof body !== "object") return c.text("Invalid publication", 400);
  const input = body as Record<string, unknown>;
  if (
    typeof input.slug !== "string" ||
    typeof input.sourcePrefix !== "string" ||
    typeof input.entryFile !== "string" ||
    (input.title !== undefined && typeof input.title !== "string")
  ) {
    return c.text("slug, sourcePrefix, and entryFile are required", 400);
  }

  try {
    const result = await savePublication({
      orgSlug,
      slug: input.slug,
      sourcePrefix: input.sourcePrefix,
      entryFile: input.entryFile,
      title: input.title,
    });
    return c.json(serialize(c, result.publication, result.documentCount));
  } catch (error) {
    if (error instanceof PublicationError) return c.text(error.message, error.status);
    throw error;
  }
});

app.delete("/api/publications/:slug", async (c) => {
  const orgSlug = await authenticatedOrg(c);
  if (!orgSlug) return c.text("Unauthorized", 401);
  const removed = await removePublication(orgSlug, c.req.param("slug"));
  if (!removed) return c.text("Publication not found", 404);
  return c.json({ unpublished: true, slug: c.req.param("slug") });
});

export default app;
