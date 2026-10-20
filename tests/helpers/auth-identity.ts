import type { TestConvex } from "convex-test";
import type schema from "../../convex/schema";
import authSchema from "../../convex/betterAuth/schema";

export function registerAuth(backend: TestConvex<typeof schema>) {
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../../convex/betterAuth/**/*.ts"));
}
