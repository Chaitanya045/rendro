import { createApi } from "@convex-dev/better-auth";
import { mutationGeneric, queryGeneric } from "convex/server";
import type { DefaultFunctionArgs, GenericDatabaseReader, GenericDataModel, GenericMutationCtx, GenericQueryCtx, RegisteredMutation, RegisteredQuery } from "convex/server";
import { createAuthOptions } from "../auth";
import schema from "./schema";

const api = createApi(schema, createAuthOptions);
type Where = { field: string; operator?: string; value: unknown };

// The upstream adapter's equality fast path uses db.get(id) without a table.
// Validate in the component (where these IDs live) before delegating, including
// write selectors. Invalid selectors have the same result as absent records.
function normalizeSelector<T extends { model: string; where?: Where[] }>(db: GenericDatabaseReader<GenericDataModel>, selector: T): T {
  return {
    ...selector,
    where: selector.where?.map(clause => {
      if (clause.field !== "_id") return clause;
      const normalize = (value: unknown) => typeof value === "string" ? db.normalizeId(selector.model, value) : null;
      if (!clause.operator || clause.operator === "eq") {
        const id = normalize(clause.value);
        return id ? { ...clause, value: id } : { ...clause, operator: "in", value: [] };
      }
      if (clause.operator === "in" && Array.isArray(clause.value)) {
        return { ...clause, value: clause.value.map(normalize).filter(id => id !== null) };
      }
      return clause;
    }),
  };
}

type Implementation<Ctx, Args, Result> = {
  _handler: (ctx: Ctx, args: Args) => Result;
  exportArgs: () => string;
  exportReturns: () => string;
};

// Re-register the handlers so both Convex runtime invocation and local tests
// use the guard. Preserve the upstream schema-derived argument/return validators.
function guardedQuery<A extends DefaultFunctionArgs & { model: string; where?: Where[] }, R>(original: RegisteredQuery<"public", A, R>) {
  const implementation = original as unknown as Implementation<GenericQueryCtx<GenericDataModel>, A, R>;
  const wrapped = queryGeneric((ctx: GenericQueryCtx<GenericDataModel>, args: A) => implementation._handler(ctx, normalizeSelector(ctx.db, args)));
  return Object.assign(wrapped, { exportArgs: implementation.exportArgs, exportReturns: implementation.exportReturns });
}
function guardedMutation<A extends DefaultFunctionArgs & { input: { model: string; where?: Where[] } }, R>(original: RegisteredMutation<"public", A, R>) {
  const implementation = original as unknown as Implementation<GenericMutationCtx<GenericDataModel>, A, R>;
  const wrapped = mutationGeneric(async (ctx: GenericMutationCtx<GenericDataModel>, args: A) => {
    const input = normalizeSelector(ctx.db, args.input);
    // updateOne throws for missing records; return the adapter's nullable result
    // for invalid IDs, allowing Better Auth to produce its controlled response.
    if (original === api.updateOne && input.where?.some(w => w.field === "_id" && w.operator === "in" && Array.isArray(w.value) && !w.value.length)) return null;
    return await implementation._handler(ctx, { ...args, input });
  });
  return Object.assign(wrapped, { exportArgs: implementation.exportArgs, exportReturns: implementation.exportReturns });
}

export const create = api.create;
export const findOne = guardedQuery(api.findOne);
export const findMany = guardedQuery(api.findMany);
export const updateOne = guardedMutation(api.updateOne);
export const updateMany = guardedMutation(api.updateMany);
export const deleteOne = guardedMutation(api.deleteOne);
export const deleteMany = guardedMutation(api.deleteMany);
