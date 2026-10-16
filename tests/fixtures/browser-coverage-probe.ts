export function coverageProbe(execute: boolean) {
  if (execute) {
    return "executed browser branch";
  }
  return "unexecuted browser branch";
}
Object.assign(globalThis, { coverageProbe, coverageProof: coverageProbe(true) });

export function neverCalled() {
  return "unused export stays in the denominator";
}
