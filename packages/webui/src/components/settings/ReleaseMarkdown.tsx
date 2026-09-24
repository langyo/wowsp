import { defineComponent, type VNode } from "vue";

import { openExternal } from "@/utils/openExternal";

/** Parsed block model: GitHub release notes are headings, bullet lists
 *  and loose paragraphs (the auto-generated "What's Changed" layout). */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "para"; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^[-*+]\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item[1].trim());
      else blocks.push({ kind: "list", items: [item[1].trim()] });
      continue;
    }
    blocks.push({ kind: "para", text: line.trim() });
  }
  return blocks;
}

/** Inline spans: `**bold**` and `[label](https://…)` links. Links open
 *  through the Rust shell (`openExternal`) like every other external URL
 *  in the app; nothing is ever rendered as raw HTML. */
const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * ReleaseMarkdown — the tiny subset of markdown GitHub release notes
 * actually use (## / ### headings, `- ` bullets, bold, links), rendered
 * as plain vnodes. No markdown dependency, no v-html: the release body
 * is third-party text and stays structural text.
 */
export default defineComponent({
  name: "ReleaseMarkdown",
  props: {
    source: { type: String, required: true },
  },
  setup(props) {
    function renderInline(text: string) {
      const out: (string | VNode)[] = [];
      // A shared regex keeps lastIndex state; re-instantiate per call.
      const re = new RegExp(INLINE_RE.source, "g");
      let last = 0;
      let key = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1] !== undefined) {
          out.push(<strong key={`b${key++}`}>{m[1]}</strong>);
        } else {
          const url = m[3];
          out.push(
            <button
              key={`l${key++}`}
              type="button"
              class="release-md__link"
              onClick={() => void openExternal(url)}
            >
              {m[2]}
            </button>,
          );
        }
        re.lastIndex = last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    return () => {
      const blocks = parseBlocks(props.source);
      if (!blocks.length) return null;
      return (
        <div class="release-md">
          {blocks.map((b, i) => {
            if (b.kind === "heading") {
              // The release's ## section titles read as the pane's own
              // h3; deeper levels (### ✨ Features) step down to h4.
              return b.level <= 2 ? (
                <h3 key={i} class="release-md__heading release-md__heading--major">
                  {renderInline(b.text)}
                </h3>
              ) : (
                <h4 key={i} class="release-md__heading">
                  {renderInline(b.text)}
                </h4>
              );
            }
            if (b.kind === "list") {
              return (
                <ul key={i} class="release-md__list">
                  {b.items.map((item, j) => (
                    <li key={j} class="release-md__item">
                      {renderInline(item)}
                    </li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={i} class="release-md__para">
                {renderInline(b.text)}
              </p>
            );
          })}
        </div>
      );
    };
  },
});
