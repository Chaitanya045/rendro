import { Hono } from "hono";
import { getObjectStream } from "@/minio";
import { isDeleted } from "@/soft-delete";
import { verifyShareToken } from "@/share-links";
import { logger } from "@/logger";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectMobileViewportScrollbarStyle, readHtmlStream } from "@/routes/document-html";

const app = new Hono();

app.get("/share/:token", async (c) => {
  const token = c.req.param("token");
  const result = verifyShareToken(token);
  if (!result.ok) {
    return c.text(result.reason === "expired" ? "Share link expired" : "Invalid share link", result.status);
  }

  const key = result.key;
  if (await isDeleted(key)) return c.html(renderNotFoundPage({ path: c.req.path }), 404);

  try {
    const stream = await getObjectStream(key);
    if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);

    const html = injectMobileViewportScrollbarStyle(await readHtmlStream(stream));
    return c.html(html);
  } catch (err) {
    logger.error({ err, key }, "share stream failed");
    return c.text("Stream failed", 500);
  }
});

export default app;
