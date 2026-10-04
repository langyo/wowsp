/** Default-scheme brand override: the light secondary slot resolves pink
 *  while every other slot of the factory default palette — light primary
 *  and the whole dark (Nord) set — stays exactly as hikari ships it. The
 *  override mutates the shared preset table, so the assertions read it
 *  through hikari's own resolver, the same path the settings swatch and
 *  the mode-token bridge take. */
import { describe, expect, it } from "vitest";

import { getThemeTokens } from "@celestia-island/hikari";

import {
  applyDefaultSchemeBrand,
  DEFAULT_SCHEME_LIGHT_SECONDARY,
} from "./defaultSchemeBrand";

describe("applyDefaultSchemeBrand", () => {
  it("resolves the light secondary slot as pink", () => {
    applyDefaultSchemeBrand();
    const light = getThemeTokens("default", "light");
    expect(light?.secondary).toEqual(DEFAULT_SCHEME_LIGHT_SECONDARY);
    expect(light?.secondary).not.toEqual({ r: 156, g: 106, b: 222 });
  });

  it("leaves the light primary untouched", () => {
    applyDefaultSchemeBrand();
    const light = getThemeTokens("default", "light");
    expect(light?.primary).toEqual({ r: 214, g: 51, b: 132 });
  });

  it("leaves the dark (Nord) palette untouched", () => {
    applyDefaultSchemeBrand();
    const dark = getThemeTokens("default", "dark");
    expect(dark?.primary).toEqual({ r: 136, g: 192, b: 208 });
    expect(dark?.secondary).toEqual({ r: 143, g: 188, b: 187 });
  });

  it("is idempotent across repeated boots", () => {
    applyDefaultSchemeBrand();
    applyDefaultSchemeBrand();
    const light = getThemeTokens("default", "light");
    expect(light?.secondary).toEqual(DEFAULT_SCHEME_LIGHT_SECONDARY);
  });
});
