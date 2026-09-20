import { QueryClient, isCancelledError } from "@tanstack/query-core";
import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";

type Requester = (path: string, options?: RequestInit) => Promise<unknown>;
type Identity = { userId: string; origin: string };
export const ORGANIZATIONS_STALE_TIME = Infinity;
const listPath = "/api/auth/organization/list";
const changes = new Set(["create", "update", "delete", "leave", "accept-invitation", "add-member", "remove-member"]);
type OrganizationPersister = Pick<ReturnType<typeof experimental_createQueryPersister>, "persisterFn" | "removeQueries">;
function labels(response: unknown) {
  if (!Array.isArray(response)) throw new Error("Invalid organization list");
  return response.map((value: unknown) => {
    const org = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof org.id !== "string" || typeof org.name !== "string") throw new Error("Invalid organization list");
    return { id: org.id, name: org.name, slug: typeof org.slug === "string" ? org.slug : "" };
  });
}

/** Display data only. This cache must never authorize access to an organization. */
export function createOrganizationListCache(identity: Identity, rawRequest: Requester, changed: () => void = () => {}, persistence?: OrganizationPersister) {
  const client = new QueryClient({ defaultOptions: { queries: {
    // Membership-changing writes and authorization failures are the freshness
    // boundary. Navigation, visibility and reconnects do not refetch this
    // display-only list.
    staleTime: ORGANIZATIONS_STALE_TIME, gcTime: Infinity, retry: false, networkMode: "always",
  } } });
  const key = ["rendro-organization-list", identity.origin, identity.userId] as const;
  async function clear() { client.clear(); await persistence?.removeQueries({ queryKey: key, exact: true }); }
  async function invalidate() { client.removeQueries({ queryKey: key, exact: true }); await persistence?.removeQueries({ queryKey: key, exact: true }); }
  function abort() { return new DOMException("Organization list request aborted", "AbortError"); }
  async function request(path: string, options: RequestInit = {}) {
    const url = new URL(path, identity.origin), method = (options.method || "GET").toUpperCase();
    const sameOrigin = url.origin === identity.origin;
    const mutation = sameOrigin && method !== "GET" && method !== "HEAD" && changes.has(url.pathname.replace(/^\/api\/auth\/organization\//, ""));
    const cacheable = Boolean(identity.userId) && sameOrigin && url.pathname === listPath && !url.search && method === "GET";
    if (options.signal?.aborted) throw abort();
    if (mutation) { await invalidate(); changed(); }
    try {
      if (!cacheable) return await rawRequest(path, options);
      const query = client.getQueryCache().build(client, { queryKey: key });
      const queryOptions = { queryKey: key, queryFn: async ({ signal }: { signal: AbortSignal }) => {
        // A menu closing cancels its consumer, not a shared read used by the chooser.
        const response = await rawRequest(path, { ...options, cache: "no-store", signal });
        return labels(response);
      } };
      if (persistence) Object.assign(queryOptions, { persister: persistence.persisterFn });
      const data = await client.fetchQuery(queryOptions);
      if (options.signal?.aborted) throw abort();
      if (!Object.is(client.getQueryCache().find({ queryKey: key, exact: true }), query)) throw new Error("Organizations changed. Please try again.");
      return structuredClone(data);
    } catch (error) {
      if ((error as { status?: number })?.status === 401 || (error as { status?: number })?.status === 403) await clear();
      if (options.signal?.aborted) throw abort();
      if (isCancelledError(error)) throw new Error("Organizations changed. Please try again.", { cause: error });
      throw error;
    } finally {
      // Remove pre-write reads even if a request fails after the server commits.
      if (mutation) { await invalidate(); changed(); }
    }
  }
  return { request, clear, invalidate };
}

export function installOrganizationListCache(identity: Identity, rawRequest: Requester) {
  let channel: BroadcastChannel | undefined;
  function broadcast(kind: "invalidate" | "clear") { try { channel?.postMessage({ userId: identity.userId, kind }); } catch { /* Cross-tab delivery is best effort. */ } }
  let storage;
  try {
    storage = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
      removeItem: (key: string) => sessionStorage.removeItem(key),
      entries: () => {
        const result: Array<[string, string]> = [];
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index), value = key && sessionStorage.getItem(key);
          if (key && value !== null) result.push([key, value]);
        }
        return result;
      },
    };
    const probe = "rendro-org-cache-probe"; storage.setItem(probe, probe); storage.removeItem(probe);
  } catch { storage = undefined; }
  const persistence = experimental_createQueryPersister({
    storage,
    buster: "rendro-organization-list-v1",
    maxAge: Infinity,
    prefix: "rendro-organization-list-" + encodeURIComponent(identity.userId),
    refetchOnRestore: false,
  });
  const cache = createOrganizationListCache(identity, rawRequest, () => broadcast("invalidate"), persistence);
  if (typeof BroadcastChannel !== "undefined") try {
    channel = new BroadcastChannel("rendro-organization-list");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
      if (data.userId !== identity.userId) return;
      if (data.kind === "invalidate") void cache.invalidate();
      if (data.kind === "clear") void cache.clear();
    };
  } catch { /* Restricted browsers still retain local caching and invalidation. */ }
  document.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (link?.origin === identity.origin && link.pathname === "/api/auth/sign-out") { void cache.clear(); broadcast("clear"); }
  }, true);
  return cache.request;
}
