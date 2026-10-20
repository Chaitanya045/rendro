import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fontManifest } from "@/routes/font-manifest";
import { assertIcons, buildFonts, diffFontBuild, fontDirectory, runFontBuild, writeFontBuild, type FontBuild } from "../scripts/fonts/build";
import { loadIconCatalog, missingIcons, NON_ICON_LITERALS, scanIconNames } from "../scripts/fonts/icon-names";

const repo = resolve(".");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rendro-fonts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A minimal project root: borrowed node_modules plus caller-supplied source files. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(scratch, "project-"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "scripts"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const catalog = loadIconCatalog(repo);
const committedIcons = readFileSync(join(repo, fontDirectory, fontManifest.icons.file));

describe("icon subset", () => {
  it("contains exactly the icons the source renders", () => {
    const used = scanIconNames(repo, catalog);
    expect([...fontManifest.icons.names], "run pnpm build:fonts after adding, renaming or removing an icon").toEqual(used);
  });

  it("renders every listed icon as one ligature glyph and nothing it was not asked for", () => {
    expect(missingIcons(committedIcons, fontManifest.icons.names)).toEqual([]);
    expect(missingIcons(committedIcons, ["star", "settings_suggest", "groups"])).toEqual(["star", "settings_suggest", "groups"]);
  });

  it("is a small static subset, not the 4 MB source font", () => {
    expect(committedIcons.length).toBeLessThan(16 * 1024);
  });

  it("knows the full Material Symbols vocabulary", () => {
    expect(catalog.size).toBeGreaterThan(3000);
    expect(catalog.get("close")).toBeGreaterThanOrEqual(0xe000);
    expect(catalog.has("not_a_real_icon")).toBe(false);
  });
});

describe("icon extraction", () => {
  it("finds icons in markup, CSS content, string literals and ternaries", () => {
    const root = project({
      "src/routes/page.ts": [
        "const markup = `<span class=\"material-symbols-outlined\" aria-hidden=\"true\">star</span>`;",
        "const css = `.x::before{content:\"bookmark\";font:400 20px/1 \"Material Symbols Outlined\"}`;",
        "const pick = flag ? 'search' : \"favorite\";",
        "const dynamic = `<i class='material-symbols-outlined'>${name ?? \"settings_suggest\"}</i>`;",
      ].join("\n"),
    });
    expect(scanIconNames(root, catalog)).toEqual(["bookmark", "favorite", "search", "settings_suggest", "star"]);
  });

  it("ignores listed words, non-icons, files that render no icons and the font definitions", () => {
    const root = project({
      "src/routes/page.ts": "const a = `<b class=\"material-symbols-outlined\">${\"warning\"}</b>`; const words = [\"block\", \"pending\", \"nonsense\", \"Star\", \"star-icon\", \"2\"];",
      "src/routes/plain.ts": "export const word = \"star\";",
      "src/routes/fonts.ts": "export const x = 'Material Symbols Outlined'; const y = \"bookmark\";",
      "src/routes/font-manifest.ts": "export const x = 'material-symbols-outlined'; const y = \"search\";",
      "src/deep/nested/more.ts": "const n = 'material-symbols-outlined'; const icon = \"lock\";",
      "src/notes.md": "material-symbols-outlined \"mail\"",
    });
    expect(scanIconNames(root, catalog)).toEqual(["lock"]);
    for (const word of ["block", "pending", "warning"]) expect(NON_ICON_LITERALS.has(word) && catalog.has(word)).toBe(true);
  });

  it("scans the JSX page modules too (#288)", () => {
    const root = project({ "src/routes/page.tsx": "export const P = () => <span class=\"material-symbols-outlined\">search</span>;" });
    expect(scanIconNames(root, catalog)).toEqual(["search"]);
  });
});

describe("font build output", () => {
  let build: FontBuild;
  beforeAll(async () => { build = await buildFonts(repo); }, 60_000);

  it("matches the committed files byte for byte", () => {
    expect(diffFontBuild(repo, build)).toEqual([]);
    expect(build.iconNames).toEqual([...fontManifest.icons.names]);
  });

  it("emits hashed woff2 files and the license texts that must ship with them", () => {
    const names = [...build.files.keys()].sort();
    expect(names).toEqual([
      ...fontManifest.inter.faces.map(face => face.file), fontManifest.icons.file,
      "LICENSE-Inter-OFL-1.1.txt", "LICENSE-Material-Symbols-Apache-2.0.txt",
    ].sort());
    for (const name of names.filter(file => file.endsWith(".woff2"))) {
      expect(Buffer.from(build.files.get(name) as Uint8Array).subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
    expect(Buffer.from(build.files.get("LICENSE-Inter-OFL-1.1.txt") as Uint8Array).toString()).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(Buffer.from(build.files.get("LICENSE-Material-Symbols-Apache-2.0.txt") as Uint8Array).toString()).toContain("Apache License");
  });

  it("is reproducible", async () => {
    const again = await buildFonts(repo);
    expect(again.manifest).toBe(build.manifest);
    expect([...again.files.keys()]).toEqual([...build.files.keys()]);
  }, 60_000);

  it("reports drift: missing, changed and stale files and an outdated manifest", () => {
    const root = mkdtempSync(join(scratch, "drift-"));
    expect(diffFontBuild(root, build)).toContain("src/routes/font-manifest.ts is out of date");
    const directory = join(root, fontDirectory);
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(root, "src/routes"), { recursive: true });
    writeFontBuild(root, build);
    expect(diffFontBuild(root, build)).toEqual([]);

    const [first] = [...build.files.keys()];
    writeFileSync(join(directory, first), "tampered");
    rmSync(join(directory, fontManifest.icons.file));
    writeFileSync(join(directory, "old-font.0123456789.woff2"), "stale");
    writeFileSync(join(root, "src/routes/font-manifest.ts"), "// edited\n");
    expect(diffFontBuild(root, build).sort()).toEqual([
      `${fontDirectory}/${first} differs from the generated file`,
      `${fontDirectory}/${fontManifest.icons.file} is missing`,
      `${fontDirectory}/old-font.0123456789.woff2 is stale`,
      "src/routes/font-manifest.ts is out of date",
    ].sort());
  });

  it("writes the build, removing fonts that are no longer generated", () => {
    const root = mkdtempSync(join(scratch, "write-"));
    mkdirSync(join(root, "src/routes"), { recursive: true });
    mkdirSync(join(root, fontDirectory), { recursive: true });
    writeFileSync(join(root, fontDirectory, "gone.0123456789.woff2"), "stale");
    writeFontBuild(root, build);
    writeFontBuild(root, build);
    expect(readdirSync(join(root, fontDirectory)).sort()).toEqual([...build.files.keys()].sort());
    expect(existsSync(join(root, fontDirectory, "gone.0123456789.woff2"))).toBe(false);
  });
});

describe("font build failures and CLI", () => {
  it("fails when the Inter unicode-range cannot be found", async () => {
    const root = mkdtempSync(join(scratch, "no-range-"));
    mkdirSync(join(root, "node_modules/@fontsource-variable/inter"), { recursive: true });
    writeFileSync(join(root, "node_modules/@fontsource-variable/inter/wght.css"), "/* nothing */");
    await expect(buildFonts(root)).rejects.toThrow("No unicode-range for Inter latin");
  });

  it("refuses an icon subset that lost a ligature", () => {
    expect(() => assertIcons(committedIcons, ["close"])).not.toThrow();
    expect(() => assertIcons(committedIcons, ["close", "star"])).toThrow("Icon subset lost ligatures: star");
  });

  it("builds, verifies and detects drift through the CLI entry", async () => {
    const root = project({ "src/routes/page.ts": "const a = `<span class=\"material-symbols-outlined\">link</span>`;" });
    mkdirSync(join(root, "src/routes"), { recursive: true });
    const log = vi.fn();
    expect(await runFontBuild(root, ["--check"], log)).toBe(1);
    expect(log.mock.calls[0][0]).toContain("Run pnpm build:fonts");
    expect(await runFontBuild(root, [], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith("Built 5 font files (1 icons).");
    expect(await runFontBuild(root, ["--check"], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith("Fonts verified (1 icons).");
    writeFileSync(join(root, "src/routes/page.ts"), "const a = `<span class=\"material-symbols-outlined\">link</span><i class=\"material-symbols-outlined\">lock</i>`;");
    expect(await runFontBuild(root, ["--check"], log)).toBe(1);
    expect(log.mock.calls.at(-1)?.[0]).toContain("is out of date");
  }, 60_000);

  it("runs against the working directory with the real console", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const argv = process.argv;
    const code = process.exitCode;
    process.argv = [argv[0], "scripts/build-fonts.ts", "--check"];
    try {
      await import("../scripts/build-fonts");
      expect(info).toHaveBeenCalledWith(`Fonts verified (${fontManifest.icons.names.length} icons).`);
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = argv;
      process.exitCode = code;
      info.mockRestore();
    }
  }, 60_000);
});
