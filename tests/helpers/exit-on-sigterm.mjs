// Preloaded only while collecting subprocess coverage: Node writes V8 coverage at
// a normal exit, not when SIGTERM kills the process.
process.on("SIGTERM", () => process.exit(0));
