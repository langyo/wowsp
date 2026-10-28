/**
 * playerContextMenu — the app-global right-click menu for PLAYER
 * surfaces (名单标记系统的操作入口). One binding at the document root
 * resolves any [data-player-name] element under the trigger and opens
 * the shared hikari context menu: the macOS-style tag strip (three
 * toggleable dots — 消极作战 / 疑似作弊 / 隐藏高手) pinned above the
 * standard actions (open the water table / copy the nickname).
 *
 * Delegation contract — every surface that renders a player identity
 * adds these attrs (the menu finds them via closest()):
 *   data-player-name       the RAW nickname (rows may display the
 *                          masked form; markers match the raw name)
 *   data-player-account?   decimal account id — rename-proof matching
 *   data-player-realm?     realm hint for the water-table jump
 * AI/scripted names never carry the attrs, so they keep the platform
 * menu. The tactical board's canvas menus are INNER bindings: hikari
 * resolves innermost-first and the point arrives already
 * defaultPrevented — the builder then steps aside.
 */
import { defineComponent, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import {
  HkTagDotRow,
  bindContextMenu,
  useContextMenu,
  type ContextMenuRequest,
  type ContextTriggerPoint,
  type HkMenuItem,
} from "@celestia-island/hikari";

import { useClipboard } from "@/composables/useClipboard";
import { isAiName } from "@/utils/aiNames";
import { t } from "@/i18n";
import type { MarkerColor } from "@/api";
import { MARKER_COLORS, useMarkersStore } from "@/stores/markers";

/** The shared dot ink — the same hexes the settings list, the live
 * roster dots and the holo beads paint (keep the family in step). */
export const MARKER_DOT_COLORS: Record<MarkerColor, string> = {
  red: "#e5484d",
  yellow: "#ffd400",
  purple: "#a855f7",
};

/** The localized marker name (消极作战 / 疑似作弊 / 隐藏高手 …). */
export function markerColorLabel(color: MarkerColor): string {
  return t(
    color === "red"
      ? "settings.markersColorRed"
      : color === "yellow"
        ? "settings.markersColorYellow"
        : "settings.markersColorPurple",
  );
}

/** The identity resolved from a trigger point. */
export interface PlayerMenuTarget {
  nickname: string;
  accountId: number | null;
  realm: string | null;
}

/** Resolve the delegation target under a trigger point; null when the
 *  trigger carries no player row (or an inner binding already claimed
 *  it, or the name is an AI/scripted unit). */
export function playerFromPoint(point: ContextTriggerPoint): PlayerMenuTarget | null {
  if (point.defaultPrevented) return null; // an inner binding's menu stands
  const el =
    point.target instanceof Element
      ? point.target.closest<HTMLElement>("[data-player-name]")
      : null;
  if (!el) return null;
  const nickname = el.getAttribute("data-player-name")?.trim() ?? "";
  if (!nickname || isAiName(nickname)) return null;
  const account = el.getAttribute("data-player-account");
  const realm = el.getAttribute("data-player-realm");
  return {
    nickname,
    accountId: account != null && /^\d+$/.test(account) ? Number(account) : null,
    realm: realm || null,
  };
}

/** Builder dependencies — injected so tests drive the menu without a
 *  live router or clipboard. */
export interface PlayerMenuDeps {
  markers: ReturnType<typeof useMarkersStore>;
  openLookup: (nickname: string, realm: string | null) => void;
  copyName: (nickname: string) => void;
}

/** One dot toggle: same color unmarks, another color re-marks (the
 *  backend upserts by nickname; the account id sharpens the match). */
async function toggleMarker(
  player: PlayerMenuTarget,
  color: string,
  deps: PlayerMenuDeps,
): Promise<void> {
  if (!MARKER_COLORS.includes(color as MarkerColor)) return;
  if (deps.markers.colorOf(player.nickname, player.accountId) === color) {
    await deps.markers.remove(player.nickname);
    return;
  }
  await deps.markers.add(player.nickname, color as MarkerColor, null, player.accountId);
}

/** Build the shared player context menu for a trigger; null when the
 *  trigger resolves to no player (the native menu then applies). */
export function buildPlayerContextMenuRequest(
  point: ContextTriggerPoint,
  deps: PlayerMenuDeps,
): ContextMenuRequest | null {
  const player = playerFromPoint(point);
  if (!player) return null;
  const items: HkMenuItem[] = [
    { key: "lookup", label: t("common.playerMenu.lookup") },
    { key: "copy", label: t("common.playerMenu.copyName") },
  ];
  return {
    x: point.x,
    y: point.y,
    title: player.nickname,
    items,
    // The tag strip stays live across toggles: the header render reads
    // the store, and clicks inside the region never close the menu.
    header: () => (
      <HkTagDotRow
        label={t("settings.markersTitle")}
        tags={MARKER_COLORS.map((color) => ({
          key: color,
          color: MARKER_DOT_COLORS[color],
          label: markerColorLabel(color),
          active: deps.markers.colorOf(player.nickname, player.accountId) === color,
        }))}
        onToggle={(key: string) => {
          void toggleMarker(player, key, deps);
        }}
      />
    ),
    onSelect: (key: string) => {
      if (key === "lookup") deps.openLookup(player.nickname, player.realm);
      else if (key === "copy") deps.copyName(player.nickname);
    },
  };
}

/**
 * The mount point for the app-global player menu: a renderless host
 * INSIDE the provider tree. App renders HkContextMenuProvider inside
 * its own template, and Vue's inject() only sees provides from
 * ANCESTORS — a usePlayerContextMenu() call in App's OWN setup would
 * hand back hikari's no-op fallback and the menu would never open.
 * Mount <PlayerContextMenuHost /> as the provider's child instead.
 */
export const PlayerContextMenuHost = defineComponent({
  name: "PlayerContextMenuHost",
  setup() {
    usePlayerContextMenu();
    return () => null;
  },
});

/** Install the app-global player context menu (via PlayerContextMenuHost,
 *  inside the provider tree): right-click / long-press / menu-key on any
 *  [data-player-name] element opens the shared menu. */
export function usePlayerContextMenu(): void {
  const ctx = useContextMenu();
  const markers = useMarkersStore();
  const router = useRouter();
  const { copy } = useClipboard();
  void markers.ensureLoaded();

  const deps: PlayerMenuDeps = {
    markers,
    openLookup: (nickname, realm) => {
      void router.push({
        path: "/lookup",
        query: realm ? { name: nickname, realm } : { name: nickname },
      });
    },
    copyName: (nickname) => copy(nickname),
  };

  const unbind = bindContextMenu(document.body, ctx, (point) =>
    buildPlayerContextMenuRequest(point, deps),
  );
  onBeforeUnmount(unbind);
}
