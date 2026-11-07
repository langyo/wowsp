/**
 * The app's 2D-canvas class-glyph painter — a thin re-export of the shared
 * `@wowsp/holo` implementation, so the app's minimap, the site's minimap and
 * the tactical board all draw ONE atlas table.
 *
 * The app used to carry a verbatim copy of the table and the painter; every
 * glyph change then had to be made twice (the auxiliary entry in #1816 was
 * the last one). The module path stays because the minimap painter imports
 * `./shipGlyph` — the call sites did not move.
 */
export { drawShipGlyph } from "@wowsp/holo";
