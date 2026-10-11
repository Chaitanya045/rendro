import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire comment status receipts", { hours: 24 }, internal.documentThreads.cleanupStatusReceipts, {});
crons.interval("expire legacy comment status receipts", { hours: 24 }, internal.threads.cleanupStatusReceipts, {});
export default crons;
