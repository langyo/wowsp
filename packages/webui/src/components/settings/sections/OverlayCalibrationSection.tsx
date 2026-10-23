/** Overlay calibration settings section (游戏内显示校准): the in-game
 *  water meter's card leads (view mode / roster attribution / display
 *  content — see OverlaySection), then the persistent per-client
 *  Tab-anchor calibrations the overlay detector stores. One card per
 *  REGISTERED client — the client selector's own anatomy (platform badge,
 *  localized name, realm tag, twin-disambiguating path tail) plus a
 *  last-updated stamp — with its independent PvP / PvE entries expressed
 *  ENTIRELY as HkTag chips (the battle class, the state badges, and the
 *  table-rect / rows / teams / window readouts — label + mono value inside
 *  each chip) plus a right-aligned icon-only edit button. Calibration files whose
 *  install left the registry keep trailing cards so existing data stays
 *  visible and editable. An entry nobody measured yet is STILL editable
 *  (提前编辑): the submit creates it from the drawing (see
 *  set_calibration_anchor). Editing reopens the shared manual-locate
 *  picker in calibration mode (see ManualLocateOverlay) against any
 *  reference image; the submitted box rescales onto the STORED entry, so
 *  editing never depends on the client currently running. */
import { computed, defineComponent, onMounted, ref, watch, type PropType } from "vue";
import { RefreshCw, SquarePen } from "@lucide/vue";
import {
  HkButton,
  HkSettingsGroup,
  HkSettingsHint,
  HkSpinner,
  HkTag,
  useToast,
} from "@celestia-island/hikari";

import {
  api,
  type CalibrationClientInfo,
  type CalibrationEntryInfo,
  type GameInstallKind,
} from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { useConfigStore } from "@/stores/config";
import { useManualLocateStore } from "@/stores/manualLocate";
import { SETTINGS_ANCHOR_CALIBRATION_LIST } from "@/stores/settingsUi";
import PlatformIcon from "@/components/base/PlatformIcon";
import ErrorCard from "@/components/base/ErrorCard";
import OverlaySection from "@/components/settings/sections/OverlaySection";
import { clientMenuOptions } from "@/utils/installLabel";
import { normalizeGamePath, sameGamePath } from "@/utils/gamePath";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import "./OverlayCalibrationSection.scss";

/** Rust's `kind_name` spells kongzhong without the cn- prefix the webui's
 *  kind union uses; every other kind string matches directly, and unknown
 *  kinds fall back to `manual` (the neutral platform badge). */
const KIND_FIX: Record<string, GameInstallKind> = { kongzhong: "cnKongzhong" };
const KNOWN_KINDS: readonly string[] = [
  "wargaming",
  "steam",
  "lesta",
  "cn360",
  "cnKongzhong",
  "manual",
];

function normalizeKind(kind: string): GameInstallKind {
  return (
    KIND_FIX[kind] ??
    (KNOWN_KINDS.includes(kind) ? (kind as GameInstallKind) : "manual")
  );
}

/** Locale-aware relative time (Intl.RelativeTimeFormat — no hand-rolled
 *  unit words per locale), coarse-grained to the most fitting unit. */
function relativeTime(at: number, locale: string): string {
  const diff = at - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

/** One card: a registered install (whether or not the detector has written
 *  a calibration file for it yet), or a calibration file whose install no
 *  longer sits in the registry (kept so existing data stays visible and
 *  editable). */
interface CalibCard {
  kind: GameInstallKind;
  /** Install root path — the display identity; submits prefer the
   *  calibration file's own stored key (the backend normalizes either
   *  spelling before it hashes the file name). */
  path: string;
  realm?: string | null;
  cal: CalibrationClientInfo | null;
  /** No registered install matches this calibration file. */
  unregistered: boolean;
}

export default defineComponent({
  name: "SettingsOverlayCalibrationSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup(props) {
    const manualLocate = useManualLocateStore();
    const configStore = useConfigStore();
    const { uiLocale } = useLanguage();
    const toast = useToast();
    const clients = ref<CalibrationClientInfo[]>([]);
    const loading = ref(false);
    const loaded = ref(false);
    /** Last list-fetch failure (`null` once any fetch has succeeded) —
     *  while set, the card list must not render: install-only cards would
     *  read as "not calibrated" and their pre-edit buttons could create
     *  entries over state the section never managed to show. */
    const loadError = ref<string | null>(null);

    async function refresh() {
      loading.value = true;
      try {
        clients.value = await api.fetchOverlayCalibrationList();
        loaded.value = true;
        loadError.value = null;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        loadError.value = loaded.value ? null : msg;
        toast.error(`${t("settings.overlayCalibration")}: ${msg}`);
      } finally {
        loading.value = false;
      }
    }
    onMounted(() => void refresh());
    // A successful calibration submit bumps the picker store's version
    // (the picker layer and this section are otherwise decoupled) — re-read
    // the list so the edited card reflects the write without a manual
    // refresh. The section may not be mounted at submit time; that is
    // fine, the next mount re-reads anyway.
    watch(() => manualLocate.calibrationVersion, () => void refresh());

    /** Registered installs first (the game-path list's own order), then
     *  calibration files whose install is gone (backend's newest-first
     *  order kept). Matching goes through the case/separator-insensitive
     *  compare — the watcher stores a normalized path spelling. */
    const cards = computed<CalibCard[]>(() => {
      const byKey = new Map(
        clients.value.map((c) => [normalizeGamePath(c.clientKey), c] as const),
      );
      const rows: CalibCard[] = configStore.installs.map((i) => ({
        kind: i.kind,
        path: i.path,
        realm: i.realm,
        cal: byKey.get(normalizeGamePath(i.path)) ?? null,
        unregistered: false,
      }));
      for (const c of clients.value) {
        if (!configStore.installs.some((i) => sameGamePath(i.path, c.clientKey))) {
          rows.push({
            kind: normalizeKind(c.kind),
            path: c.clientKey,
            realm: null,
            cal: c,
            unregistered: true,
          });
        }
      }
      return rows;
    });

    /** Card titles through the client-menu labeller — localized kind name
     *  (+ realm), with the shortest distinguishing path tail when two
     *  cards would otherwise read identically (twin installs). */
    const cardLabels = computed(() => {
      const pseudo = cards.value.map((c) => ({
        kind: c.kind,
        path: c.path,
        realm: c.realm ?? undefined,
      }));
      return new Map(
        clientMenuOptions(pseudo).map((o) => [normalizeGamePath(o.value), o.label] as const),
      );
    });

    /** One entry's edit button: arm the backend's picker-open flag (no
     *  battle gates here), then raise the shared picker layer in
     *  calibration mode with this client + class as the submit target —
     *  an empty target CREATES its entry from the drawing, so the
     *  install's kind rides along for exactly that case. */
    async function editEntry(c: CalibCard, cls: "pvp" | "pve") {
      try {
        await api.startCalibrationLocate();
      } catch (err) {
        toast.error(`${t("settings.overlayCalibration")}: ${(err as Error).message || err}`);
        return;
      }
      const e = cls === "pvp" ? (c.cal?.pvp ?? null) : (c.cal?.pve ?? null);
      manualLocate.openPicker({
        mode: "calibration",
        calibration: {
          clientKey: c.cal?.clientKey ?? c.path,
          class: cls,
          kind: c.kind,
          // The entry's stored per-team shape seeds the editor's count
          // control (rosters differ between battles — the stored one may be
          // stale); a not-yet-recorded entry starts from the class's classic
          // placeholder, mirroring the backend's own defaults.
          teamSizes: e
            ? [e.teamSizes[0], e.teamSizes[1]]
            : cls === "pve"
              ? [9, 0]
              : [12, 12],
        },
      });
    }

    /** One entry readout as a TAG — label (muted) + value (mono/tabular)
     *  inside one HkTag chip; the optional tooltip carries the screen
     *  fingerprint etc. */
    function fieldTag(label: string, value: string, title?: string) {
      return (
        <span class="calib-sec__field" title={title}>
          <HkTag size="sm">
            <span class="calib-sec__tag-label">{label}</span>
            <span class="calib-sec__tag-value">{value}</span>
          </HkTag>
        </span>
      );
    }

    /** One battle-class row of a client card — everything chip-shaped: the
     *  battle class, the state badges, and every stored readout (table
     *  rect / rows / teams / window) ride HkTag chips. */
    function classRow(c: CalibCard, cls: "pvp" | "pve") {
      const e: CalibrationEntryInfo | null =
        cls === "pvp" ? (c.cal?.pvp ?? null) : (c.cal?.pve ?? null);
      const edit = t("settings.overlayCalibrationEdit");
      return (
        <div class="calib-sec__class" key={cls}>
          <HkTag variant={cls === "pvp" ? "primary" : "info"} size="sm">
            {t(
              cls === "pvp"
                ? "settings.overlayCalibrationClassPvp"
                : "settings.overlayCalibrationClassPve",
            )}
          </HkTag>
          {e ? (
            <>
              <span class="calib-sec__badges">
                {e.certified ? (
                  <HkTag variant="success" size="sm">
                    {t("settings.overlayCalibrationCertified")}
                  </HkTag>
                ) : null}
                {e.manual ? (
                  <HkTag variant="info" size="sm">
                    {t("settings.overlayCalibrationManual")}
                  </HkTag>
                ) : null}
                {e.suspect ? (
                  <HkTag variant="warning" size="sm">
                    {t("settings.overlayCalibrationSuspect")}
                  </HkTag>
                ) : null}
              </span>
              {/* The stored table rectangle, game-window relative
                  (physical px) — the "key feature points" the detector
                  anchored. */}
              {fieldTag(
                t("settings.overlayCalibrationFieldRect"),
                `${e.rosterRect.x},${e.rosterRect.y} · ${e.rosterRect.width}×${e.rosterRect.height}`,
              )}
              {fieldTag(
                t("settings.overlayCalibrationFieldRows"),
                String(e.rowCenters.length),
              )}
              {fieldTag(
                t("settings.overlayCalibrationFieldTeams"),
                `${e.teamSizes[0]}v${e.teamSizes[1]}`,
              )}
              {/* Window identity the entry was measured at — editing keeps
                  it, so mismatches here explain a remap rather than block
                  one. The monitor fingerprint rides the tooltip. */}
              {fieldTag(
                t("settings.overlayCalibrationFieldWindow"),
                `@${e.gameOrigin[0]},${e.gameOrigin[1]} · ${e.gameSize[0]}×${e.gameSize[1]}`,
                e.screen,
              )}
            </>
          ) : (
            // Never calibrated (or this class never ran): the edit button
            // still creates the entry from a drawing (提前编辑).
            <HkTag variant="warning" size="sm">
              {t("settings.overlayCalibrationNone")}
            </HkTag>
          )}
          {/* Icon-only control — the wrapping span carries the hover
              tooltip (HkButton takes ariaLabel, not title) and pins the
              row's right edge. */}
          <span class="calib-sec__edit" title={edit}>
            <HkButton
              size="sm"
              variant="secondary"
              ariaLabel={edit}
              onClick={() => void editEntry(c, cls)}
            >
              <SquarePen size={13} />
            </HkButton>
          </span>
        </div>
      );
    }

    return () => (
          <>
          {/* The water meter's own card first (view mode, roster
              attribution, display content) — the calibration list below
              only matters once the overlay is on. */}
          <OverlaySection ctx={props.ctx} />
          {/* in-game overlay anchor calibration — the detector's persistent
              per-client memory of where the Tab table sat, one card per
              registered client (plus orphaned calibration files at the
              end). The list is a pure read (overlay_calibration_list)
              merged with the install registry; the edit flow reopens the
              shared picker in calibration mode and creates empty entries
              from the drawing. Unreachable on the phone app build (no
              overlay window there — the rail filters the section out).
              data-settings-anchor: the live battle panel's locate pill
              glide target (settingsUi.show("overlayCalibration",
              SETTINGS_ANCHOR_CALIBRATION_LIST) slides the pane onto this
              card — the 手动定位 list, not the water-meter toggles above). */}
          <HkSettingsGroup
            title={t("settings.overlayCalibration")}
            data-settings-anchor={SETTINGS_ANCHOR_CALIBRATION_LIST}
          >
            <HkSettingsHint>{t("settings.overlayCalibrationDesc")}</HkSettingsHint>
            <div class="calib-sec__toolbar">
              <HkButton size="sm" variant="secondary" loading={loading.value} onClick={() => void refresh()}>
                <RefreshCw size={13} />
                {t("settings.overlayCalibrationRefresh")}
              </HkButton>
            </div>
            {loading.value && !loaded.value ? (
              <div class="calib-sec__state">
                <HkSpinner size={16} tone="current" />
              </div>
            ) : loadError.value != null ? (
              // Never fetched successfully: show the failure instead of
              // cards (see loadError) — the toolbar's refresh button above
              // is the retry. The section title rides along as the card's
              // headline (it prefixed the old raw hint line).
              <ErrorCard error={loadError.value} title={t("settings.overlayCalibration")} />
            ) : cards.value.length === 0 ? (
              <HkSettingsHint>{t("settings.overlayCalibrationEmpty")}</HkSettingsHint>
            ) : (
              <div class="calib-sec__clients">
                {cards.value.map((c) => (
                  <div class="calib-sec__client" key={c.path}>
                    {/* Title row mirrors the client selector: platform
                        badge, localized client name (+ realm tag), the
                        twin-disambiguating tail baked into the label; the
                        full install path rides the title tooltip, and the
                        last-updated stamp sits top-right. */}
                    <div class="calib-sec__head" title={c.path}>
                      <PlatformIcon kind={c.kind} size={22} />
                      <span class="calib-sec__name">
                        {cardLabels.value.get(normalizeGamePath(c.path)) ?? c.path}
                      </span>
                      {c.realm ? (
                        <HkTag variant="default" size="sm">{c.realm.toUpperCase()}</HkTag>
                      ) : null}
                      {c.unregistered ? (
                        <HkTag variant="warning" size="sm">
                          {t("settings.overlayCalibrationUnregistered")}
                        </HkTag>
                      ) : null}
                      {c.cal?.updatedAtMs != null ? (
                        <span class="calib-sec__updated">
                          {t("settings.overlayCalibrationUpdated", {
                            time: relativeTime(c.cal.updatedAtMs, uiLocale.value),
                          })}
                        </span>
                      ) : null}
                    </div>
                    {classRow(c, "pvp")}
                    {classRow(c, "pve")}
                  </div>
                ))}
              </div>
            )}
          </HkSettingsGroup>

          </>
    );
  },
});
