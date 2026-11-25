// @vitest-environment node
/**
 * Contract: the blocking toast's cancel is the house icon ✕ (hikari
 * 0.55.485), not the text button it used to be — the affordance every
 * consent gate in this app raises (updater idle prompt, pack-update
 * catch-up, mod-conflict gate).
 *
 * Why this test exists: the cancel's SHAPE and its accessible name live
 * entirely in the installed hikari package, so a version bump can move
 * them without touching a single WoWSP file. Before 0.55.485 the card
 * rendered an HButton variant="secondary" whose VISIBLE label was the
 * caller's cancelLabel (取消 / 稍后 / 忽略); the release turns it into the
 * ghost icon button with the same string moved onto aria-label + title.
 * The assertions read the INSTALLED package through the same exports map
 * the app's sass pipeline uses, so they follow whatever pnpm-lock pins —
 * the same drift class the sibling playtimeHeatmap.styles.test.ts covers.
 *
 * The app-side half pins the two host contracts this seat depends on:
 * every consent gate keeps supplying its localized cancelLabel (so the ✕
 * never falls back to hikari's generic "Cancel"), and the theme layer
 * keeps WoWSP's white-ink convention on the warning band's ✕ (the icon
 * button declares ink ON itself through the --hi-icon-button-* bridge
 * instead of inheriting color, so the band must re-pin the bridge).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);

/** Installed package root. ./package.json is not in hikari's exports map,
 *  so the root is derived from a resolved component sheet
 *  (<pkg>/src/components/<Sheet>.scss -> <pkg>). */
const resolvedSheet = req.resolve("@celestia-island/hikari/components/HkBlockingToast.scss");
const pkgRoot = dirname(dirname(dirname(resolvedSheet)));
const readPkg = (relativePath: string) => readFileSync(join(pkgRoot, relativePath), "utf8");

const toastTsx = readPkg("src/components/HkBlockingToast.tsx");
const toastCss = compile(resolvedSheet, { style: "expanded" }).css.replace(/\r\n/g, "\n");

/** The compiled rule body for an exact selector, flat rules only. */
function compiledRule(sheet: string, selector: string): string {
  const at = sheet.indexOf(selector);
  if (at < 0) return "";
  const open = sheet.indexOf("{", at);
  const close = sheet.indexOf("}", open);
  if (open < 0 || close < 0) return "";
  return sheet.slice(open + 1, close);
}

describe("the blocking toast's cancel is the icon ✕ (installed release)", () => {
  it("renders the icon seat, with the label moved onto the accessible name", () => {
    // The seat every consent gate's ✕ now shares, rendered through the
    // house icon button with lucide's X glyph.
    const seatAt = toastTsx.indexOf("hk-blocking-toast-cancel");
    const buttonAt = toastTsx.indexOf("<HIconButton");
    expect(seatAt, "the cancel seat exists in the component source").toBeGreaterThan(-1);
    expect(buttonAt, "the seat renders through the house icon button").toBeGreaterThan(-1);
    expect(buttonAt, "the icon button owns the seat").toBeLessThan(seatAt);
    expect(toastTsx, "the glyph is lucide's X").toContain("<X aria-hidden");
    // The caller's cancelLabel resolves to the control's NAME, never its
    // visible text: both the accessible name and the hover title carry it.
    expect(toastTsx, "aria-label carries the resolved label").toContain(
      "aria-label={cancelText}",
    );
    expect(toastTsx, "the hover title carries the resolved label").toContain(
      "title: cancelText",
    );
    // No text cancel left behind: the old secondary HButton seat is gone.
    expect(toastTsx, "the text cancel is retired").not.toContain('variant="secondary"');
  });

  it("ships the per-band ink bridge the ✕ reads", () => {
    // Each tinted card re-pins the STANDARD icon button's ink at its own
    // seat (the HkToast copy/close grammar): the ✕ must never fall back to
    // the page-secondary default on a filled band. The on-tone variables
    // are the same ones the band text already used.
    for (const [band, ink] of [
      ["info", "--hi-color-text-on-info"],
      ["warning", "--hi-color-text-on-warning"],
      ["danger", "--hi-color-text-on-danger"],
    ] as const) {
      const body = compiledRule(
        toastCss,
        ".hk-blocking-toast-" + band + " .hk-blocking-toast-cancel",
      );
      expect(body, "the " + band + " band pins the ✕ ink").toContain("var(" + ink);
      expect(body, "the " + band + " band wires the active ink too").toContain(
        "--hi-icon-button-icon-color-active: var(" + ink,
      );
    }
    // The dead text-cancel styling is fully retired — a leftover
    // .hk-btn-secondary cancel rule would compete with the icon seat.
    expect(
      compiledRule(toastCss, ".hk-blocking-toast-actions .hk-btn-secondary"),
      "no cancel text-button rules left",
    ).toBe("");
  });
});

describe("WoWSP's own layers meet the new cancel seat", () => {
  const srcDir = join(process.cwd(), "src");
  const readSrc = (relativePath: string) => readFileSync(join(srcDir, relativePath), "utf8");

  it("every consent gate keeps supplying its localized cancelLabel", () => {
    // The three gates' cancelLabels are what the ✕ announces; dropping one
    // would silently downgrade the accessible name to hikari's generic
    // "Cancel"/"取消" and lose the app's own voice.
    for (const [file, key] of [
      ["stores/updater.ts", "about.updateLater"],
      ["stores/cache.ts", "settings.resUpdateLater"],
      ["components/layout/ModConflictToast.tsx", "modConflict.dismiss"],
    ] as const) {
      const source = readSrc(file);
      expect(source, file + " keeps its cancelLabel").toContain(
        'cancelLabel: t("' + key + '")',
      );
    }
  });

  it("keeps the white-ink convention on the warning band's ✕", () => {
    // The warning band forces white text app-side, but the icon button
    // declares its ink ON the button through the bridge rather than
    // inheriting color — the band must re-pin the bridge (this sheet loads
    // after hikari's aggregate, so the same-specificity restatement wins).
    const theme = readSrc("theme/theme.scss");
    const bandAt = theme.indexOf(".hk-blocking-toast-warning");
    expect(bandAt, "the warning band rule exists").toBeGreaterThan(-1);
    const window = theme.slice(bandAt, bandAt + 900);
    expect(window, "the warning band's ✕ bridge is re-pinned white").toContain(
      "--hi-icon-button-icon-color: #fff",
    );
    // Info/danger need no bridge: their ✕ rides the on-tone variable the
    // text cancel already used, which the existing picks drive white.
    const dangerAt = theme.indexOf(".hk-blocking-toast-danger");
    expect(dangerAt, "the danger band ink pick exists").toBeGreaterThan(-1);
    expect(theme.slice(dangerAt, dangerAt + 300)).toContain(
      "--hi-color-text-on-danger: #fff",
    );
  });
});
