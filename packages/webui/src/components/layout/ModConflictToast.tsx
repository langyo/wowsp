import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HkModal, showBlockingToast } from "@celestia-island/hikari";

import {
  api,
  type ModIntegrityProblem,
  type ModIntegrityReport,
} from "@/api";
import { t } from "@/i18n";
import { useConfigStore } from "@/stores/config";
import { isMobileApp, isNative } from "@/utils/platform";
import "./ModConflictToast.scss";

/** The late one-shot boot scan's delay, counted from the moment the
 *  active install resolves. Sits past the updater's auto-check (5 s)
 *  prompt window and the duplicate-install ask (9 s) so the scan's card
 *  never stacks onto either — the duplicate-install precedent. */
const BOOT_SCAN_DELAY_MS = 15000;

/** Desktop-native only: browser dev has no scanner backend and the phone
 *  app has no local mod trees; the card renders nothing there, so it is
 *  safe to keep mounted unconditionally at the shell level. */
const QUIET_BUILD = !isNative() || isMobileApp();

/** The offending path's basename — problem.asset is one already, but
 *  problem.path is tree-relative and may carry either separator. */
function basename(p: string): string {
  const SEP = String.fromCharCode(92); // the Windows path separator
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf(SEP));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * ModConflictToast — the pre-launch mod-conflict ask-to-resolve card.
 * The backend's scanner (commands/mod_integrity.rs) proves a mod tree
 * would break the game UI (a dangling asset reference, a corrupt .swf,
 * one load claim made by two files) and this card asks the user to
 * resolve it — an ask-to-resolve consent card, NOT a transient toast:
 * it stays up until answered and never auto-dismisses. The card itself
 * is hikari's blocking-toast gate (showBlockingToast, danger variant;
 * the shell-level <HkBlockingToast /> host owns the toast column,
 * stacking and the enter/leave motion) — this component only keeps the
 * two triggers and the details modal.
 *
 * Two triggers feed the same gate: the backend's wowsp://mod-conflict
 * push (the watchdog detected the game starting — the "while the game
 * boots" alert, deduped per boot per game root) and a late one-shot
 * boot scan over the active install once it resolves (the
 * ship-GameParams warm's watch, delayed past the updater prompt). One
 * card up at a time — a newer report arriving while the card stands
 * just refreshes the report the details modal reads; a scan answering
 * no problems raises nothing.
 *
 * 查看详情 (the gate's confirm move) opens a plain HkModal listing
 * every problem row (localized kind, the offending asset/path, the
 * referencing files) with a hint that the mod hub's management page is
 * where mods are resolved; 知道了 dismisses FOR THE SESSION (no
 * persistence, the next app launch re-arms the gate). Purely
 * informational — nothing is blocked while the card or the modal is up.
 */
export default defineComponent({
  name: "ModConflictToast",
  setup() {
    const config = useConfigStore();

    /** The report the details modal presents (null = nothing to show). */
    const report = ref<ModIntegrityReport | null>(null);
    /** The details modal's visibility. */
    const modalOpen = ref(false);
    /** Session-dismissal latch: 知道了 silences both triggers until the
     *  next app launch. */
    const dismissed = ref(false);
    /** The gate card is up — one at a time, the newest report wins for
     *  the modal (the card's summary text is frozen at raise time; the
     *  modal is the resolution surface). */
    let cardPending = false;
    let scanTimer: number | undefined;
    let unlisten: (() => void) | null = null;

    /** Dismiss for the session: latch both triggers, drop the modal. */
    function dismiss() {
      dismissed.value = true;
      modalOpen.value = false;
    }

    /** Take a fresh report: only problems raise the card, a dismissal
     *  stands, and the newest report wins (a late boot scan may replace
     *  what the game-boot push already raised, and vice versa). */
    function ingest(next: ModIntegrityReport) {
      if (QUIET_BUILD || dismissed.value || next.problems.length === 0) return;
      report.value = next;
      if (cardPending) return;
      cardPending = true;
      void showBlockingToast(
        t("modConflict.summary", {
          count: next.problems.length,
          names: offendingNames(next),
        }),
        {
          title: t("modConflict.title"),
          confirmLabel: t("modConflict.review"),
          cancelLabel: t("modConflict.dismiss"),
          variant: "danger",
        },
      ).then((review) => {
        cardPending = false;
        if (review) modalOpen.value = true;
        else dismiss();
      });
    }

    /** Localized kind label — explicit branches over a dynamic key so a
     *  backend kind the UI predates can never render a raw key path. */
    function kindLabel(kind: ModIntegrityProblem["kind"]): string {
      switch (kind) {
        case "dangling_ref":
          return t("modConflict.kind.dangling_ref");
        case "invalid_swf":
          return t("modConflict.kind.invalid_swf");
        case "overlap":
          return t("modConflict.kind.overlap");
      }
    }

    /** The summary line's names half: the first 1-2 offending asset
     *  basenames (deduped); when a problem carries neither an asset nor
     *  a path, its kind label stands in so the line never renders empty. */
    function offendingNames(rep: ModIntegrityReport): string {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const problem of rep.problems) {
        const base = basename(problem.asset ?? problem.path ?? "");
        if (!base || seen.has(base)) continue;
        seen.add(base);
        names.push(base);
        if (names.length >= 2) break;
      }
      if (names.length > 0) return names.join(", ");
      return rep.problems.length > 0
        ? kindLabel(rep.problems[0]!.kind)
        : t("modConflict.modal.empty");
    }

    onMounted(() => {
      if (QUIET_BUILD) return;
      // Trigger (a): the backend watchdog's game-boot push.
      void (async () => {
        try {
          unlisten = (await api.listenModConflict?.(ingest)) ?? null;
        } catch {
          unlisten = null;
        }
      })();
      // Trigger (b): the late one-shot boot scan — the same watch the
      // ship-GameParams warm uses, firing once per session so later
      // install switches never rescan behind the user's back.
      let scannedRoot: string | null = null;
      watch(
        () => config.activeInstall?.path ?? "",
        (root) => {
          if (!root || scannedRoot !== null || dismissed.value) return;
          scannedRoot = root;
          scanTimer = window.setTimeout(() => {
            scanTimer = undefined;
            void api
              .modIntegrityScan(root)
              .then(ingest)
              .catch(() => {
                // No scanner backend (older shell) — stay quiet.
              });
          }, BOOT_SCAN_DELAY_MS);
        },
      );
    });

    onBeforeUnmount(() => {
      unlisten?.();
      unlisten = null;
      if (scanTimer !== undefined) window.clearTimeout(scanTimer);
    });

    return () => {
      if (QUIET_BUILD || !report.value) return null;
      const rep = report.value;
      return (
        /* The plain details modal — informational, never blocking. */
        <HkModal
          modelValue={modalOpen.value}
          onUpdate:modelValue={(v: boolean) => (modalOpen.value = v)}
          title={t("modConflict.modal.title")}
          width="30rem"
          footerActions={[
            {
              label: t("common.close"),
              variant: "secondary",
              onClick: () => (modalOpen.value = false),
            },
          ]}
        >
          {{
            default: () => (
              <div class="mod-conflict-modal__body">
                {rep.problems.length === 0 ? (
                  <p class="mod-conflict-modal__empty">
                    {t("modConflict.modal.empty")}
                  </p>
                ) : (
                  <div class="mod-conflict-modal__list">
                    {rep.problems.map((problem, index) => (
                      <div class="mod-conflict-modal__problem" key={index}>
                        <p class="mod-conflict-modal__head">
                          <span class="mod-conflict-modal__kind">
                            {kindLabel(problem.kind)}
                          </span>
                          <span class="mod-conflict-modal__target">
                            {problem.asset ?? problem.path ?? ""}
                          </span>
                        </p>
                        {problem.files.length > 0 ? (
                          <p class="mod-conflict-modal__files">
                            {t("modConflict.modal.files", {
                              files: problem.files.join(", "),
                            })}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                <p class="mod-conflict-modal__hint">
                  {t("modConflict.modal.hint")}
                </p>
              </div>
            ),
          }}
        </HkModal>
      );
    };
  },
});
