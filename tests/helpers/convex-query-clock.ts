import { posix } from "node:path";
import ts from "typescript";

/**
 * Static guard: no Convex query may read the clock, directly or through a helper.
 *
 * Convex caches a query result until a document it read changes; elapsed time
 * never invalidates it. A query that compares `Date.now()` to a deadline can
 * therefore keep serving a stale "allowed" after the deadline passes. Time-based
 * decisions belong in the calling action/httpAction, which receives the stored
 * deadline from the query.
 *
 * The analysis works on a map of repo-relative path -> source text, so it can run
 * on the real tree and on in-memory fixtures. From every query registration it
 * follows each reference to a top-level declaration, through relative imports
 * (including namespace imports), and reports any clock access it can reach.
 */

export type ClockFinding = { query: string; file: string; line: number; symbol: string; text: string; path: string[] };
export type Analysis = { queries: string[]; findings: ClockFinding[] };

// Callees that register a query. Helpers that wrap one (for example a factory
// that calls `queryGeneric`) are discovered automatically.
const registrations = new Set(["query", "internalQuery", "queryGeneric", "internalQueryGeneric"]);
// `Date.<member>` accesses that are pure functions of their arguments.
const pureDateMembers = new Set(["parse", "UTC"]);

type Declaration = { node: ts.Node; file: string; name: string };
type FileInfo = {
  source: ts.SourceFile;
  declarations: Map<string, Declaration>;
  imports: Map<string, { file: string; name: string | null }>;
  reexports: Map<string, { file: string; name: string }>;
};

function resolveModule(from: string, specifier: string, files: Map<string, FileInfo>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.join(posix.dirname(from), specifier).replace(/\.(js|ts)$/, "");
  return [`${base}.ts`, `${base}/index.ts`].find(candidate => files.has(candidate)) ?? null;
}

function isExported(node: ts.Node) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function indexFile(path: string, text: string): FileInfo {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, Declaration>();
  const declare = (name: string, node: ts.Node) => declarations.set(name, { node, file: path, name });
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) declare(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declare(declaration.name.text, declaration);
        else for (const element of declaration.name.elements) if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) declare(element.name.text, declaration);
      }
    }
  }
  return { source, declarations, imports: new Map(), reexports: new Map() };
}

function linkImports(files: Map<string, FileInfo>) {
  for (const [path, info] of files) {
    for (const statement of info.source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings) {
        const file = resolveModule(path, statement.moduleSpecifier.text, files);
        if (!file) continue;
        const bindings = statement.importClause.namedBindings;
        if (ts.isNamespaceImport(bindings)) info.imports.set(bindings.name.text, { file, name: null });
        else for (const element of bindings.elements) info.imports.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const file = resolveModule(path, statement.moduleSpecifier.text, files);
        if (!file) continue;
        if (!statement.exportClause) info.reexports.set("*", { file, name: "*" });
        else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) info.reexports.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
        }
      }
    }
  }
}

/** Follows imports and re-exports to the declaration an exported name refers to. */
function lookupExport(files: Map<string, FileInfo>, file: string, name: string, seen = new Set<string>()): Declaration | null {
  const key = `${file}#${name}`;
  const info = files.get(file);
  if (seen.has(key) || !info) return null;
  seen.add(key);
  const own = info.declarations.get(name);
  if (own) return own;
  for (const [exported, target] of info.reexports) {
    if (exported === name) return lookupExport(files, target.file, target.name, seen);
    if (exported === "*") {
      const found = lookupExport(files, target.file, name, seen);
      if (found) return found;
    }
  }
  return null;
}

const calleeName = (call: ts.CallExpression) => ts.isIdentifier(call.expression) ? call.expression.text : null;

/** The enclosing top-level declaration's name, used to scope allowlist entries. */
function symbolOf(node: ts.Node) {
  let current: ts.Node = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  if (ts.isVariableStatement(current)) return current.declarationList.declarations.map(declaration => declaration.name.getText()).join(",");
  if ("name" in current && current.name && typeof (current.name as ts.Node).getText === "function") return (current.name as ts.Node).getText();
  return "<module>";
}

/** The clock expression a node represents, or null. Type positions never count. */
function clockRead(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    // Property names and declarations are not references to the global.
    if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isPropertyAssignment(parent) && parent.name === node)
      || (ts.isBindingElement(parent) && parent.propertyName === node)
      || (ts.isParameter(parent) && parent.name === node)
      || (ts.isVariableDeclaration(parent) && parent.name === node)
      || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return null;
    if (node.text === "performance" || node.text === "Temporal") return node.text;
    if (node.text !== "Date") return null;
    // Pure uses: `new Date(value)`, `Date.parse`, `Date.UTC`, `x instanceof Date`.
    if (ts.isNewExpression(parent) && parent.expression === node) return parent.arguments?.length ? null : "new Date()";
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return pureDateMembers.has(parent.name.text) ? null : `Date.${parent.name.text}`;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) return null;
    return "Date";
  }
  return null;
}

type Root = { node: ts.Node; label: string };

/** Every query registration, with the expression that supplies its handler. */
function findRoots(files: Map<string, FileInfo>) {
  // A function that registers a query inside itself is a factory; calls to it
  // register queries too. Iterate so factories that call factories are found.
  const factories = new Set<string>();
  const registers = (callee: string | null) => callee !== null && (registrations.has(callee) || factories.has(callee));
  for (let changed = true; changed;) {
    changed = false;
    for (const info of files.values()) {
      for (const declaration of info.declarations.values()) {
        if (factories.has(declaration.name) || (!ts.isFunctionDeclaration(declaration.node) && !ts.isVariableDeclaration(declaration.node))) continue;
        let found = false;
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && registers(calleeName(node))) found = true;
          if (!found) ts.forEachChild(node, visit);
        };
        visit(declaration.node);
        if (found) { factories.add(declaration.name); changed = true; }
      }
    }
  }
  const roots: Array<Root & { file: string; exported: string | null }> = [];
  for (const [file, info] of files) {
    for (const statement of info.source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!init || !ts.isCallExpression(init) || !isExported(statement) || !registers(calleeName(init))) continue;
        const exported = declaration.name.getText();
        // A direct registration carries its handler as an argument. A factory
        // call hands the arguments to the factory, which is scanned on its own.
        if (registrations.has(calleeName(init) ?? "")) roots.push({ node: init, label: exported, file, exported });
        else roots.push({ node: declaration, label: exported, file, exported });
      }
    }
    const visit = (node: ts.Node) => {
      // Registrations inside a factory body (not the exported call sites above).
      if (ts.isCallExpression(node) && registrations.has(calleeName(node) ?? "")
        && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isVariableDeclarationList(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent.parent))) {
        roots.push({ node, label: `${symbolOf(node)}()`, file, exported: null });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.source);
  }
  return roots;
}

/**
 * @param sources repo-relative path -> source text (convex/** and anything they import)
 */
export function analyzeQueryClockReads(sources: Record<string, string>): Analysis {
  const files = new Map(Object.entries(sources).map(([path, text]) => [path, indexFile(path, text)]));
  linkImports(files);
  const roots = findRoots(files);
  const findings: ClockFinding[] = [];

  for (const root of roots) {
    const seen = new Set<Declaration>();
    const scan = (node: ts.Node, file: string, path: string[]) => {
      const visit = (current: ts.Node) => {
        if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return;
        const read = clockRead(current);
        if (read !== null) {
          const line = current.getSourceFile().getLineAndCharacterOfPosition(current.getStart()).line + 1;
          findings.push({ query: `${root.file}:${root.label}`, file, line, symbol: symbolOf(current), text: read, path });
        }
        if (ts.isIdentifier(current)) follow(current, file, path);
        // `ns.helper` through a namespace import.
        if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
          const imported = files.get(file)?.imports.get(current.expression.text);
          if (imported?.name === null) enter(lookupExport(files, imported.file, current.name.text), path);
        }
        ts.forEachChild(current, visit);
      };
      visit(node);
    };
    const enter = (declaration: Declaration | null, path: string[]) => {
      if (!declaration || seen.has(declaration)) return;
      seen.add(declaration);
      scan(declaration.node, declaration.file, [...path, `${declaration.file}:${declaration.name}`]);
    };
    const follow = (identifier: ts.Identifier, file: string, path: string[]) => {
      const info = files.get(file);
      if (!info || (ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier)) return;
      const local = info.declarations.get(identifier.text);
      if (local) return enter(local, path);
      const imported = info.imports.get(identifier.text);
      if (imported?.name) enter(lookupExport(files, imported.file, imported.name), path);
    };
    scan(root.node, root.file, []);
  }

  const unique = new Map(findings.map(finding => [`${finding.query}|${finding.file}:${finding.line}:${finding.text}`, finding]));
  const exported = roots.flatMap(root => root.exported === null ? [] : [`${root.file}:${root.exported}`]);
  return { queries: [...new Set(exported)].sort(), findings: [...unique.values()] };
}

/** Findings not covered by `allow` (keys `file#symbol`) plus allowlist entries nothing uses. */
export function enforceAllowlist(analysis: Analysis, allow: Record<string, string>) {
  const key = (finding: ClockFinding) => `${finding.file}#${finding.symbol}`;
  const violations = analysis.findings.filter(finding => !(key(finding) in allow));
  const used = new Set(analysis.findings.map(key));
  const stale = Object.keys(allow).filter(entry => !used.has(entry));
  return { violations, stale };
}
