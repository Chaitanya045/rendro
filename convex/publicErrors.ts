import { ConvexError } from "convex/values";
import { publicErrorMessages, type PublicErrorCode } from "../src/shared/public-errors";

// Only pass fixed, authored messages here; never exception text or input values.
export function publicError(code: PublicErrorCode, message: string = publicErrorMessages[code]) {
  return new ConvexError({ code, message });
}
