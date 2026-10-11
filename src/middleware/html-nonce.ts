import { AsyncLocalStorage } from "node:async_hooks";

export const nonceContext = new AsyncLocalStorage<string>();

/** Only trusted, server-authored script/style tags call this; never rewrite publisher HTML. */
export function nonceAttribute(): string {
  const nonce = nonceContext.getStore();
  return nonce ? ` nonce="${nonce}"` : "";
}

