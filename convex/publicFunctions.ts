import { v } from "convex/values";
import type { ObjectType, PropertyValidators, Validator } from "convex/values";
import { query as registerQuery, mutation as registerMutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { publicError } from "./publicErrors";

// Convex's native argument validator runs before the handler and includes input
// and schema diagnostics on dev deployments. Validate public RPC arguments here
// instead, using the same schema and inferred API types, with a safe rejection.
// IDs remain strings; each handler normalizes them after authentication.
function matches(schema: Validator<unknown, "required" | "optional", string>, value: unknown): boolean {
  switch (schema.kind) {
    case "string": return typeof value === "string";
    case "float64": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "literal": return value === schema.value;
    case "array": return Array.isArray(value) && value.every(item => matches(schema.element, item));
    case "union": return schema.members.some((member: Validator<unknown, "required" | "optional", string>) => matches(member, value));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = value as Record<string, unknown>;
      return Object.keys(fields).every(key => Object.hasOwn(schema.fields, key))
        && Object.entries(schema.fields as Record<string, Validator<unknown, "required" | "optional", string>>).every(([key, field]) =>
          (field.isOptional === "optional" && fields[key] === undefined) || matches(field, fields[key]));
    }
    // Unsupported schema kinds are programming errors, never client failures.
    default: throw new Error("Unsupported public argument validator");
  }
}

function argumentsValidator<A extends PropertyValidators>(args: A) {
  const schema = v.object(args);
  return (input: ObjectType<A>) => {
    if (!matches(schema, input)) publicError("invalid_input");
    return input;
  };
}

export function query<A extends PropertyValidators, R>(definition: {
  args: A; handler: (ctx: QueryCtx, args: ObjectType<A>) => R;
}) {
  const validate = argumentsValidator(definition.args);
  return registerQuery({
    args: v.any() as Validator<ObjectType<A>, "required", string>,
    handler: (ctx, args) => definition.handler(ctx, validate(args)),
  });
}

export function mutation<A extends PropertyValidators, R>(definition: {
  args: A; handler: (ctx: MutationCtx, args: ObjectType<A>) => R;
}) {
  const validate = argumentsValidator(definition.args);
  return registerMutation({
    args: v.any() as Validator<ObjectType<A>, "required", string>,
    handler: (ctx, args) => definition.handler(ctx, validate(args)),
  });
}
