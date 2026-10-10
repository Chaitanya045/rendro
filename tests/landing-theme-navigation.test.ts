import { Window, type HTMLButtonElement } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import authPages from "@/routes/auth-pages";
import { renderLandingPage } from "@/routes/landing";

const windows: Window[] = [];
type ThemeWindow = Window & { RendroTheme: { getMode(): string } };

function load(html: string, path: string, saved: string | null, systemDark = false) {
  const win = new Window({ url: `https://rendro.test${path}`, settings: {
    enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
  } });
  windows.push(win);
  Object.defineProperty(win, "matchMedia", { value: (query: string) => ({
    matches: query.includes("color-scheme") ? systemDark : query.includes("reduced-motion"),
    addEventListener() {}, removeEventListener() {},
  }) });
  if (saved !== null) win.localStorage.setItem("commentor-theme", saved);
  win.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) win.eval(match[1]);
  return win as ThemeWindow;
}

afterEach(async () => { for (const win of windows.splice(0)) await win.happyDOM.close(); });

describe("landing and authentication theme navigation", () => {
  it("keeps small secondary copy readable on light surfaces, including card hover", () => {
    const tokens = renderLandingPage().match(/:root \{([\s\S]*?)\}/)?.[1] ?? "";
    function color(name: string) {
      const hex = tokens.match(new RegExp(`${name}: #(\\w{6});`))?.[1];
      expect(hex, name).toBeDefined();
      const linear = [0, 2, 4].map(offset => {
        const channel = Number.parseInt(hex!.slice(offset, offset + 2), 16) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
    }
    const foreground = color("--text-muted");
    for (const name of ["--surface", "--surface-elevated", "--surface-hover"]) {
      const background = color(name);
      const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      expect(ratio, name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    { saved: "dark", systemDark: false, expected: "dark" },
    { saved: "light", systemDark: true, expected: "light" },
    { saved: "system", systemDark: true, expected: "dark" },
    { saved: "system", systemDark: false, expected: "light" },
    { saved: null, systemDark: true, expected: "dark" },
    { saved: null, systemDark: false, expected: "light" },
    { saved: "invalid-preference", systemDark: true, expected: "dark" },
  ])("keeps the resolved theme on home → sign-in/get-started → home: %j", async ({ saved, systemDark, expected }) => {
    const home = load(renderLandingPage(), "/", saved, systemDark);
    const initial = home.document.documentElement.dataset.resolvedTheme;
    expect(initial).toBe(expected);
    for (const label of ["Sign in", "Get started"]) {
      const link = [...home.document.querySelectorAll("a")].find(anchor => anchor.textContent.trim() === label);
      const path = link?.getAttribute("href");
      expect(path).toBe(label === "Sign in" ? "/sign-in" : "/sign-up");
      const destination = load(await (await authPages.request(path!)).text(), path!, home.localStorage.getItem("commentor-theme"), systemDark);
      expect(destination.document.documentElement.dataset.resolvedTheme).toBe(initial);
      expect(destination.RendroTheme.getMode()).toBe(home.RendroTheme.getMode());
      const returned = load(renderLandingPage(), "/", destination.localStorage.getItem("commentor-theme"), systemDark);
      expect(returned.document.documentElement.dataset.resolvedTheme).toBe(initial);
      // Navigation must not rewrite missing or invalid preferences merely to
      // force the marketing surface to dark.
      expect(returned.localStorage.getItem("commentor-theme")).toBe(saved);
    }
  });

  it("carries theme changes made on either screen across full document navigation", async () => {
    const home = load(renderLandingPage(), "/", "system");
    home.document.querySelector<HTMLButtonElement>("#theme-toggle")!.click();
    expect(home.RendroTheme.getMode()).toBe("dark");
    const signIn = load(await (await authPages.request("/sign-in")).text(), "/sign-in", home.localStorage.getItem("commentor-theme"));
    expect(signIn.document.documentElement.dataset.resolvedTheme).toBe("dark");
    signIn.document.querySelector<HTMLButtonElement>("#theme-toggle")!.click();
    expect(signIn.RendroTheme.getMode()).toBe("light");
    const returned = load(renderLandingPage(), "/", signIn.localStorage.getItem("commentor-theme"));
    expect(returned.document.documentElement.dataset.resolvedTheme).toBe("light");
    expect(returned.document.getElementById("theme-toggle")?.getAttribute("title")).toBe("Theme: light");
  });
});
