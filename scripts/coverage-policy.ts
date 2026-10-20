import { resolve } from "node:path";

export const sourceInclude = ["src/**/*.ts", "src/**/*.tsx", "convex/**/*.ts", "shared/**/*.ts", "scripts/**/*.{ts,mjs}"];
export const sourceExclude = ["**/*.d.ts", "convex/_generated/**", "convex/betterAuth/_generated/**", "convex/betterAuth/schema.generated.ts"];

/** esbuild loader options that compile one authored file as the project does: server pages are Hono JSX (tsconfig.json). */
export function sourceLoader(path: string) {
  if (path.endsWith(".tsx")) return { loader: "tsx", jsx: "automatic", jsxImportSource: "hono/jsx" } as const;
  return { loader: /\.[cm]?ts$/.test(path) ? "ts" : "js" } as const;
}

// Vitest uses picomatch with contains:true. Absolute globs prevent a relative
// src/** (or exclusion) from also selecting a nested */src/** tree.
export function coveragePolicy(root: string) {
  const anchor = (pattern: string) => `${resolve(root).replaceAll("\\", "/")}/${pattern}(?![\\s\\S])`;
  // The final negative lookahead requires end-of-path even with contains:true;
  // picomatch and tinyglobby both support it. Otherwise .ts also matches .tsx.
  return { include: sourceInclude.map(anchor), exclude: sourceExclude.map(anchor) };
}
