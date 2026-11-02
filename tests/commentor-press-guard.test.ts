import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PressGuard } from "../src/commentor/press-guard";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("runs a rebuild at once when nothing is pressed", () => {
  const guard = new PressGuard();
  const apply = vi.fn();
  guard.run(apply);
  expect(apply).toHaveBeenCalledOnce();
  expect(guard.pressed).toBe(false);
});

it("holds a rebuild while a press is down and runs only the newest one on a later task after the release", () => {
  const guard = new PressGuard();
  const first = vi.fn();
  const second = vi.fn();
  guard.press("pointer");
  guard.run(first);
  guard.run(second);
  expect(guard.pressed).toBe(true);
  expect([first, second].map(fn => fn.mock.calls.length)).toEqual([0, 0]);
  guard.release("pointer");
  // The click the release produced is dispatched before the rebuild.
  expect(second).not.toHaveBeenCalled();
  vi.advanceTimersByTime(0);
  expect([first, second].map(fn => fn.mock.calls.length)).toEqual([0, 1]);
  expect(guard.pressed).toBe(false);
});

it("waits for every source and ignores the release of one that is not held", () => {
  const guard = new PressGuard();
  const apply = vi.fn();
  guard.release("pointer");
  vi.advanceTimersByTime(0);
  guard.press("pointer");
  guard.press("key");
  guard.run(apply);
  guard.release("pointer");
  vi.advanceTimersByTime(10);
  expect(apply).not.toHaveBeenCalled();
  guard.release("key");
  vi.advanceTimersByTime(0);
  expect(apply).toHaveBeenCalledOnce();
});

it("leaves the rebuild to the release of a press that began before the flush", () => {
  const guard = new PressGuard();
  const apply = vi.fn();
  guard.press("pointer");
  guard.run(apply);
  guard.release("pointer");
  guard.press("pointer");
  vi.advanceTimersByTime(0);
  expect(apply).not.toHaveBeenCalled();
  guard.release("pointer");
  vi.advanceTimersByTime(0);
  expect(apply).toHaveBeenCalledOnce();
});

it("does not repeat a rebuild that already ran now", () => {
  const guard = new PressGuard();
  const waiting = vi.fn();
  const now = vi.fn();
  guard.press("pointer");
  guard.run(waiting);
  guard.release("pointer");
  guard.run(now);
  vi.advanceTimersByTime(0);
  expect([waiting, now].map(fn => fn.mock.calls.length)).toEqual([0, 1]);
});

it("drops a press that never ends after the cap, so updates cannot freeze", () => {
  const guard = new PressGuard(500);
  const apply = vi.fn();
  guard.press("pointer");
  guard.run(apply);
  vi.advanceTimersByTime(499);
  expect(apply).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(guard.pressed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(apply).toHaveBeenCalledOnce();
  // Its late release changes nothing.
  guard.release("pointer");
  vi.advanceTimersByTime(0);
  expect(apply).toHaveBeenCalledOnce();
});

it("restarts the cap with each new press", () => {
  const guard = new PressGuard(500);
  guard.press("pointer");
  vi.advanceTimersByTime(400);
  guard.press("key");
  vi.advanceTimersByTime(400);
  expect(guard.pressed).toBe(true);
  vi.advanceTimersByTime(100);
  expect(guard.pressed).toBe(false);
});
