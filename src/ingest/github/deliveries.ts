import { retryAfterMs } from "../../../shared/retry-after";
import { readBytes } from "./http-source";
import { GitHubError } from "./source";

/** One attempt to deliver a webhook. Redeliveries share the `guid` (X-GitHub-Delivery) of the original. */
export interface WebhookDelivery {
  id: number;
  guid: string;
  deliveredAt: number;
  statusCode: number;
}

/** GitHub App webhook deliveries. GitHub never retries a failed delivery itself; redelivery reaches back three days. */
export interface WebhookDeliveries {
  /** Newest first, one page per call. */
  list(cursor: string | null): Promise<{ deliveries: WebhookDelivery[]; next: string | null }>;
  redeliver(id: number): Promise<void>;
}

/** Signs app JWTs (RS256 with the app's private key): `appJwtSigner` (#338). */
export interface AppJwtProvider {
  jwt(): Promise<string>;
}

export class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured`);
    this.name = "NotConfiguredError";
  }
}

/** Until P1 creates the GitHub App there is nothing to redeliver. */
export const unconfiguredDeliveries: WebhookDeliveries = {
  list: () => Promise.reject(new NotConfiguredError("GitHub App webhook delivery access")),
  redeliver: () => Promise.reject(new NotConfiguredError("GitHub App webhook delivery access")),
};

const MAX_PAGE_BYTES = 1024 * 1024;

export class HttpWebhookDeliveries implements WebhookDeliveries {
  private readonly fetcher: typeof fetch;
  private readonly apiOrigin: string;
  private readonly now: () => number;

  constructor(private readonly app: AppJwtProvider, options: { fetch?: typeof fetch; apiOrigin?: string; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com").origin;
    this.now = options.now ?? Date.now;
  }

  async list(cursor: string | null): Promise<{ deliveries: WebhookDelivery[]; next: string | null }> {
    const url = new URL("/app/hook/deliveries", this.apiOrigin);
    url.searchParams.set("per_page", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await this.send(url.href, "GET");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBytes(response, MAX_PAGE_BYTES)));
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      body = null;
    }
    if (!Array.isArray(body)) throw new GitHubError("invalid-response", "Unexpected deliveries response", response.status);
    const deliveries = body.flatMap((raw: { id?: unknown; guid?: unknown; delivered_at?: unknown; status_code?: unknown } | null) => {
      const deliveredAt = typeof raw?.delivered_at === "string" ? Date.parse(raw.delivered_at) : NaN;
      if (!raw || !Number.isSafeInteger(raw.id) || typeof raw.guid !== "string" || !Number.isFinite(deliveredAt)) return [];
      // A timed-out attempt has no HTTP status; it counts as a failure.
      const statusCode = Number.isSafeInteger(raw.status_code) ? raw.status_code as number : 0;
      return [{ id: raw.id as number, guid: raw.guid, deliveredAt, statusCode }];
    });
    return { deliveries, next: nextCursor(response.headers.get("link")) };
  }

  async redeliver(id: number): Promise<void> {
    const response = await this.send(`${this.apiOrigin}/app/hook/deliveries/${id}/attempts`, "POST");
    await response.body?.cancel();
  }

  private async send(url: string, method: string): Promise<Response> {
    const response = await this.fetcher(url, {
      method,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await this.app.jwt()}`, "user-agent": "rendro-ingest", "x-github-api-version": "2022-11-28" },
    });
    if (response.ok) return response;
    await response.body?.cancel();
    const { status } = response;
    if (status === 403 || status === 429) {
      const now = this.now();
      const retryAfter = retryAfterMs(response.headers.get("retry-after"), now);
      throw new GitHubError("rate-limited", "GitHub rate limit", status, now + (retryAfter || 60_000));
    }
    if (status === 404) throw new GitHubError("not-found", "Delivery not found", status);
    throw new GitHubError(status >= 500 ? "server" : "invalid-response", "Unexpected deliveries response", status);
  }
}

/** The `cursor` of the Link header's rel="next" URL. */
export function nextCursor(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) {
      try {
        return new URL(match[1]).searchParams.get("cursor");
      } catch {
        return null;
      }
    }
  }
  return null;
}
