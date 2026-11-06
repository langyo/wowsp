/**
 * ShotFooter contract: the DOM face of the shared share watermark must carry
 * the same fixed blocks the canvas drawFooter paints (brand + tagline,
 * disclaimers, QQ group + project URL) and append the caller's extra lines.
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import ShotFooter from "./ShotFooter";

describe("ShotFooter", () => {
  it("renders the fixed WoWSP watermark blocks", () => {
    const w = mount(ShotFooter);
    expect(w.find(".shot-footer__name").text()).toBe("WoWSP");
    // The test locale has no share messages loaded: the keys come back
    // verbatim, which still pins WHICH strings the footer reads.
    expect(w.find(".shot-footer__tagline").text()).toBe("share.shotTagline");
    expect(w.text()).toContain("share.shotDisclaimer1");
    expect(w.text()).toContain("share.shotDisclaimer2");
    expect(w.text()).toContain("share.shotQqGroup");
    expect(w.text()).toContain("github.com/langyo/wowsp");
    expect(w.find("img.shot-footer__logo").attributes("src")).toBe("/logo.webp");
  });

  it("appends the caller's centered notes and right-side meta lines", () => {
    const w = mount(ShotFooter, {
      props: { notes: ["note-a"], meta: ["meta-a"] },
    });
    expect(w.find(".shot-footer__note").text()).toBe("note-a");
    expect(w.find(".shot-footer__meta").text()).toBe("meta-a");
  });
});
