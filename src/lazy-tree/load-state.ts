export type DocumentLoadState = "loading" | "loaded" | "error";

export function documentLoadAccessibility(state: DocumentLoadState): {
  busy: boolean;
  message: string;
  assertive: boolean;
} {
  if (state === "loading")
    return { busy: true, message: "Loading document", assertive: false };
  if (state === "error")
    return {
      busy: false,
      message: "Document failed to load. Select it again to retry.",
      assertive: true,
    };
  return { busy: false, message: "", assertive: false };
}
