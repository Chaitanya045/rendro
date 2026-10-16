// @bcoe/v8-coverage 1.x ships JavaScript without declarations.
declare module "@bcoe/v8-coverage" {
  import type { Profiler } from "node:inspector";
  export function mergeScriptCovs(scripts: Profiler.ScriptCoverage[]): Profiler.ScriptCoverage | undefined;
}
