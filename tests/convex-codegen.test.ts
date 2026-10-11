import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../convex", import.meta.url));
const regenerate = "Run npx convex codegen against DEV and commit both _generated directories.";

// Match Convex entry points, including helpers and nested modules, but keep
// separately mounted components out of their parent's API.
function modules(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated" || existsSync(join(path, "convex.config.ts"))) return [];
      return modules(path, `${prefix}${entry.name}/`);
    }
    if (!/^[^.#][^.]*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)
      || /^schema\.(ts|js)$/.test(entry.name) || path.includes(" ")) return [];
    if (/\.tsx?$/.test(entry.name) && !/^\s{0,100}(import|export)/m.test(readFileSync(path, "utf8"))) return [];
    return [`${prefix}${entry.name.replace(/\.[^.]+$/, "")}`];
  }).sort();
}

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function moduleManifest(source: ts.SourceFile) {
  const imports = new Map<string, string>();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
      imports.set(node.importClause.namedBindings.name.text, node.moduleSpecifier.text.replace(/^\.\.\//, "").replace(/\.js$/, ""));
    }
  }
  const entries: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(source) === "ApiFromModules") {
      const manifest = node.typeArguments?.[0];
      if (!manifest || !ts.isTypeLiteralNode(manifest)) throw new Error("Expected ApiFromModules manifest");
      for (const member of manifest.members) {
        if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeQueryNode(member.type)) throw new Error("Expected module reference");
        const name = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
        expect(imports.get(member.type.exprName.getText(source)), regenerate).toBe(name);
        entries.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...imports.values()].sort(), regenerate).toEqual([...entries].sort());
  return entries.sort();
}

function componentFunctions(source: ts.SourceFile) {
  const declaration = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === "ComponentApi");
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) throw new Error("Missing ComponentApi");
  const functions: string[] = [];
  function visit(node: ts.TypeNode, prefix: string) {
    if (!ts.isTypeLiteralNode(node)) throw new Error(`Expected API namespace: ${prefix}`);
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) throw new Error("Expected API property");
      const name = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
      const path = prefix ? `${prefix}/${name}` : name;
      if (ts.isTypeReferenceNode(member.type) && member.type.typeName.getText(source) === "FunctionReference") {
        const kind = member.type.typeArguments?.[0];
        if (!kind || !ts.isLiteralTypeNode(kind) || !ts.isStringLiteral(kind.literal)) throw new Error("Missing function kind");
        functions.push(`${path}:${kind.literal.text}`);
      } else {
        visit(member.type, path);
      }
    }
  }
  visit(declaration.type, "");
  return functions.sort();
}

describe("Convex generated bindings (offline drift guard)", () => {
  it.each([
    ["application", root, "api.d.ts"],
    ["Better Auth component", join(root, "betterAuth"), "api.ts"],
  ])("includes every %s module in its generated API", (_name, directory, filename) => {
    expect(moduleManifest(parse(join(directory, "_generated", filename))), regenerate).toEqual(modules(directory));
  });

  it("exposes exactly the component's public registered functions and their kinds", async () => {
    const loaders = import.meta.glob("../convex/betterAuth/**/*.ts");
    const functions: string[] = [];
    for (const module of modules(join(root, "betterAuth"))) {
      const load = loaders[`../convex/betterAuth/${module}.ts`];
      if (!load) throw new Error(`Missing component module loader: ${module}`);
      const exports = await load();
      if (typeof exports !== "object" || exports === null) throw new Error(`Invalid module: ${module}`);
      for (const [name, value] of Object.entries(exports)) {
        if (typeof value !== "function" || !("isPublic" in value) || value.isPublic !== true) continue;
        const kind = "isQuery" in value ? "query" : "isMutation" in value ? "mutation" : "isAction" in value ? "action" : undefined;
        if (kind) functions.push(`${module}/${name}:${kind}`);
      }
    }
    // ComponentApi references use "internal" visibility in the parent, but
    // only functions declared public *inside* the component belong here.
    expect(componentFunctions(parse(join(root, "betterAuth/_generated/component.ts"))), regenerate).toEqual(functions.sort());
  });
});
