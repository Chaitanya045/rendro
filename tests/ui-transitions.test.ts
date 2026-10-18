import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import app from "@/worker";
import { app as nodeApp } from "@/index";

// Inspect Node registrations without binding a port or making any requests.
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import registry from "./ui-transitions.json";

const text = z.string().trim().min(1);
const status = z.enum(["untested", "unit", "browser", "e2e"]);
const route = z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL) \/\S*$/);
const pointer = z.strictObject({
  file: z.string().regex(/^(tests\/[\w/-]+\.test\.ts|e2e\/[\w/-]+\.spec\.ts)$/),
  // For it.each, use the literal declaration template, including %s/$name.
  name: text,
  kind: z.enum(["unit", "browser", "e2e"]),
}).refine(value => value.file.startsWith("e2e/") === (value.kind === "e2e"));
const edgeSchema = z.strictObject({
  id: z.string().regex(/^UI-\d{3}-E\d{2,}$/),
  from: text, trigger: text, expected: text,
  inventoryRefs: z.array(z.string().regex(/^(UI-\d{3}|[RGAMOPVC]\d{2})$/)),
  status, tests: z.array(pointer),
});
const familySchema = z.strictObject({
  id: z.string().regex(/^UI-\d{3}$/), title: text, area: text,
  routes: z.array(route).min(1), sources: z.array(z.string().regex(/^(src|scripts)\/[\w/-]+\.ts$/)).min(1),
  roles: z.array(z.enum(["anonymous", "owner", "admin", "member", "outsider"])).min(1),
  viewports: z.array(z.number().int().positive()).min(1),
  engines: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1),
  status, auditEvidence: z.enum(["U", "B", "UNTESTED", "NOT_IN_AUDIT"]), auditNote: text,
  edges: z.array(edgeSchema).min(1),
});
const counts = z.strictObject({ untested: z.number().int().nonnegative(), unit: z.number().int().nonnegative(), browser: z.number().int().nonnegative(), e2e: z.number().int().nonnegative() });
const percentage = z.number().min(0).max(100);
const coverage = z.strictObject({ statements: percentage, branches: percentage, functions: percentage, lines: percentage, files: z.number().int().positive() });
const schema = z.strictObject({
  version: z.literal(1),
  baseline: z.strictObject({
    date: text, commit: text, sources: z.array(text).min(2), auditFamilies: counts,
    testRun: z.strictObject({ passedFiles: z.number(), skippedFiles: z.number(), passedTests: z.number(), skippedTests: z.number() }),
    sourceCoverage: z.strictObject({ configured: coverage, widened: coverage }),
  }),
  routeLedger: z.array(z.strictObject({ id: z.string().regex(/^R\d{2}$/), surface: text, variants: text, sourceNote: text, routes: z.array(route).min(1) })),
  routeSkips: z.array(z.strictObject({ route, reason: text })),
  testSkips: z.array(z.strictObject({ file: text, reason: text })),
  families: z.array(familySchema).min(1),
});
const tiers = ["untested", "unit", "browser", "e2e"];
const strongest = (values: string[]) => tiers[Math.max(0, ...values.map(value => tiers.indexOf(value)))];
const appRoutes = [...app.routes, ...nodeApp.routes];
const registeredRoutes = new Set(appRoutes.map(({ method, path }) => `${method} ${path}`));
const pageRoutes = new Set(registry.families.flatMap(family => family.routes));
const skips = new Set(registry.routeSkips.map(skip => skip.route));
const missingRoutes = (routes: { method: string; path: string }[]) =>
  [...new Set(routes.map(({ method, path }) => `${method} ${path}`))].filter(key => !pageRoutes.has(key) && !skips.has(key));

// Parse declarations, not comments/substring matches. Reject disabled tests and
// suites conservatively: conditional skip/runIf needs explicit review before
// it can count as baseline evidence. This does not prove semantic assertions;
// reviewers must check the narrowly described edge against the actual test.
function declarations(source: string) {
  const file = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function expectsFailure(node: ts.Node): boolean {
    if (ts.isCallExpression(node) && /^(test|it)\.fail$/.test(node.expression.getText(file))) return true;
    return ts.forEachChild(node, expectsFailure) ?? false;
  }
  function visit(node: ts.Node, disabled = false) {
    if (ts.isCallExpression(node)) {
      let root: ts.Expression = node.expression;
      while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) root = root.expression;
      const callee = ts.isIdentifier(root) && ["it", "test", "describe"].includes(root.text) ? node.expression.getText(file) : "";
      const test = /^(it|test)(?:\b|\.)/.test(callee);
      const suite = /^describe(?:\b|\.)/.test(callee);
      if ((test || suite) && /\.(skip|todo|only|skipIf|runIf|fail)\b/.test(callee)) disabled = true;
      const title = node.arguments[0];
      if (test && !disabled && !expectsFailure(node) && title && ts.isStringLiteralLike(title) && node.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        found.push(title.text);
      }
    }
    ts.forEachChild(node, child => visit(child, disabled));
  }
  visit(file);
  return found;
}

function unique(values: string[]) {
  expect(new Set(values).size, `Duplicate IDs/values: ${values.filter((value, i) => values.indexOf(value) !== i).join(", ")}`).toBe(values.length);
}

describe("UI transition registry", () => {
  it("validates the complete schema and rejects malformed metadata", () => {
    expect(schema.safeParse(registry).success).toBe(true);
    const invalid = structuredClone(registry);
    invalid.families[0].edges[0].trigger = "";
    expect(schema.safeParse(invalid).success).toBe(false);
    expect(status.safeParse("covered").success).toBe(false);
    expect(pointer.safeParse({ file: "../missing.ts", name: "test", kind: "browser" }).success).toBe(false);
    expect(pointer.safeParse({ file: "e2e/auth.spec.ts", name: "auth", kind: "e2e" }).success).toBe(true);
    expect(pointer.safeParse({ file: "e2e/auth.spec.ts", name: "auth", kind: "unit" }).success).toBe(false);
    expect(pointer.safeParse({ file: "tests/auth.test.ts", name: "auth", kind: "e2e" }).success).toBe(false);
  });

  it("keeps IDs unique and retains every family and route from both inventories", () => {
    unique(registry.families.map(family => family.id));
    unique(registry.families.flatMap(family => family.edges.map(edge => edge.id)));
    unique(registry.routeLedger.map(entry => entry.id));
    unique(registry.routeSkips.map(entry => entry.route));
    const ids = new Set(registry.families.map(family => family.id));
    for (let i = 1; i <= 152; i++) expect(ids.has(`UI-${String(i).padStart(3, "0")}`)).toBe(true);
    const refs = new Set(registry.families.flatMap(family => family.edges.flatMap(edge => edge.inventoryRefs)));
    for (const [prefix, count] of Object.entries({ G: 12, A: 10, M: 15, O: 17, P: 12, V: 18, C: 14 })) {
      for (let i = 1; i <= count; i++) expect(refs.has(`${prefix}${String(i).padStart(2, "0")}`)).toBe(true);
    }
    expect(registry.routeLedger.map(entry => entry.id)).toEqual(Array.from({ length: 35 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`));
    for (const entry of registry.routeLedger) {
      for (const route of entry.routes) expect(pageRoutes.has(route), `${entry.id}: ${route}`).toBe(true);
    }
    for (const family of registry.families) {
      unique(family.routes);
      for (const source of family.sources) expect(existsSync(resolve(source)), source).toBe(true);
      for (const edge of family.edges) expect(edge.id.startsWith(`${family.id}-E`)).toBe(true);
    }
  });

  it("credits only explicitly cited assertion edges and derives family evidence tiers", () => {
    for (const family of registry.families) {
      expect(family.status, family.id).toBe(strongest(family.edges.map(edge => edge.status)));
      for (const edge of family.edges) {
        expect(edge.status, edge.id).toBe(strongest(edge.tests.map(test => test.kind)));
        expect(edge.tests.length === 0, edge.id).toBe(edge.status === "untested");
        for (const test of edge.tests) {
          expect(registry.testSkips.some(skip => skip.file === test.file), edge.id).toBe(false);
          if (test.kind !== "e2e") expect(test.file.endsWith("-browser.test.ts"), edge.id).toBe(test.kind === "browser");
        }
      }
    }
  });

  // #121: every transition is asserted somewhere. A new edge must arrive with its test; there is no "untested" backlog.
  it("leaves no transition untested", () => {
    const untested = registry.families.flatMap(family => family.edges.filter(edge => edge.status === "untested").map(edge => edge.id));
    expect(untested).toEqual([]);
    expect(registry.families.filter(family => family.status === "untested").map(family => family.id)).toEqual([]);
  });

  const testFiles = [...new Set(registry.families.flatMap(family => family.edges.flatMap(edge => edge.tests.map(test => test.file))))];
  it.each(testFiles)("resolves enabled test declarations in %s", file => {
    expect(existsSync(resolve(file)), file).toBe(true);
    const names = declarations(readFileSync(file, "utf8"));
    for (const family of registry.families) for (const edge of family.edges) for (const test of edge.tests) {
      if (test.file === file) expect(names, `${edge.id}: ${file}`).toContain(test.name);
    }
  });

  it("enumerates skipped test files without giving them coverage credit", () => {
    for (const skip of registry.testSkips) expect(existsSync(resolve(skip.file)), skip.file).toBe(true);
  });

  it("distinguishes literal/parameterized tests from comments, skipped suites and partial names", () => {
    const source = `// it("comment only", () => {});
      describe.skip("disabled", () => { it("nested skip", () => {}); });
      it.skip("skipped", () => {}); it.todo("todo");
      it.skipIf(true)("conditional", () => {});
      test("expected failure", () => { test.fail(true, "known issue"); });
      test.fail("declared failure", () => {});
      test("exact name", () => {});
      it.each([1, 2])("case %s", () => {});
      describe("enabled", () => { it("nested", function() {}); });`;
    expect(declarations(source)).toEqual(["exact name", "case %s", "nested"]);
    expect(declarations(source)).not.toContain("exact");
  });

  it("classifies every actual Hono registration, including HTML POST and frame routes", () => {
    expect(missingRoutes(appRoutes)).toEqual([]);
    for (const route of [...pageRoutes, ...skips]) expect(registeredRoutes.has(route), `Stale route: ${route}`).toBe(true);
    for (const route of skips) expect(pageRoutes.has(route), `Page also skipped: ${route}`).toBe(false);
  });

  it("fails for a new page in a mounted module, a new HTML POST, or a new ALL handler", () => {
    const changed = new Hono().route("/", app);
    const module = new Hono().get("/new-page", c => c.html("new page"));
    changed.route("/organizations/:organizationId", module);
    changed.post("/api/new-html-result", c => c.html("result"));
    changed.all("/new-universal-page", c => c.html("page"));
    expect(missingRoutes(changed.routes)).toEqual([
      "GET /organizations/:organizationId/new-page", "POST /api/new-html-result", "ALL /new-universal-page",
    ]);
  });

  it("prints a deterministic summary from the checked-in registry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await import("../scripts/ui-transition-report");
      const report = log.mock.calls.map(args => args.join(" ")).join("\n");
      expect(report).toContain(`Families: ${registry.families.length}`);
      for (const tier of tiers) {
        expect(report).toContain(`${tier}: ${registry.families.filter(family => family.status === tier).length}`);
      }
      expect(report).toContain("Audit baseline: 152 families (64 untested, 62 unit, 26 browser, 0 e2e)");
      expect(report).toContain(`All edges at browser/e2e: ${registry.families.filter(family => family.edges.every(edge => ["browser", "e2e"].includes(edge.status))).length}`);
    } finally {
      log.mockRestore();
    }
  });
});
