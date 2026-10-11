import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import betterAuth from "./betterAuth/convex.config";

const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);

export default app;
