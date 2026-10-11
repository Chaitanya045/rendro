import { ConvexError } from "convex/values";
import { publicErrorMessages, type PublicErrorCode } from "../src/shared/public-errors";

// SDK 1.42: values/errors.ts sets message from data; registration_impl.ts
// serializes data separately; browser/http_client.ts forwards errorMessage.
// The backend's redaction.rs includes frames in dev and redacts the diagnostic
// message in prod, while retaining application data. Don't rely on prod alone.
// Runtime regression: tests/convex-public-rpc.test.ts (backend 2026-10-06).
// One fixed message and one throw site per expected code, never input values.
export function publicError(code: PublicErrorCode): never {
  // Convex's dev envelope contains a separate message and source-mapped frames.
  // Suppress capture at construction, rather than just replacing .stack: Convex
  // also reads the frame data populated by its own prepareStackTrace hook.
  // Keep this synchronous and restore the limit for unrelated runtime errors.
  const limit = Error.stackTraceLimit;
  let error: ConvexError<{ code: PublicErrorCode; message: string }>;
  try {
    Error.stackTraceLimit = 0;
    error = new ConvexError({ code, message: publicErrorMessages[code] });
    error.message = publicErrorMessages[code];
    void error.stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
  throw error;
}
