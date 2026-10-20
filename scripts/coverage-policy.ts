import { resolve } from "node:path";

export const sourceInclude = ["src/**/*.ts", "convex/**/*.ts", "shared/**/*.ts", "scripts/**/*.{ts,mjs}"];
export const sourceExclude = ["**/*.d.ts", "convex/_generated/**", "convex/betterAuth/_generated/**", "convex/betterAuth/schema.generated.ts"];

// Vitest uses picomatch with contains:true. Absolute globs prevent a relative
// src/** (or exclusion) from also selecting a nested */src/** tree.
export function coveragePolicy(root: string) {
  const anchor = (pattern: string) => `${resolve(root).replaceAll("\\", "/")}/${pattern}(?![\\s\\S])`;
  // The final negative lookahead requires end-of-path even with contains:true;
  // picomatch and tinyglobby both support it. Otherwise .ts also matches .tsx.
  return { include: sourceInclude.map(anchor), exclude: sourceExclude.map(anchor) };
}
