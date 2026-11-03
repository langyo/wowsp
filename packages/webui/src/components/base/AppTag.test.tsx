/**
 * Contract tests for AppTag — the app's ONE tag primitive on hikari's
 * HkTag base (2026-11-03 tag unification). The contract under test:
 * the hikari anatomy always renders (.hk-tag classes, sm/md scale),
 * the app classes only ADD faces/tones/radius, interactive wraps a real
 * button around the face, and attrs fall through to the right element.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import AppTag from "./AppTag";

enableAutoUnmount(afterEach);

describe("AppTag", () => {
  it("renders hikari's tag anatomy at the app-default sm size", () => {
    const wrapper = mount(AppTag, { slots: { default: () => "ASIA" } });
    const tag = wrapper.find("span.hk-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.classes()).toContain("hk-tag-sm");
    expect(tag.classes()).toContain("hk-tag-default");
    // The app classes ride along; soft is the default face (no face class).
    expect(tag.classes()).toContain("app-tag");
    expect(tag.classes()).toContain("app-tag--default");
    expect(tag.classes()).toContain("app-tag--pill");
    expect(tag.classes().some((c) => c.startsWith("app-tag--") && /solid|outline/.test(c))).toBe(false);
    expect(tag.text()).toBe("ASIA");
  });

  it("maps the app tones onto hikari variants (accent→warning, event→primary)", () => {
    const accent = mount(AppTag, { props: { tone: "accent" } });
    expect(accent.find(".hk-tag").classes()).toContain("hk-tag-warning");
    expect(accent.find(".hk-tag").classes()).toContain("app-tag--accent");
    const event = mount(AppTag, { props: { tone: "event" } });
    expect(event.find(".hk-tag").classes()).toContain("hk-tag-primary");
    expect(event.find(".hk-tag").classes()).toContain("app-tag--event");
  });

  it("carries the solid/outline faces as additive classes", () => {
    const solid = mount(AppTag, { props: { face: "solid", tone: "warning" } });
    expect(solid.find(".hk-tag").classes()).toContain("app-tag--solid");
    const outline = mount(AppTag, { props: { face: "outline" } });
    expect(outline.find(".hk-tag").classes()).toContain("app-tag--outline");
  });

  it("drops the pill radius class when pill={false}", () => {
    const rect = mount(AppTag, { props: { pill: false } });
    expect(rect.find(".hk-tag").classes()).not.toContain("app-tag--pill");
  });

  it("honors size='md' as the explicit larger step", () => {
    const wrapper = mount(AppTag, { props: { size: "md" } });
    expect(wrapper.find(".hk-tag").classes()).toContain("hk-tag-md");
    expect(wrapper.find(".hk-tag").classes()).not.toContain("hk-tag-sm");
  });

  it("falls attrs through onto the tag span when static", () => {
    const wrapper = mount(AppTag, {
      attrs: { "data-hint": "提示", class: "replay-card__pill" },
      slots: { default: () => "行动" },
    });
    const tag = wrapper.find("span.hk-tag.app-tag");
    expect(tag.attributes("data-hint")).toBe("提示");
    // The host class merges onto the SAME element for a static tag.
    expect(tag.classes()).toContain("replay-card__pill");
  });

  it("interactive wraps the face in a real button and routes the click", async () => {
    const onClick = vi.fn();
    const wrapper = mount(AppTag, {
      props: { interactive: true },
      attrs: { onClick, "aria-pressed": "true", class: "resources-chip" },
      slots: { default: () => "战斗 · 63" },
    });
    const btn = wrapper.find("button.app-tag-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("type")).toBe("button");
    expect(btn.attributes("aria-pressed")).toBe("true");
    // The host class lands on the BUTTON (the layout element) while the
    // face classes stay on the inner hikari tag.
    expect(btn.classes()).toContain("resources-chip");
    const tag = btn.find("span.hk-tag.app-tag");
    expect(tag.exists()).toBe(true);
    expect(tag.text()).toBe("战斗 · 63");
    await btn.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders hikari's close button and re-emits close", async () => {
    const wrapper = mount(AppTag, {
      props: { closable: true, closeLabel: "移除" },
      slots: { default: () => "标签" },
    });
    const close = wrapper.find("button.hk-tag-close");
    expect(close.exists()).toBe(true);
    expect(close.attributes("aria-label")).toBe("移除");
    await close.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("never nests a close button inside an interactive tag", () => {
    const wrapper = mount(AppTag, {
      props: { interactive: true, closable: true },
      slots: { default: () => "标签" },
    });
    expect(wrapper.find("button.app-tag-btn button").exists()).toBe(false);
  });

  it("renders the icon slot through hikari's icon anatomy", () => {
    const wrapper = mount(AppTag, {
      slots: { icon: () => <span class="fake-icon" />, default: () => "国服" },
    });
    expect(wrapper.find(".hk-tag-icon .fake-icon").exists()).toBe(true);
  });
});
