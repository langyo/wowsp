/**
 * renderRichText — restricted markdown → HTML for the license step's
 * agreement bodies (the merged copyright/announcement page, the SySL
 * agreement, the full telemetry notice).
 *
 * Dialect — anything not listed below passes through literally, so
 * numbered legal clauses like "1. 定义" survive as plain text (no ordered
 * lists, code blocks or block quotes are implemented on purpose):
 *   blocks: `# ` / `## ` / `### ` headings map to h2/h3/h4 (`#` becomes
 *           h2 so a document never rivals the pane's h1); a line made of
 *           3+ hyphens → <hr>; consecutive `- ` lines gather into a
 *           <ul><li> run; blank lines split paragraphs; a single newline
 *           inside a paragraph renders as <br/> — a hard break, so legal
 *           text keeps its original line folds and full-width typography
 *           instead of being reflowed.
 *   inline (applied in this order): `[text](https://…)` → anchor with
 *           target="_blank" rel="noreferrer"; `**bold**` → <strong>;
 *           then bare http(s) URLs auto-link.
 *
 * Safety order: the WHOLE source is HTML-escaped first (& < > " '), and
 * only then do the transforms run — the renderer never treats source text
 * as trusted markup, so document content cannot introduce any element or
 * attribute beyond what these transforms themselves emit. The bare-URL
 * pass runs last and carries a negative lookbehind that rejects a URL
 * directly preceded by a quote, `=`, or `>` — exactly how the earlier
 * link pass embeds a URL into an href attribute or anchor body — so
 * already-linked URLs are never wrapped a second time.
 */

/** Bare URL: whitespace, the characters the escape pass rewrites (& < >
 *  " ') and the full-width quotes CJK prose closes around a URL with all
 *  end the match — an `&` can never begin an escaped entity mid-match, so
 *  a source quote right after the URL cannot leak into the href. (Real
 *  query strings need `&amp;`: write them as a `[text](url)` markdown
 *  link, whose href keeps the entity and stays HTML-correct.) A quote /
 *  `=` / `>` immediately before the match means it already sits inside
 *  the markup the link pass generated and is skipped. */
const BARE_URL = /(?<!["'=>])(?:https?:\/\/[^\s<>&"']+)/g;

/** Sentence / bracket punctuation allowed to close a sentence around a
 *  bare URL — trimmed off the link so the href stays clean. */
const TRAILING_PUNCT = /[)\]}.,;:!?'"，。；：！？）】》]+$/;

/** Markdown link `[text](https://…)`; the text may hold entities from the
 *  escape pass, the URL runs to the first `)` or whitespace. */
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** `**bold**` — the content itself cannot contain asterisks. */
const BOLD = /\*\*([^*]+)\*\*/g;

const HEADING_TAGS = ["h2", "h3", "h4"] as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline transforms on already-escaped text, in the documented order. */
function renderInline(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(BOLD, "<strong>$1</strong>")
    .replace(BARE_URL, (url: string) => {
      const linked = url.replace(TRAILING_PUNCT, "");
      return `<a href="${linked}" target="_blank" rel="noreferrer">${linked}</a>${url.slice(linked.length)}`;
    });
}

/** Render the restricted markdown dialect to an HTML string (assign via
 *  innerHTML — the input was fully escaped before any transform ran). */
export function renderRichText(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.join("<br/>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(`<ul>${list.join("")}</ul>`);
      list = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      flushAll();
      blocks.push("<hr/>");
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const tag = HEADING_TAGS[heading[1].length - 1];
      blocks.push(`<${tag}>${renderInline(heading[2])}</${tag}>`);
      continue;
    }
    const item = /^-\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(`<li>${renderInline(item[1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(renderInline(line));
  }
  flushAll();
  return blocks.join("\n");
}
