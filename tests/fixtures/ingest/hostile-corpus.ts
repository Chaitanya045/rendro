/**
 * Hostile inputs for the ingest sanitizer. Every executable payload calls the
 * `__xss(n)` canary, and every exfiltration payload targets evil.invalid, so
 * the Node and Chromium suites can detect any case that survives. These are
 * well-known public test vectors (OWASP cheat sheet, published mXSS research
 * and parser-differential CVEs), grouped by technique.
 */
export interface HostileCase {
  name: string;
  /** "html" is a repo .html file; "markdown" is a .md file with inline HTML. */
  kind: "html" | "markdown";
  source: string;
  /** Text that must survive as visible content, proving the case was neutralized rather than dropped wholesale. */
  keeps?: string;
}

const html = (name: string, source: string, keeps?: string): HostileCase => ({ name, kind: "html", source, keeps });
const md = (name: string, source: string, keeps?: string): HostileCase => ({ name, kind: "markdown", source, keeps });

export const hostileCorpus: HostileCase[] = [
  // Script elements and event handlers
  html("script element", "<p>before</p><script>__xss(1)</script><p>after</p>", "after"),
  html("external script", '<SCRIPT SRC="https://evil.invalid/x.js"></SCRIPT><p>kept</p>', "kept"),
  html("img onerror", '<img src="x" onerror="__xss(2)">'),
  html("mixed-case handler", '<img src="x" OnErRoR="__xss(3)">'),
  html("handler after newline and slash", '<img src="x"/\nonerror=__xss(4)>'),
  html("body onload", '<body onload="__xss(5)"><p>body</p></body>', "body"),
  html("svg onload", '<svg onload="__xss(6)"></svg><p>kept</p>', "kept"),
  html("details ontoggle", '<details open ontoggle="__xss(7)"><summary>s</summary>d</details>', "d"),
  html("autofocus onfocus", '<input autofocus onfocus="__xss(8)">'),
  html("animation event", '<style>@keyframes x{}</style><div style="animation-name:x" onanimationstart="__xss(9)">a</div>', "a"),
  html("media source onerror", '<video><source onerror="__xss(10)"></video><audio src="x" onerror="__xss(11)"></audio>'),
  html("click handler", '<a href="#top" onclick="__xss(12)">link</a>', "link"),
  html("iframe srcdoc", '<iframe srcdoc="<script>parent.__xss(13)</script>"></iframe>'),
  html("object and embed", '<object data="javascript:__xss(14)"></object><embed src="javascript:__xss(15)">'),
  html("marquee and isindex", '<marquee onstart="__xss(16)">m</marquee><isindex type="image" src="x" onerror="__xss(17)">', "m"),
  html("template content", "<template><script>__xss(18)</script><img src=x onerror=__xss(19)></template>"),
  html("onmouseover on allowed tag", '<p onmouseover="__xss(20)" onpointerenter="__xss(21)">hover</p>', "hover"),

  // URL schemes in href and src
  html("javascript href", '<a href="javascript:__xss(22)">a</a>', "a"),
  html("javascript href with entities", '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;__xss(23)">a</a><a href="&#0000106avascript:__xss(24)">b</a>', "b"),
  html("javascript href with hex entity", '<a href="&#x6A;avascript&colon;__xss(25)">a</a>', "a"),
  html("javascript href with tab and newline", '<a href="jav&#x09;ascript:__xss(26)">a</a><a href="java\nscript:__xss(27)">b</a>', "b"),
  html("javascript href with leading space and controls", '<a href=" \u0001javascript:__xss(28)">a</a><a href="JaVaScRiPt:__xss(29)">b</a>', "b"),
  html("vbscript href", '<a href="vbscript:msgbox(30)">a</a>', "a"),
  html("data URLs", '<a href="data:text/html,<script>__xss(31)</script>">a</a><img src="data:image/svg+xml,<svg onload=__xss(32)>"><img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9X194c3MoMzMpPg==">', "a"),
  html("other schemes", '<a href="file:///etc/passwd">f</a><a href="blob:https://evil.invalid/x">b</a><a href="intent://x#Intent;end">i</a><a href="feed:javascript:__xss(34)">r</a>', "r"),
  html("protocol-relative and backslash hosts", '<a href="//evil.invalid/a">a</a><a href="/\\evil.invalid/b">b</a><a href="\\\\evil.invalid\\c">c</a>', "c"),
  html("cite and longdesc", '<blockquote cite="javascript:__xss(35)">q</blockquote><img src="x" longdesc="javascript:__xss(36)">', "q"),

  // SVG and MathML namespace confusion
  html("svg script", "<svg><script>__xss(37)</script></svg>"),
  html("svg foreignObject", "<svg><foreignObject><script>__xss(38)</script><img src=x onerror=__xss(39)></foreignObject></svg>"),
  html("svg xlink href", '<svg><a xlink:href="javascript:__xss(40)"><text>x</text></a></svg>'),
  html("svg animate href", '<svg><a><animate attributeName="href" values="javascript:__xss(41)"/><text>x</text></a></svg>'),
  html("svg set handler", '<svg><set attributeName="onmouseover" to="__xss(42)"/></svg>'),
  html("math href", '<math href="javascript:__xss(43)">m</math>'),
  html("svg style breakout", '<svg></p><style><a id="</style><img src=1 onerror=__xss(44)>">'),
  html("math mglyph style", "<math><mtext><table><mglyph><style><img src=x onerror=__xss(45)>"),
  html("math form nesting", "<form><math><mtext></form><form><mglyph><style></math><img src onerror=__xss(46)>"),
  html("svg p style", "<svg><p><style><img src=x onerror=__xss(47)>"),
  html("math malignmark", "<math><mi><malignmark><style><img src=x onerror=__xss(48)>"),
  html("svg style entity", "<svg><style>&lt;img src=x onerror=__xss(49)&gt;</style></svg>"),
  html("svg title breakout", '<svg><title><img src=x onerror=__xss(50)></title></svg>'),
  html("svg use external", '<svg><use href="https://evil.invalid/s.svg#x"></use></svg><p>u</p>', "u"),
  html("mathml maction", '<math><maction actiontype="statusline" xlink:href="javascript:__xss(118)">x</maction></math>'),

  // Mutation-XSS nesting and raw-text parser differentials
  html("noscript attribute breakout", '<noscript><p title="</noscript><img src=x onerror=__xss(51)>"></noscript>'),
  html("textarea slash end tag", "<textarea></textarea/><img src=x onerror=__xss(52)>"),
  html("xmp passthrough", "<xmp><img src=x onerror=__xss(53)></xmp>"),
  html("noembed and noframes", '<noembed><img title="</noembed><img src=x onerror=__xss(54)>"></noembed><noframes><img src=x onerror=__xss(55)></noframes>'),
  html("title and style raw text", "<title><img src=x onerror=__xss(56)></title><style><img src=x onerror=__xss(57)></style>"),
  html("plaintext", "<plaintext><img src=x onerror=__xss(58)>"),
  html("select template", "<select><template><img src=x onerror=__xss(59)></template></select>"),
  html("table foster parenting", "<table><tr><td>cell</td><img src=x onerror=__xss(60)><style></style></tr></table>", "cell"),
  html("nested anchors", '<a href="https://ok.example/"><a href="javascript:__xss(61)">inner</a></a>', "inner"),
  html("formatting adoption", '<b><p><i>x<a href="javascript:__xss(62)">y</b>z</i></p>', "z"),
  html("unclosed attribute quote", '<img src="x" alt="&quot; onerror=__xss(63) x=&quot;"><p title="`"><img src=x onerror=__xss(64)>`</p>'),
  html("null byte in tag and attribute", "<scr\u0000ipt>__xss(65)</scr\u0000ipt><img src=x on\u0000error=__xss(66)>"),

  // <base>, <meta>, forms, srcset, ping, CSS url()
  html("base href", '<base href="https://evil.invalid/"><a href="page.html">rel</a>', "rel"),
  html("meta refresh to script", '<meta http-equiv="refresh" content="0;url=javascript:__xss(67)">'),
  html("meta refresh to external", '<meta http-equiv="refresh" content="0;url=https://evil.invalid/r">'),
  html("meta csp and charset", '<meta http-equiv="Content-Security-Policy" content="default-src *"><meta charset="utf-7">+ADw-script+AD4-__xss(68)+ADw-/script+AD4-', "ADw"),
  html("form action", '<form action="https://evil.invalid/f" method="post"><input name="q" value="v"><input type="submit"></form><p>after form</p>', "after form"),
  html("formaction", '<form><button formaction="javascript:__xss(69)">go</button><input type="image" src="x" formaction="https://evil.invalid/i"></form>', "go"),
  html("srcset", '<img src="ok.png" srcset="https://evil.invalid/a.png 1x, https://evil.invalid/b.png 2x"><picture><source srcset="https://evil.invalid/c.png"><img src="pic.png"></picture>'),
  html("ping", '<a href="/doc.md" ping="https://evil.invalid/ping">pinged</a>', "pinged"),
  html("css url in style attribute", '<div style="background:url(https://evil.invalid/d.png)">s1</div><p style="background-image:url(\'javascript:__xss(70)\')">s2</p><span style="--x:url(https://evil.invalid/e)">s3</span>', "s3"),
  html("css expression and behavior", '<div style="width:expression(__xss(71));behavior:url(https://evil.invalid/x.htc)">e</div>', "e"),
  html("style element imports", '<style>@import url(https://evil.invalid/g.css); body{background:url(https://evil.invalid/h.png)}</style><p>styled</p>', "styled"),
  html("presentational URL attributes", '<table background="https://evil.invalid/t.png"><tr><td>t</td></tr></table><video poster="https://evil.invalid/p.png"></video>', "t"),
  html("link elements", '<link rel="stylesheet" href="https://evil.invalid/s.css"><link rel="prefetch" href="https://evil.invalid/p"><link rel="import" href="https://evil.invalid/i.html">'),
  html("dom clobbering names", '<img name="getElementById" src="x"><form name="cookie"></form><a id="defaultView" name="__xss">c</a>', "c"),

  // Comments, CDATA and entities
  html("comment hides payload", "<!--<img src=x onerror=__xss(72)>--><p>visible</p>", "visible"),
  html("comment bang close", "<!-- --!><img src=x onerror=__xss(73)> --><p>v</p>", "v"),
  html("abrupt comment close", "<!--><img src=x onerror=__xss(74)>--><!---><img src=x onerror=__xss(75)>-->"),
  html("conditional comment", "<!--[if IE]><script>__xss(76)</script><![endif]--><p>ie</p>", "ie"),
  html("processing instruction", "<?xml version='1.0'?><img src=x onerror=__xss(77)>"),
  html("cdata in html", "<![CDATA[><img src=x onerror=__xss(78)>]]><p>cd</p>", "cd"),
  html("cdata in svg", "<svg><![CDATA[><img src=x onerror=__xss(79)>]]></svg>"),
  html("entity-encoded markup stays text", "<p>&lt;script&gt;__xss(80)&lt;/script&gt; &#x3C;img src=x onerror=__xss(81)&#x3E; &amp;lt;b&amp;gt;</p>", "<script>"),

  // Full repo HTML documents
  html("document head payloads", '<!doctype html><html manifest="https://evil.invalid/m"><head><title>T</title><base href="https://evil.invalid/"><script>__xss(82)</script><link rel="stylesheet" href="https://evil.invalid/s.css"><meta http-equiv="refresh" content="0;url=https://evil.invalid/"></head><body onload="__xss(83)"><h1>Doc</h1></body></html>', "Doc"),
  html("frameset document", '<frameset onload="__xss(84)"><frame src="javascript:__xss(85)"></frameset>'),

  // Markdown-specific vectors
  md("markdown javascript link", "[click](javascript:__xss(86)) [b](<javascript:__xss(87)>) [c](JAVASCRIPT:__xss(88))", "click"),
  md("markdown reference link", "[x][ref]\n\n[ref]: javascript:__xss(89)", "x"),
  md("markdown image scheme", "![alt](javascript:__xss(90)) ![d](data:image/svg+xml,<svg/onload=__xss(91)>)"),
  md("markdown autolink scheme", "<javascript:__xss(92)> <vbscript:msgbox(93)> <data:text/html,x>", "javascript"),
  md("markdown entity in destination", "[e](javascript&#58;__xss(94)) [f](java&#x73;cript:__xss(95))", "e"),
  md("markdown encoded control in destination", "[g](java%0ascript:__xss(96)) [h](%2e%2e/%2e%2e/escape.md)", "g"),
  md("markdown title attribute breakout", '[t](https://ok.example/ "a\\" onclick=\\"__xss(97)")', "t"),
  md("markdown inline html", "Inline <img src=x onerror=__xss(98)> and <a href=\"javascript:__xss(99)\">raw</a>.", "raw"),
  md("markdown html block", "<div onclick=\"__xss(100)\">\n\n**bold** inside\n\n</div>\n\n<script>__xss(101)</script>", "bold"),
  md("markdown code stays text", "`<script>__xss(102)</script>`\n\n```html\n<img src=x onerror=__xss(103)>\n```", "<script>"),
  md("markdown fence info injection", '```js" onmouseover="__xss(104)\nlet a\n```', "let a"),
  md("markdown footnote label", "x[^1]\n\n[^1]: <img src=x onerror=__xss(105)> note", "note"),
  md("markdown heading html", "# Title <img src=x onerror=__xss(106)>\n\n## <svg onload=__xss(107)>", "Title"),
  md("markdown table html", "| a | b |\n|---|---|\n| <img src=x onerror=__xss(108)> | <a href=\"javascript:__xss(109)\">l</a> |", "l"),
  md("markdown alert html", "> [!WARNING]\n> <img src=x onerror=__xss(110)> careful", "careful"),
  md("markdown front matter", "---\ntitle: <script>__xss(111)</script>\n---\n\nbody", "body"),
  md("markdown svg and math", "<svg><script>__xss(112)</script></svg>\n\n<math><mtext><table><mglyph><style><img src=x onerror=__xss(113)>", ""),
  md("markdown nested mxss", '<noscript><p title="</noscript><img src=x onerror=__xss(114)>">', ""),
  md("markdown base and meta", '<base href="https://evil.invalid/">\n\n[rel](page.md)\n\n<meta http-equiv="refresh" content="0;url=https://evil.invalid/">', "rel"),
  md("markdown forms and srcset", '<form action="https://evil.invalid/"><button formaction="javascript:__xss(115)">b</button></form>\n\n<img srcset="https://evil.invalid/s.png 2x" src="ok.png">\n\n<a href="x.md" ping="https://evil.invalid/p">p</a>', "p"),
  md("markdown style url", '<p style="background:url(https://evil.invalid/u.png)">styled</p>', "styled"),
  md("markdown link above repo root", "[up](../../../../outside.md) [abs](/../../etc/passwd)", "up"),
  md("markdown html entity smuggling", "<a href=\"&#x26;#x6A;avascript:__xss(119)\">amp</a> &#60;script&#62;__xss(120)&#60;/script&#62;", "amp"),
  md("markdown comments and cdata", "<!-- <img src=x onerror=__xss(116)> -->\n\n<![CDATA[<img src=x onerror=__xss(117)>]]>\n\ntext", "text"),
];
