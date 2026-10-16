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
      "scripts/**",
      // Plain-JS preload for subprocesses, outside the TypeScript project.
      "tests/helpers/exit-on-sigterm.mjs",
    ],
  }
);
