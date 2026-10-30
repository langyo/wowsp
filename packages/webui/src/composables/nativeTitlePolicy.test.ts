/** Policy fence: wowsp's own markup carries NO native `title=` tooltips.
 *
 * Every hover hint in the app goes through the delegated data-hint channel
 * (this folder) or, for markup hikari itself renders, hikari's document
 * tooltip bridge — a native `title=` attribute is therefore always a
 * regression: it renders the browser's own bubble (unthemed, unfocusable,
 * outside the popup-manager z bands) on any surface that forgot the hook,
 * and it silently double-bubbles nowhere else. This test scans the webui
 * source for `title=` attribute positions and fails on:
 *
 *  - any DOM tag (lowercase-first) carrying `title=` — migrate it to
 *    `data-hint` (+ `aria-label` when the element is icon-only);
 *  - any COMPONENT tag carrying `title=` that is not in HEADING_PROPS —
 *    those components declare `title` as a visible heading/label
 *    (HkModal, HkSettingsGroup, …), which is not a tooltip; a new
 *    heading-prop component joins the set deliberately, with a comment;
 *  - any occurrence whose enclosing tag cannot be recovered — classify it
 *    explicitly (migrate, exclude, or extend the scanner) instead of
 *    leaving it ambiguous.
 *
 * Not attributes, so never flagged: JS declarations (`const title = …`,
 * including JSX-valued ones) and member writes (`document.title = …`).
 *
 * Excluded wholesale: `*.test.*` (fixtures legitimately probe titles),
 * `src/overlay/**` (the game-overlay windows run a non-Vue bootstrap
 * without the tooltip hook — native titles are the only tooltip they have)
 * and this folder's own bridge files (their docs/tests discuss `title=`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Same resolution bootChrome.test.ts uses — vitest rewrites import.meta.url
 * per environment, so derive the package dir from the module file itself. */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(PKG_DIR, "src");

/** Components whose `title` prop is a visible heading/label, NOT a native
 * tooltip attribute. Keep sorted; additions need a one-line justification
 * in the PR that adds them. */
const HEADING_PROPS = new Set([
  "App",
  "AppTitleBar",
  "AsyncSearchCombo",
  "ErrorCard",
  "FilterCategoryChip",
  "HAlert",
  "HkAlert",
  "HkConfirmDialog",
  "HkDrawer",
  "HkEmptyState",
  "HkErrorLanding",
  "HkExpansionPanel",
  "HkLogWindow",
  "HkMenu",
  "HkModal",
  "HkPopover",
  "HkSettingsGroup",
  "HkSettingsSub",
  "HkTitleBar",
  "HMenu", // hikari exports the menu both as HkMenu and the HMenu alias
  "ImageSquareCropModal",
  "PlaytimeBreakdownPie",
]);

/** Heading-prop attributes on MULTILINE component tags whose opening tag
 * sits beyond the scanner's recovery window — pinned by file + exact line
 * content so renumbering cannot silently re-allow a different line. */
const HEADING_PROP_LINES = new Set([
  // <HkPopover …> heading; the popover's props span past the recovery window.
  "components/ships/ShipFilterBar.tsx|title={t(def.title)}",
  // <AsyncSearchCombo …> heading prop on the mod-search combo.
  'views/ResourcesView.tsx|title={t("resources.searchMod")}',
]);

/** Path fragments that never contain migratable markup. */
const SKIP_PATH = [
  /\.test\.[tj]sx?$/,
  /(^|[\\/])overlay([\\/]|$)/,
  /globalTooltip\.ts$/,
  /globalTooltip\.test\.ts$/,
];

interface Violation {
  file: string;
  line: number;
  tag: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".generated") continue;
      walk(p, out);
    } else if (/\.(tsx|ts|vue)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Recover the nearest preceding opening tag for an attribute position. */
function enclosingTag(before: string): string | null {
  const window = before.slice(-400);
  const matches = [...window.matchAll(/<([A-Za-z][\w.:-]*)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/** One `title=` attribute candidate on a line, at its column. */
function titleAttrColumns(raw: string): number[] {
  const cols: number[] = [];
  const re = /\btitle\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) cols.push(m.index);
  return cols;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (SKIP_PATH.some((re) => re.test(rel))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (HEADING_PROP_LINES.has(rel + "|" + trimmed)) continue;
      for (const col of titleAttrColumns(raw)) {
        const linePrefix = raw.slice(0, col);
        // Declarations and member writes are not JSX attributes.
        if (/(\bconst|\blet|\bvar)\s+$/.test(linePrefix)) continue;
        if (/[.?]\s*$/.test(linePrefix)) continue;
        const tag = enclosingTag(lines.slice(0, i).join("\n") + "\n" + raw.slice(0, col));
        if (tag == null) {
          violations.push({ file: rel, line: i + 1, tag: "?", text: trimmed.slice(0, 120) });
        } else if (/^[a-z]/.test(tag)) {
          violations.push({ file: rel, line: i + 1, tag, text: trimmed.slice(0, 120) });
        } else if (!HEADING_PROPS.has(tag)) {
          violations.push({ file: rel, line: i + 1, tag, text: trimmed.slice(0, 120) });
        }
      }
    }
  }
  return violations;
}

describe("native title policy", () => {
  it("wowsp markup carries no native title= tooltips", () => {
    const violations = scan();
    const rendered = violations
      .map((v) => "  " + v.file + ":" + v.line + "  <" + v.tag + ">  " + v.text)
      .join("\n");
    const message = violations.length
      ? "Native title= tooltip(s) found (migrate to data-hint; heading-prop components join HEADING_PROPS with a comment):\n" +
        rendered
      : "";
    expect(message, "found " + violations.length + " native title= occurrence(s)").toBe("");
  });
});
