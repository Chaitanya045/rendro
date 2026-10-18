import { expect } from "./fixtures";
import { assertLoopback, localHttp } from "./backend";
import type { FaultRule } from "./services";

/**
 * Make the Worker's storage or Convex requests fail for one spec's own data (see `startFaults`). Returns the function that
 * ends the outage; call it in `finally`, or use `during`, so a failing assertion cannot leave a rule behind.
 */
export async function injectFault(rule: FaultRule): Promise<() => Promise<void>> {
  const control = process.env.RENDRO_E2E_FAULTS;
  if (!control) throw new Error("Missing local fault control");
  assertLoopback(control);
  const created = await localHttp(`${control}/faults`, rule);
  expect(created.status).toBe(200);
  const { id } = JSON.parse(created.body) as { id: string };
  return async () => { await fetch(`${control}/faults/${id}`, { method: "DELETE" }); };
}

export async function during<T>(rule: FaultRule, work: () => Promise<T>): Promise<T> {
  const end = await injectFault(rule);
  try { return await work(); } finally { await end(); }
}
