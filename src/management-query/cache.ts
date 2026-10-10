import { QueryClient, isCancelledError } from "@tanstack/query-core";

type Requester = (path: string, options?: RequestInit) => Promise<unknown>;
export interface CacheIdentity { userId: string; organizationId: string; origin: string }
export const MANAGEMENT_STALE_TIME = 30_000;
export const MANAGEMENT_GC_TIME = 5 * 60_000;
export interface MutationImpact { organizationId: string; resource: "all" | "projects" | "publications" | "none"; projectId?: string }

export function mutationImpact(path: string, options: RequestInit, identity: CacheIdentity): MutationImpact {
  const impact: MutationImpact = { organizationId: identity.organizationId, resource: "all" };
  try {
    const url = new URL(path, identity.origin);
    if (url.origin !== identity.origin) return impact;
    const body: unknown = typeof options.body === "string" ? JSON.parse(options.body) : null;
    const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (data.organizationId && data.organizationId !== identity.organizationId) return impact;
    if (["/api/rendro/credentials", "/api/rendro/credentials/revoke", "/api/rendro/shares/revoke"].includes(url.pathname)) impact.resource = "none";
    else if (url.pathname === "/api/rendro/projects") impact.resource = "projects";
    else if (["/api/rendro/publications", "/api/rendro/publications/remove"].includes(url.pathname)) {
      impact.resource = "publications";
      if (typeof data.projectId === "string" && data.projectId) impact.projectId = data.projectId;
    }
  } catch { /* Unknown writes invalidate conservatively, never skip them. */ }
  return impact;
}

// Opt in endpoints, not whole API prefixes. Never retain roles, credentials,
// invitation data, share tokens, documents or mutation responses.
const endpoints = new Map([
  ["/api/rendro/projects", false],
  ["/api/rendro/projects/get", true],
  ["/api/rendro/deployments", true],
  ["/api/rendro/publications", true],
]);

export function managementQueryKey(path: string, identity: CacheIdentity) {
  try {
    const url = new URL(path, identity.origin);
    if (!identity.userId || !identity.organizationId || url.origin !== identity.origin || !endpoints.has(url.pathname)) return null;
    const params = url.searchParams;
    if (Array.from(params.keys()).some((key) => key !== "organizationId" && key !== "projectId")) return null;
    if (params.getAll("organizationId").length !== 1 || params.get("organizationId") !== identity.organizationId) return null;
    if (params.getAll("projectId").length > 1 || (endpoints.get(url.pathname) && !params.get("projectId"))) return null;
    if (!endpoints.get(url.pathname) && params.has("projectId")) return null;
    return ["rendro-management", identity.userId, identity.organizationId, url.pathname, params.get("projectId") || ""] as const;
  } catch { return null; }
}

export function createManagementQueryCache(identity: CacheIdentity, rawRequest: Requester) {
  const client = new QueryClient({ defaultOptions: { queries: {
    staleTime: MANAGEMENT_STALE_TIME,
    gcTime: MANAGEMENT_GC_TIME,
    retry: false,
    // Preserve the existing immediate offline error/retry UI; don't hang a
    // navigation waiting for the network manager to resume an unobserved query.
    networkMode: "always",
  } } });
  function clear() { client.clear(); }
  function abortError() { return new DOMException("Page navigation aborted", "AbortError"); }
  async function request(path: string, options: RequestInit, authorize: () => Promise<void>) {
    const key = managementQueryKey(path, identity);
    if (!key) return rawRequest(path, options);
    if (options.signal?.aborted) throw abortError();
    const query = client.getQueryCache().build(client, { queryKey: key });
    const hasRetainedData = query.state.data !== undefined;
    const cancel = () => { void client.cancelQueries({ queryKey: key, exact: true }); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      // TanStack alone decides freshness and fetching. Previously retained data
      // additionally needs fresh authorization, in parallel with any refetch.
      const [data] = await Promise.all([
        client.fetchQuery({ queryKey: key, queryFn: ({ signal }) => rawRequest(path, { ...options, signal }) }),
        hasRetainedData ? authorize().catch((error: unknown) => { clear(); throw error; }) : undefined,
      ]);
      if (options.signal?.aborted) throw abortError();
      // Native removal cancels in-flight work. The identity check also fences
      // an already-resolved cached promise awaiting its authorization check.
      if (!Object.is(client.getQueryCache().find({ queryKey: key, exact: true }), query)) throw abortError();
      // Route controllers may sort/splice their local data; never allow that
      // to mutate a different screen's cached response.
      return structuredClone(data);
    } catch (error) {
      if (isCancelledError(error) || options.signal?.aborted) throw abortError();
      if ((error as { status?: number })?.status === 401 || (error as { status?: number })?.status === 403) clear();
      throw error;
    } finally { options.signal?.removeEventListener("abort", cancel); }
  }
  // Resuming visibility must not abort a page's initial request. Mark completed
  // data stale, but leave an already-running server read and its UI intact.
  function invalidate() { void client.invalidateQueries({ refetchType: "none" }); }
  function applyImpact(impact: MutationImpact) {
    if (!impact || impact.organizationId !== identity.organizationId || !["all", "projects", "publications", "none"].includes(impact.resource)) return;
    if (impact.resource === "none") return;
    // Remove only affected native queries, canceling pre-write reads as well.
    // No custom cache storage, timestamps, eviction loop or generation counter.
    client.removeQueries({ predicate: (query) => {
      const key = query.queryKey;
      if (impact.resource === "all") return true;
      if (impact.resource === "projects") return key[3] === "/api/rendro/projects";
      return key[3] === "/api/rendro/publications" && (!impact.projectId || key[4] === impact.projectId);
    } });
  }
  function invalidateMutation(path: string, options: RequestInit) { const impact = mutationImpact(path, options, identity); applyImpact(impact); return impact; }
  return { request, clear, invalidate, invalidateMutation, applyImpact, canCache: (path: string) => Boolean(managementQueryKey(path, identity)) };
}
