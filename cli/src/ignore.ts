/** A small gitignore subset: *, ?, whole-segment **, / anchors, directories and !.
 * The walker prunes ignored directories, so negate a parent before its children.
 * Other glob syntax is literal; backslash only escapes a leading # or !.
 */
export function createIgnoreMatcher(text: string): (path: string, directory: boolean) => boolean {
  const rules: Array<{ expression: RegExp; directory: boolean; negate: boolean }> = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (/^\\[#!]/.test(line)) line = line.slice(1);
    const directory = line.endsWith("/");
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const prefix = anchored || line.includes("/") ? "^" : "(?:^|/)";
    const segments = line.split("/");
    const pattern = segments.map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
      const glob = segment.replace(/[.*+?^${}()|[\]\\]/g, char => {
        if (char === "*") return "[^/]*";
        if (char === "?") return "[^/]";
        return `\\${char}`;
      });
      return glob + (last ? "" : "/");
    }).join("");
    rules.push({ expression: new RegExp(prefix + pattern + "$"), directory, negate });
  }
  return (path, directory) => {
    let ignored = false;
    for (const rule of rules) {
      if ((!rule.directory || directory) && rule.expression.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };
}
