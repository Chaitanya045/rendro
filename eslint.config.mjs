import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Pages render through Hono JSX, which escapes every string (#288). Only src/routes/trusted-html.tsx writes
    // text unescaped: nonce'd inline code authored in this repository, and the finished page.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/routes/trusted-html.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["hono/html", "hono/utils/html", "hono/helper/*"], message: "Unescaped HTML goes through src/routes/trusted-html.tsx only." }],
      }],
      "no-restricted-syntax": ["error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Unescaped HTML goes through src/routes/trusted-html.tsx only." },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: "Unescaped HTML goes through src/routes/trusted-html.tsx only." },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    // Playwright specs interleave Node code with in-page DOM lookups, like the Vitest browser tests.
    files: ["e2e/**/*.spec.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["eslint.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    ignores: [
      ".wrangler/**",
      "test-results/**",
      "playwright-report/**",
      "bin/**",
      "convex/_generated/**",
      "convex/betterAuth/_generated/**",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "public/**",
      "src/commentor/**",
      // Generated wasm-bindgen glue and TypeScript types for the comrak engine
      // (wasm/comrak-engine); regenerate with `pnpm build:wasm`.
      "src/ingest/comrak-engine/**",
      "scripts/**",
      // Plain-JS preload for subprocesses, outside the TypeScript project.
      "tests/helpers/exit-on-sigterm.mjs",
      // Plain-JS service Worker for the E2E harness, bundled by Wrangler (see its header comment).
      "e2e/storage-faults-worker.mjs",
    ],
  }
);
