import { retryAfterMs } from "./rate-limit";

export async function httpErrorMessage(response: Response): Promise<string> {
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    return `429 Rate limited. ${delay === undefined ? "Wait before retrying." : `Retry after ${Math.ceil(delay / 1000)}s.`}`;
  }
  let message = response.status >= 500 ? "Backend unavailable" : "Request failed";
  if (response.status < 500) {
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
        message = data.error;
      }
    } catch { /* A non-JSON error page is not a useful CLI diagnostic. */ }
  }
  return `${response.status} ${message}`;
}
