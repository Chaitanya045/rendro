import { requestNonce } from "@/middleware/html-nonce";
import { COMMENTOR_PARENT_VERSION, LAZY_TREE_VERSION, PRIVATE_VIEWER_VERSION, RUM_VERSION } from "@/viewer/asset-versions";
import { viewerUpdateNoticeStyles } from "@/viewer/markup";
import { shareLabel, shellScript, shellStyles, type ScopedDocumentShellOptions } from "./app";
import { CommentRecovery, FaviconLinks, FontHead, Stylesheet, ThemeAssets, ThemeButton } from "./head";
import { InlineScript, InlineStyle, renderHtml, scriptJson } from "./trusted-html";

function RepoSearch() {
  return (
    <div class="repo-search" id="repo-search" data-repo-search="" hidden>
      <form class="repo-search-field" role="search">
        <span class="material-symbols-outlined repo-search-icon" aria-hidden="true">search</span>
        <input class="repo-search-input" id="repo-search-input" type="search" name="q" placeholder="Search documents" aria-label="Search documents" role="combobox" aria-autocomplete="list" aria-controls="repo-search-results" aria-expanded="false" autocomplete="off" spellcheck={false} maxlength={200} />
        <button class="repo-search-clear" id="repo-search-clear" type="button" aria-label="Clear search" hidden><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
      </form>
      <div class="repo-search-results" id="repo-search-results" role="listbox" aria-label="Search results" hidden></div>
      <div class="repo-search-status" id="repo-search-status" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>
  );
}

function TreeSkeletonNode({ caret, width }: { caret: boolean; width: "w-md" | "w-lg" }) {
  return (
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        {caret && <span class="tree-skeleton-icon tree-skeleton-caret"></span>}
        <span class="tree-skeleton-icon"></span>
        <span class={`tree-skeleton-label ${width}`}></span>
      </div>
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div class="tree-skeleton" aria-label="Loading documents" aria-busy="true">
      <TreeSkeletonNode caret={false} width="w-lg" />
      <TreeSkeletonNode caret width="w-md" />
      <TreeSkeletonNode caret width="w-md" />
      <TreeSkeletonNode caret width="w-lg" />
      <TreeSkeletonNode caret width="w-md" />
    </div>
  );
}

/** A private repository's frames take images through tickets; the shell's viewer renews them and offers a reload (#293). */
function ParentViewer({ base }: { base: string }) {
  return (
    <>
      <InlineStyle code={viewerUpdateNoticeStyles} />
      <aside id="viewer-update-notice" aria-label="Document update" hidden><span role="status" aria-live="polite"></span><button type="button">Reload</button></aside>
      <script nonce={requestNonce()} src={`/private-viewer.js?v=${PRIVATE_VIEWER_VERSION}`} data-viewer="parent" data-config={JSON.stringify({ base })}></script>
    </>
  );
}

/** The repository docs shell (`/r/{owner}/{repo}`): sidebar tree and search, the sandboxed document frame, comments. */
export function ShellDocument(options: ScopedDocumentShellOptions) {
  const org = options.namespace;
  const nonce = requestNonce();
  const bootstrap = `window.RENDRO_INITIAL_DOC=${scriptJson(`${org}/${options.selectedPath}`)};window.RENDRO_ORG=${scriptJson(org)};`
    + `window.RENDRO_DOCUMENT_BASE=${scriptJson(options.basePath)};window.RENDRO_REPO_COMMENT_CONFIG=${scriptJson(options.repoCommentConfig)};`;
  return (
    <html lang="en">
      <head>
        <FaviconLinks />
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{options.title} — Rendro</title>
        <FontHead icons weights={[400, 600, 700]} />
        <ThemeAssets />
        <InlineStyle code={shellStyles} />
        <Stylesheet name="viewer-base" />
      </head>
      <body>
        <header class="topbar">
          <div class="topbar-left">
            <button class="topbar-btn-icon mobile-tree-toggle" id="mobile-tree-toggle" type="button" aria-label="Open document tree" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">menu</span></button>
            <h1 class="topbar-logo">{options.title}</h1>
          </div>
          <div class="topbar-actions">
            <span class="shortcut-tooltip-wrap"><button class="topbar-btn-icon shell-toggle" id="shell-toggle" type="button" aria-label="Hide app shell, keyboard shortcut Ctrl Shift H" aria-describedby="shell-shortcut-tooltip" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">fullscreen</span><span class="mobile-action-label" id="shell-mobile-label">Enter reading mode</span></button><span class="shortcut-tooltip" id="shell-shortcut-tooltip" role="tooltip"><span class="shortcut-tooltip-label">Hide app shell</span><span class="shortcut-keys" id="shell-shortcut-keys" aria-hidden="true"><span class="shortcut-key">Ctrl</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span></span></span></span>
            <button class="topbar-btn topbar-btn-share" id="share-btn" type="button" aria-label={shareLabel}>
              <span class="share-icon-window" aria-hidden="true"><span class="share-icon-track"><span class="material-symbols-outlined share-icon-row">link</span><span class="share-icon-row"><span class="share-loader"></span></span><span class="material-symbols-outlined share-icon-row" id="share-feedback-icon">check</span></span></span>
              <span class="share-label-window" aria-hidden="true"><span class="share-label-track"><span class="share-label">{shareLabel}</span><span class="share-label">Copying link…</span><span class="share-label" id="share-feedback-label">Link copied!</span></span></span>
            </button>
            <ThemeButton />
            <div class="mobile-more" id="mobile-more">
              <button class="topbar-btn-icon" id="mobile-more-btn" type="button" aria-label="More document actions" aria-haspopup="dialog" aria-controls="mobile-more-menu" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">more_vert</span></button>
              <div class="mobile-more-menu" id="mobile-more-menu" role="dialog" aria-label="More document actions" hidden></div>
            </div>
          </div>
        </header>
        <div class="share-live" id="share-live" role="status" aria-live="polite" aria-atomic="true"></div>
        <aside class="share-error" id="share-error" aria-label="Sharing feedback" hidden>
          <div id="share-error-message" aria-hidden="true"><span id="share-error-text"></span></div>
          <div class="share-error-actions"><button type="button" class="topbar-btn" id="share-retry">Retry</button><button type="button" class="topbar-btn" id="share-dismiss">Dismiss</button></div>
        </aside>
        <div class="shell-hotzone shell-hotzone-top" id="shell-hotzone-top" aria-hidden="true"></div>
        <div class="shell-hotzone shell-hotzone-left" id="shell-hotzone-left" aria-hidden="true"></div>
        <button class="mobile-tree-backdrop" id="mobile-tree-backdrop" type="button" aria-label="Close document tree"></button>

        <aside class="sidebar" id="doc-sidebar" aria-labelledby="doc-sidebar-title">
          <div class="sidebar-divider" id="doc-sidebar-title">Docs</div>
          <RepoSearch />
          <div class="sidebar-tree" data-tree-org={org} data-document-base={options.basePath} data-frame-base={options.frameBase}>
            <div class="tree-stack" id="tree-container" style="position:relative">
              <div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>
              <TreeSkeleton />
            </div>
          </div>
        </aside>

        <main class="main">
          <div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-controls="doc-sidebar" aria-label="Resize document tree" aria-valuemin="220" aria-valuemax="420" aria-valuenow="280" aria-valuetext="Document tree 280 pixels wide" tabindex={0}><span class="resizer-sparks resizer-sparks-top" aria-hidden="true"></span><span class="resizer-sparks resizer-sparks-bottom" aria-hidden="true"></span></div>
          <div class="main-placeholder" id="main-placeholder">
            <div class="ph-icon"><span class="material-symbols-outlined" aria-hidden="true" style="font-size:32px;color:#71717a">edit_document</span></div>
            <h2>Select a document</h2>
            <p>Choose a document from the sidebar to view its contents, or create a new page to start writing.</p>
          </div>
          <iframe name="content-frame" id="content-frame" class="content-frame" src="about:blank" title="Document content" style="display:none" sandbox="allow-scripts allow-forms allow-popups allow-downloads"></iframe>
        </main>

        <InlineScript code={shellScript} />
        <InlineScript code={bootstrap} />
        <CommentRecovery userId={null} />
        {options.repoCommentConfig.convexUrl && <script nonce={nonce} src={`/commentor-parent.js?v=${COMMENTOR_PARENT_VERSION}`}></script>}
        <script nonce={nonce} src={`/lazy-tree.js?v=${LAZY_TREE_VERSION}`}></script>
        {options.privateViewerBase !== undefined && <ParentViewer base={options.privateViewerBase} />}
        {/* Real-user monitoring (#282): async, so it never holds up parsing or the first document. */}
        {options.monitoring && <script nonce={nonce} async src={`/rum.js?v=${RUM_VERSION}`}></script>}
      </body>
    </html>
  );
}

export function renderScopedDocumentShell(options: ScopedDocumentShellOptions): string {
  return renderHtml(<ShellDocument {...options} />, "<!DOCTYPE html>\n");
}
