import { legacyOrganization, legacyUnavailable } from "@/legacy-access";
import { assetHeaders } from "@/routes/asset-headers";
import { Hono } from "hono";
import { getObjectStream } from "@/minio";
import { isDeleted } from "@/soft-delete";
import { verifyShareToken } from "@/share-links";
import { logger } from "@/logger";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectMobileViewportScrollbarStyle, readHtmlStream } from "@/routes/document-html";

const app = new Hono();
app.onError(legacyUnavailable);

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
  if (!await legacyOrganization(key.split("/")[0])) return unavailable();
  if (await isDeleted(key)) return unavailable();

  try {
    const stream = await getObjectStream(key);
    if (!stream) return unavailable();

    // The whole document is decoded as UTF-8 and re-encoded by c.html.
    const html = injectMobileViewportScrollbarStyle(await readHtmlStream(stream));
    return c.html(html, 200, assetHeaders(key, false, "text/html; charset=utf-8"));
  } catch (err) {
    logger.error({ err, key }, "share stream failed");
    return legacyUnavailable(new Error("Storage unavailable"), c);
  }
});

export default app;
