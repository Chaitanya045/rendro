import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire inactive admission buckets", { hours: 1 }, internal.admissionBuckets.cleanup, {});
export default crons;
