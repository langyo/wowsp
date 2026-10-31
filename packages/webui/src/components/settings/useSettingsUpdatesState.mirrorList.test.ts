/** Mirror-ladder hook behavior (useSettingsUpdatesState): add (normalize,
 *  dedupe, invalid-URL guard), remove, and the probe fold. Persistence
 *  rides the real cache store against a mocked api layer, so the
 *  saveMirrors round-trip (spread + sanitized adoption) is exercised too. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
  getNetworkConfig: vi.fn(),
  setNetworkConfig: vi.fn(),
  githubMirrorLadder: vi.fn(),
  githubMirrorProbe: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));
// settingsUi drags the router graph in — the hook never touches it.
vi.mock("@/stores/settingsUi", () => ({
  SETTINGS_ANCHOR_BAKED_MODELS: "baked-models",
  useSettingsUiStore: () => ({ show: vi.fn() }),
}));

import { settingsSavedFlash } from "@/stores/settingsSavedFlash";
import { useSettingsUpdatesState } from "./useSettingsUpdatesState";

/** The ladder the mocked backend answers (the real contract set). */
const LADDER = {
  official: "https://github.com",
  builtIn: [
    "https://ghp.ci",
    "https://gh-proxy.com",
    "https://ghfast.top",
    "https://ghproxy.net",
  ],
  user: [] as string[],
};

/** The config round-trip: setNetworkConfig echoes what it was sent (the
 *  shell's sanitized-adoption contract, reduced to its mirror fields). */
function echoConfig(config: { githubMirrors?: string[] | null }) {
  return { mode: "none", ...config };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  settingsSavedFlash.value = false;
  mocks.getNetworkConfig.mockResolvedValue(echoConfig({ githubMirrors: [] }));
  mocks.setNetworkConfig.mockImplementation(async (config: { githubMirrors?: string[] | null }) =>
    echoConfig(config),
  );
  mocks.githubMirrorLadder.mockResolvedValue(structuredClone(LADDER));
  mocks.githubMirrorProbe.mockResolvedValue([]);
});

describe("useSettingsUpdatesState mirror ladder", () => {
  it("lazily loads the ladder once and re-syncs the cache store list", async () => {
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    await state.ensureLadder();
    expect(mocks.githubMirrorLadder).toHaveBeenCalledTimes(1);
    expect(state.ladder.value).toEqual(LADDER);
    expect(state.mirrorRows.value.map((r) => r.kind)).toEqual([
      "official",
      "builtin",
      "builtin",
      "builtin",
      "builtin",
    ]);
  });

  it("falls back to the static ladder when the command is missing", async () => {
    mocks.githubMirrorLadder.mockRejectedValue(new Error("no such command"));
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    expect(state.ladder.value.official).toBe("https://github.com");
    expect(state.ladder.value.builtIn).toHaveLength(4);
  });

  it("adds a normalized custom mirror through saveMirrors", async () => {
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    state.newMirrorDraft.value = "https://mirror.example.com/";
    await state.addMirror(state.newMirrorDraft.value);
    // The trailing slash was stripped before persisting.
    expect(mocks.setNetworkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ githubMirrors: ["https://mirror.example.com"] }),
    );
    expect(state.ladder.value.user).toEqual(["https://mirror.example.com"]);
    expect(state.newMirrorDraft.value).toBe("");
    expect(settingsSavedFlash.value).toBe(true);
  });

  it("rejects a draft without the https:// prefix", async () => {
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    await state.addMirror("http://insecure.example.com");
    expect(mocks.setNetworkConfig).not.toHaveBeenCalled();
    expect(state.ladder.value.user).toEqual([]);
  });

  it("dedupes against built-in rows without a second write", async () => {
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    await state.addMirror("https://ghp.ci");
    expect(mocks.setNetworkConfig).not.toHaveBeenCalled();
    expect(state.newMirrorDraft.value).toBe("");
  });

  it("removes a custom mirror and its probe state", async () => {
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    await state.addMirror("https://mirror.example.com");
    state.probeState.value["https://mirror.example.com"] = {
      prefix: "https://mirror.example.com",
      ok: false,
      elapsedMs: 8000,
      error: "timeout",
    };
    mocks.setNetworkConfig.mockClear();
    await state.removeMirror("https://mirror.example.com");
    expect(mocks.setNetworkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ githubMirrors: [] }),
    );
    expect(state.ladder.value.user).toEqual([]);
    expect(state.probeState.value["https://mirror.example.com"]).toBeUndefined();
  });

  it("marks every row testing, then folds the probe rows in by prefix", async () => {
    mocks.githubMirrorProbe.mockResolvedValue([
      { prefix: "https://github.com", ok: true, elapsedMs: 180, error: null },
      ...LADDER.builtIn.map((prefix, i) => ({
        prefix,
        ok: i !== 3,
        elapsedMs: 200 + i * 10,
        error: i === 3 ? "timeout" : null,
      })),
    ]);
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    const pending = state.probeMirrors();
    // In-flight: every ladder row reads "testing" (probeState folds in
    // only after the awaited call resolves).
    expect(state.probing.value).toBe(true);
    expect(state.probeState.value["https://github.com"]).toBe("testing");
    await pending;
    expect(state.probing.value).toBe(false);
    expect(state.probeState.value["https://github.com"]).toMatchObject({ ok: true, elapsedMs: 180 });
    expect(state.probeState.value["https://ghproxy.net"]).toMatchObject({ ok: false });
    expect(state.probeState.value["https://ghp.ci"]).toMatchObject({ ok: true });
  });

  it("drops the pending marks when the probe refuses (older shell)", async () => {
    mocks.githubMirrorProbe.mockRejectedValue(new Error("no such command"));
    const state = useSettingsUpdatesState();
    await state.ensureLadder();
    await state.probeMirrors();
    expect(state.probing.value).toBe(false);
    expect(state.probeState.value).toEqual({});
  });
});
