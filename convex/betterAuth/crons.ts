import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire session read windows", { minutes: 5 }, internal.sessionReadLimit.cleanup, {});
export default crons;
