/** Stable application failures shared by Convex RPC, HTTP and the comment host. */
export const publicErrorMessages = {
  invalid_id: "Invalid ID",
  not_found: "Comment not found",
  unauthenticated: "Unauthenticated",
  forbidden: "Forbidden",
  invalid_input: "Invalid input",
  conflict: "Operation arguments changed",
} as const;
export type PublicErrorCode = keyof typeof publicErrorMessages;
export type PublicErrorData = { code: PublicErrorCode; message: string };

export function isPublicErrorData(value: unknown): value is PublicErrorData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return typeof data.code === "string" && Object.hasOwn(publicErrorMessages, data.code)
    && typeof data.message === "string" && Object.keys(data).length === 2;
}
