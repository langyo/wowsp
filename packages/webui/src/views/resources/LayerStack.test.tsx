/** The swimlane's host contract: rows render from the layer list, legacy
 *  rows ride lockedKeys, selection/report/apply stay prop callbacks (never
 *  IPC), and the pending banner appears exactly when the stack is dirty.
 *  The second suite covers the layer detail pane's preview section: which
 *  AssetPreview source + mode each layer category gets, and the legacy
 *  layers' installed-tree video fallback. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";

import { HkDraggableList } from "@celestia-island/hikari";

import type { ModLayer } from "@/api";
import { loadLocaleMessages, t } from "@/i18n";

import type { ResourcesCtx } from "./context";
import LayerStack, { renderLayerDetail } from "./LayerStack";

/* The layer pane's previews are the second suite's unit under test: a stub
 * records every prop set the pane hands to AssetPreview (the real component
 * would reach IPC, and its grid/player are covered by their own tests). The
 * recorder survives vi.mock hoisting through vi.hoisted. */
const previewStub = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@/features/modhub/AssetPreview", async () => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({
      name: "AssetPreview",
      props: [
        "source",
        "gameRoot",
        "relPath",
        "layerPackId",
        "layerVersion",
        "mode",
        "silentEmpty",
        "emptyNoteKey",
      ],
      setup(props) {
        previewStub.calls.push({ ...props });
        return () => null;
      },
    }),
  };
});

enableAutoUnmount(afterEach);
// Render the real labels (rather than raw keys + intlify warnings).
beforeAll(async () => {
  await loadLocaleMessages("en-US");
});

function layer(patch: Partial<ModLayer> & { packId: string }): ModLayer {
  return {
    name: patch.packId,
    version: "1.0.0",
    category: "skin",
    layerClass: "override",
    enabled: true,
    priority: 0,
    slots: [],
    fileCount: 3,
    winningCount: 3,
    shadowedCount: 0,
    coveredBy: null,
    managed: true,
    ...patch,
  };
}

function mountStack(patch: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onReorder = vi.fn();
  const onApply = vi.fn();
  const onOpenReport = vi.fn();
  const onRetry = vi.fn();
  const wrapper = mount(LayerStack, {
    props: {
      layers: [
        layer({ packId: "top", shadowedCount: 2 }),
        layer({ packId: "legacy", managed: false }),
      ],
      rendered: false,
      slotConflicts: [{ slot: "ship:JSB039", packIds: ["top", "legacy"] }],
      onSelect,
      onReorder,
      onApply,
      onOpenReport,
      onRetry,
      ...patch,
    },
  });
  return { wrapper, onSelect, onReorder, onApply, onOpenReport, onRetry };
}

describe("LayerStack swimlane", () => {
  it("renders one lane per layer and locks the legacy rows", () => {
    const { wrapper } = mountStack();
    expect(wrapper.findAll(".layer-lane")).toHaveLength(2);
    expect(wrapper.findAll(".layer-lane--legacy")).toHaveLength(1);
    const list = wrapper.findComponent(HkDraggableList);
    expect(list.props("lockedKeys")).toEqual(["legacy"]);
    expect(list.props("items")).toHaveLength(2);
  });

  it("selects a layer on click and keeps drag/report actions on props", async () => {
    const { wrapper, onSelect, onReorder, onOpenReport } = mountStack();
    await wrapper.findAll(".layer-lane")[0].trigger("click");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ packId: "top" }));
    // The reorder callback is the only drag path — the component never
    // reaches IPC itself.
    const list = wrapper.findComponent(HkDraggableList);
    list.vm.$emit("reorder", 0, 1);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    // Text may be a raw key under the test i18n; the report action is the
    // header strip's first button.
    const report = wrapper.find(".layer-stack__tools button");
    expect(report.exists()).toBe(true);
    await report.trigger("click");
    expect(onOpenReport).toHaveBeenCalled();
  });

  it("shows the pending banner only while the stack is dirty", async () => {
    const clean = mountStack({ rendered: true });
    expect(clean.wrapper.find(".layer-stack__pending").exists()).toBe(false);
    const dirty = mountStack();
    expect(dirty.wrapper.find(".layer-stack__pending").exists()).toBe(true);
    await dirty.wrapper.find(".layer-stack__pending button").trigger("click");
    expect(dirty.onApply).toHaveBeenCalled();
  });
});

/* The detail pane is a render function, not a component (DetailPane mounts
 * it inside its own tree). The host below does exactly that, with a
 * hand-built ResourcesCtx covering the members the layer pane reads. */
function mountLayerDetail(layerEntry: ModLayer) {
  const layers = ref([layerEntry]);
  const ctx = {
    gameRoot: ref("C:/TestGame"),
    busy: ref(new Set<string>()),
    layerStack: {
      layers,
      conflicts: ref([]),
      busy: ref(false),
      layerById: (packId: string) =>
        layers.value.find((entry) => entry.packId === packId) ?? null,
      move: vi.fn(),
      setEnabled: vi.fn(),
    },
    pairedCatalogOfLayer: () => null,
    canUninstallLayer: () => false,
    requestLayerUninstall: vi.fn(),
    layerUpdate: vi.fn(),
  } as unknown as ResourcesCtx;
  const Host = defineComponent({
    name: "LayerDetailHost",
    render() {
      return renderLayerDetail(ctx, layerEntry.packId);
    },
  });
  const wrapper = mount(Host);
  const section = () => wrapper.find(".layer-detail__preview");
  const label = () => section().find(".layer-detail__label").text();
  const hint = () => section().find(".mod-detail__hint").text();
  return { wrapper, section, label, hint };
}

function lastPreview(): Record<string, unknown> {
  return previewStub.calls[previewStub.calls.length - 1];
}

describe("LayerStack layer detail previews", () => {
  beforeEach(() => {
    previewStub.calls.length = 0;
  });

  it("previews a managed voice layer from the layer store", () => {
    const { label, hint } = mountLayerDetail(
      layer({ packId: "voice.pack", category: "voice", version: "2.1.0" }),
    );
    expect(previewStub.calls).toHaveLength(1);
    expect(lastPreview()).toMatchObject({
      source: "layer",
      mode: "audio",
      layerPackId: "voice.pack",
      layerVersion: "2.1.0",
      silentEmpty: true,
      // The titled section explains an empty store instead of leaving the
      // label + hint above nothing.
      emptyNoteKey: "resources.layers.previewEmpty",
    });
    expect(label()).toBe(t("resources.layers.audioTitle"));
    expect(hint()).toBe(t("resources.layers.audioHint"));
  });

  it("keeps the login-video section for video layers and video payloads", () => {
    const video = mountLayerDetail(layer({ packId: "video.pack", category: "video" }));
    expect(video.label()).toBe(t("resources.layers.videoTitle"));
    expect(video.hint()).toBe(t("resources.layers.videoHint"));
    expect(lastPreview()).toMatchObject({
      source: "layer",
      mode: "video",
      layerPackId: "video.pack",
      layerVersion: "1.0.0",
    });

    // A non-video category that still ships video files keeps the player.
    const payload = mountLayerDetail(
      layer({ packId: "video.skin", category: "skin", videoDir: "gui/video/login" }),
    );
    expect(payload.label()).toBe(t("resources.layers.videoTitle"));
    expect(lastPreview()).toMatchObject({
      source: "layer",
      mode: "video",
      layerPackId: "video.skin",
    });
  });

  it("previews material and interface layers as a texture gallery", () => {
    const textures = mountLayerDetail(layer({ packId: "tex", category: "textures" }));
    expect(textures.label()).toBe(t("resources.layers.textureTitle"));
    expect(textures.hint()).toBe(t("resources.layers.textureHint"));
    expect(lastPreview()).toMatchObject({ source: "layer", mode: "image", layerPackId: "tex" });

    const skin = mountLayerDetail(layer({ packId: "skin.pack", category: "skin" }));
    expect(skin.label()).toBe(t("resources.layers.textureTitle"));
    expect(lastPreview()).toMatchObject({ source: "layer", mode: "image", layerPackId: "skin.pack" });
  });

  it("keeps legacy layers on the installed-tree video fallback", () => {
    mountLayerDetail(
      layer({
        packId: "legacy",
        managed: false,
        category: "video",
        videoDir: "gui/video/login",
      }),
    );
    expect(previewStub.calls).toHaveLength(1);
    expect(lastPreview()).toMatchObject({
      source: "installed",
      mode: "video",
      gameRoot: "C:/TestGame",
      relPath: "gui/video/login",
    });
    expect(previewStub.calls.some((call) => call.source === "layer")).toBe(false);
    // The legacy fallback has no store to explain: no empty note key.
    expect(lastPreview().emptyNoteKey).toBeUndefined();
  });

  it("shows no preview at all for a legacy layer with no video payload", () => {
    const { section } = mountLayerDetail(
      layer({ packId: "legacy.skin", managed: false, category: "skin" }),
    );
    expect(previewStub.calls).toHaveLength(0);
    expect(section().exists()).toBe(false);
  });
});
