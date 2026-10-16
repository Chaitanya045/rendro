const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

export function escapeHtml(value: string): string {
  // The pattern matches exactly the keys above, so every lookup succeeds.
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
