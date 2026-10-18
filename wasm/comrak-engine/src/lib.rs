//! A narrow WebAssembly build of the upstream [`comrak`] crate for the ingest
//! pipeline.
//!
//! It exposes exactly the one renderer `src/ingest/markdown-engine.ts` uses, with
//! the same comrak options the previous `comrak-wasm@0.0.11` dependency set, so
//! the HTML output is byte-identical. `unsafe` (raw HTML passthrough) is on
//! purpose: the parse5 allowlist sanitizer downstream is the security boundary,
//! and heading ids/alerts are added after sanitizing.

use comrak::{markdown_to_html, Options};
use wasm_bindgen::prelude::*;

/// The comrak options the ingest renderer sets, mirroring the former
/// `markdown-engine.ts` `OPTIONS` object: the GFM extensions Rendro relies on,
/// plus raw-HTML passthrough and task-list classes.
fn ingest_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.render.r#unsafe = true;
    options.render.tasklist_classes = true;
    options
}

/// Render GitHub-flavoured Markdown to an unsafe HTML string.
///
/// The output is untrusted and must go through the allowlist sanitizer.
#[wasm_bindgen(js_name = markdownToHtml)]
pub fn markdown_to_html_js(markdown: &str) -> String {
    markdown_to_html(markdown, &ingest_options())
}
