/** NetworkSection: the settings 网络 diagnostics pane. The api module is
 *  mocked (the same seam the sibling section tests use); the section runs
 *  against the real pinia store and the real i18n tables. Covers the PAC
 *  presentation (info tag + neutral hint, never the old warning div, the
 *  WPAD warning kept), the service-health table rows and the probe
 *  matrix's verdict pills (ok + tooltip'd error). */
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";

import type { NetworkConfig, NetworkProbeReport, UpstreamHostReport } from "@/api";

const mocks = vi.hoisted(() => ({
  api: {
    getNetworkConfig: vi.fn(),
    setNetworkConfig: vi.fn(),
    networkProbe: vi.fn(),
    upstreamHealth: vi.fn(),
  },
}));

vi.mock("@/api", () => ({ api: mocks.api }));
vi.mock("@/stores/settingsSavedFlash", () => ({ notifySettingsSaved: vi.fn() }));

vi.mock("@celestia-island/hikari", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@celestia-island/hikari")>();
  const passthrough = (name: string) =>
    defineComponent({
      name,
      props: { title: { type: String, default: undefined } },
      setup(props, { slots }) {
        return () =>
          h("div", { class: `stub-${name}` }, [
            props.title ? h("span", { class: "stub-title" }, props.title) : null,
            slots.default?.() ?? [],
          ]);
      },
    });
  const HkButton = defineComponent({
    name: "HkButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });
  const HkInput = defineComponent({
    name: "HkInput",
    props: {
      modelValue: { type: String, default: "" },
      placeholder: { type: String, default: "" },
      disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h("input", {
          class: "stub-HkInput",
          value: props.modelValue,
          placeholder: props.placeholder,
          disabled: props.disabled,
          onInput: (event: Event) =>
            emit("update:modelValue", (event.target as HTMLInputElement).value),
        });
    },
  });
  const HkTabs = defineComponent({
    name: "HkTabs",
    props: {
      modelValue: { type: String, default: "" },
      tabs: { type: Array, default: () => [] },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "div",
          { class: "stub-HkTabs" },
          (props.tabs as Array<{ key: string; label: string }>).map((tab) =>
            h(
              "button",
              {
                key: tab.key,
                type: "button",
                "data-tab": tab.key,
                "data-active": tab.key === props.modelValue ? "" : undefined,
                onClick: () => emit("update:modelValue", tab.key),
              },
              tab.label,
            ),
          ),
        );
    },
  });
  const HkTag = defineComponent({
    name: "HkTag",
    props: {
      variant: { type: String, default: "default" },
      size: { type: String, default: "md" },
    },
    setup(props, { slots }) {
      return () =>
        h(
          "span",
          { class: "stub-HkTag", "data-variant": props.variant, "data-size": props.size },
          slots.default?.() ?? [],
        );
    },
  });
  const HkStatusPill = defineComponent({
    name: "HkStatusPill",
    props: {
      state: { type: String, default: "unknown" },
      label: { type: String, default: "" },
      latencyMs: { type: Number, default: undefined },
    },
    setup(props) {
      return () =>
        h("span", {
          class: "stub-HkStatusPill",
          "data-state": props.state,
          "data-label": props.label || undefined,
          "data-latency": props.latencyMs != null ? String(props.latencyMs) : undefined,
        });
    },
  });
  const HkTooltip = defineComponent({
    name: "HkTooltip",
    props: { text: { type: String, required: true } },
    setup(props, { slots }) {
      return () =>
        h("span", { class: "stub-HkTooltip", "data-text": props.text }, slots.default?.() ?? []);
    },
  });
  /** Renders the real column/row contract (titles, align, widths, slot
   *  cells) in plain markup the assertions can query. */
  const HkTable = defineComponent({
    name: "HkTable",
    props: {
      columns: { type: Array, default: () => [] },
      rows: { type: Array, default: () => [] },
      rowKey: { type: String, default: undefined },
      size: { type: String, default: "md" },
    },
    setup(props, { slots }) {
      return () => {
        const columns = props.columns as Array<{ key: string; title: string; align?: string; width?: string }>;
        const rows = props.rows as Record<string, unknown>[];
        return h("table", { class: `stub-HkTable stub-HkTable-${props.size}` }, [
          h("thead", [
            h(
              "tr",
              columns.map((col) =>
                h(
                  "th",
                  { key: col.key, "data-key": col.key, "data-align": col.align, "data-width": col.width },
                  col.title,
                ),
              ),
            ),
          ]),
          h(
            "tbody",
            rows.map((row, i) =>
              h(
                "tr",
                { key: String(props.rowKey != null ? row[props.rowKey] : i) },
                columns.map((col) => {
                  const slot = slots[`cell-${col.key}`];
                  return h("td", { key: col.key, "data-cell": col.key }, [
                    slot ? slot({ row, value: row[col.key], index: i }) : String(row[col.key] ?? ""),
                  ]);
                }),
              ),
            ),
          ),
        ]);
      };
    },
  });
  return {
    ...actual,
    HkButton,
    HkInput,
    HkSettingsGroup: passthrough("HkSettingsGroup"),
    HkSettingsHint: passthrough("HkSettingsHint"),
    HkSettingsSub: passthrough("HkSettingsSub"),
    HkStatusPill,
    HkTable,
    HkTabs,
    HkTag,
    HkTooltip,
  };
});

import { initLocaleMessages, t } from "@/i18n";
import { useSettingsNetworkState } from "@/components/settings/useSettingsNetworkState";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import NetworkSection from "./NetworkSection";

enableAutoUnmount(afterEach);

// Load the real message tables: the assertions compare against the SAME
// localized strings the component renders.
beforeAll(async () => {
  await initLocaleMessages();
});

function systemProxy(overrides: Partial<NetworkProbeReport["system"]> = {}): NetworkProbeReport["system"] {
  return {
    manualProxyEnabled: false,
    pacConfigured: false,
    pacUrl: null,
    pacStatus: null,
    autoDetect: false,
    ...overrides,
  };
}

function probeReport(overrides: Partial<NetworkProbeReport> = {}): NetworkProbeReport {
  return {
    mode: "system",
    effectiveProxy: null,
    proxySource: null,
    system: systemProxy(),
    rows: [],
    directPreferredHosts: [],
    ...overrides,
  };
}

function hostEntry(overrides: Partial<UpstreamHostReport> = {}): UpstreamHostReport {
  return {
    id: "stats-api",
    host: "api.example.invalid",
    purpose: "statsApi",
    realms: ["asia"],
    kind: "stats",
    consecutiveFailures: 0,
    lastSuccessTs: null,
    lastFailureTs: null,
    lastError: null,
    lastElapsedMs: null,
    recorded: false,
    ...overrides,
  };
}

function baseConfig(): NetworkConfig {
  return { mode: "system", proxy: null, resourceCdn: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  mocks.api.getNetworkConfig.mockResolvedValue(baseConfig());
  mocks.api.setNetworkConfig.mockImplementation((config: NetworkConfig) => Promise.resolve(config));
  mocks.api.networkProbe.mockResolvedValue(probeReport());
  mocks.api.upstreamHealth.mockResolvedValue([]);
});

/** The section reads the settings body's shared network state — mount it
 *  through a host that owns the real state hook (its onMounted wiring
 *  needs a live component instance). */
function mountSection() {
  return mount(
    defineComponent({
      name: "NetworkSectionHost",
      setup() {
        const network = useSettingsNetworkState();
        return () => h(NetworkSection, { ctx: { network } as unknown as SettingsBodyCtx });
      },
    }),
    { attachTo: document.body },
  );
}

/** The pane is a diagnostic tool, not a poll: the probe report exists only
 *  after the 测试连接 button fires one. Drive that real flow. */
async function mountAndProbe() {
  const wrapper = mountSection();
  await flushPromises();
  const run = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(t("settings.networkDiagRun")),
  );
  expect(run).toBeTruthy();
  run!.click();
  await flushPromises();
  await flushPromises();
  return wrapper;
}

const bodyText = () => document.body.textContent ?? "";

describe("network diagnostics pane", () => {
  it("renders PAC as an info tag + neutral hint and never as the old warning div; the WPAD warning stays", async () => {
    mocks.api.networkProbe.mockResolvedValue(
      probeReport({
        effectiveProxy: "http://proxy.example:8080",
        proxySource: "pac",
        system: systemProxy({
          pacConfigured: true,
          pacUrl: "http://proxy.example/proxy.pac",
          pacStatus: "loaded",
        }),
      }),
    );
    const wrapper = await mountAndProbe();
    // The tag: neutral info variant, "PAC", beside the effective row's value.
    const tag = document.body.querySelector(".stub-HkTag");
    expect(tag).not.toBeNull();
    expect(tag!.getAttribute("data-variant")).toBe("info");
    expect(tag!.getAttribute("data-size")).toBe("sm");
    expect(tag!.textContent).toBe(t("settings.networkDiagPacTag"));
    // A PAC-resolved policy replaces the raw URL with what the script does.
    expect(bodyText()).toContain(t("settings.networkDiagPacPerHost"));
    // The hint is the muted HkSettingsHint, NOT the warning tint.
    const hints = [...document.body.querySelectorAll(".stub-HkSettingsHint")];
    expect(hints.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacActive")))).toBe(true);
    const warnDivs = [...document.body.querySelectorAll(".settings-modal__netdiagwarn")];
    expect(
      warnDivs.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacActive"))),
    ).toBe(false);
    wrapper.unmount();
    // WPAD keeps its warning div unchanged.
    mocks.api.networkProbe.mockResolvedValue(
      probeReport({ system: systemProxy({ autoDetect: true }) }),
    );
    const wrapper2 = await mountAndProbe();
    expect(
      [...document.body.querySelectorAll(".settings-modal__netdiagwarn")].some((el) =>
        (el.textContent ?? "").includes(t("settings.networkDiagAutoDetect")),
      ),
    ).toBe(true);
    wrapper2.unmount();
  });

  it("renders the PAC fallback hint when the configured script cannot be fetched or parsed", async () => {
    mocks.api.networkProbe.mockResolvedValue(
      probeReport({ system: systemProxy({ pacConfigured: true, pacStatus: "unavailable" }) }),
    );
    await mountAndProbe();
    const hints = [...document.body.querySelectorAll(".stub-HkSettingsHint")];
    expect(hints.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacUnavailable")))).toBe(
      true,
    );
    expect(hints.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacActive")))).toBe(
      false,
    );
  });

  it("marks PAC from the config snapshot before any probe runs", async () => {
    // The shell resolves the channel at config-read time: a PAC policy has
    // no proxy URL to show, so the snapshot's provenance is the pre-probe
    // signal and the tag must appear without the user pressing 测试连接.
    mocks.api.getNetworkConfig.mockResolvedValue({ ...baseConfig(), proxySource: "pac" });
    const wrapper = mountSection();
    await flushPromises();
    expect(mocks.api.networkProbe).not.toHaveBeenCalled();
    const tag = document.body.querySelector(".stub-HkTag");
    expect(tag).not.toBeNull();
    expect(tag!.getAttribute("data-variant")).toBe("info");
    expect(tag!.textContent).toBe(t("settings.networkDiagPacTag"));
    expect(bodyText()).toContain(t("settings.networkDiagPacPerHost"));
    const hints = [...document.body.querySelectorAll(".stub-HkSettingsHint")];
    expect(hints.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacActive")))).toBe(
      true,
    );
    const warnDivs = [...document.body.querySelectorAll(".settings-modal__netdiagwarn")];
    expect(
      warnDivs.some((el) => (el.textContent ?? "").includes(t("settings.networkDiagPacActive"))),
    ).toBe(false);
    wrapper.unmount();
  });

  it("renders health rows with purpose, host and latency pills, and the failing variant", async () => {
    mocks.api.upstreamHealth.mockResolvedValue([
      hostEntry({ id: "ok-host", host: "ok.example.invalid", purpose: "statsApi", recorded: true, lastElapsedMs: 321 }),
      hostEntry({
        id: "bad-host",
        host: "bad.example.invalid",
        purpose: "clans",
        recorded: true,
        consecutiveFailures: 3,
      }),
      hostEntry({ id: "quiet-host", host: "quiet.example.invalid", purpose: "mirror", recorded: false }),
    ]);
    const wrapper = mountSection();
    await flushPromises();
    const tables = document.body.querySelectorAll(".stub-HkTable");
    expect(tables).toHaveLength(1); // no probe report yet — health table only
    // Headers: fixed left-aligned columns.
    const headers = [...tables[0]!.querySelectorAll("th")].map((th) => ({
      key: th.getAttribute("data-key"),
      align: th.getAttribute("data-align"),
      width: th.getAttribute("data-width"),
      title: th.textContent,
    }));
    expect(headers).toEqual([
      { key: "purpose", align: "left", width: expect.any(String), title: t("settings.networkDiagColPurpose") },
      { key: "host", align: "left", width: expect.any(String), title: t("settings.networkDiagColHost") },
      { key: "latency", align: "left", width: expect.any(String), title: t("settings.networkDiagColLatency") },
    ]);
    const rows = [...tables[0]!.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2); // the unrecorded entry is filtered out
    expect(rows[0]!.textContent).toContain(t("upstream.purpose.statsApi"));
    expect(rows[0]!.textContent).toContain("ok.example.invalid");
    const okPill = rows[0]!.querySelector(".stub-HkStatusPill");
    expect(okPill!.getAttribute("data-state")).toBe("ok");
    expect(okPill!.getAttribute("data-latency")).toBe("321");
    expect(rows[1]!.textContent).toContain(t("upstream.purpose.clans"));
    const failPill = rows[1]!.querySelector(".stub-HkStatusPill");
    expect(failPill!.getAttribute("data-state")).toBe("error");
    expect(failPill!.getAttribute("data-label")).toBe(
      t("settings.networkDiagHealthFails", { n: 3 }),
    );
    expect(bodyText()).toContain(t("settings.networkDiagHealthTitle"));
    expect(wrapper.text()).toBeTruthy();
  });

  it("renders probe rows as ok and error pills, with the full error on a tooltip", async () => {
    mocks.api.networkProbe.mockResolvedValue(
      probeReport({
        rows: [
          { endpoint: "github", path: "proxy", ok: true, status: 200, elapsedMs: 123, error: null },
          {
            endpoint: "wg-api",
            path: "direct",
            ok: false,
            status: null,
            elapsedMs: 5000,
            error: "connection timed out after 5000 ms",
          },
        ],
      }),
    );
    await mountAndProbe();
    const table = document.body.querySelector(".stub-HkTable");
    expect(table).not.toBeNull();
    const headers = [...table!.querySelectorAll("th")].map((th) => ({
      key: th.getAttribute("data-key"),
      align: th.getAttribute("data-align"),
      title: th.textContent,
    }));
    expect(headers).toEqual([
      { key: "path", align: "left", title: t("settings.networkDiagColPath") },
      { key: "endpoint", align: "left", title: t("settings.networkDiagColEndpoint") },
      { key: "result", align: "left", title: t("settings.networkDiagColResult") },
    ]);
    const rows = [...table!.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(t("settings.networkDiagPathProxy"));
    expect(rows[0]!.textContent).toContain(t("settings.networkDiagEndpointGithub"));
    const okPill = rows[0]!.querySelector(".stub-HkStatusPill");
    expect(okPill!.getAttribute("data-state")).toBe("ok");
    expect(okPill!.getAttribute("data-label")).toBe("HTTP 200");
    expect(okPill!.getAttribute("data-latency")).toBe("123");
    expect(rows[1]!.textContent).toContain(t("settings.networkDiagPathDirect"));
    const errorCell = rows[1]!.querySelector('[data-cell="result"]')!;
    const tooltip = errorCell.querySelector(".stub-HkTooltip");
    expect(tooltip!.getAttribute("data-text")).toBe("connection timed out after 5000 ms");
    const errorPill = errorCell.querySelector(".stub-HkStatusPill");
    expect(errorPill!.getAttribute("data-state")).toBe("error");
    expect(errorPill!.getAttribute("data-label")).toBe("connection timed out after 5000 ms");
  });
});
