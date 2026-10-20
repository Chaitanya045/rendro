import { publicError } from "./publicErrors";
import { constantTimeEqual } from "../shared/constant-time";

export function requireInternalSecret(provided: string): void {
  const expected = process.env.CONVEX_INTERNAL_SECRET;
  if (!expected || !constantTimeEqual(provided, expected)) publicError("forbidden");
}
