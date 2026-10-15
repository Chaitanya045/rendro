import { assetHeaders } from "@/routes/asset-headers";
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
  // Only a verified signature can establish expiry. All other unavailable
  // links get the same message without revealing document or token history.
  const unavailable = (status: 404 | 410 = 404) => c.html(renderNotFoundPage({
    status,
    path: "/share/…",
    heading: "Share link unavailable",
    message: "This share link is invalid or no longer available. Ask the sender for a new link.",
  }), status);
  if (!result.ok) return unavailable(result.reason === "expired" ? 410 : 404);

  const key = result.key;
  if (await isDeleted(key)) return unavailable();

  try {
    const stream = await getObjectStream(key);
    if (!stream) return unavailable();

    const html = injectMobileViewportScrollbarStyle(await readHtmlStream(stream));
    return c.html(html, 200, assetHeaders(key, false, "text/html"));
  } catch (err) {
    logger.error({ err, key }, "share stream failed");
    return c.text("Stream failed", 500);
  }
});

export default app;
