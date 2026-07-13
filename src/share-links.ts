import { createHmac, timingSafeEqual } from "node:crypto";
import { AUTH_SECRET } from "@/config";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SharePayload {
  k: string;
  e: number;
}

export type ShareTokenResult =
  | { ok: true; key: string; expiresAt: number }
  | { ok: false; status: 403 | 410; reason: "invalid" | "expired" };

function base64UrlEncode(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeDocPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function isShareableDocKey(key: string): boolean {
  return key.endsWith(".html") && !key.includes("..") && !key.includes("\\") && !key.includes("\0");
}

export function createShareToken(key: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!isShareableDocKey(key)) throw new Error("Invalid share key");
  const payload = base64UrlEncode(JSON.stringify({ k: key, e: nowSeconds + SHARE_TTL_SECONDS } satisfies SharePayload));
  return `${payload}.${sign(payload)}`;
}

export function createShareUrl(origin: string, key: string, nowSeconds?: number): string {
  return `${origin}/share/${createShareToken(key, nowSeconds)}#${encodeDocPath(key)}`;
}

export function verifyShareToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): ShareTokenResult {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { ok: false, status: 403, reason: "invalid" };
  if (!safeEqual(signature, sign(payload))) return { ok: false, status: 403, reason: "invalid" };

  const decoded = base64UrlDecode(payload);
  if (!decoded) return { ok: false, status: 403, reason: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, status: 403, reason: "invalid" };
  }

  if (!parsed || typeof parsed !== "object") return { ok: false, status: 403, reason: "invalid" };
  const payloadObject = parsed as Partial<SharePayload>;
  if (typeof payloadObject.k !== "string" || typeof payloadObject.e !== "number") {
    return { ok: false, status: 403, reason: "invalid" };
  }
  if (!isShareableDocKey(payloadObject.k)) {
    return { ok: false, status: 403, reason: "invalid" };
  }
  if (!Number.isSafeInteger(payloadObject.e) || payloadObject.e < nowSeconds) {
    return { ok: false, status: 410, reason: "expired" };
  }

  return { ok: true, key: payloadObject.k, expiresAt: payloadObject.e };
}
