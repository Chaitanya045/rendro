import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), "utf8");
function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
}
const helper = "src/routes/trusted-html.tsx";

describe("server JSX boundary (#288)", () => {
  it("compiles JSX with Hono's runtime, in server modules only", () => {
    expect(JSON.parse(read("tsconfig.json")).compilerOptions).toMatchObject({ jsx: "react-jsx", jsxImportSource: "hono/jsx" });
    const pages = sources("src").filter(file => file.endsWith(".tsx"));
    expect(pages).toContain(helper);
    for (const file of pages) expect(file).toMatch(/^src\/(routes|repo-read)\/[\w-]+\.tsx$/);
  });

  it("writes unescaped HTML only through the audited helper", () => {
    for (const file of sources("src").filter(name => name !== helper)) {
      expect(read(file), file).not.toMatch(/dangerouslySetInnerHTML|from\s*["']hono\/(?:html|utils\/html|helper\/)/);
    }
    // The helper's own unescaped writes: one inline script body, one inline style body.
    expect(read(helper).match(/\braw\(/g)).toHaveLength(2);
  });
});
