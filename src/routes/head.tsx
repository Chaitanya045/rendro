import { commentRecoveryScript } from "@/commentor/recovery-session";
import { fontFaceStyles, fontPreloads, fontUrl, type FontOptions } from "./fonts";
import { styleManifest } from "./style-manifest";
import { sharedThemeRuntime, sharedThemeStyles } from "./theme";
import { InlineScript, InlineStyle, renderHtml } from "./trusted-html";

/** Shared by every Rendro-owned HTML document. */
export function FaviconLinks() {
  return (
    <>
      <link rel="icon" href="/favicon.ico" sizes="16x16 32x32" type="image/x-icon" />
      <link rel="icon" href="/favicon.svg" sizes="any" type="image/svg+xml" />
    </>
  );
}

/**
 * Same-origin font preloads and @font-face rules for the document head. All Inter weights share one
 * variable file per subset; each face clamps the variable axis to a single weight, so weights the
 * design never used still snap to the nearest declared face. Only the Latin file is preloaded.
 */
export function FontHead(options: FontOptions) {
  return (
    <>
      {fontPreloads(options).map(file => <link rel="preload" href={fontUrl(file)} as="font" type="font/woff2" crossorigin="" />)}
      <InlineStyle data-rendro-fonts="" code={fontFaceStyles(options)} />
    </>
  );
}

/** Same-origin stylesheet link for a self-hosted, hashed stylesheet. */
export function Stylesheet({ name }: { name: keyof typeof styleManifest }) {
  return <link rel="stylesheet" href={`/styles/${styleManifest[name]}`} />;
}

/** The theme stylesheet and runtime every theme-aware page loads before its own CSS. */
export function ThemeAssets() {
  return (
    <>
      <InlineStyle data-rendro-theme="" code={sharedThemeStyles} />
      <InlineScript data-rendro-theme="" code={sharedThemeRuntime} />
    </>
  );
}

// Shells share markup as well as behavior: page-local button classes must not
// override this control's interaction states. Menu placement changes only layout.
export function ThemeButton() {
  return (
    <button class="rendro-theme-control" id="theme-toggle" type="button" aria-label="Switch to dark theme" title="Theme: system">
      <span class="material-symbols-outlined rendro-theme-icon" aria-hidden="true">contrast</span>
    </button>
  );
}

/** Sign-out in another tab ends this one too (src/commentor/recovery-session.ts). */
export function CommentRecovery({ userId, completedSignOut = false }: { userId: string | null; completedSignOut?: boolean }) {
  return <InlineScript code={commentRecoveryScript(userId, completedSignOut)} />;
}

// The same parts as strings, for callers outside JSX.
export const renderFaviconLinks = () => renderHtml(<FaviconLinks />);
export const renderFontHead = (options: FontOptions = {}) => renderHtml(<FontHead {...options} />);
export const renderStylesheet = (name: keyof typeof styleManifest) => renderHtml(<Stylesheet name={name} />);
export const renderThemeAssets = () => renderHtml(<ThemeAssets />);
export const renderThemeButton = () => renderHtml(<ThemeButton />);
