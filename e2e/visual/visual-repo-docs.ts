/**
 * The repository the visual baselines read through /r/ (#268): a public repo whose every string is fixed, with
 * nested folders, Markdown that exercises code and tables, a long page title and one large document. It only
 * exists in the visual runs (`RENDRO_E2E_VISUAL=1`), so the functional shards never ingest it.
 */

export const longTitle = "A deliberately long documentation title that wraps in the sidebar tree and in the page header";

const cell = (row: number, column: number) => `r${row}c${column}`;

/** Sections of fixed prose: stable text, so the large-document baseline never drifts. */
function largeDocument(sections: number): string {
  const parts = ["# Large reference\n", "A long page: every section below is generated from fixed text.\n"];
  for (let section = 1; section <= sections; section++) {
    const id = String(section).padStart(3, "0");
    parts.push(
      `## Section ${id}\n`,
      `Section ${id} describes the behaviour of module ${id}: it reads its input once, validates it against the schema and hands the result to the next stage without copying.\n`,
      `- Input ${id}: a bounded list of records\n- Output ${id}: the validated list, in the same order\n`,
      `| Field | Type | Notes |\n|---|---|---|\n| ${cell(section, 1)} | string | Stable key for module ${id} |\n| ${cell(section, 2)} | number | Count of processed records |\n`,
    );
  }
  return parts.join("\n");
}

export function visualDocs(): Record<string, string> {
  return {
    "README.md": "# Visual docs\n",
    "docs/index.md": [
      "# Visual home",
      "",
      "A fixed set of pages the baselines render. Start with the [getting started guide](guide/start.md).",
      "",
      "- Read the [reference](reference/api.md) for the endpoints.",
      "- Follow the [external changelog](https://example.com/changelog) for releases.",
      "- A [link to a page that was removed](guide/removed.md) shows the error state.",
      "",
      "> [!NOTE]",
      "> Every page here is fixed text, rendered once at ingest.",
      "",
    ].join("\n"),
    "docs/guide/start.md": "---\ntitle: Getting started\n---\n# Getting started\n\nInstall the CLI, then run it from the repository root.\n\n```sh\npnpm add -D rendro\npnpm rendro init\n```\n\nContinue with the [nested topic](deep/nested/topic.md).\n",
    "docs/guide/deep/nested/topic.md": [
      "# Nested topic",
      "",
      "A page three folders deep, with code of several languages and a wide table.",
      "",
      "## Configuration",
      "",
      "```ts",
      "export interface Options {",
      "  readonly branch: string;",
      "  readonly paths: readonly string[];",
      "}",
      "",
      "export const defaults: Options = { branch: \"main\", paths: [\"docs\"] };",
      "```",
      "",
      "```json",
      "{ \"branch\": \"main\", \"paths\": [\"docs\"], \"search\": true }",
      "```",
      "",
      "## Options",
      "",
      "| Option | Type | Default | Description |",
      "|---|---|---|---|",
      "| `branch` | string | `main` | The branch whose documents are published |",
      "| `paths` | string[] | `[\"docs\"]` | Folders read for pages |",
      "| `search` | boolean | `true` | Index every section for search |",
      "| `titleFromHeading` | boolean | `true` | Use the first heading as the page title in the sidebar |",
      "",
      "1. Edit the files.",
      "2. Push the branch.",
      "3. Read the result.",
      "",
      "- [x] Install",
      "- [ ] Publish",
      "",
      "Inline `code`, **bold** and _emphasis_ sit beside a [relative link](../../start.md).",
      "",
    ].join("\n"),
    "docs/reference/api.md": "# API reference\n\n## Endpoints\n\n| Method | Path | Result |\n|---|---|---|\n| GET | `/pages` | The page list |\n| GET | `/pages/{id}` | One page |\n\nRequests that do not match return a **404**.\n",
    "docs/reference/config.md": "# Configuration\n\n```yaml\nbranch: main\npaths:\n  - docs\n```\n",
    "docs/reference/errors.md": "# Errors\n\nEvery error carries a stable code.\n",
    "docs/long-title.md": `# ${longTitle}\n\nThe sidebar shows this title, and so does the page.\n`,
    "docs/large.md": largeDocument(160),
  };
}
