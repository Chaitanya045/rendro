import { HttpGitHubSource } from "../../src/ingest/github/http-source";
import { RateGovernor, type Clock } from "../../src/ingest/github/rate-governor";
import { staticTokenProvider } from "../../src/ingest/github/token";
import { IngestCoordinator } from "../../src/ingest/orchestrator/coordinator";
import type { IngestDependencies } from "../../src/ingest/orchestrator/ingest";
import { contentPipeline } from "../../src/ingest/orchestrator/content-pipeline";
import type { ContentPipeline } from "../../src/ingest/orchestrator/pipeline";
import { plaintextSealer, r2Store, type ContentSealer } from "../../src/ingest/orchestrator/store";
import { FakeGitHub } from "./fake-github";
import { FakeDurableStorage, FakeR2Bucket } from "./fake-storage";
import { initNodeMarkdownEngine } from "./markdown-engine";

initNodeMarkdownEngine();

/** Reject with a value that is not an Error, as some runtimes and libraries do. */
export function rejectWith(value: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return Promise.reject(value);
}

/** A clock whose sleeps advance time instantly, so backoff and pacing are observable without waiting. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public time = Date.UTC(2026, 9, 18, 12)) {}
  now = () => this.time;
  sleep = (ms: number) => {
    this.sleeps.push(ms);
    this.time += ms;
    return Promise.resolve();
  };
}

export interface FixtureOptions {
  pipeline?: ContentPipeline;
  sealer?: ContentSealer;
  token?: string | null;
  governor?: ConstructorParameters<typeof RateGovernor>[0];
  snapshot?: IngestDependencies["snapshot"];
}

export function ingestFixture(options: FixtureOptions = {}) {
  const clock = new FakeClock();
  const github = new FakeGitHub();
  github.now = clock.now;
  github.rate.reset = Math.floor(clock.time / 1000) + 3600;
  const bucket = new FakeR2Bucket();
  const store = r2Store(bucket);
  const source = new HttpGitHubSource({
    tokens: staticTokenProvider(options.token === undefined ? github.token : options.token),
    fetch: github.fetch,
    apiOrigin: github.origin,
    archiveOrigins: [github.archiveOrigin],
    clock,
    governor: new RateGovernor({ clock, ...options.governor }),
  });
  const deps: IngestDependencies = {
    source, store, sealer: options.sealer ?? plaintextSealer, pipeline: options.pipeline ?? contentPipeline(), now: clock.now,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  };
  const storage = new FakeDurableStorage();
  const coordinator = new IngestCoordinator({ storage }, deps);
  return { clock, github, bucket, store, source, deps, storage, coordinator };
}

/** A docs repository: `pages` Markdown pages and `images` PNGs under docs/, plus `sources` unrelated files. */
export function docsRepoFiles({ pages = 5, images = 1, sources = 3, pageBytes = 600 }: { pages?: number; images?: number; sources?: number; pageBytes?: number } = {}) {
  const files: Record<string, string | Uint8Array> = { "README.md": "# Project\n\nSee docs.\n" };
  for (let index = 0; index < pages; index += 1) {
    const section = index % 4 === 0 ? "" : `section-${index % 4}/`;
    files[`docs/${section}page-${index}.md`] = `# Page ${index}\n\n${"Lorem ipsum dolor sit amet. ".repeat(Math.ceil(pageBytes / 28))}\n`;
  }
  files["docs/index.md"] = "# Home\n\nWelcome.\n";
  for (let index = 0; index < images; index += 1) files[`docs/img/figure-${index}.png`] = new Uint8Array(2048).fill(index % 251);
  for (let index = 0; index < sources; index += 1) files[`src/module-${index}.ts`] = `export const value${index} = ${index};\n`.repeat(40);
  return files;
}
