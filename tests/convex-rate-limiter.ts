import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "../node_modules/@convex-dev/rate-limiter/src/component/schema";

// Same component modules as the package's test helper, without its vite/client
// global declarations (the repository declares ImportMeta.glob itself).
const modules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts");
export default {
  register(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>) {
    t.registerComponent("rateLimiter", schema, modules);
  },
};
