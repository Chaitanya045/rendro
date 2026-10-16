import type { Context, Env, Input } from "hono";
import { routePath } from "hono/route";

/** Only application-authored route templates enter logs, never request URLs.
 * Wildcards and unmatched routes deliberately reveal no path/query suffix. */
export function requestLogPath<E extends Env, P extends string, I extends Input>(context: Context<E, P, I>): string {
  return routePath(context) || "[unmatched]";
}
