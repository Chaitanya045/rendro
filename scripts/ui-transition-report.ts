import { readFileSync } from "node:fs";
import type data from "../tests/ui-transitions.json";

const registry: typeof data = JSON.parse(readFileSync(new URL("../tests/ui-transitions.json", import.meta.url), "utf8"));
const statuses = ["untested", "unit", "browser", "e2e"];
const edges = registry.families.flatMap(family => family.edges);
console.log(`UI transition registry — ${registry.baseline.date} / ${registry.baseline.commit}`);
console.log(`Families: ${registry.families.length} (strongest cited assertion tier, not complete family coverage)`);
for (const status of statuses) console.log(`  ${status}: ${registry.families.filter(family => family.status === status).length}`);
console.log(`Edges: ${edges.length}`);
for (const status of statuses) console.log(`  ${status}: ${edges.filter(edge => edge.status === status).length}`);
console.log(`All edges at browser/e2e: ${registry.families.filter(family => family.edges.every(edge => ["browser", "e2e"].includes(edge.status))).length}`);
console.log(`Page/response routes: ${new Set(registry.families.flatMap(family => family.routes)).size}; explicit route exclusions: ${registry.routeSkips.length}`);
const baseline = registry.baseline.auditFamilies;
console.log(`Audit baseline: 152 families (${baseline.untested} untested, ${baseline.unit} unit, ${baseline.browser} browser, ${baseline.e2e} e2e)`);
for (const [scope, coverage] of Object.entries(registry.baseline.sourceCoverage)) {
  console.log(`Historical ${scope} coverage S/B/F/L: ${coverage.statements}/${coverage.branches}/${coverage.functions}/${coverage.lines}% (${coverage.files} files)`);
}
for (const skip of registry.testSkips) console.log(`Not credited: ${skip.file} — ${skip.reason}`);
console.log("Target: every edge at browser/e2e across Chromium, Firefox and WebKit; declared roles/viewports are requirements, not execution evidence.");
