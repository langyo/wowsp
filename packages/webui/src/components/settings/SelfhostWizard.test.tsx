/** SelfhostWizard — the repoDir plumbing: the persisted wowsp-checkout
 *  path (localStorage slot in the gateway store) seeds the env step's
 *  input, and the deploy step forwards it together with the domain and
 *  the kv step's namespace id. Empty path fields are omitted so Rust's
 *  auto-probe keeps working.
 *
 *  The api module is mocked; the wizard is driven click-by-click through
 *  its HkStepFlow bodies (buttons matched by their translated labels —
 *  the wizard is open, so HkModal's body is in document.body). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getHealth: vi.fn(),
  selfhostProbe: vi.fn(),
  selfhostStep: vi.fn(),
  publishStart: vi.fn(),
  publishStop: vi.fn(),
  appdataRead: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    gatewayGetConfig: mocks.getConfig,
    gatewaySetConfig: mocks.setConfig,
    gatewayGetHealth: mocks.getHealth,
    gatewaySelfhostProbe: mocks.selfhostProbe,
    gatewaySelfhostStep: mocks.selfhostStep,
    gatewayPublishStart: mocks.publishStart,
    gatewayPublishStop: mocks.publishStop,
    appdataRead: mocks.appdataRead,
    listenGatewayState: () => Promise.resolve(() => undefined),
    listenGatewayBattle: () => Promise.resolve(() => undefined),
    listenGatewaySelfhost: () => Promise.resolve(() => undefined),
  },
  GATEWAY_OFFICIAL_ROOT: "https://wowsp.langyo.xyz/gateway/",
  GATEWAY_ROUTE_RE: /^r:[a-z]{2,5}:[0-9]+$/,
}));

import { initLocaleMessages, t } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import SelfhostWizard from "./SelfhostWizard";

enableAutoUnmount(afterEach);

const REPO = "D:/src/wowsp";

function mountWizard(): void {
  const pinia = createPinia();
  setActivePinia(pinia);
  const gateway = useGatewayStore();
  gateway.setSelfhostRepo(REPO);
  mount(SelfhostWizard, {
    props: { modelValue: true },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
}

/** Click the first document-body button whose label contains the text. */
async function clickButton(label: string): Promise<void> {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  expect(btn, "button containing " + label).toBeTruthy();
  btn!.click();
  await flushPromises();
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.appdataRead.mockRejectedValue(new Error("no cache file"));
  mocks.selfhostProbe.mockResolvedValue({
    nodePath: "node",
    nodeVersion: "v22.14.0",
    npxPath: "npx",
    rustc: "rustc 1.86.0",
    wasmTarget: "wasm32-unknown-unknown",
    workerBuild: "worker-build 0.0.14",
    wranglerAuthed: true,
    account: "mock@example.com",
  });
  mocks.selfhostStep.mockImplementation(async (step: string) => ({
    step,
    kvId: step === "kv-ensure" ? "kv-123" : undefined,
    url: step === "deploy" ? "https://gateway.example.com/gateway/" : undefined,
  }));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SelfhostWizard repoDir plumbing", () => {
  it("forwards the persisted repoDir, domain and kv id to the deploy step", async () => {
    mountWizard();
    await flushPromises();

    // env → next
    await clickButton(t("gateway.selfhostNext"));
    // login (already authed — the button offers re-auth, same step run)
    await clickButton(t("gateway.selfhostReauth"));

    // target: type the domain into the placeholder-named field, validate
    const domainInput = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === t("gateway.selfhostDomainPlaceholder"),
    );
    expect(domainInput).toBeTruthy();
    domainInput!.value = "gateway.example.com";
    domainInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await clickButton(t("gateway.selfhostValidate"));

    // kv: create (forwards repoDir too)
    await clickButton(t("gateway.selfhostKvCreate"));
    expect(mocks.selfhostStep).toHaveBeenCalledWith("kv-ensure", { repoDir: REPO });

    // deploy: domain + the kv step's id + the repoDir
    await clickButton(t("gateway.selfhostDeploy"));
    const deploy = mocks.selfhostStep.mock.calls.find((c) => c[0] === "deploy");
    expect(deploy?.[1]).toEqual({
      domain: "gateway.example.com",
      kvId: "kv-123",
      repoDir: REPO,
    });
  });

  it("omits repoDir when the pref is empty (dev auto-probe path)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const gateway = useGatewayStore();
    gateway.setSelfhostRepo("");
    mount(SelfhostWizard, {
      props: { modelValue: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await flushPromises();

    await clickButton(t("gateway.selfhostNext"));
    await clickButton(t("gateway.selfhostReauth"));
    const domainInput = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === t("gateway.selfhostDomainPlaceholder"),
    );
    domainInput!.value = "gateway.example.com";
    domainInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await clickButton(t("gateway.selfhostValidate"));
    await clickButton(t("gateway.selfhostKvCreate"));

    expect(mocks.selfhostStep).toHaveBeenCalledWith("kv-ensure", {});
  });
});
