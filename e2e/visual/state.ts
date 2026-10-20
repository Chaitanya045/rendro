import { readFileSync, existsSync } from "node:fs";
import { test as base } from "../fixtures";
import type { Seed } from "../seed";
import type { RepoFixtures } from "../repo-fixtures";

/**
 * The data seam of #120: the visual runs render seeded data whose every user-visible string is
 * fixed, provisioned once by the global setup (see seed-visual.ts, written to `visual.json`).
 * Both the screenshot suite and the axe suite open the exact same states from this fixture, so a
 * baseline and its scan can never render different data.
 */

export type VisualState = {
  /** Fixed time (ms) that every page clock is set to before navigation. */
  clockEpoch: number;
  crown: { organizationId: string; projectId: string; teamIds: string[]; cookies: Array<{ name: string; value: string; url: string }> };
  /** `/r/<owner>/<name>` of the visual repository, whose pages carry the seeded threads. */
  docs: string;
  vaultOrganizationId: string;
  /** The seeded owner (`owner@example.test`): the account menu email must stay fixed. */
  seedOwner: Seed;
  repos: () => RepoFixtures;
};

export type VisualFixtures = { visual: VisualState };

let loaded: VisualState | undefined;

export function loadVisualState(): VisualState {
  if (loaded) return loaded;
  const path = process.env.RENDRO_E2E_VISUAL;
  if (!path || !existsSync(path)) throw new Error("The visual state is missing: run through e2e/visual.config.ts so the global setup provisions it");
  const origin = process.env.RENDRO_E2E_ORIGIN;
  const seedPath = process.env.RENDRO_E2E_SEED;
  const reposPath = process.env.RENDRO_E2E_REPOS;
  const directory = process.env.RENDRO_E2E_DIRECTORY;
  if (!origin || !seedPath || !reposPath || !directory) throw new Error("Missing local E2E state");
  const visual = JSON.parse(readFileSync(path, "utf8")) as {
    clockEpoch: number;
    crown: { organizationId: string; projectId: string; teamIds: string[]; cookies: Array<{ name: string; value: string }> };
    docs: string;
    vaultOrganizationId: string;
  };
  const state: VisualState = {
    ...visual,
    crown: { ...visual.crown, cookies: visual.crown.cookies.map(cookie => ({ ...cookie, url: origin })) },
    seedOwner: JSON.parse(readFileSync(seedPath, "utf8")) as Seed,
    repos: (): RepoFixtures => JSON.parse(readFileSync(reposPath, "utf8")) as RepoFixtures,
  };
  void directory;
  loaded = state;
  return state;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the worker fixture carries no test-scoped siblings
export const testVisual = base.extend<{}, VisualFixtures>({
  visual: [
    // eslint-disable-next-line no-empty-pattern -- fixtures.ts uses the same Playwright idiom for zero dependencies
    async ({}, use, info) => {
      void info;
      await use(loadVisualState());
    },
    { scope: "worker" }],
});
