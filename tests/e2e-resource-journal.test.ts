import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: commands.spawn, execFileSync: commands.exec }));
import { ResourceJournal, sweepResources, registerResources, emergencyTeardown } from "../e2e/resource-journal";

let root: string;
let resources: ResourceJournal;
let processes: Map<number, string>;
let kill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rendro-journal-test-"));
  processes = new Map([[process.pid, "owner-start"], [12345, "child-start"]]);
  commands.spawn.mockImplementation((command: string, args: string[]) => command === "ps"
    ? { stdout: processes.get(Number(args[1])) ?? "", status: 0 }
    : { stdout: "", stderr: "", status: 0 });
  commands.exec.mockReset();
  kill = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  kill.mockReset().mockReturnValue(true);
  commands.spawn.mockImplementation(() => ({ stdout: "", stderr: "No such container", status: 1 }));
  resources?.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("persists resources before acquisition, removes them, and closes idempotently", () => {
  resources = new ResourceJournal(root);
  resources.child({ pid: 12345 } as ChildProcess);
  const temporary = join(root, "download");
  mkdirSync(temporary);
  resources.temporary(temporary);
  commands.exec.mockImplementation(() => {
    expect(JSON.parse(readFileSync(join(resources.directory, "resources.json"), "utf8")).containers).toEqual(["fixture-container"]);
  });
  resources.createContainer("fixture-container", ["image"]);
  expect(commands.exec).toHaveBeenCalledWith("docker", ["create", "--name", "fixture-container", "image"], expect.any(Object));
  resources.close();
  resources.close();
  expect(kill).toHaveBeenCalledExactlyOnceWith(12345, "SIGKILL");
  expect(existsSync(resources.directory)).toBe(false);
  expect(existsSync(temporary)).toBe(false);
  expect(() => resources.assertActive()).toThrow("torn down");
});
it("rejects failed spawns and late acquisitions", () => {
  resources = new ResourceJournal(root);
  expect(() => resources.child({} as ChildProcess)).toThrow("failed to start");
  resources.close();
  expect(() => resources.createContainer("late", [])).toThrow("torn down");
});
it("sweeps abandoned owners while protecting active runs and reused PIDs", () => {
  resources = new ResourceJournal(root);
  resources.child({ pid: 12345 } as ChildProcess);
  sweepResources(root);
  expect(existsSync(resources.directory)).toBe(true);
  const stale = join(root, "stale");
  mkdirSync(stale);
  writeFileSync(join(stale, "resources.json"), JSON.stringify({ owner: { pid: 99999, started: "old" },
    children: [{ pid: 12345, started: "previous-process" }, { pid: 23456, started: "live-child" }, { pid: 34567, started: "" }], containers: ["abandoned"], temporaryDirectories: [] }));
  processes.set(23456, "live-child");
  sweepResources(root);
  expect(kill).toHaveBeenCalledExactlyOnceWith(23456, "SIGKILL");
  expect(existsSync(stale)).toBe(false);
});
it("skips not-yet-published journals but fails closed on corrupt metadata", () => {
  mkdirSync(join(root, "new-run"));
  sweepResources(root);
  writeFileSync(join(root, "new-run", "resources.json"), "bad JSON");
  expect(() => sweepResources(root)).toThrow();
});
it.each(["ESRCH", "EPERM"])("handles a process kill %s", code => {
  resources = new ResourceJournal(root);
  resources.child({ pid: 12345 } as ChildProcess);
  kill.mockImplementation(() => { throw Object.assign(new Error("kill failed"), { code }); });
  if (code === "ESRCH") expect(() => resources.close()).not.toThrow();
  else {
    expect(() => resources.close()).toThrow("kill failed");
    expect(existsSync(resources.directory)).toBe(true);
  }
});
it.each(["No such container: removed", "daemon unavailable"])("handles container cleanup: %s", stderr => {
  resources = new ResourceJournal(root);
  resources.createContainer("fixture", []);
  commands.spawn.mockImplementation(() => ({ stdout: "", stderr, status: 1 }));
  if (stderr.startsWith("No such")) expect(() => resources.close()).not.toThrow();
  else {
    expect(() => resources.close()).toThrow("Could not remove");
    expect(existsSync(resources.directory)).toBe(true);
    expect(() => resources.assertActive()).toThrow("torn down");
  }
});
it("registers exit/signal cleanup immediately and retains failed cleanup for recovery", () => {
  const events: EventEmitter = process;
  const old = new Map(["exit", "SIGINT", "SIGTERM"].map(event => [event, new Set(events.listeners(event))]));
  resources = new ResourceJournal(root);
  const handler = (event: string) => events.listeners(event).find(listener => !old.get(event)!.has(listener))!;
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit called"); });
  expect(() => { handler("SIGINT")(); }).toThrow("exit called");
  expect(exit).toHaveBeenLastCalledWith(130);
  expect(() => { handler("SIGTERM")(); }).toThrow("exit called");
  expect(exit).toHaveBeenLastCalledWith(143);
  resources.createContainer("fixture", []);
  commands.spawn.mockImplementation(() => ({ stdout: "", stderr: "daemon unavailable", status: 1 }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const previous = process.exitCode;
  handler("exit")();
  expect(log).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
  process.exitCode = previous;
  commands.spawn.mockImplementation(() => ({ stdout: "", stderr: "", status: 0 }));
  handler("exit")();
  expect(existsSync(resources.directory)).toBe(false);
});

it("registers teardown before setup returns", () => {
  emergencyTeardown();
  resources = registerResources(root);
  emergencyTeardown();
  expect(existsSync(resources.directory)).toBe(false);
});
