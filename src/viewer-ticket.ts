import { authCookiePair } from "../shared/auth-cookies";

const sessionTokenPair = authCookiePair("session_token");
const preferencePair = authCookiePair("dont_remember");

/** Session-token pairs under every name Convex reads (current and legacy). */
export function sessionTokenCookie(cookie: string): string {
  return cookie.split(";").map(part => part.trim())
    .filter(part => sessionTokenPair.test(part)).join("; ");
}

export function viewerSessionCookie(cookie: string): string {
  const token = sessionTokenCookie(cookie);
  if (!token) return "";
  // Retain compatibility with existing tickets. Convex derives the lifetime
  // preference from the persisted session, regardless of this client marker.
  // Never forward session_data, unrelated cookies, or bearer API credentials.
  const preference = cookie.split(";").map(part => part.trim())
    .filter(part => preferencePair.test(part));
  return [token, ...preference].join("; ");
}
