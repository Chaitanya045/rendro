import { CONVEX_INTERNAL_SECRET } from "@/config";
import { signAuthClientIp } from "../shared/auth-client-ip";

const clientIps = new WeakMap<Request, string>();

/** Register ingress metadata, never arbitrary headers from the Node server. */
export function registerAuthClientIp(request: Request, ip: string | undefined): void {
  if (ip) clientIps.set(request, ip);
}

export function authClientIpHeaders(request: Request, target: string, method = request.method): Promise<Headers> {
  return signAuthClientIp(new Request(target, { method }), clientIps.get(request), CONVEX_INTERNAL_SECRET);
}
