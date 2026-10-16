import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ProcessIdentity = { pid: number; started: string };
type Journal = { owner: ProcessIdentity; children: ProcessIdentity[]; containers: string[]; temporaryDirectories: string[] };
const journalFile = "resources.json";
export const journalRoot = join(tmpdir(), "rendro-e2e-runs");

function identity(pid: number): ProcessIdentity {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return { pid, started: result.stdout.trim() };
}
function alive(process: ProcessIdentity) {
  return process.started !== "" && identity(process.pid).started === process.started;
}
function dispose(directory: string, journal: Journal) {
  for (const child of journal.children) {
    if (alive(child)) {
      try { process.kill(child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  for (const name of journal.containers) {
    const result = spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 15_000 });
    if (result.status !== 0 && !result.stderr.includes("No such container")) {
      throw new Error(`Could not remove E2E container ${name}`, { cause: result.error });
    }
  }
  for (const temporary of journal.temporaryDirectories) rmSync(temporary, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}

/** Recover only abandoned runs; process start times protect against PID reuse. */
export function sweepResources(root = journalRoot) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(root)) {
    const directory = join(root, entry);
    let journal: Journal;
    try { journal = JSON.parse(readFileSync(join(directory, journalFile), "utf8")) as Journal; } catch (error) {
      // A concurrent constructor may not have published its first journal yet;
      // it cannot acquire resources until after that publication.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!alive(journal.owner)) dispose(directory, journal);
  }
}

/** Created synchronously before setup's first await or resource acquisition. */
export class ResourceJournal {
  readonly directory: string;
  private closed = false;
  private disposed = false;
  private journal: Journal = { owner: identity(process.pid), children: [], containers: [], temporaryDirectories: [] };
  private onExit = () => {
    try { this.close(); } catch (error) { console.error(error); process.exitCode = 1; }
  };
  private onInterrupt = () => process.exit(130);
  private onTerminate = () => process.exit(143);

  constructor(root = journalRoot) {
    sweepResources(root);
    this.directory = mkdtempSync(join(root, "run-"));
    this.save();
    process.on("exit", this.onExit);
    process.on("SIGINT", this.onInterrupt);
    process.on("SIGTERM", this.onTerminate);
  }
  private save() {
    const path = join(this.directory, journalFile);
    writeFileSync(`${path}.tmp`, JSON.stringify(this.journal), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  assertActive() {
    if (this.closed) throw new Error("E2E setup has already been torn down");
  }
  child(child: ChildProcess) {
    this.assertActive();
    if (child.pid === undefined) throw new Error("E2E child failed to start");
    this.journal.children.push(identity(child.pid));
    this.save();
  }
  temporary(directory: string) {
    this.assertActive();
    this.journal.temporaryDirectories.push(directory);
    this.save();
  }
  createContainer(name: string, args: string[]) {
    this.assertActive();
    this.journal.containers.push(name);
    this.save();
    // Creation is synchronous so exit/teardown cannot race a daemon request
    // that creates a container after cleanup. Starting it later is safe.
    execFileSync("docker", ["create", "--name", name, ...args], { stdio: "pipe", timeout: 120_000 });
  }
  close() {
    if (this.disposed) return;
    this.closed = true;
    dispose(this.directory, this.journal);
    this.disposed = true;
    process.off("exit", this.onExit);
    process.off("SIGINT", this.onInterrupt);
    process.off("SIGTERM", this.onTerminate);
  }
}

let active: ResourceJournal | undefined;
export function registerResources(root = journalRoot) {
  active = new ResourceJournal(root);
  return active;
}
export function emergencyTeardown() { active?.close(); }
