// Convex database adapter for better-auth, usable from Workers (no HTTP proxy needed).
// Uses ConvexClient to call the component's adapter CRUD functions.

import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { CONVEX_URL } from "./config";
import type { BetterAuthOptions } from "better-auth";

let _client: ConvexClient | null = null;
function client(): ConvexClient {
  if (!_client) _client = new ConvexClient(CONVEX_URL);
  return _client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convexAuthAdapter(): BetterAuthOptions["database"] {
  const c = client();
  return {
    id: "convex",
    type: "custom",
    async create(data: { model: string; data: Record<string, unknown> }): Promise<Record<string, unknown>> {
      return (await c.mutation(api.betterAuth.adapter.create as any, {
        input: { model: data.model, data: data.data },
      })) as Record<string, unknown>;
    },
    async findOne(query: { model: string; where: Array<{ field: string; value: unknown; operator?: string }>; select?: string[] }) {
      return c.query(api.betterAuth.adapter.findOne as any, {
        model: query.model,
        where: query.where,
        select: query.select,
      }) as Promise<Record<string, unknown> | null>;
    },
    async findMany(query: { model: string; where?: Array<{ field: string; value: unknown; operator?: string }>; limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } }) {
      return c.query(api.betterAuth.adapter.findMany as any, {
        model: query.model,
        where: query.where,
        limit: query.limit,
        offset: query.offset,
        sortBy: query.sortBy,
      }) as Promise<Record<string, unknown>[]>;
    },
    async updateOne(data: { model: string; where: Array<{ field: string; value: unknown; operator?: string }>; update: Record<string, unknown> }) {
      return (await c.mutation(api.betterAuth.adapter.updateOne as any, {
        input: { model: data.model, where: data.where, update: data.update },
      })) as Record<string, unknown> | null;
    },
    async updateMany(data: { model: string; where: Array<{ field: string; value: unknown; operator?: string }>; update: Record<string, unknown> }) {
      return (await c.mutation(api.betterAuth.adapter.updateMany as any, {
        input: { model: data.model, where: data.where, update: data.update },
      })) as number;
    },
    async deleteOne(data: { model: string; where: Array<{ field: string; value: unknown; operator?: string }> }) {
      return (await c.mutation(api.betterAuth.adapter.deleteOne as any, {
        input: { model: data.model, where: data.where },
      })) as Record<string, unknown> | null;
    },
    async deleteMany(data: { model: string; where: Array<{ field: string; value: unknown; operator?: string }> }) {
      return (await c.mutation(api.betterAuth.adapter.deleteMany as any, {
        input: { model: data.model, where: data.where },
      })) as number;
    },
    async count(query: { model: string; where?: Array<{ field: string; value: unknown; operator?: string }> }) {
      const result = await c.query(api.betterAuth.adapter.findMany as any, {
        model: query.model,
        where: query.where,
        limit: 0,
      });
      return (result as unknown[]).length;
    },
  } as any;
}
