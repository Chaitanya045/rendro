import { httpRouter } from "convex/server";
import { authComponent } from "./auth";
import { createAuthOptions } from "./auth";
import { betterAuth } from "better-auth/minimal";
import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { convex } from "@convex-dev/better-auth/plugins";

const http = httpRouter();

authComponent.registerRoutesLazy(http, (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    ...createAuthOptions(ctx),
    plugins: [convex({ authConfig })],
  });
});

export default http;
