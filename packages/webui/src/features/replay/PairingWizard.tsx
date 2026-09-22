/**
 * Mobile "get replays from the PC" wizard — a sheet-driven flow (hikari
 * HModal auto-docks as a bottom sheet on phone layout):
 *
 *   hosts → [live discovery + saved + manual (collapsed)] ─┐ LAN
 *   hosts → [nothing to configure — straight to the code] ─┘ internet (beta)
 *   pin   → [hikari OTP grid: 6 cells, auto-submit]
 *   remote→ [remote replay list + pulls + game-data sync]
 *
 * LAN hosts come from the UDP discovery stream (`wowsp://pairing-discovery`)
 * — nobody types an IP or a port on a normal network; the old host+port form
 * survives collapsed under "add manually" for AP-isolation edge cases.
 * Internet mode (v2) is PIN-ONLY with zero discovery: the pairing gateway
 * (`gateway.wowsp.langyo.xyz`) is a hidden built-in service, so the phone
 * just enters the 6-digit code shown on the desktop. The mode toggle
 * defaults to internet until the phone has paired with something. The PIN
 * step is the hikari `HOtpInput` everywhere.
 *
 * The discovery listener is tied to THIS component's lifecycle: started when
 * the sheet opens, stopped on close/unmount.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import {
  Check,
  ChevronDown,
  Database,
  Download,
  Laptop,
  Plus,
  X,
} from "@lucide/vue";

import {
  HButton,
  HInput,
  HModal,
  HSpinner,
  HTabs,
  HOtpInput,
  useToast,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  gatewayTarget,
  parseHostInput,
  usePairingStore,
  type PairedHost,
} from "@/stores/pairing";
import type { DiscoveredHost, RemoteReplayEntry } from "@/api";
import { modeColor, modeKey } from "@/utils/modeColors";
import "./PairingWizard.scss";

/** `YYYYMMDD[_HHMMSS]` → locale-friendly date(+time); raw when unparseable. */
function formatDateTime(dt?: string | null): string {
  if (!dt) return "—";
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return dt;
  const [, y, mo, d, hh, mm] = m;
  const hhmm = hh ? ` ${hh}:${mm}` : "";
  return `${y}-${mo}-${d}${hhmm}`;
}

/** Mode pill label with the generic fallback (same rule as the rail cards). */
function modeLabel(e: RemoteReplayEntry): string {
  const key = modeKey(e.matchGroup, e.scenario, e.eventType, e.botCount ?? 0);
  if (!key) return t("replay.mode._fallback");
  const lbl = t(`replay.mode.${key}`);
  return lbl === `replay.mode.${key}` ? t("replay.mode._fallback") : lbl;
}

export default defineComponent({
  name: "PairingWizard",
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ["close", "imported"],
  setup(props, { emit }) {
    const store = usePairingStore();
    const toast = useToast();

    type Step = "hosts" | "pin" | "remote";
    const step = ref<Step>("hosts");
    /** Transport for this session (target + the paired entry once minted). */
    const mode = ref<"lan" | "relay">("lan");
    /** LAN host being paired (discovery row / saved entry / manual form). */
    const lanTarget = ref<{ host: string; port: number; label: string } | null>(null);
    /** The paired entry — the session identity for every remote call. */
    const entry = ref<PairedHost | null>(null);

    // ── hosts step: mode tabs ────────────────────────────────────────────
    function goHosts() {
      step.value = "hosts";
      entry.value = null;
      lanTarget.value = null;
      pinDraft.value = "";
      pinError.value = null;
    }

    function connectLan(host: string, port: number, label: string) {
      mode.value = "lan";
      lanTarget.value = { host, port, label };
      step.value = "pin";
    }

    function goInternetPin() {
      mode.value = "relay";
      step.value = "pin";
    }

    // ── discovery (LAN) ─────────────────────────────────────────────────
    const manualOpen = ref(false);
    const hostDraft = ref("");
    const portDraft = ref("");
    const addError = ref<string | null>(null);

    /** Saved LAN hosts NOT currently visible in the discovery list (the same
     *  desktop shown by both is one row — discovery wins). */
    const savedOnly = computed(() =>
      store.hosts.filter(
        (h) =>
          h.mode === "lan" &&
          !store.discovered.some(
            (d) => d.host.toLowerCase() === h.host.toLowerCase() && d.port === h.port,
          ),
      ),
    );

    /** Validate the manual form and continue to the PIN step. */
    function addAndConnect() {
      const parsed = parseHostInput(hostDraft.value, portDraft.value);
      if (!parsed) {
        addError.value = t("replay.pairing.invalidAddress");
        return;
      }
      addError.value = null;
      connectLan(parsed.host, parsed.port, `${parsed.host}:${parsed.port}`);
    }

    // ── PIN step: hikari OTP grid ────────────────────────────────────────
    const pinDraft = ref("");
    const pinBusy = ref(false);
    const pinError = ref<string | null>(null);

    const pinTargetLabel = computed(() => lanTarget.value?.label ?? "");

    async function submitPin() {
      if (pinBusy.value || pinDraft.value.length !== 6) return;
      pinBusy.value = true;
      pinError.value = null;
      const target =
        mode.value === "relay"
          ? gatewayTarget()
          : lanTarget.value
            ? ({ kind: "lan", host: lanTarget.value.host, port: lanTarget.value.port } as const)
            : null;
      if (!target) {
        pinBusy.value = false;
        return;
      }
      try {
        entry.value = await store.pairAndSave(
          target,
          pinDraft.value.trim(),
          mode.value === "relay" ? t("replay.pairing.internetLabel") : undefined,
        );
        step.value = "remote";
        void loadRemote();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Surface through the OTP's error channel; clear the grid so the
        // next complete entry re-fires autoSubmit.
        pinError.value = message.startsWith("pairing gateway unreachable")
          ? t("replay.pairing.gatewayUnreachable")
          : message;
        pinDraft.value = "";
      } finally {
        pinBusy.value = false;
      }
    }

    // ── remote list + pulls ──────────────────────────────────────────────
    const remoteList = ref<RemoteReplayEntry[]>([]);
    const listBusy = ref(false);
    const listError = ref<string | null>(null);
    /** Remote names pulled successfully this session (replace-set: reactivity). */
    const doneNames = ref<Set<string>>(new Set());

    async function loadRemote() {
      const cur = entry.value;
      if (!cur) return;
      listBusy.value = true;
      listError.value = null;
      try {
        remoteList.value = await store.listRemote(cur);
      } catch (e) {
        listError.value = e instanceof Error ? e.message : String(e);
      } finally {
        listBusy.value = false;
      }
    }

    /** Per-file pull state: store progress + local done bookkeeping. */
    function fileState(name: string): "idle" | "pulling" | "done" | "error" {
      if (doneNames.value.has(name)) return "done";
      const p = store.progressByFile[name];
      if (!p) return "idle";
      if (p.phase === "done") return "done";
      if (p.phase === "error") return "error";
      return "pulling";
    }

    function pctOf(name: string): number {
      const p = store.progressByFile[name];
      if (!p || p.total <= 0) return 0;
      return Math.min(100, Math.round((p.received / p.total) * 100));
    }

    async function download(name: string) {
      const cur = entry.value;
      if (!cur) return;
      if (fileState(name) === "pulling" || fileState(name) === "done") return;
      try {
        await store.pullReplay(cur, name);
        doneNames.value = new Set([...doneNames.value, name]);
        // Let the host view refresh its local list as each file lands.
        emit("imported", doneNames.value.size);
      } catch {
        toast.error(t("replay.pairing.pullFailed", { name }));
      }
    }

    async function downloadAll() {
      const names = remoteList.value
        .map((e) => e.path)
        .filter((n) => fileState(n) === "idle" || fileState(n) === "error");
      // Sequential: pulls are already fast, and one file at a time keeps the
      // (single) progress stream unambiguous.
      for (const n of names) await download(n);
    }

    // ── game-data sync (ship encyclopedia + gameparams caches) ───────────
    const gdBusy = ref(false);
    const gdPct = computed(() => {
      const p = store.gamedataProgress;
      if (!p || p.phase === "error" || p.total <= 0) return 0;
      return Math.min(100, Math.round((p.received / p.total) * 100));
    });
    const gdState = computed<"idle" | "syncing" | "done" | "error">(() => {
      if (gdBusy.value) return "syncing";
      const p = store.gamedataProgress;
      if (!p) return "idle";
      if (p.phase === "done") return "done";
      if (p.phase === "error") return "error";
      return "idle";
    });

    async function syncGamedata() {
      const cur = entry.value;
      if (!cur || gdBusy.value) return;
      gdBusy.value = true;
      try {
        const { files } = await store.syncGamedata(cur);
        toast.success(t("replay.pairing.gamedataDone", { n: files }));
      } catch (e) {
        toast.error(
          t("replay.pairing.gamedataFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        gdBusy.value = false;
      }
    }

    const importedCount = computed(() => doneNames.value.size);
    const pendingCount = computed(
      () => remoteList.value.filter((e) => fileState(e.path) === "pulling").length,
    );

    // ── lifecycle: fresh session per open; discovery tracks the sheet ────

    /** Fresh session per open: reset all state and run the LAN discovery
     *  listener (stopped again on close/unmount). Internet mode is the
     *  DEFAULT while the phone has not paired with anything (the owner
     *  could not find pairing at all — discoverability first). */
    function beginSession() {
      if (!store.loaded) void store.load();
      step.value = "hosts";
      mode.value = store.hosts.length === 0 ? "relay" : "lan";
      entry.value = null;
      lanTarget.value = null;
      hostDraft.value = "";
      portDraft.value = "";
      manualOpen.value = false;
      addError.value = null;
      pinDraft.value = "";
      pinError.value = null;
      remoteList.value = [];
      listError.value = null;
      doneNames.value = new Set();
      store.wireProgressStream();
      void store.startDiscovery();
    }

    watch(
      () => props.open,
      (open) => {
        if (open) {
          beginSession();
        } else {
          void store.stopDiscovery();
        }
      },
    );
    // Deep-link birth (?pairing=1): the sheet mounts already open, so the
    // open-watch above never fires — run the session setup once here.
    if (props.open) beginSession();
    onBeforeUnmount(() => {
      // The listener MUST not outlive the wizard.
      void store.stopDiscovery();
    });

    const title = computed(() =>
      step.value === "pin" ? t("replay.pairing.pinTitle") : t("replay.pairing.title"),
    );

    const footerActions = computed(() => {
      if (step.value === "pin") {
        return [
          {
            label: t("replay.pairing.back"),
            variant: "secondary" as const,
            onClick: goHosts,
          },
          {
            label: t("replay.pairing.pair"),
            variant: "primary" as const,
            loading: pinBusy.value,
            disabled: pinDraft.value.length !== 6,
            onClick: () => void submitPin(),
          },
        ];
      }
      if (step.value === "remote") {
        return [
          {
            label: t("replay.pairing.back"),
            variant: "secondary" as const,
            onClick: goHosts,
          },
          {
            label: t("replay.pairing.downloadAll"),
            variant: "primary" as const,
            loading: pendingCount.value > 0,
            disabled: remoteList.value.length === 0,
            onClick: () => void downloadAll(),
          },
        ];
      }
      return [];
    });

    const renderDiscoveredRow = (d: DiscoveredHost) => (
      <li key={`${d.host}:${d.port}`} class="pairing-wizard__host">
        <button
          type="button"
          class="pairing-wizard__host-main"
          onClick={() => connectLan(d.host, d.port, d.name)}
        >
          <span class="pairing-wizard__host-icon">
            <Laptop size={18} />
          </span>
          <span class="pairing-wizard__host-body">
            <span class="pairing-wizard__host-label">{d.name}</span>
            <span class="pairing-wizard__host-addr">
              {d.host}:{d.port}
            </span>
          </span>
          <span class="pairing-wizard__host-live" aria-hidden="true" />
        </button>
      </li>
    );

    return () => (
      <HModal
        modelValue={props.open}
        onUpdate:modelValue={(v: boolean) => {
          if (!v) emit("close");
        }}
        title={title.value}
        width="30rem"
        footerActions={footerActions.value}
      >
        <div class="pairing-wizard">
          {step.value === "hosts" ? (
            <>
              <HTabs
                block
                variant="segmented"
                modelValue={mode.value}
                onUpdate:modelValue={(v: string) => (mode.value = v === "relay" ? "relay" : "lan")}
                tabs={[
                  { key: "lan", label: t("replay.pairing.tabLan") },
                  { key: "relay", label: t("replay.pairing.tabInternet") },
                ]}
              />

              {mode.value === "lan" ? (
                <>
                  {/* ── live discovery ── */}
                  <div class="pairing-wizard__sub">{t("replay.pairing.discoveryTitle")}</div>
                  {store.discovered.length > 0 ? (
                    <ul class="pairing-wizard__hosts">
                      {store.discovered.map(renderDiscoveredRow)}
                    </ul>
                  ) : (
                    <p class="pairing-wizard__empty">
                      <HSpinner size="sm" tone="current" />
                      {t("replay.pairing.discoverySearching")}
                    </p>
                  )}

                  {/* ── saved hosts the discovery list does not show ── */}
                  {savedOnly.value.length > 0 ? (
                    <>
                      <div class="pairing-wizard__sub">{t("replay.pairing.savedTitle")}</div>
                      <ul class="pairing-wizard__hosts">
                        {savedOnly.value.map((h) => (
                          <li key={`${h.host}:${h.port}`} class="pairing-wizard__host">
                            <button
                              type="button"
                              class="pairing-wizard__host-main"
                              onClick={() => connectLan(h.host, h.port, h.label)}
                            >
                              <span class="pairing-wizard__host-icon">
                                <Laptop size={18} />
                              </span>
                              <span class="pairing-wizard__host-body">
                                <span class="pairing-wizard__host-label">{h.label}</span>
                                <span class="pairing-wizard__host-addr">
                                  {h.host}:{h.port}
                                  {h.lastSeen
                                    ? ` · ${new Date(h.lastSeen).toLocaleDateString()}`
                                    : ""}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="pairing-wizard__host-remove"
                              aria-label={t("replay.pairing.removeHost")}
                              onClick={() => store.removeHost(h.host, h.port)}
                            >
                              <X size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {/* ── manual entry (collapsed; AP-isolation fallback) ── */}
                  <button
                    type="button"
                    class="pairing-wizard__manual-toggle"
                    onClick={() => (manualOpen.value = !manualOpen.value)}
                  >
                    <ChevronDown
                      size={14}
                      class={["pairing-wizard__manual-chevron", { open: manualOpen.value }]}
                    />
                    {t("replay.pairing.manualTitle")}
                  </button>
                  {manualOpen.value ? (
                    <div class="pairing-wizard__form">
                      <HInput
                        modelValue={hostDraft.value}
                        onUpdate:modelValue={(v: string) => (hostDraft.value = v)}
                        placeholder={t("replay.pairing.hostPlaceholder")}
                        spellcheck={false}
                      />
                      <HInput
                        class="pairing-wizard__port"
                        modelValue={portDraft.value}
                        onUpdate:modelValue={(v: string) => (portDraft.value = v)}
                        placeholder={t("replay.pairing.portPlaceholder")}
                        variant="number"
                        submitOnEnter={() => addAndConnect()}
                      />
                      <HButton size="sm" variant="secondary" onClick={addAndConnect}>
                        <Plus size={14} />
                        {t("replay.pairing.add")}
                      </HButton>
                    </div>
                  ) : null}
                  {addError.value ? (
                    <p class="pairing-wizard__error">{addError.value}</p>
                  ) : null}
                </>
              ) : (
                <>
                  {/* ── internet (built-in gateway) ──
                      PIN-only, zero configuration: the gateway is a hidden
                      built-in service, the code comes off the desktop's
                      screen. */}
                  <p class="pairing-wizard__hint">{t("replay.pairing.internetHint")}</p>
                  <HButton
                    block
                    variant="primary"
                    onClick={goInternetPin}
                  >
                    {t("replay.pairing.internetNext")}
                  </HButton>
                </>
              )}
            </>
          ) : null}

          {step.value === "pin" ? (
            <>
              <p class="pairing-wizard__hint">
                {mode.value === "relay"
                  ? t("replay.pairing.pinPromptRelay")
                  : t("replay.pairing.pinPrompt", { label: pinTargetLabel.value })}
              </p>
              <HOtpInput
                length={6}
                separated
                autofocus
                autoSubmit
                modelValue={pinDraft.value}
                onUpdate:modelValue={(v: string) => (pinDraft.value = v)}
                submitOnEnter={() => void submitPin()}
                disabled={pinBusy.value}
                error={pinError.value ?? undefined}
                hint={
                  pinBusy.value
                    ? t("replay.pairing.pinPairing")
                    : t("replay.pairing.pinWhere")
                }
              />
              {pinBusy.value ? (
                <div class="pairing-wizard__pin-busy">
                  <HSpinner size="sm" tone="current" />
                </div>
              ) : null}
            </>
          ) : null}

          {step.value === "remote" && entry.value ? (
            <>
              <div class="pairing-wizard__remote-head">
                <span class="pairing-wizard__remote-addr">
                  {entry.value.mode === "relay"
                    ? entry.value.label
                    : `${entry.value.host}:${entry.value.port}`}
                </span>
                <HButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadRemote()}
                  ariaLabel={t("replay.refresh")}
                >
                  {t("replay.refresh")}
                </HButton>
              </div>

              <div class="pairing-wizard__gamedata">
                <HButton
                  size="sm"
                  variant="secondary"
                  disabled={gdState.value === "syncing"}
                  onClick={() => void syncGamedata()}
                >
                  {gdState.value === "syncing" ? (
                    <HSpinner size="sm" tone="current" />
                  ) : (
                    <Database size={14} />
                  )}
                  {t("replay.pairing.syncGameData")}
                </HButton>
                {gdState.value === "syncing" ? (
                  <span class="pairing-wizard__gamedata-body">
                    <span class="pairing-wizard__gamedata-prog">
                      <span
                        class="pairing-wizard__gamedata-fill"
                        style={{ width: `${gdPct.value}%` }}
                      />
                    </span>
                    <span class="pairing-wizard__gamedata-note">
                      {gdPct.value > 0
                        ? `${gdPct.value}%`
                        : t("replay.pairing.gamedataSyncing")}
                    </span>
                  </span>
                ) : gdState.value === "done" ? (
                  <span class="pairing-wizard__gamedata-note pairing-wizard__gamedata-note--ok">
                    {t("replay.pairing.gamedataDoneShort")}
                  </span>
                ) : gdState.value === "error" ? (
                  <span class="pairing-wizard__gamedata-note pairing-wizard__gamedata-note--bad">
                    {t("replay.pairing.gamedataErrorShort")}
                  </span>
                ) : (
                  <span class="pairing-wizard__gamedata-note">
                    {t("replay.pairing.gamedataHint")}
                  </span>
                )}
              </div>

              {listBusy.value ? (
                <div class="pairing-wizard__remote-loading">
                  <HSpinner size="md" tone="current" />
                </div>
              ) : listError.value ? (
                <p class="pairing-wizard__error">{listError.value}</p>
              ) : remoteList.value.length === 0 ? (
                <p class="pairing-wizard__empty">{t("replay.pairing.remoteEmpty")}</p>
              ) : (
                <ul class="pairing-wizard__entries">
                  {remoteList.value.map((e) => {
                    const st = fileState(e.path);
                    const prog = store.progressByFile[e.path];
                    return (
                      <li key={e.path} class="pairing-wizard__entry">
                        <button
                          type="button"
                          class="pairing-wizard__entry-main"
                          disabled={st === "pulling" || st === "done"}
                          onClick={() => void download(e.path)}
                        >
                          <span class="pairing-wizard__entry-top">
                            <span class="pairing-wizard__entry-ship">
                              {e.ownShipName ?? t("replay.ownShip")}
                            </span>
                            {e.matchGroup ? (
                              <span
                                class="pairing-wizard__entry-pill"
                                style={
                                  modeColor(
                                    e.matchGroup,
                                    e.scenario,
                                    e.eventType,
                                    e.botCount ?? 0,
                                  ) as CSSProperties
                                }
                              >
                                {modeLabel(e)}
                              </span>
                            ) : null}
                          </span>
                          <span class="pairing-wizard__entry-sub">
                            {formatDateTime(e.dateTime)} · {e.mapName ?? t("replay.map.unknown")}
                            {e.playerCount > 0
                              ? ` · ${t("replay.players", { n: e.playerCount })}`
                              : ""}
                          </span>
                          {st === "pulling" ? (
                            <span class="pairing-wizard__entry-progress">
                              <span
                                class="pairing-wizard__entry-progress-fill"
                                style={{ width: `${pctOf(e.path)}%` }}
                              />
                              {prog && prog.total > 0 ? (
                                <span class="pairing-wizard__entry-pct">
                                  {pctOf(e.path)}%
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </button>
                        <span class="pairing-wizard__entry-actions">
                          {st === "done" ? (
                            <span class="pairing-wizard__entry-done" data-hint={t("replay.pairing.pulled")}>
                              <Check size={16} />
                            </span>
                          ) : st === "error" ? (
                            <button
                              type="button"
                              class="pairing-wizard__entry-retry"
                              onClick={() => void download(e.path)}
                              title={prog?.error ?? ""}
                            >
                              {t("common.retry")}
                            </button>
                          ) : st === "pulling" ? (
                            <HSpinner size="sm" tone="current" />
                          ) : (
                            <button
                              type="button"
                              class="pairing-wizard__entry-dl"
                              aria-label={t("replay.pairing.pull")}
                              onClick={() => void download(e.path)}
                            >
                              <Download size={16} />
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {importedCount.value > 0 ? (
                <p class="pairing-wizard__done">
                  {t("replay.pairing.done", { n: importedCount.value })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </HModal>
    );
  },
});
