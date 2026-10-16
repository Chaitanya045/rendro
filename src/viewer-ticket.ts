import { legacyStoragePrefix, modernStoragePrefix } from "@/storage-boundary";
import { EncryptJWT, jwtDecrypt } from "jose";
import { AUTH_SECRET } from "@/config";

export const VIEWER_TICKET_SECONDS = 15 * 60;
const audience = "rendro:private-document-viewer:v1";
export interface ViewerScope {
  organizationId: string;
  projectId: string;
  manifestKey: string;
}
interface ViewerTicket extends ViewerScope { cookie: string }

export function sessionTokenCookie(cookie: string): string {
  return cookie.split(";").map(part => part.trim())
    .filter(part => /^(?:__Secure-)?better-auth\.session_token=.+$/.test(part)).join("; ");
}

export function viewerSessionCookie(cookie: string): string {
  const token = sessionTokenCookie(cookie);
  if (!token) return "";
  // Retain compatibility with existing tickets. Convex derives the lifetime
  // preference from the persisted session, regardless of this client marker.
  // Never forward session_data, unrelated cookies, or bearer API credentials.
  const preference = cookie.split(";").map(part => part.trim())
    .filter(part => /^(?:__Secure-)?better-auth\.dont_remember=.+$/.test(part));
  return [token, ...preference].join("; ");
}

async function ticketKey(domain = audience): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${domain}:${AUTH_SECRET}`),
  ));
}

export async function createViewerTicket(input: ViewerTicket): Promise<string> {
  const cookie = viewerSessionCookie(input.cookie);
  if (!cookie) throw new Error("Viewer session required");
  if (!modernStoragePrefix(input)) throw new Error("Invalid viewer storage scope");
  return new EncryptJWT({ ...input, cookie })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(audience).setIssuedAt().setExpirationTime(`${VIEWER_TICKET_SECONDS}s`)
    .encrypt(await ticketKey());
}

export async function readViewerTicket(
  token: string, scope: Pick<ViewerScope, "organizationId" | "projectId">,
): Promise<ViewerTicket | null> {
  try {
    const { payload } = await jwtDecrypt(token, await ticketKey(), {
      audience, keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
      requiredClaims: ["exp", "iat"], maxTokenAge: VIEWER_TICKET_SECONDS,
    });
    if (payload.organizationId !== scope.organizationId || payload.projectId !== scope.projectId
      || typeof payload.manifestKey !== "string" || !payload.manifestKey
      || typeof payload.cookie !== "string" || !payload.cookie
      || viewerSessionCookie(payload.cookie) !== payload.cookie) return null;
    const ticket = { ...scope, manifestKey: payload.manifestKey, cookie: payload.cookie };
    return modernStoragePrefix(ticket) ? ticket : null;
  } catch { return null; }
}

// A separate audience/key prevents legacy capabilities from authorizing v2 reads.
const legacyAudience = "rendro:legacy-document-viewer:v1";
export async function createLegacyViewerTicket(orgSlug: string, sessionCookie: string): Promise<string> {
  const cookie = viewerSessionCookie(sessionCookie);
  if (!cookie) throw new Error("Viewer session required");
  const storagePrefix = legacyStoragePrefix(orgSlug);
  if (!storagePrefix) throw new Error("Invalid legacy storage scope");
  return new EncryptJWT({ orgSlug, storagePrefix, cookie }).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(legacyAudience).setIssuedAt().setExpirationTime(`${VIEWER_TICKET_SECONDS}s`)
    .encrypt(await ticketKey(legacyAudience));
}
export async function readLegacyViewerTicket(token: string, orgSlug: string): Promise<{ cookie: string; storagePrefix: string } | null> {
  try {
    const { payload } = await jwtDecrypt(token, await ticketKey(legacyAudience), {
      audience: legacyAudience, keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
      requiredClaims: ["exp", "iat"], maxTokenAge: VIEWER_TICKET_SECONDS,
    });
    const storagePrefix = legacyStoragePrefix(orgSlug);
    return storagePrefix && payload.storagePrefix === storagePrefix && payload.orgSlug === orgSlug && typeof payload.cookie === "string" && payload.cookie
      && viewerSessionCookie(payload.cookie) === payload.cookie ? { cookie: payload.cookie, storagePrefix } : null;
  } catch { return null; }
}
