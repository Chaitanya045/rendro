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

export function viewerSessionCookie(cookie: string): string {
  // Never forward/cache session_data, other cookies, or bearer API credentials.
  return cookie.split(";").map(part => part.trim())
    .filter(part => /^(?:__Secure-)?better-auth\.session_token=.+$/.test(part)).join("; ");
}

async function ticketKey(): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${audience}:${AUTH_SECRET}`),
  ));
}

export async function createViewerTicket(input: ViewerTicket): Promise<string> {
  const cookie = viewerSessionCookie(input.cookie);
  if (!cookie) throw new Error("Viewer session required");
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
    return { ...scope, manifestKey: payload.manifestKey, cookie: payload.cookie };
  } catch { return null; }
}
