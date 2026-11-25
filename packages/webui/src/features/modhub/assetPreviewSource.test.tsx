/** AssetPreview's source routing. The "layer" source must read one managed
 *  layer's app-data store (list / read / absolute-path RPCs), while
 *  "installed" keeps reading the rendered res_mods tree; the store has no
 *  model-preview command, so meshes are dropped from a layer listing. The
 *  suite also pins the cross-store invariants: the audio player's track key
 *  is namespaced per layer (bare layer rels collide across packs), a
 *  listing/read that settles after a switch is discarded, layer switches
 *  re-key the thumbnail caches (installed switches keep them), and an empty
 *  titled section explains itself through emptyNoteKey. The real hikari
 *  player is stubbed so the resolved asset-protocol URL is assertable
 *  without a media stack. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  path: vi.fn(),
  layerList: vi.fn(),
  layerRead: vi.fn(),
  layerPath: vi.fn(),
  play: vi.fn(),
  playedDataUrl: "",
}));

vi.mock("@/api", () => ({
  api: {
    modHubListAssets: mocks.list,
    modHubReadAsset: mocks.read,
    modHubAssetFilePath: mocks.path,
    modHubLayerListAssets: mocks.layerList,
    modHubLayerReadAsset: mocks.layerRead,
    modHubLayerAssetFilePath: mocks.layerPath,
    modHubReadModel: vi.fn(),
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ uiLocale: { value: "en" } }),
}));
vi.mock("@/stores/audioPlayer", () => ({
  useAudioPlayerStore: () => ({ play: mocks.play, active: false, rel: "" }),
}));
vi.mock("@/stores/updater", () => ({ useUpdaterStore: () => ({ portable: false }) }));
// The 3D stage pulls three.js/holo at module load; these paths never render
// it (the layer source drops meshes, the installed one is covered elsewhere).
vi.mock("./ModelStage", () => ({ default: { name: "ModelStage", render: () => null } }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@celestia-island/hikari", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    HkMediaPlayer: defineComponent({
      name: "HkMediaPlayer",
      props: ["src", "type"],
      setup() {
        return () => h("div", { class: "hk-media-player-stub" });
      },
    }),
    HkScrollContainer: defineComponent({
      name: "HkScrollContainer",
      setup(_, { slots }) {
        return () => h("div", { class: "hk-scroll-stub" }, slots.default?.());
      },
    }),
    HkSpinner: defineComponent({
      name: "HkSpinner",
      setup() {
        return () => h("span", { class: "hk-spinner-stub" });
      },
    }),
    useToast: () => ({ show: vi.fn(), error: vi.fn() }),
  };
});

import AssetPreview from "./AssetPreview";

enableAutoUnmount(afterEach);

const video = (rel: string, size = 1024) => ({
  rel,
  size,
  kind: "video",
  ext: "webm",
  playable: true,
});

describe("AssetPreview layer source", () => {
  it("lists and resolves a managed layer's video through the layer store", async () => {
    mocks.layerList.mockResolvedValue([
      video("gui/video/login/main.webm", 4096),
      video("gui/video/login/main_low.webm", 1024),
    ]);
    mocks.layerPath.mockResolvedValue(
      "C:/data/mods/layers/pack_1/2.0/files/gui/video/login/main.webm",
    );
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "pack/1",
        layerVersion: "2.0",
        mode: "video",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(mocks.layerList).toHaveBeenCalledWith("pack/1", "2.0");
    expect(mocks.list).not.toHaveBeenCalled();
    // Only the ONE primary tier resolves a path; the sibling stays a row.
    expect(mocks.layerPath).toHaveBeenCalledWith(
      "pack/1",
      "2.0",
      "gui/video/login/main.webm",
    );
    expect(mocks.path).not.toHaveBeenCalled();
    expect(
      wrapper.findComponent({ name: "HkMediaPlayer" }).props("src"),
    ).toBe(
      "asset://localhost/C:/data/mods/layers/pack_1/2.0/files/gui/video/login/main.webm",
    );
    expect(wrapper.findAll(".asset-preview__video-tier")).toHaveLength(1);
  });

  it("reads layer thumbnails through the layer read command", async () => {
    mocks.layerList.mockResolvedValue([
      {
        rel: "content/gui/tex.dds",
        size: 10,
        kind: "image",
        ext: "dds",
        playable: false,
      },
    ]);
    mocks.layerRead.mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" });
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "layer-a",
        layerVersion: "1.2.3",
        mode: "image",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(mocks.layerRead).toHaveBeenCalledWith(
      "layer-a",
      "1.2.3",
      "content/gui/tex.dds",
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(wrapper.find(".asset-preview__tile img").attributes("src")).toBe(
      "data:image/png;base64,AAA",
    );
  });

  it("hands a layer voice line to the player through the layer read command", async () => {
    mocks.layerList.mockResolvedValue([
      {
        rel: "banks/mods/MyBank/line.wem",
        size: 10,
        kind: "audio",
        ext: "wem",
        playable: true,
      },
    ]);
    mocks.layerRead.mockResolvedValue({ dataUrl: "data:audio/wav;base64,BBB" });
    mocks.play.mockImplementation(
      async (
        _rel: string,
        _name: string,
        loader: () => Promise<string>,
      ) => {
        mocks.playedDataUrl = await loader();
      },
    );
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "voice-a",
        layerVersion: "3.0",
        mode: "audio",
        silentEmpty: true,
      },
    });
    await flushPromises();
    await wrapper.find(".asset-preview__audio-btn").trigger("click");
    await flushPromises();
    expect(mocks.play).toHaveBeenCalled();
    expect(mocks.layerRead).toHaveBeenCalledWith(
      "voice-a",
      "3.0",
      "banks/mods/MyBank/line.wem",
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.playedDataUrl).toBe("data:audio/wav;base64,BBB");
    // The player key is store-namespaced, never a bare layer-relative rel.
    expect(mocks.play.mock.calls[0][0]).toBe(
      "layer:voice-a@3.0/banks/mods/MyBank/line.wem",
    );
  });

  it("namespaces the audio key so shared rels across packs never collide", async () => {
    mocks.layerList.mockResolvedValue([
      {
        rel: "banks/mods/Shared/line.wem",
        size: 10,
        kind: "audio",
        ext: "wem",
        playable: true,
      },
    ]);
    mocks.layerRead
      .mockResolvedValueOnce({ dataUrl: "data:audio/wav;base64,AA" })
      .mockResolvedValueOnce({ dataUrl: "data:audio/wav;base64,BB" });
    const played: string[] = [];
    mocks.play.mockImplementation(
      async (
        _key: string,
        _name: string,
        loader: () => Promise<string>,
      ) => {
        played.push(await loader());
      },
    );
    const packA = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "pack-a",
        layerVersion: "1",
        mode: "audio",
        silentEmpty: true,
      },
    });
    await flushPromises();
    await packA.find(".asset-preview__audio-btn").trigger("click");
    await flushPromises();
    const packB = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "pack-b",
        layerVersion: "1",
        mode: "audio",
        silentEmpty: true,
      },
    });
    await flushPromises();
    await packB.find(".asset-preview__audio-btn").trigger("click");
    await flushPromises();
    const keys = mocks.play.mock.calls.map((call) => call[0]);
    expect(keys).toEqual([
      "layer:pack-a@1/banks/mods/Shared/line.wem",
      "layer:pack-b@1/banks/mods/Shared/line.wem",
    ]);
    expect(keys[0]).not.toBe(keys[1]);
    // Each click fed the player ITS pack's decoded bytes.
    expect(played).toEqual(["data:audio/wav;base64,AA", "data:audio/wav;base64,BB"]);
  });

  it("reloads when the layer ids change", async () => {
    mocks.layerList.mockResolvedValue([]);
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "layer-a",
        layerVersion: "1",
        mode: "image",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(mocks.layerList).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ layerPackId: "layer-b", layerVersion: "2" });
    await flushPromises();
    expect(mocks.layerList).toHaveBeenCalledTimes(2);
    expect(mocks.layerList).toHaveBeenLastCalledWith("layer-b", "2");
  });

  it("drops the thumbnail cache when the layer switches", async () => {
    // A fresh listing per call, like the backend: the ref must change for
    // the eager thumbnail watcher to run again.
    mocks.layerList.mockImplementation(async () => [
      {
        rel: "gui/icons/tile.dds",
        size: 10,
        kind: "image",
        ext: "dds",
        playable: false,
      },
    ]);
    mocks.layerRead
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,AAA" })
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,BBB" });
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "layer-a",
        layerVersion: "1",
        mode: "image",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(wrapper.find(".asset-preview__tile img").attributes("src")).toBe(
      "data:image/png;base64,AAA",
    );
    // The next pack ships the SAME rel: a cache keyed by rel alone would
    // keep showing pack A's thumbnail instead of reading pack B's bytes.
    await wrapper.setProps({ layerPackId: "layer-b" });
    await flushPromises();
    expect(mocks.layerRead).toHaveBeenLastCalledWith(
      "layer-b",
      "1",
      "gui/icons/tile.dds",
    );
    expect(wrapper.find(".asset-preview__tile img").attributes("src")).toBe(
      "data:image/png;base64,BBB",
    );
  });

  it("discards a listing that settles after the layer switched", async () => {
    let resolveLate!: (files: unknown[]) => void;
    const pendingLate = new Promise((resolve) => {
      resolveLate = resolve;
    });
    mocks.layerList
      .mockImplementationOnce(() => pendingLate)
      .mockImplementationOnce(async () => [
        {
          rel: "new/bbb.dds",
          size: 10,
          kind: "image",
          ext: "dds",
          playable: false,
        },
      ]);
    mocks.layerRead.mockResolvedValue({ dataUrl: "data:image/png;base64,BBB" });
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "layer-a",
        layerVersion: "1",
        mode: "image",
        silentEmpty: true,
      },
    });
    expect(mocks.layerList).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ layerPackId: "layer-b" });
    await flushPromises();
    expect(wrapper.find(".asset-preview__tile").attributes("data-hint")).toBe(
      "new/bbb.dds",
    );
    // Layer A's answer arrives last: it must not overwrite B's grid.
    resolveLate([
      { rel: "old/aaa.dds", size: 10, kind: "image", ext: "dds", playable: false },
    ]);
    await flushPromises();
    expect(wrapper.findAll(".asset-preview__tile")).toHaveLength(1);
    expect(wrapper.find(".asset-preview__tile").attributes("data-hint")).toBe(
      "new/bbb.dds",
    );
  });

  it("explains an empty layer preview through the empty-note key", async () => {
    mocks.layerList.mockResolvedValue([]);
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "empty-pack",
        layerVersion: "1",
        mode: "audio",
        silentEmpty: true,
        emptyNoteKey: "resources.layers.previewEmpty",
      },
    });
    await flushPromises();
    expect(wrapper.find(".asset-preview__note").text()).toBe(
      "resources.layers.previewEmpty",
    );
  });

  it("drops model files from a layer listing", async () => {
    mocks.layerList.mockResolvedValue([
      {
        rel: "content/ship.geometry",
        size: 10,
        kind: "model",
        ext: "geometry",
        playable: false,
      },
      {
        rel: "content/ship.dds",
        size: 10,
        kind: "image",
        ext: "dds",
        playable: false,
      },
    ]);
    mocks.layerRead.mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" });
    const wrapper = mount(AssetPreview, {
      props: {
        source: "layer",
        layerPackId: "tex-a",
        layerVersion: "1.0",
        mode: "texture",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(wrapper.findAll(".asset-preview__tile")).toHaveLength(1);
    expect(wrapper.find(".asset-preview__model").exists()).toBe(false);
  });
});

describe("AssetPreview installed source", () => {
  it("keys installed audio by the bare res_mods path", async () => {
    mocks.list.mockResolvedValue([
      {
        rel: "PnFMods/voice/line.wem",
        size: 10,
        kind: "audio",
        ext: "wem",
        playable: true,
      },
    ]);
    mocks.read.mockResolvedValue({ dataUrl: "data:audio/wav;base64,CC" });
    mocks.play.mockResolvedValue(undefined);
    const wrapper = mount(AssetPreview, {
      props: {
        gameRoot: "C:/game",
        relPath: "PnFMods/voice",
        mode: "audio",
        silentEmpty: true,
      },
    });
    await flushPromises();
    await wrapper.find(".asset-preview__audio-btn").trigger("click");
    await flushPromises();
    expect(mocks.play.mock.calls[0][0]).toBe("PnFMods/voice/line.wem");
  });

  it("keeps the thumbnail cache across installed unit switches", async () => {
    // Installed rels are unit-unique: a unit→unit switch must not re-decode
    // the grid (that would be extra IPC + a placeholder flash per tile).
    mocks.list.mockImplementation(async () => [
      {
        rel: "shared/tile.dds",
        size: 10,
        kind: "image",
        ext: "dds",
        playable: false,
      },
    ]);
    mocks.read.mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" });
    const wrapper = mount(AssetPreview, {
      props: {
        gameRoot: "C:/game",
        relPath: "PnFMods/one",
        mode: "image",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ relPath: "PnFMods/two" });
    await flushPromises();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".asset-preview__tile img").attributes("src")).toBe(
      "data:image/png;base64,AAA",
    );
  });

  it("keeps the video path resolution on the res_mods commands", async () => {
    mocks.list.mockResolvedValue([video("gui/video/login/main.webm")]);
    mocks.path.mockResolvedValue(
      "C:/game/bin/1/res_mods/gui/video/login/main.webm",
    );
    const wrapper = mount(AssetPreview, {
      props: {
        gameRoot: "C:/game",
        relPath: "gui/video/login",
        mode: "video",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(mocks.list).toHaveBeenCalledWith("C:/game", "gui/video/login");
    expect(mocks.layerList).not.toHaveBeenCalled();
    expect(mocks.path).toHaveBeenCalledWith(
      "C:/game",
      "gui/video/login/main.webm",
    );
    expect(mocks.layerPath).not.toHaveBeenCalled();
    expect(
      wrapper.findComponent({ name: "HkMediaPlayer" }).props("src"),
    ).toBe(
      "asset://localhost/C:/game/bin/1/res_mods/gui/video/login/main.webm",
    );
  });

  it("keeps model rows for an installed unit's texture listing", async () => {
    mocks.list.mockResolvedValue([
      {
        rel: "content/ship.geometry",
        size: 10,
        kind: "model",
        ext: "geometry",
        playable: false,
      },
      {
        rel: "content/ship.dds",
        size: 10,
        kind: "image",
        ext: "dds",
        playable: false,
      },
    ]);
    mocks.read.mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" });
    const wrapper = mount(AssetPreview, {
      props: {
        gameRoot: "C:/game",
        relPath: "PnFMods/skin",
        mode: "texture",
        silentEmpty: true,
      },
    });
    await flushPromises();
    expect(wrapper.findAll(".asset-preview__tile")).toHaveLength(1);
    expect(wrapper.findAll(".asset-preview__model-row")).toHaveLength(1);
  });
});
