import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, ".github/workflows");
const workflows = readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort();
// The only job allowed to hold write permissions: it publishes the release and its attestation.
const writers: Record<string, string[]> = { "release.yml": ["publish"] };

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Every external `uses:` must be a full commit SHA with the human-readable version after it. */
export function unpinnedActions(text: string): string[] {
  const failures: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const match = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(.*)$/.exec(line);
    if (!match || match[1].startsWith("./")) continue;
    const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(match[1]) && /^\s+#\s*v\d+\.\d+\.\d+\S*\s*$/.test(match[2]);
    if (!pinned) failures.push(`line ${index + 1}: ${match[1]}`);
  }
  return failures;
}

/** Checkout steps must not leave the token in .git/config unless a comment says why. */
export function persistedCheckouts(text: string): string[] {
  const lines = text.split("\n");
  const failures: string[] = [];
  lines.forEach((line, index) => {
    if (!/^\s*-\s+uses:\s*actions\/checkout@/.test(line)) return;
    const body = [line];
    for (let next = index + 1; next < lines.length && (lines[next].trim() === "" || indentOf(lines[next]) > indentOf(line)); next++) body.push(lines[next]);
    const setting = body.find(entry => /^\s*persist-credentials:/.test(entry));
    const safe = setting !== undefined && (/^\s*persist-credentials:\s*false\s*$/.test(setting) || /^\s*persist-credentials:\s*true\s+#\s*\S/.test(setting));
    if (!safe) failures.push(`line ${index + 1}`);
  });
  return failures;
}

/** Jobs of one workflow with their raw bodies, plus the workflow-level header. */
function split(text: string) {
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  const header = lines.slice(0, start).join("\n");
  const jobs = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (name) { current = name; jobs.set(name, ""); } else if (current) jobs.set(current, jobs.get(current) + line + "\n");
  }
  return { header, jobs };
}

/** Least privilege: a workflow-level block without writes, an explicit block in every job, writes only for allowlisted jobs. */
export function permissionProblems(text: string, allowedWriters: string[] = []): string[] {
  const { header, jobs } = split(text);
  const problems: string[] = [];
  const top = /^permissions:(.*(?:\n {2}.*)*)/m.exec(header);
  if (!top) problems.push("missing workflow-level permissions");
  else if (/write/.test(top[1])) problems.push("workflow-level write permission");
  for (const [name, body] of jobs) {
    const own = /^ {4}permissions:(.*(?:\n {6}.*)*)/m.exec(body);
    if (!own) problems.push(`job ${name} has no permissions block`);
    else if (/write/.test(own[1]) && !allowedWriters.includes(name)) problems.push(`job ${name} has an unexpected write permission`);
  }
  return problems;
}

describe("workflow supply chain policy", () => {
  it("covers every workflow file", () => {
    expect(workflows).toEqual(["quality.yml", "r2-public-access.yml", "release.yml", "stability.yml"]);
  });

  it.each(workflows)("%s pins every external action to a commit SHA with a version comment", name => {
    const text = readFileSync(join(directory, name), "utf8");
    expect(text).toMatch(/^\s*(?:-\s+)?uses:/m);
    expect(unpinnedActions(text)).toEqual([]);
  });

  it.each(workflows)("%s never persists checkout credentials", name => {
    expect(persistedCheckouts(readFileSync(join(directory, name), "utf8"))).toEqual([]);
  });

  it.each(workflows)("%s declares least-privilege permissions", name => {
    expect(permissionProblems(readFileSync(join(directory, name), "utf8"), writers[name])).toEqual([]);
  });

  it("detects floating tags, branches, short SHAs, missing version comments and unpinned docker actions", () => {
    const sample = [
      "      - uses: actions/checkout@v4",
      "      - uses: actions/checkout@main",
      "      - uses: actions/cache@0057852",
      "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830",
      "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # latest",
      "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc3983Z # v4.3.0",
      "      - uses: docker://alpine:3",
      "    uses: org/repo/.github/workflows/x.yml@v1",
      "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0",
      "      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0-rc.1",
      "    uses: ./.github/workflows/quality.yml",
    ].join("\n");
    expect(unpinnedActions(sample)).toEqual([
      "line 1: actions/checkout@v4", "line 2: actions/checkout@main", "line 3: actions/cache@0057852",
      "line 4: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830", "line 5: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830",
      "line 6: actions/cache@0057852bfaa89a56745cba8c7296529d2fc3983Z", "line 7: docker://alpine:3", "line 8: org/repo/.github/workflows/x.yml@v1",
    ]);
  });

  it("detects checkouts that persist credentials without a justification", () => {
    const sample = [
      "      - uses: actions/checkout@sha # v4.4.0",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          fetch-depth: 0",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          persist-credentials: true",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          persist-credentials: true #",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          persist-credentials: true # pushes the changelog commit",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          fetch-depth: 0",
      "",
      "          persist-credentials: false",
      "      - uses: actions/checkout@sha # v4.4.0",
      "        with:",
      "          persist-credentials: 'false'",
      "      - uses: actions/setup-node@sha # v4.4.0",
    ].join("\n");
    expect(persistedCheckouts(sample)).toEqual(["line 1", "line 2", "line 5", "line 8", "line 19"]);
  });

  it("detects broad or missing permissions", () => {
    const job = (permissions: string) => `jobs:\n  build:\n    runs-on: ubuntu-latest\n${permissions}    steps: []\n`;
    const read = "    permissions:\n      contents: read\n";
    expect(permissionProblems(`permissions:\n  contents: read\n\n${job(read)}`)).toEqual([]);
    expect(permissionProblems(`permissions: {}\n\n${job("    permissions: {}\n")}`)).toEqual([]);
    expect(permissionProblems(`name: x\n\n${job(read)}`)).toEqual(["missing workflow-level permissions"]);
    expect(permissionProblems(`permissions:\n  contents: write\n\n${job(read)}`)).toEqual(["workflow-level write permission"]);
    expect(permissionProblems(`permissions: write-all\n\n${job(read)}`)).toEqual(["workflow-level write permission"]);
    expect(permissionProblems(`permissions: {}\n\n${job("")}`)).toEqual(["job build has no permissions block"]);
    const write = "    permissions:\n      contents: write\n";
    expect(permissionProblems(`permissions: {}\n\n${job(write)}`)).toEqual(["job build has an unexpected write permission"]);
    expect(permissionProblems(`permissions: {}\n\n${job(write)}`, ["build"])).toEqual([]);
  });
});

describe("release workflow", () => {
  const release = readFileSync(join(directory, "release.yml"), "utf8");
  const quality = readFileSync(join(directory, "quality.yml"), "utf8");

  it("runs the full quality gate before building and publishing", () => {
    expect(quality).toMatch(/\n {2}workflow_call:/);
    for (const check of ["verify", "e2e", "coverage"]) expect(quality).toMatch(new RegExp(`\\n {2}${check}:\\n`));
    const { jobs } = split(release);
    expect([...jobs.keys()]).toEqual(["gate", "build", "publish"]);
    expect(jobs.get("gate")).toContain("uses: ./.github/workflows/quality.yml");
    expect(jobs.get("build")).toContain("needs: gate");
    expect(jobs.get("publish")).toContain("needs: build");
  });

  it("publishes only from a tag push, with checksums and a pinned provenance attestation", () => {
    const { jobs } = split(release);
    const publish = jobs.get("publish")!;
    expect(release).toMatch(/push:\n {4}tags: \["v\*"\]/);
    expect(publish).toContain("if: ${{ github.event_name == 'push' }}");
    expect(publish).toMatch(/id-token: write/);
    expect(publish).toMatch(/attestations: write/);
    expect(publish).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
    expect(publish).toContain("subject-path: dist/rendro.mjs");
    expect(publish).toContain("sha256sum --check SHA256SUMS");
    expect(publish).toMatch(/files: \|\n\s+dist\/rendro.mjs\n\s+dist\/SHA256SUMS/);
    expect(jobs.get("build")).toContain("sha256sum rendro.mjs | tee SHA256SUMS");
    // Building never holds a write token.
    expect(jobs.get("build")).not.toMatch(/write/);
    expect(jobs.get("gate")).not.toMatch(/write/);
  });

  it("keeps the required check names of the quality workflow", () => {
    const { jobs } = split(quality);
    expect([...jobs.keys()]).toEqual(["verify", "e2e-engine", "e2e", "e2e-report", "coverage"]);
    expect(jobs.get("verify")).not.toMatch(/\n {4}name:/);
    expect(jobs.get("coverage")).not.toMatch(/\n {4}name:/);
  });
});
