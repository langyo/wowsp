// @vitest-environment node
/**
 * Contract: the water-meter battle heatmap rides HIKARI'S OWN scroll chrome
 * (the release picked up by this workspace's lockfile), not a platform bar.
 *
 * Why this test exists: the heatmap's scrolling lives entirely in the
 * installed hikari package. Before hikari 0.55.327 the calendar strip was a
 * plain `overflow-x: auto` div, so every platform painted a native
 * horizontal scrollbar under the grid and the chart always opened on the
 * OLDEST day. hikari now mounts the strip on HkScrollContainer (auto-hiding
 * overlay track, `align="center"`), opens it at the `"end"` anchor (newest
 * day) and lights the shared HkEdgeGlow band on the side that still hides
 * content. A version bump can silently regress any of that without touching
 * a single WoWSP file — exactly the class of drift the sibling
 * hikariModalMotion.styles.test.ts was written for.
 *
 * The assertions read the INSTALLED package (resolution through the same
 * exports map the app's sass/vite pipeline uses), so they follow the version
 * pnpm-lock actually pins; and the second half keeps WoWSP's own sheets OFF
 * the scroll surface, because a host override re-adding `overflow` would
 * resurrect the native bar underneath the overlay track.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { compile } from "sass";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);

/** Installed package root. `./package.json` is not in hikari's exports
 *  map, so the root is derived from a resolved component sheet
 *  (<pkg>/src/components/<Sheet>.scss -> <pkg>). */
const resolvedSheet = req.resolve("@celestia-island/hikari/components/HkCalendarHeatmap.scss");
const pkgRoot = dirname(dirname(dirname(resolvedSheet)));
const readPkg = (relativePath: string) => readFileSync(join(pkgRoot, relativePath), "utf8");

/** Compile a shipped sheet the way a host's sass pipeline does. */
function compileSheet(exportsSubpath: string): string {
  return compile(req.resolve(`@celestia-island/hikari/${exportsSubpath}`), {
    style: "expanded",
  }).css.replace(/\r\n/g, "\n");
}

/** Body of the first rule whose selector is exactly `selector` — never a
 *  prefix, so a state rule cannot satisfy an assertion aimed at the base
 *  rule. Flat rules only (nested Sass output is asserted with pattern
 *  matches below). */
function ruleBody(sheet: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped + "\\s*\\{").exec(sheet);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = sheet.indexOf("}", open);
  return close < 0 ? null : sheet.slice(open + 1, close);
}

const heatmapCss = compileSheet("components/HkCalendarHeatmap.scss");
const heatmapTsx = readPkg("src/components/HkCalendarHeatmap.tsx");
const scrollCss = compileSheet("components/HkScrollContainer.scss");
const edgeCss = compileSheet("components/HkEdgeGlow.scss");
const edgeTsx = readPkg("src/components/HkEdgeGlow.tsx");
const overlayChrome = readPkg("src/styles/theme/scrollbar.scss");

describe("hikari's heatmap scroll chrome (installed release)", () => {
  it("has no platform-bar scroller left in the Vue form", () => {
    // Positive control: the scroll host class is still the consumer-facing
    // contract WoWSP and shittim-chest style against (the Vue strip is the
    // HkScrollContainer root, so the class rides the container).
    const scroller = ruleBody(heatmapCss, ".hk-calendar-heatmap-scroll");
    expect(scroller, "the -scroll host rule still exists").not.toBeNull();
    expect(scroller).toContain("margin-top");
    // A native overflow declaration in this rule is the exact regression
    // this release retired: the platform bar would paint under the overlay
    // track.
    expect(scroller, "the scroll host must not own native overflow").not.toMatch(
      /overflow(-[xy])?\s*:/,
    );
    // The sheet MAY keep a plain-form fallback for the Rust/WASM renderer
    // (it renders a div without .hk-scroll-container); it must be scoped off
    // the container form and carry the bar suppression itself. Strip it and
    // the Vue form is native-overflow-free.
    const vueFormOnly = heatmapCss.replace(
      /\.hk-calendar-heatmap-scroll:not\(\.hk-scroll-container\)[^{]*\{[^}]*\}/g,
      "",
    );
    expect(vueFormOnly, "native overflow may only live in the scoped fallback").not.toMatch(
      /overflow-x\s*:\s*(auto|scroll)/,
    );
  });

  it("mounts the heatmap on HkScrollContainer with end focus and the glow", () => {
    // The strip's scroll ownership: horizontal container, center-when-fits,
    // newest-day anchor forwarded from the component's prop, overflow glow.
    // Pin the ACTUAL opening tag, not free text anywhere in the file: a
    // comment or an unrelated string must not satisfy the ownership check.
    const stripTag = /<HkScrollContainer\b[\s\S]*?>/.exec(heatmapTsx)?.[0] ?? "";
    expect(stripTag, "the strip mounts HkScrollContainer").not.toBe("");
    expect(stripTag).toContain('axis="horizontal"');
    expect(stripTag).toContain('align="center"');
    expect(stripTag, "the glow prop rides the container").toContain("overflowGlow");
    expect(stripTag).toContain("anchor={props.anchor}");
    // The default is the user-facing decision: open on the NEWEST day.
    expect(heatmapTsx, "the heatmap's default anchor is end").toMatch(
      /anchor:\s*\{[^}]*default:\s*"end"/,
    );
    // A replaced series must re-park deterministically (range switch), not
    // merely rely on the container's sticky pass.
    expect(heatmapTsx).toContain("scrollToEnd");
    expect(heatmapTsx).toMatch(/watch\(\s*\(\) => props\.days/);
  });

  it("ships the overlay bar as the container's only native-bar-free chrome", () => {
    // Sass flattens the nested suppression, so the owner rule and its
    // pseudo-element pair are asserted as compiled selectors.
    expect(scrollCss).toMatch(
      /\.hk-scroll-container-viewport\s*\{[^}]*overflow:\s*auto/,
    );
    expect(scrollCss, "the Firefox half of the suppression").toMatch(
      /\.hk-scroll-container-viewport\s*\{[^}]*scrollbar-width:\s*none/,
    );
    expect(scrollCss, "the WebKit half of the suppression").toMatch(
      /\.hk-scroll-container-viewport::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    );
    // …and the auto-hiding thumb is the bar the reader actually sees. Pin the
    // selector BOUNDARY: a prefix like .hk-scrollbar-thumb-x must not satisfy
    // the assertion that the shipped chrome still exists.
    expect(overlayChrome, "the track chrome ships").toMatch(/(^|[^\w-])\.hk-scrollbar-track([^\w-]|$)/m);
    expect(overlayChrome, "the thumb chrome ships").toMatch(/(^|[^\w-])\.hk-scrollbar-thumb([^\w-]|$)/m);
  });

  it("ships the reusable edge-glow painter the heatmap lights", () => {
    for (const edge of ["top", "bottom", "left", "right"]) {
      // Sass drops the attribute selector's quotes in its output.
      expect(edgeCss, `the ${edge} band rule exists`).toMatch(
        new RegExp(`\\.hk-edge-glow-band\\[data-edge=["']?${edge}["']?\\]`),
      );
    }
    // The band is the primary-color feathered gradient the settings rail
    // already shipped, extracted into one painter.
    expect(edgeCss).toContain("--hk-edge-glow-color");
    expect(edgeCss).toContain("--hk-edge-glow-feather");
    // Animated only through the registered breathe, and dropped (not the
    // band) under reduced motion.
    expect(edgeCss).toContain("@keyframes hk-edge-glow-breathe");
    expect(edgeCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(edgeCss, "reduced motion keeps the band, drops the loop").toMatch(
      /animation:\s*none/,
    );
    // Decoration only: never announced, never a pointer target.
    expect(edgeTsx).toContain('aria-hidden="true"');
    expect(edgeTsx).toContain("rgb(var(--color-primary) / 32%)");
    expect(edgeCss, "the painter root never takes pointer events").toMatch(
      /\.hk-edge-glow\s*\{[^}]*pointer-events:\s*none/,
    );
  });
});

describe("WoWSP keeps its own sheets off the heatmap's scroll surface", () => {
  /** Every .scss under the webui source tree. */
  function scssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...scssFiles(full));
      else if (entry.name.endsWith(".scss")) out.push(full);
    }
    return out;
  }

  const srcDir = join(process.cwd(), "src");
  const offenders: string[] = [];
  for (const file of scssFiles(srcDir)) {
    const sheet = readFileSync(file, "utf8");
    // Only rules that TARGET the heatmap's scroll host classes matter; the
    // app-wide theme may legitimately touch other hk-scroll-container parts.
    const heatmapRules =
      sheet.match(
        /[^{}]*\.hk-calendar-heatmap(?:-scroll|-body)?[^{}]*\{[^}]*\}/g,
      ) ?? [];
    for (const rule of heatmapRules) {
      if (/overflow(-[xy])?\s*:\s*(auto|scroll|overlay|hidden)/.test(rule)) {
        offenders.push(`${relative(srcDir, file)}: ${rule.trim().slice(0, 120)}`);
      }
    }
  }

  it("no WoWSP rule re-enables (or re-hides) scrolling on the heatmap host", () => {
    expect(offenders, "the host must not re-own the heatmap's scrolling").toEqual([]);
  });

  it("the view does not opt out of hikari's end focus or overflow glow", () => {
    const view = readFileSync(join(srcDir, "views", "PlaytimeView.tsx"), "utf8");
    expect(view).toContain("<HkCalendarHeatmap");
    expect(view, "no anchor=start override").not.toMatch(
      /anchor=\{\s*["']start["']\s*\}/,
    );
    expect(view, "no glow opt-out").not.toMatch(/overflowGlow=\{\s*false\s*\}/);
    expect(view, "no scrollbar opt-out").not.toMatch(/\bscrollbar=\{\s*false\s*\}/);
  });
});
