import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { signInSeeded } from "./shell-helpers";
import { publicationSlug } from "./services";

/**
 * #89: the document viewer shells render from a self-hosted, hashed base stylesheet instead of the Tailwind runtime
 * CDN, under a strict nonce CSP. The fixture's network guard already fails the test on any third-party request.
 */
async function violations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", event => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
}

for (const shell of ["private", "publication"] as const) {
  test(`the ${shell} viewer renders without a CSS runtime under a strict CSP [VIEWER-89-01]`, async ({ page, context, baseURL, seed }) => {
    await violations(page);
    const stylesheets: { url: string; status: number; type?: string; cache?: string }[] = [];
    page.on("response", response => {
      if (new URL(response.url()).pathname.startsWith("/styles/")) {
        stylesheets.push({ url: response.url(), status: response.status(), type: response.headers()["content-type"], cache: response.headers()["cache-control"] });
      }
    });
    if (shell === "private") await signInSeeded(context, baseURL, seed, "owner");
    const response = await page.goto(shell === "private" ? `/organizations/${seed.organizationId}/projects/${seed.projectId}/docs` : `/p/${publicationSlug}`);
    expect(response?.status()).toBe(200);
    await expect(page.frameLocator("#content-frame").getByRole("heading", { name: "Publication from local storage" })).toBeVisible();
    await expect(page.locator(".tree-item.active")).toHaveCount(1);

    const headers = response!.headers();
    const csp = headers["content-security-policy"];
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(csp.match(/script-src [^;]+/)![0]).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp.match(/style-src [^;]+/)![0]).toBe(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).not.toMatch(/tailwind|cdn\./);
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");

    expect(stylesheets).toEqual([{ url: expect.stringMatching(/\/styles\/viewer-base\.[0-9a-f]{10}\.css$/), status: 200,
      type: "text/css; charset=utf-8", cache: "public, max-age=31536000, immutable" }]);
    // The rules that used to come from the runtime are applied: base reset, [hidden], tree rows and icons.
    const styles = await page.evaluate(() => {
      const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        runtime: typeof (window as unknown as { tailwind?: unknown }).tailwind,
        border: css(".tree-item").borderTopStyle,
        radius: css(".tree-item").borderTopLeftRadius,
        icon: css(".tree-item .tree-icon").fontSize,
        hidden: [...document.querySelectorAll<HTMLElement>("[hidden]")].every(element => getComputedStyle(element).display === "none"),
        tapHighlight: css("html").getPropertyValue("-webkit-tap-highlight-color") || "unsupported",
      };
    });
    expect(styles).toMatchObject({ runtime: "undefined", border: "solid", radius: "8px", icon: "18px", hidden: true });
    expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
  });
}
