/** CacheServersSection — the 缓存服务器 pane's ladder + persistence
 *  wiring: the official row renders pinned with the user rows behind it,
 *  the add row persists an https root (official pinned first), the
 *  two-step remove drops a user row, and the master toggle writes
 *  statsCacheEnabled through set_network_config.
 *
 *  The api module is mocked; the section is mounted through a host that
 *  owns the real composable, so the assertions cover the full
 *  composable → component → persist path. */
import { defineComponent } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  probe: vi.fn(),
  autodiscover: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    getNetworkConfig: mocks.getConfig,
    setNetworkConfig: mocks.setConfig,
    statsCacheProbe: mocks.probe,
    statsCacheAutodiscover: mocks.autodiscover,
  },
  OFFICIAL_CACHE_SERVER: "https://wowsp.langyo.xyz",
}));

import { initLocaleMessages, t } from "@/i18n";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import { useSettingsCacheServersState } from "@/components/settings/useSettingsCacheServersState";
import CacheServersSection from "./CacheServersSection";

enableAutoUnmount(afterEach);

const OFFICIAL = "https://wowsp.langyo.xyz";
const USER = "https://legion.example.org";

/** The section under its real composable (the settings body normally
 *  provides this ctx; only the cacheServers slice is consumed). */
let cs: ReturnType<typeof useSettingsCacheServersState> | null = null;
const Host = defineComponent({
  name: "CacheServersHost",
  setup() {
    cs = useSettingsCacheServersState();
    return () => (
      <CacheServersSection ctx={{ cacheServers: cs! } as unknown as SettingsBodyCtx} />
    );
  },
});

function mountSection(): void {
  cs = null;
  mount(Host, { attachTo: document.body });
}

async function open(): Promise<void> {
  mountSection();
  await cs!.load();
  await flushPromises();
}

/** Click the first button whose aria-label matches. */
async function clickAria(label: string): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(btn, "button with aria-label " + label).toBeTruthy();
  btn!.click();
  await flushPromises();
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  document.body.innerHTML = "";
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getConfig.mockResolvedValue({
    mode: "system",
    proxy: null,
    resourceCdn: null,
    statsCacheEnabled: true,
    statsCacheServers: [OFFICIAL, USER],
    statsPeerAutodiscover: true,
  });
  // The shell echoes the sanitized payload — the composable adopts it.
  mocks.setConfig.mockImplementation(async (cfg: unknown) => cfg);
  mocks.probe.mockResolvedValue([]);
  mocks.autodiscover.mockResolvedValue(["https://mesh-a.example.org"]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CacheServersSection", () => {
  it("renders the official row pinned with the user rows behind it", async () => {
    await open();
    const html = document.body.innerHTML;
    expect(html).toContain(OFFICIAL);
    expect(html).toContain(USER);
    expect(html).toContain(t("cacheServers.officialRow"));
    expect(html).toContain(t("cacheServers.officialTag"));
    expect(html).toContain(t("cacheServers.userTag"));
    // The official row has no remove control; the user row has one —
    // exactly ONE remove button renders for the single user row.
    const removeButtons = [...document.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-label") === t("cacheServers.remove"),
    );
    expect(removeButtons.length).toBe(1);
  });

  it("persists an added server with the official root pinned first", async () => {
    await open();
    const input = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === t("cacheServers.addPlaceholder"),
    );
    expect(input).toBeTruthy();
    input!.value = "https://mesh.example.org";
    input!.dispatchEvent(new Event("input"));
    await flushPromises();
    // The add button carries no aria-label — match by its translated
    // caption like SelfhostWizard's helpers.
    const addBtn = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("cacheServers.addButton")),
    );
    expect(addBtn).toBeTruthy();
    addBtn!.click();
    await flushPromises();
    expect(mocks.setConfig).toHaveBeenCalledTimes(1);
    const payload = mocks.setConfig.mock.calls[0][0] as { statsCacheServers: string[] };
    expect(payload.statsCacheServers).toEqual([OFFICIAL, USER, "https://mesh.example.org"]);
    // The draft cleared on success.
    const draft = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === t("cacheServers.addPlaceholder"),
    );
    expect((draft as HTMLInputElement | undefined)?.value ?? "").toBe("");
  });

  it("removes a user row through the two-step confirm", async () => {
    await open();
    // Step 1 arms (the label flips to the confirm wording).
    await clickAria(t("cacheServers.remove"));
    expect(document.body.innerHTML).toContain(
      'aria-label="' + t("cacheServers.removeConfirm") + '"',
    );
    // Step 2 confirms — the ladder loses the user row, official stays.
    await clickAria(t("cacheServers.removeConfirm"));
    expect(mocks.setConfig).toHaveBeenCalledTimes(1);
    const payload = mocks.setConfig.mock.calls[0][0] as { statsCacheServers: string[] };
    expect(payload.statsCacheServers).toEqual([OFFICIAL]);
  });

  it("probes every visible row through test-all and folds the pills", async () => {
    mocks.probe.mockResolvedValue([
      {
        url: OFFICIAL,
        ok: true,
        latencyMs: 42,
        capabilities: { gateway: true, lookup: true, peers: true, blocks: true },
        error: null,
      },
      {
        url: USER,
        ok: true,
        latencyMs: 5000,
        // Alive but gateway-only: the no-lookup pill state.
        capabilities: { gateway: true, lookup: false, peers: false, blocks: false },
        error: null,
      },
    ]);
    await open();
    const testAll = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("cacheServers.testAll")),
    );
    expect(testAll).toBeTruthy();
    testAll!.click();
    await flushPromises();
    // The probe walked exactly the visible rows (official pinned + user).
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.probe.mock.calls[0][0]).toEqual([OFFICIAL, USER]);
    const html = document.body.innerHTML;
    expect(html).toContain(t("cacheServers.probeNoLookup"));
    // A refused probe (older shell) clears the pending marks instead of
    // leaving rows spinning — the pills fall back to untested.
    mocks.probe.mockRejectedValue(new Error("command missing"));
    const testAllAgain = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("cacheServers.testAll")),
    );
    testAllAgain!.click();
    await flushPromises();
    expect(document.body.innerHTML).toContain(t("cacheServers.probeUntested"));
  });

  it("previews verified community nodes through discover-now", async () => {
    await open();
    const discover = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("cacheServers.discoverNow")),
    );
    expect(discover).toBeTruthy();
    discover!.click();
    await flushPromises();
    expect(mocks.autodiscover).toHaveBeenCalledTimes(1);
    const html = document.body.innerHTML;
    expect(html).toContain(
      t("cacheServers.discoveredCount", { count: 1 }).split(" ").slice(0, 2).join(" "),
    );
    expect(html).toContain("https://mesh-a.example.org");
    // The preview never auto-adds: no config write happened.
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it("rejects a non-https add draft without persisting", async () => {
    await open();
    const input = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === t("cacheServers.addPlaceholder"),
    );
    input!.value = "http://insecure.example.org";
    input!.dispatchEvent(new Event("input"));
    await flushPromises();
    const addBtn = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(t("cacheServers.addButton")),
    );
    addBtn!.click();
    await flushPromises();
    expect(mocks.setConfig).not.toHaveBeenCalled();
    // The draft stays for the user to fix.
    expect(input!.value).toBe("http://insecure.example.org");
  });

  it("persists the master toggle through set_network_config", async () => {
    await open();
    const switches = [
      ...document.querySelectorAll("input.hk-switch-input"),
    ] as HTMLInputElement[];
    expect(switches.length).toBeGreaterThanOrEqual(2);
    switches[0]!.checked = false;
    switches[0]!.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(mocks.setConfig).toHaveBeenCalledTimes(1);
    const payload = mocks.setConfig.mock.calls[0][0] as { statsCacheEnabled: boolean };
    expect(payload.statsCacheEnabled).toBe(false);
  });
});
