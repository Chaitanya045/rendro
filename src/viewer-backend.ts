export class ViewerBackendError extends Error {
  readonly unavailable = true;
  constructor(readonly retryAfter = "1") {
    super("Viewer backend unavailable");
  }
}

/** A failed lookup must never look like an authoritative denial or missing row. */
export async function viewerBackendJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          // Keep all existing controlled denials indistinguishable, including
          // expired/revoked public grants. 408 and 429 are retryable failures.
          if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) return null;
          const value = response.headers.get("Retry-After");
          const seconds = value && /^\d+$/.test(value) ? Number(value)
            : value ? Math.ceil((Date.parse(value) - Date.now()) / 1_000) : 1;
          throw new ViewerBackendError(String(Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 1));
        }
        return await response.json() as T | null;
      })(),
      // Include stalled response bodies even when the transport ignores abort.
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new ViewerBackendError()), { once: true });
      }),
    ]);
  } catch (error) {
    throw error instanceof ViewerBackendError ? error : new ViewerBackendError();
  } finally {
    clearTimeout(timeout);
  }
}
