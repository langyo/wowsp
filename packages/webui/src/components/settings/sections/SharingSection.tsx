/** Sharing settings section (录像共享计划): the replay-share status card,
 *  the inline consent → select → upload wizard and the contributors list.
 *  Wire truth: CONTRACT-replay-share.md §10/§11 — the Rust side lives in
 *  commands/contribution/ and every DTO is mirrored in
 *  api/modules/contribution.ts. */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRouter } from "vue-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  Wand2,
} from "@lucide/vue";
import {
  HkAlert,
  HkButton,
  HkCheckbox,
  HkInput,
  HkProgressBar,
  HkSelect,
  HkSettingsGroup,
  HkSettingsHint,
  HkSettingsSub,
  HkSpinner,
  HkStepFlow,
  HkTag,
  useToast,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { api, type ContributionState, type PlanCandidate, type PlanItem, type QueueSnapshot } from "@/api";
import { useReplayStore } from "@/stores/replay";
import ReplayListFilter, {
  FILTER_ANY,
  collectModeOptions,
  collectPlayerOptions,
  filterByClient,
  filterByDateRange,
  filterByPlayer,
  filterReplays,
  modeLabelOfKey,
  replayModeKeyOf,
  sortReplays,
  type ReplaySortDir,
} from "@/features/replay/ReplayListFilter";
import { modeColorOfKey } from "@/utils/modeColors";
import { serverTagOf } from "@/utils/installLabel";
import { displayMapName } from "@/utils/mapNames";
import { formatBytes } from "@/components/settings/useSettingsUpdatesState";
import { runtimeShipEntry } from "@/utils/runtimeShipDb";
import type { ReplayMetaLite } from "@/api";
import shipNamesDbRaw from "@/data/ship_names.json";
import contributorsDoc from "@/res/contributors.json";
import "./SharingSection.scss";

/** Both sides pin the consent version (contract §11). */
const CONSENT_VERSION = 1;
/** The five realms the identity picker offers (contract §2/§3). */
const REALM_CODES = ["asia", "cn", "ru", "eu", "na"] as const;
/** The ship classes a plan hint may carry (tauri_shared SHIP_CLASSES). */
const SHIP_CLASS_KEYS = [
  "AirCarrier",
  "Battleship",
  "Cruiser",
  "Destroyer",
  "Submarine",
] as const;
/** Wizard anatomy (contract §10): consent → select → upload → done. */
const STEP_KEYS = ["intro", "select", "upload", "done"] as const;
type StepKey = (typeof STEP_KEYS)[number];
/** The pipeline stages the upload step walks through (contract §9). */
const PIPELINE_STAGES = ["plan", "check", "mine", "pack", "upload"] as const;

/** One row of the shipped contributors placeholder (contract §10 — the
 *  data-pack rail refreshes it per release). */
interface ContributorEntry {
  name: string;
  realm: string;
  count: number;
}

const contributorsFile = contributorsDoc as {
  version: number;
  generatedAt: string | null;
  contributors: ContributorEntry[];
};

/** The baked offline ship DB's row shape — only the hint fields matter
 *  here (modelLoader's full wrapper drags three.js into the import graph,
 *  so this section reads the SAME json through a local one-liner plus the
 *  dependency-free runtime registrations;Auxiliary and other non-hull
 *  spellings answer null, exactly what the Rust plausibility check
 *  accepts). */
interface ShipHintRow {
  tier?: number | null;
  type?: string | null;
  names?: Record<string, string> | null;
}
const shipNameMap = shipNamesDbRaw as Record<string, ShipHintRow>;

/** Resolve a shipId's {class, tier} hint for the plan candidates — the
 *  replay header only carries the id, and the wanted ruleset matches on
 *  class/tier (contract §9 PlanCandidate). */
function shipHintOf(
  shipId: number | null | undefined,
): { shipClass: string | null; tier: number | null } {
  if (shipId == null) return { shipClass: null, tier: null };
  const baked = shipNameMap[String(shipId)];
  const rt = baked ? null : runtimeShipEntry(shipId);
  const tier = baked?.tier ?? rt?.tier ?? null;
  const type = baked?.type ?? rt?.type ?? null;
  const shipClass =
    type != null && (SHIP_CLASS_KEYS as readonly string[]).includes(type) ? type : null;
  return { shipClass, tier };
}

/** Localized ship name off the same offline row (the card foot label). */
function shipNameOf(shipId: number | null | undefined, lang: string): string | null {
  if (shipId == null) return null;
  const baked = shipNameMap[String(shipId)];
  const names = baked?.names ?? runtimeShipEntry(shipId)?.names ?? null;
  if (!names) return null;
  const values = Object.values(names);
  return names[lang] ?? names["en-US"] ?? names["en"] ?? (values.length > 0 ? values[0] : null);
}

/** The replay filename stamp as `YYYY-MM-DD[ HH:MM]` (ReplayView's
 *  formatDateTime, kept local — the view module is page-scoped). */
function formatStamp(dt?: string | null): string {
  if (!dt) return "—";
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return dt;
  const [, y, mo, d, hh, mm] = m;
  return hh ? `${y}-${mo}-${d} ${hh}:${mm}` : `${y}-${mo}-${d}`;
}

export default defineComponent({
  name: "SettingsSharingSection",
  setup() {
    const toast = useToast();
    const router = useRouter();
    const { dataLanguage } = useLanguage();
    const replays = useReplayStore();

    // ── status card ───────────────────────────────────────────────────────
    const state = ref<ContributionState | null>(null);
    const enrolled = computed(() => state.value?.identity != null);

    async function refreshState() {
      try {
        state.value = await api.contributionState();
      } catch {
        // The Rust side degrades to defaults itself; a transport failure
        // keeps the last known card instead of blanking it.
      }
    }

    // Identity draft — pre-filled from the declared identity once loaded.
    const idRealm = ref<string>("asia");
    const idName = ref("");
    const savingIdentity = ref(false);
    watch(
      () => state.value?.identity,
      (id) => {
        if (id) {
          idRealm.value = id.realm;
          idName.value = id.name;
        }
      },
    );

    async function saveIdentity() {
      const name = idName.value.trim();
      if (name.length < 3 || name.length > 24) {
        toast.error(t("sharing.status.nameInvalid"));
        return;
      }
      if (savingIdentity.value) return;
      savingIdentity.value = true;
      try {
        await api.contributionSetIdentity(idRealm.value, name);
        await refreshState();
        toast.success(t("sharing.status.saved"));
      } catch (e) {
        toast.error((e as Error).message || String(e));
      } finally {
        savingIdentity.value = false;
      }
    }

    // Consent terms — the SAME §11 copy the wizard's intro step shows,
    // collapsible from the status card for an enrolled contributor.
    const termsOpen = ref(false);

    const syncing = ref(false);
    async function syncMine() {
      if (syncing.value) return;
      syncing.value = true;
      try {
        await api.contributionSyncMine();
        await refreshState();
        toast.success(t("sharing.status.syncDone"));
      } catch (e) {
        toast.error((e as Error).message || String(e));
      } finally {
        syncing.value = false;
      }
    }

    // Forget — the house two-step armed confirm (same as the cache clears).
    const forgetArmed = ref(false);
    async function forgetIdentity() {
      if (!forgetArmed.value) {
        forgetArmed.value = true;
        return;
      }
      forgetArmed.value = false;
      try {
        await api.contributionForgetIdentity();
        await refreshState();
        toast.success(t("sharing.status.forgotten"));
      } catch (e) {
        toast.error((e as Error).message || String(e));
      }
    }

    /** The enroll CTA lands on the wizard's consent step — the wizard sits
     *  directly below the status card, so scroll its group into view. */
    const wizardRef = ref<HTMLElement | null>(null);
    function scrollToWizard() {
      wizardRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ── wizard: shared plumbing ───────────────────────────────────────────
    const step = ref<StepKey>("intro");
    const steps = computed(() =>
      STEP_KEYS.map((key) => ({ key, label: t(`sharing.wizard.step.${key}`) })),
    );

    // ── wizard: intro (consent) ───────────────────────────────────────────
    const agree = ref(false);
    const consentGiven = computed(
      () => agree.value || (state.value?.consentVersion ?? 0) >= CONSENT_VERSION,
    );
    watch(agree, (on) => {
      if (!on || (state.value?.consentVersion ?? 0) >= CONSENT_VERSION) return;
      // The check itself records the consent (contract §10: the checkbox is
      // the save). A failure unchecks so the gate cannot be walked past.
      api
        .contributionSaveConsent(CONSENT_VERSION)
        .then(() => refreshState())
        .catch((e) => {
          agree.value = false;
          toast.error((e as Error).message || String(e));
        });
    });

    // ── wizard: select (filter + cards + planner) ─────────────────────────
    // ReplayListFilter with a PRIVATE state instance — none of it touches
    // the replay page's persisted blob (wowsp.replayFilter.v1): a wizard
    // session starts from the defaults every time.
    const selectedModes = ref(new Set<string>());
    const sortDir = ref<ReplaySortDir>("desc");
    const dateFrom = ref<string | null>(null);
    const dateTo = ref<string | null>(null);
    const selectedClient = ref<string>(FILTER_ANY);
    const selectedPlayer = ref<string>(FILTER_ANY);
    const listLoading = ref(false);

    const allReplays = computed(() => replays.list);
    /** One pipeline over both blocks (the page rail's order, minus its
     *  persistence): mode → date window → client → player → time sort. */
    const visibleReplays = computed(() => {
      const byMode = filterReplays([...allReplays.value], selectedModes.value);
      const byDate = filterByDateRange(byMode, dateFrom.value, dateTo.value);
      const byClient = filterByClient(byDate, selectedClient.value);
      return sortReplays(filterByPlayer(byClient, selectedPlayer.value), sortDir.value);
    });

    const modeOptions = computed(() =>
      collectModeOptions(allReplays.value, selectedModes.value),
    );
    const playerOptions = computed(() =>
      collectPlayerOptions(allReplays.value, [selectedPlayer.value]),
    );
    const clientOptions = computed(() => {
      // The client dimension lists the installs the entries themselves
      // name (path → tag label), most-tagged first — the settings surface
      // has no game-detect store dependency to ask the host directly.
      const counts = new Map<string, { label: string; n: number }>();
      for (const r of allReplays.value) {
        if (!r.installPath) continue;
        const tag = serverTagOf(r.installKind, r.installRealm);
        const row = counts.get(r.installPath) ?? {
          label: tag || r.installPath.split(/[\\/]/).filter(Boolean).pop() || r.installPath,
          n: 0,
        };
        row.n += 1;
        counts.set(r.installPath, row);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label))
        .map(([value, { label }]) => ({ value, label }));
    });

    /** Verdict rows keyed by path — filled by the planner pass. */
    const planByPath = ref(new Map<string, PlanItem>());
    const planning = ref(false);
    const planError = ref<string | null>(null);
    /** Checked paths — the wizard's selection. */
    const checked = ref(new Set<string>());

    /** Candidate row for one replay: path + the ship class/tier hints the
     *  planner cannot read off the header (contract §9). */
    function candidateOf(r: ReplayMetaLite): PlanCandidate {
      const { shipClass, tier } = shipHintOf(r.ownShipId);
      return { path: r.path, shipClass, tier };
    }

    /** Wanted rules by id — the scarcity table smart-select sorts on. */
    const wantedRules = ref(new Map<string, { collected: number; maxCount: number | null }>());

    async function loadWanted() {
      try {
        const doc = await api.contributionFetchWanted(false);
        wantedRules.value = new Map(
          doc.rules.map((r) => [r.id, { collected: r.collected, maxCount: r.maxCount ?? null }]),
        );
      } catch {
        // Offline / relay down: smart select still runs without the caps
        // (remaining unknown = treat as unlimited, no per-rule cap).
        wantedRules.value = new Map();
      }
    }

    /** The planner pass itself: hash + verdict the (filtered) set. Shared
     *  by SMART SELECT and any manual re-evaluate. */
    async function runPlan(items: PlanCandidate[]): Promise<PlanItem[]> {
      planError.value = null;
      const out = await api.contributionPlan(items);
      const next = new Map(planByPath.value);
      for (const item of out) next.set(item.path, item);
      planByPath.value = next;
      return out;
    }

    /** SMART SELECT (contract §10): plan the filtered set, sort the
     *  accept-verdict items by rule scarcity (collected/maxCount ascending,
     *  unlimited rules last) then battle time descending, and check boxes
     *  capped at each rule's remaining quota. */
    async function smartSelect() {
      if (planning.value || visibleReplays.value.length === 0) return;
      planning.value = true;
      try {
        await loadWanted();
        const items = await runPlan(visibleReplays.value.map(candidateOf));
        const remainingOf = (ruleId: string | null | undefined): number => {
          if (!ruleId) return Number.POSITIVE_INFINITY;
          const rule = wantedRules.value.get(ruleId);
          if (!rule) return Number.POSITIVE_INFINITY;
          if (rule.maxCount == null) return Number.POSITIVE_INFINITY;
          return Math.max(0, rule.maxCount - rule.collected);
        };
        const scarcityOf = (item: PlanItem): number => {
          if (!item.ruleId) return Number.POSITIVE_INFINITY;
          const rule = wantedRules.value.get(item.ruleId);
          if (!rule || rule.maxCount == null || rule.maxCount <= 0) {
            return Number.POSITIVE_INFINITY;
          }
          return rule.collected / rule.maxCount;
        };
        const accepts = items
          .filter((i) => i.verdict === "accept")
          .sort(
            (a, b) =>
              scarcityOf(a) - scarcityOf(b) ||
              (b.facts.battleTime < a.facts.battleTime ? -1 : b.facts.battleTime > a.facts.battleTime ? 1 : 0),
          );
        const takenPerRule = new Map<string, number>();
        const next = new Set<string>();
        for (const item of accepts) {
          const rem = remainingOf(item.ruleId);
          if (rem !== Number.POSITIVE_INFINITY) {
            const taken = takenPerRule.get(item.ruleId ?? "") ?? 0;
            if (taken >= rem) continue;
            takenPerRule.set(item.ruleId ?? "", taken + 1);
          }
          next.add(item.path);
        }
        checked.value = next;
      } catch (e) {
        planError.value = (e as Error).message || String(e);
      } finally {
        planning.value = false;
      }
    }

    function toggleChecked(path: string) {
      const next = new Set(checked.value);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      checked.value = next;
    }

    const estBytes = computed(() => {
      let sum = 0;
      for (const path of checked.value) sum += planByPath.value.get(path)?.sizeBytes ?? 0;
      return sum;
    });

    /** Rescan the store's default list (every detected install's replays
     *  folder) — the section may mount before the replay page ever did. */
    async function refreshList() {
      if (listLoading.value) return;
      listLoading.value = true;
      try {
        await replays.refreshAll();
      } catch (e) {
        toast.error((e as Error).message || String(e));
      } finally {
        listLoading.value = false;
      }
    }

    // ── wizard: upload (queue snapshot: event + poll fallback) ────────────
    const queue = ref<QueueSnapshot | null>(null);
    let unlisten: (() => void) | null = null;
    let pollTimer: number | undefined;

    function applySnapshot(q: QueueSnapshot) {
      queue.value = q;
      // Terminal transitions land the wizard on the done step (a cancel or
      // an error keeps the upload view so the outcomes stay readable).
      if (step.value === "upload" && !q.running && q.stage === "done") {
        step.value = "done";
        void refreshState();
      }
    }

    function startPolling() {
      stopPolling();
      pollTimer = window.setInterval(() => {
        // The event bus is the fast path; the poll covers a dropped
        // listener (and the browser mock, which has no event bus at all).
        if (queue.value?.running || step.value === "upload") {
          api.contributionQueue().then(applySnapshot, () => {});
        }
      }, 1500);
    }
    function stopPolling() {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }

    async function startUpload() {
      const candidates = visibleReplays.value
        .filter((r) => checked.value.has(r.path))
        .map(candidateOf);
      if (candidates.length === 0) return;
      try {
        await api.contributionStart(candidates);
        const q = await api.contributionQueue();
        step.value = "upload";
        applySnapshot(q);
        startPolling();
      } catch (e) {
        toast.error((e as Error).message || String(e));
      }
    }

    async function cancelUpload() {
      try {
        await api.contributionCancel();
      } catch (e) {
        toast.error((e as Error).message || String(e));
      }
    }

    const uploading = computed(() => step.value === "upload" && (queue.value?.running ?? false));
    const outcomeCounts = computed(() => {
      const counts = { accepted: 0, duplicate: 0, unwanted: 0, failed: 0 };
      for (const r of queue.value?.results ?? []) counts[r.outcome] += 1;
      return counts;
    });
    const uploadPct = computed(() => {
      const q = queue.value;
      if (!q || q.totalBytes <= 0) return null;
      return Math.min(100, Math.round((q.currentBytes / q.totalBytes) * 100));
    });

    // ── wizard: done ──────────────────────────────────────────────────────
    const contributorsRef = ref<HTMLElement | null>(null);
    function scrollToContributors() {
      contributorsRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ── contributors list (shipped placeholder; data-pack refreshes it) ────
    const contributorGroups = computed(() => {
      const byRealm = new Map<string, ContributorEntry[]>();
      for (const c of contributorsFile.contributors) {
        const bucket = byRealm.get(c.realm) ?? [];
        bucket.push(c);
        byRealm.set(c.realm, bucket);
      }
      return REALM_CODES.map((realm) => ({
        realm,
        entries: (byRealm.get(realm) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      })).filter((g) => g.entries.length > 0);
    });
    const hasContributors = computed(() => contributorsFile.contributors.length > 0);

    function openContributor(c: ContributorEntry) {
      void router.push({ path: "/lookup", query: { name: c.name, realm: c.realm } });
    }
    function isSelf(c: ContributorEntry): boolean {
      const id = state.value?.identity;
      return id != null && id.realm === c.realm && id.name === c.name;
    }

    // ── lifecycle ─────────────────────────────────────────────────────────
    onMounted(() => {
      void refreshState();
      if (replays.list.length === 0) void refreshList();
      // Wire the progress stream once; the poll only runs while the upload
      // step is live (single-flight, so one snapshot describes everything).
      const un = api.listenContributionProgress?.(applySnapshot);
      if (un instanceof Promise) {
        void un
          .then((u) => {
            unlisten = u;
          })
          .catch(() => {});
      } else if (un) {
        unlisten = un;
      }
      // Re-attach to a pipeline still running from an earlier visit (the
      // section unmounts when switched away — the Rust run survives).
      api
        .contributionQueue()
        .then((q) => {
          if (q.running) {
            step.value = "upload";
            applySnapshot(q);
            startPolling();
          }
        })
        .catch(() => {});
      // Leaving the section disarms the pending two-step forget.
    });
    onBeforeUnmount(() => {
      stopPolling();
      unlisten?.();
      unlisten = null;
    });

    // ── footer gating ─────────────────────────────────────────────────────
    const primaryLabel = computed(() => {
      if (step.value === "intro") return t("sharing.wizard.next");
      if (step.value === "select") return t("sharing.wizard.startUpload");
      if (step.value === "upload") return t("sharing.wizard.doneLabel");
      return t("sharing.wizard.viewContributors");
    });
    const primaryDisabled = computed(() => {
      if (step.value === "intro") return !consentGiven.value;
      if (step.value === "select") return checked.value.size === 0;
      return false;
    });
    function onPrimary() {
      if (step.value === "intro") step.value = "select";
      else if (step.value === "select") void startUpload();
      else if (step.value === "upload") step.value = "done";
      else scrollToContributors();
    }
    function goBack() {
      const i = STEP_KEYS.indexOf(step.value);
      // Upstream of the upload step only — a finished/failed run restarts
      // from select (the queue's own state stays whatever the pipeline left).
      step.value = STEP_KEYS[Math.max(0, Math.min(i === 3 ? 2 : i - 1, 2))];
    }

    /** The §11 consent bullets — shared by the wizard intro and the status
     *  card's collapsible terms view (one copy, two surfaces). */
    function renderConsent() {
      return (
        <ul class="sharing-sec__consent">
          {(
            [
              "contains",
              "usedFor",
              "noRedistribution",
              "contributorList",
              "identity",
              "revoke",
            ] as const
          ).map((key) => (
            <li key={key}>{t(`sharing.consent.${key}`)}</li>
          ))}
        </ul>
      );
    }

    /** One selectable replay card — the page rail's card info layout in a
     *  lighter, checkbox-led variant (contract §10). */
    function renderSelectCard(r: ReplayMetaLite) {
      const item = planByPath.value.get(r.path);
      const on = checked.value.has(r.path);
      const shipName = shipNameOf(r.ownShipId, dataLanguage.value);
      const serverTag = serverTagOf(r.installKind, r.installRealm);
      const modeKey = replayModeKeyOf(r);
      return (
        <li
          key={r.path}
          class={["sharing-sec__card", on ? "sharing-sec__card--on" : ""].join(" ")}
          aria-label={t("sharing.select.checkCard", { name: r.playerName ?? "" })}
        >
          <HkCheckbox
            modelValue={on}
            onUpdate:modelValue={() => toggleChecked(r.path)}
          />
          <div
            class="sharing-sec__card-body"
            role="button"
            tabindex={0}
            onClick={() => toggleChecked(r.path)}
            onKeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleChecked(r.path);
              }
            }}
          >
            <div class="sharing-sec__card-top">
              <span class="sharing-sec__card-title">
                {r.playerName ?? t("replay.list.unknownPlayer")}
              </span>
              <span class="sharing-sec__card-pills">
                {serverTag ? <span class="sharing-sec__pill">{serverTag}</span> : null}
                {modeKey ? (
                  <span
                    class="sharing-sec__pill"
                    style={{ background: modeColorOfKey(modeKey).color }}
                  >
                    {modeLabelOfKey(modeKey)}
                  </span>
                ) : null}
                {item ? (
                  <span class={`sharing-sec__pill sharing-sec__pill--${item.verdict}`}>
                    {t(`sharing.select.verdict.${item.verdict}`)}
                  </span>
                ) : null}
              </span>
            </div>
            <div class="sharing-sec__card-row">
              <span class="sharing-sec__card-label">{t("replay.matchTime")}</span>
              <span class="sharing-sec__card-val">{formatStamp(r.dateTime)}</span>
            </div>
            <div class="sharing-sec__card-row">
              <span class="sharing-sec__card-label">{t("replay.mapLabel")}</span>
              <span class="sharing-sec__card-val">{displayMapName(r.mapName, dataLanguage.value)}</span>
            </div>
            <div class="sharing-sec__card-foot">
              {shipName ? (
                <span class="sharing-sec__card-ship">{shipName}</span>
              ) : null}
              <span class="sharing-sec__card-players">
                {t("replay.players", { n: r.playerCount })}
              </span>
            </div>
          </div>
        </li>
      );
    }

    return () => (
      <>
      {/* ── participation status card ──────────────────────────────────── */}
      <HkSettingsGroup title={t("sharing.status.title")}>
        <HkSettingsHint>{t("sharing.status.hint")}</HkSettingsHint>
        {!enrolled.value ? (
          <div class="sharing-sec__enroll">
            <p class="sharing-sec__enroll-copy">{t("sharing.status.enrollCopy")}</p>
            <HkButton variant="primary" onClick={scrollToWizard}>
              <Upload size={15} />
              {t("sharing.status.enroll")}
            </HkButton>
          </div>
        ) : (
          <>
          <HkSettingsSub title={t("sharing.status.identity")} />
          {/* Identity editor — self-declared server + nickname; no account
              binding (contract §3). */}
          <div class="sharing-sec__identity">
            <HkSelect
              label={t("sharing.status.realm")}
              options={REALM_CODES.map((r) => ({ value: r, label: r.toUpperCase() }))}
              modelValue={idRealm.value}
              onUpdate:modelValue={(v: string) => (idRealm.value = v)}
            />
            <HkInput
              label={t("sharing.status.name")}
              placeholder={t("sharing.status.namePlaceholder")}
              modelValue={idName.value}
              onUpdate:modelValue={(v: string) => (idName.value = v)}
            />
            <div class="sharing-sec__identity-save">
              <HkButton
                size="sm"
                variant="secondary"
                loading={savingIdentity.value}
                onClick={() => void saveIdentity()}
              >
                <Check size={14} />
                {t("sharing.status.save")}
              </HkButton>
            </div>
          </div>
          {/* Consent + terms view — the collapsible carries the full §11
              copy (the wizard intro's bullets verbatim). */}
          <div class="sharing-sec__meta">
            <HkTag variant={(state.value?.consentVersion ?? 0) >= 1 ? "success" : "warning"} size="sm">
              {(state.value?.consentVersion ?? 0) >= 1
                ? t("sharing.status.consentRecorded", { version: state.value?.consentVersion ?? CONSENT_VERSION })
                : t("sharing.status.consentMissing")}
            </HkTag>
            <button
              type="button"
              class="sharing-sec__terms-toggle"
              onClick={() => (termsOpen.value = !termsOpen.value)}
            >
              {termsOpen.value ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {termsOpen.value ? t("sharing.status.hideTerms") : t("sharing.status.viewTerms")}
            </button>
          </div>
          {termsOpen.value ? renderConsent() : null}
          {/* My counts + last sync — the status card's live numbers. */}
          <div class="sharing-sec__counts">
            <span class="sharing-sec__count">
              <span class="sharing-sec__count-num">{state.value?.creditCount ?? 0}</span>
              <span class="sharing-sec__count-label">{t("sharing.status.credits")}</span>
            </span>
            <span class="sharing-sec__count">
              <span class="sharing-sec__count-num">{formatBytes(state.value?.stagedBytes ?? 0)}</span>
              <span class="sharing-sec__count-label">{t("sharing.status.staged")}</span>
            </span>
          </div>
          <div class="sharing-sec__sync-row">
            <span class="sharing-sec__sync-label">
              {state.value?.lastSyncAt
                ? t("sharing.status.lastSync", {
                    time: new Date(state.value.lastSyncAt).toLocaleString(),
                  })
                : t("sharing.status.neverSynced")}
            </span>
            <span class="sharing-sec__sync-actions">
              <HkButton
                size="sm"
                variant="secondary"
                loading={syncing.value}
                onClick={() => void syncMine()}
              >
                <RefreshCw size={14} />
                {t("sharing.status.refresh")}
              </HkButton>
              {forgetArmed.value ? (
                <HkButton size="sm" variant="danger" onClick={() => void forgetIdentity()}>
                  <Trash2 size={14} />
                  {t("sharing.status.forgetConfirm")}
                </HkButton>
              ) : (
                <HkButton size="sm" variant="secondary" onClick={() => void forgetIdentity()}>
                  <Trash2 size={14} />
                  {t("sharing.status.forget")}
                </HkButton>
              )}
            </span>
          </div>
          </>
        )}
      </HkSettingsGroup>

      {/* ── the inline wizard — rendered in-section, NOT a modal ───────── */}
      <div ref={wizardRef} class="sharing-sec__wizard">
        <HkSettingsGroup title={t("sharing.wizard.title")}>
          <HkSettingsHint>{t("sharing.wizard.hint")}</HkSettingsHint>
          <HkStepFlow
            steps={steps.value}
            modelValue={step.value}
            onUpdate:modelValue={(v: string) => {
              // Forward clicks past a gate are refused here (the footer
              // owns the gating; the timeline only walks finished steps).
              const i = STEP_KEYS.indexOf(v as StepKey);
              const cur = STEP_KEYS.indexOf(step.value);
              if (i > cur && (v === "select" ? !consentGiven.value : v === "upload")) return;
              if (v === "upload" && checked.value.size === 0) return;
              step.value = v as StepKey;
            }}
            v-slots={{
              intro: () => (
                <div class="sharing-sec__step">
                  {renderConsent()}
                  <HkCheckbox
                    modelValue={consentGiven.value}
                    onUpdate:modelValue={(v: boolean) => (agree.value = v)}
                    label={t("sharing.consent.agree")}
                  />
                </div>
              ),
              select: () => (
                <div class="sharing-sec__step">
                  {/* The filter trigger — a PRIVATE state instance of the
                      page rail's component (nothing persists). */}
                  <div class="sharing-sec__select-head">
                    {allReplays.value.length + replays.external.length > 0 ? (
                      <ReplayListFilter
                        modeOptions={modeOptions.value}
                        selectedModes={selectedModes.value}
                        sortDir={sortDir.value}
                        onUpdate:selectedModes={(s: Set<string>) => (selectedModes.value = s)}
                        onUpdate:sortDir={(d: ReplaySortDir) => (sortDir.value = d)}
                        dateFrom={dateFrom.value}
                        dateTo={dateTo.value}
                        onUpdate:dateFrom={(v: string | null) => (dateFrom.value = v)}
                        onUpdate:dateTo={(v: string | null) => (dateTo.value = v)}
                        selectedClient={selectedClient.value}
                        clientOptions={clientOptions.value}
                        onUpdate:selectedClient={(v: string) => (selectedClient.value = v)}
                        selectedPlayer={selectedPlayer.value}
                        playerOptions={playerOptions.value}
                        onUpdate:selectedPlayer={(v: string) => (selectedPlayer.value = v)}
                      />
                    ) : null}
                    <HkButton
                      size="sm"
                      variant="secondary"
                      loading={listLoading.value}
                      onClick={() => void refreshList()}
                    >
                      <RefreshCw size={14} />
                      {t("sharing.select.rescan")}
                    </HkButton>
                    <HkButton
                      size="sm"
                      variant="primary"
                      loading={planning.value}
                      disabled={visibleReplays.value.length === 0}
                      onClick={() => void smartSelect()}
                    >
                      <Wand2 size={14} />
                      {t("sharing.select.smart")}
                    </HkButton>
                  </div>
                  {planning.value ? (
                    <p class="sharing-sec__plan-note">
                      <HkSpinner size="xs" tone="current" />
                      <span>{t("sharing.select.planning")}</span>
                    </p>
                  ) : null}
                  {planError.value ? (
                    <HkAlert variant="error" size="sm" message={planError.value} />
                  ) : null}
                  {visibleReplays.value.length === 0 ? (
                    <p class="sharing-sec__empty">
                      {allReplays.value.length === 0
                        ? t("sharing.select.empty")
                        : t("sharing.select.filterEmpty")}
                    </p>
                  ) : (
                    <ul class="sharing-sec__list">
                      {visibleReplays.value.map(renderSelectCard)}
                    </ul>
                  )}
                  {/* Summary bar — selection count + estimated bytes (the
                      planner's sizes; unplanned picks count without one). */}
                  <div class="sharing-sec__summary">
                    <span>{t("sharing.select.summary", { n: checked.value.size })}</span>
                    {estBytes.value > 0 ? (
                      <span>{t("sharing.select.estSize", { size: formatBytes(estBytes.value) })}</span>
                    ) : null}
                  </div>
                </div>
              ),
              upload: () => {
                const q = queue.value;
                return (
                  <div class="sharing-sec__step">
                    {/* Per-stage indicator: plan → check → mine → pack →
                        upload, then the terminal done/error line. */}
                    <div class="sharing-sec__stages">
                      {PIPELINE_STAGES.map((s) => {
                        const idx = PIPELINE_STAGES.indexOf(s);
                        const cur = q ? PIPELINE_STAGES.indexOf(q.stage as (typeof PIPELINE_STAGES)[number]) : -1;
                        const stateCls =
                          q == null || cur < 0
                            ? ""
                            : idx < cur
                              ? "sharing-sec__stage--done"
                              : idx === cur
                                ? "sharing-sec__stage--active"
                                : "";
                        return (
                          <span key={s} class={["sharing-sec__stage", stateCls].join(" ")}>
                            {idx < cur ? <Check size={12} /> : null}
                            {t(`sharing.upload.stage.${s}`)}
                          </span>
                        );
                      })}
                    </div>
                    {q?.stage === "error" ? (
                      <HkAlert
                        variant="error"
                        size="sm"
                        message={q.message ?? t("sharing.upload.failed")}
                      />
                    ) : null}
                    {q && q.totalBytes > 0 ? (
                      <div class="sharing-sec__progress">
                        <HkProgressBar value={uploadPct.value ?? 0} />
                        <span class="sharing-sec__progress-note">
                          {formatBytes(q.currentBytes)} / {formatBytes(q.totalBytes)} ·{" "}
                          {t("sharing.upload.items", { done: q.doneItems, total: q.totalItems })}
                        </span>
                      </div>
                    ) : q ? (
                      <p class="sharing-sec__progress-note">
                        {t("sharing.upload.items", { done: q.doneItems, total: q.totalItems })}
                        {q.message ? ` · ${q.message}` : ""}
                      </p>
                    ) : (
                      <p class="sharing-sec__progress-note">
                        <HkSpinner size="xs" tone="current" />
                      </p>
                    )}
                    {(q?.results.length ?? 0) > 0 ? (
                      <ul class="sharing-sec__outcomes">
                        {q?.results.map((r) => (
                          <li key={r.sha256} class="sharing-sec__outcome">
                            <span class="sharing-sec__outcome-name">{r.fileName}</span>
                            <HkTag
                              variant={
                                r.outcome === "accepted"
                                  ? "success"
                                  : r.outcome === "failed"
                                    ? "danger"
                                    : "default"
                              }
                              size="sm"
                            >
                              {t(`sharing.upload.outcome.${r.outcome}`)}
                            </HkTag>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {uploading.value ? (
                      <div class="sharing-sec__cancel">
                        <HkButton size="sm" variant="secondary" onClick={() => void cancelUpload()}>
                          {t("sharing.upload.cancel")}
                        </HkButton>
                      </div>
                    ) : null}
                  </div>
                );
              },
              done: () => {
                const c = outcomeCounts.value;
                return (
                  <div class="sharing-sec__step">
                    <p class="sharing-sec__done-line">
                      {t("sharing.done.summary", {
                        accepted: c.accepted,
                        duplicate: c.duplicate,
                        unwanted: c.unwanted,
                        failed: c.failed,
                      })}
                    </p>
                    <HkSettingsHint>{t("sharing.done.hint")}</HkSettingsHint>
                  </div>
                );
              },
            }}
          />
          {/* Footer — the house prev/primary row under the flow (HkStepFlow
              itself owns only the timeline + bodies). */}
          <div class="sharing-sec__wizard-footer">
            {step.value === "intro" || uploading.value ? null : (
              <HkButton variant="secondary" onClick={goBack}>
                {t("sharing.wizard.prev")}
              </HkButton>
            )}
            {uploading.value ? (
              <HkButton variant="secondary" onClick={() => void cancelUpload()}>
                {t("sharing.upload.cancel")}
              </HkButton>
            ) : (
              <HkButton
                variant="primary"
                disabled={primaryDisabled.value}
                onClick={onPrimary}
              >
                {primaryLabel.value}
              </HkButton>
            )}
          </div>
        </HkSettingsGroup>
      </div>

      {/* ── contributors list (shipped placeholder — data-pack rail) ───── */}
      <div ref={contributorsRef}>
        <HkSettingsGroup title={t("sharing.contributors.title")}>
          <HkSettingsHint>{t("sharing.contributors.hint")}</HkSettingsHint>
          {!hasContributors.value ? (
            <p class="sharing-sec__empty">{t("sharing.contributors.empty")}</p>
          ) : (
            <div class="sharing-sec__contrib-groups">
              {contributorGroups.value.map((g) => (
                <div key={g.realm} class="sharing-sec__contrib-group">
                  <span class="sharing-sec__contrib-realm">{g.realm.toUpperCase()}</span>
                  <div class="sharing-sec__contrib-chips">
                    {g.entries.map((c) => (
                      <button
                        key={`${c.realm}:${c.name}`}
                        type="button"
                        class={[
                          "sharing-sec__contrib-chip",
                          isSelf(c) ? "sharing-sec__contrib-chip--self" : "",
                        ].join(" ")}
                        onClick={() => openContributor(c)}
                      >
                        <span class="sharing-sec__contrib-name">{c.name}</span>
                        {isSelf(c) ? (
                          <span class="sharing-sec__contrib-self">{t("sharing.contributors.self")}</span>
                        ) : null}
                        <span class="sharing-sec__contrib-count">
                          {t("sharing.contributors.count", { n: c.count })}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div class="sharing-sec__contrib-note">
            <Users size={14} />
            <span>{t("sharing.contributors.note")}</span>
          </div>
        </HkSettingsGroup>
      </div>
      </>
    );
  },
});
