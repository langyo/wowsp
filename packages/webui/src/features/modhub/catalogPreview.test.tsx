/** CatalogPreviewMedia's play-gate contract (user report 2026-11-25): the
 *  gate surface carries ONLY the play button — a posterless entry keeps the
 *  bare dark gate, because the standard line under the media already names
 *  the format and the old centered Clapperboard caption collided with the
 *  centered play button on top of it. The standard caption stays BELOW the
 *  gate, a poster still renders, and the started player rides the shared
 *  asset-preview video card vocabulary the installed/layer panes use. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@celestia-island/hikari", () => ({
  // A plain button passthrough so the gate's single-button shape and its
  // class hooks stay assertable (the real HkButton renders extra chrome).
  HkButton: defineComponent({
    name: "HkButton",
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () =>
        h("button", { type: "button", ...attrs, class: ["hk-btn", attrs.class] }, [
          slots.default?.(),
        ]);
    },
  }),
  HkMediaPlayer: defineComponent({
    name: "HkMediaPlayer",
    props: ["src", "type", "poster"],
    setup() {
      return () => h("div", { class: "hk-media-player-stub" });
    },
  }),
}));

import CatalogPreviewMedia from "./CatalogPreview";

enableAutoUnmount(afterEach);

const mountGate = (posterSrc = "") =>
  mount(CatalogPreviewMedia, {
    props: {
      videoSrc: "https://hub.example/clip.mp4",
      posterSrc,
      alt: "Clip",
    },
  });

describe("CatalogPreviewMedia play gate", () => {
  it("carries only the play button inside a posterless gate", () => {
    const wrapper = mountGate();
    const gate = wrapper.find(".catalog-preview__gate");
    expect(gate.exists()).toBe(true);
    // Exactly ONE button — the play CTA — and no standard text inside.
    expect(gate.findAll("button")).toHaveLength(1);
    expect(gate.find("button").text()).toBe("resources.previewVideo.play");
    expect(gate.find(".catalog-preview__standard").exists()).toBe(false);
    expect(gate.find("img").exists()).toBe(false);
  });

  it("keeps the standard caption below the gate", () => {
    const wrapper = mountGate();
    const children = wrapper.find(".catalog-preview").element.children;
    expect(children).toHaveLength(2);
    expect(children[0].classList.contains("catalog-preview__gate")).toBe(true);
    expect(children[1].classList.contains("catalog-preview__standard")).toBe(
      true,
    );
    expect(children[1].textContent).toBe("resources.previewVideo.standard");
  });

  it("renders the poster image when the entry carries one", () => {
    const wrapper = mountGate("https://proxy.example/poster.png");
    const img = wrapper.find("img.catalog-preview__poster");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("https://proxy.example/poster.png");
    // Poster + the one play button — no other gate content.
    expect(wrapper.findAll(".catalog-preview__gate button")).toHaveLength(1);
  });

  it("mounts the started player in the shared asset-preview video card", async () => {
    const wrapper = mountGate("https://proxy.example/poster.png");
    await wrapper.find(".catalog-preview__gate button").trigger("click");
    await flushPromises();
    const card = wrapper.find(".asset-preview__videos .asset-preview__video");
    expect(card.exists()).toBe(true);
    expect(
      wrapper.findComponent({ name: "HkMediaPlayer" }).props("src"),
    ).toBe("https://hub.example/clip.mp4");
    expect(wrapper.find(".catalog-preview__gate").exists()).toBe(false);
  });
});
