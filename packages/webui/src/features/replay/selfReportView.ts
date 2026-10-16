/**
 * Shared display layer for the 我的战绩 report — the pure helpers behind
 * BOTH hosts (the live panel's body and the replay results modal's self
 * view) and their share shots: one row view, one summary-tile list, one
 * damage-composition vocabulary, one shot model. The copied image can
 * never disagree with the panel beside it.
 */
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import type { ShipIconVariant } from "@/features/holographic/shipIcons";
import { t } from "@/i18n";
import { damageColor } from "@/utils/winrate";
import { rowCompEntries, type FamilyDamage } from "./damageComp";
import type { SelfCombatRow, SelfStatsModel } from "./liveSelfStats";
import type { SelfShotColumn, SelfShotModel, SelfShotRow, SelfShotStat } from "./liveSelfShot";

/** Masking is a per-host concern (the live head's toggle drives its whole
 *  panel; the modal has its own bar) — helpers take the resolver. */
type MaskOf = (name: string) => string;

/** Match-time stamp (M:SS) for the 同步至 line and row tooltips. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Localized label for a composition bucket (family or row-comp key). */
export function compLabel(key: string): string {
  return t(`replay.comp.${key}`);
}

/** Localized + masked view of one combat row (DOM rows and shot rows). */
export interface SelfRowView {
  nick: string;
  rawNick: string | null;
  bot: boolean;
  shipName: string;
  shipType: string | null;
  iconVariant: ShipIconVariant;
  damage: number;
  maxHp: number | null;
  hpRatio: number | null;
  killed: boolean;
  lastAt: number;
  /** Non-zero composition chips (label + formatted value), desc. */
  compChips: { key: string; label: string; text: string }[];
  /** The chips as one muted line — the share row's ship-name suffix. */
  compLine: string;
}

export function selfRowViewOf(row: SelfCombatRow, lang: string, maskOf: MaskOf): SelfRowView {
  const shipName =
    row.shipId != null ? (shipNameFromOfflineDb(row.shipId, lang) ?? "") : "";
  const relation = row.relation;
  const iconVariant: ShipIconVariant =
    row.killed || row.hpRatio === 0
      ? "sunk"
      : relation == null
        ? "plain"
        : relation <= 1
          ? "ally"
          : "enemy";
  const compChips = rowCompEntries(row.comp).map((c) => ({
    key: c.key,
    label: compLabel(c.key),
    text: c.total.toLocaleString(),
  }));
  return {
    nick: maskOf(row.name ?? `#${row.entityId}`),
    rawNick: row.name,
    bot: row.bot,
    shipName,
    shipType: row.shipId != null ? (shipOfflineEntry(row.shipId)?.type ?? null) : null,
    iconVariant,
    damage: row.damage,
    maxHp: row.maxHp,
    hpRatio: row.hpRatio,
    killed: row.killed,
    lastAt: row.lastAt,
    compChips,
    compLine: compChips.map((c) => `${c.label} ${c.text}`).join(" · "),
  };
}

/** Fold duplicate achievements into name ×n chips — ALL duplicates, not
 *  just consecutive ones (an A · B · A earn order must still read A ×2 · B),
 *  first-earn order preserved. */
export function foldAchievementsOf(
  m: SelfStatsModel | null,
): { name: string; count: number }[] {
  const byName = new Map<string, { name: string; count: number }>();
  for (const a of m?.achievements ?? []) {
    const hit = byName.get(a.name);
    if (hit) hit.count += 1;
    else byName.set(a.name, { name: a.name, count: 1 });
  }
  return [...byName.values()];
}

/** One summary tile of the stats row. */
export interface SelfTile {
  label: string;
  value: string;
  color?: string;
}

/** The summary tiles: damage / plane damage / hits / taken / frags — exp
 *  once the authoritative results landed. */
export function selfTilesOf(m: SelfStatsModel | null): SelfTile[] {
  const tiles: SelfTile[] = [
    {
      label: t("replay.live.selfDamage"),
      value: m ? m.damage.toLocaleString() : "—",
      color: m ? damageColor(m.damage) : undefined,
    },
    { label: t("replay.live.selfPlaneDamage"), value: m ? m.planeDamage.toLocaleString() : "—" },
    { label: t("replay.live.selfHits"), value: m ? String(m.hits) : "—" },
    { label: t("replay.live.selfTaken"), value: m ? m.taken.toLocaleString() : "—" },
    { label: t("replay.live.selfFrags"), value: m ? String(m.frags) : "—" },
  ];
  if (m?.final && m.final.exp != null) {
    tiles.push({
      label: t("replay.live.selfExp"),
      value: m.final.exp.toLocaleString(),
    });
  }
  return tiles;
}

/** The server's damage split by weapon family — the strip under the tiles.
 *  Chips render desc by damage (the fold's order). */
export function globalCompOf(
  m: SelfStatsModel | null,
): { key: string; label: string; text: string; share: number }[] {
  const comp: FamilyDamage[] = m?.damageComp ?? [];
  const total = comp.reduce((acc, f) => acc + f.total, 0);
  return comp.map((f) => ({
    key: f.family,
    label: compLabel(f.family),
    text: f.total.toLocaleString(),
    share: total > 0 ? f.total / total : 0,
  }));
}

/** Options both hosts fill to place the report in its context. */
export interface SelfShotOptions {
  title: string;
  mode: SelfShotModel["mode"];
  mapLabel: string | null;
  /** Provenance line (同步至 M:SS / 结算完成 / null). */
  metaLine: string | null;
  /** My nick · ship line. */
  selfLine: string;
  lang: string;
  maskOf: MaskOf;
  estimateNote: string | null;
}

/** The share-shot model for the self report — the exact panel content
 *  (tiles, composition line, achievements, both ledgers) in the renderer's
 *  vocabulary. Nicks arrive masked; row composition rides the ship-name
 *  line so the canvas renderer stays untouched by it. */
export function buildSelfShotModel(m: SelfStatsModel | null, opts: SelfShotOptions): SelfShotModel {
  const tiles: SelfShotStat[] = selfTilesOf(m).map((x) => ({
    label: x.label,
    value: x.value,
    ...(x.color ? { color: x.color } : {}),
  }));
  const achievements = foldAchievementsOf(m).map(
    (a) => (a.count > 1 ? `${a.name} ×${a.count}` : a.name),
  );
  const compChips = globalCompOf(m);
  const compLine =
    compChips.length > 0
      ? `${t("replay.live.selfCompTitle")} ${compChips.map((c) => `${c.label} ${c.text}`).join(" · ")}`
      : null;
  const mkCol = (rows: SelfCombatRow[], title: string): SelfShotColumn => ({
    title,
    emptyLabel: t("replay.live.selfNoRows"),
    rows: rows.map(
      (r): SelfShotRow => {
        const v = selfRowViewOf(r, opts.lang, opts.maskOf);
        const shipLine = [v.shipName || "—", v.compLine].filter(Boolean).join(" · ");
        return {
          nick: v.nick,
          shipName: shipLine,
          bot: v.bot,
          sunk: v.killed || v.hpRatio === 0,
          killed: v.killed,
          shipType: v.shipType,
          iconVariant: v.iconVariant === "plain" ? undefined : v.iconVariant,
          damage: v.damage.toLocaleString(),
        };
      },
    ),
  });
  return {
    title: opts.title,
    mode: opts.mode,
    mapLabel: opts.mapLabel,
    metaLine: opts.metaLine,
    selfLine: opts.selfLine,
    summary: tiles,
    achievements,
    compLine,
    columns: [
      mkCol(m?.dealt ?? [], t("replay.live.selfDealtTitle")),
      mkCol(m?.received ?? [], t("replay.live.selfReceivedTitle")),
    ],
    estimateNote: opts.estimateNote,
    botLabel: t("replay.bot"),
    killLabel: t("replay.live.selfKillMark"),
  };
}
