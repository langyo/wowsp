/** Shape of one baked `ship_live_stats.json` record. Field names are kept
 *  short — the asset ships to every client. See
 *  `scripts/extract_ship_live_stats.py` for where each number comes from. */

/** Per-band AA: `r` = outer range (km), `dps` = continuous DPS (summed). */
export interface AaBandStat {
  r: number;
  dps: number;
}

export type AaBands = {
  near?: AaBandStat;
  medium?: AaBandStat;
  far?: AaBandStat;
};

/** ASW airstrike: `r` range (km), `n` charges, `t` reload (s). */
export interface AswStat {
  r: number;
  n?: number;
  t?: number;
}

export interface ShipLiveStats {
  /** Main-battery range (km). */
  main?: number;
  /** Secondary-battery range (km). */
  sec?: number;
  /** Torpedo range (km). */
  torp?: number;
  hp?: number;
  /** Top speed (kn). */
  spd?: number;
  /** Surface detectability (km). */
  det?: number;
  /** Air detectability (km). */
  detAir?: number;
  aa?: AaBands;
  asw?: AswStat;
  /** Consumable-slot families in slot order (GameParams ShipAbilities). */
  load?: string[];
  /** Researchable module kinds still ahead of the stock hull. */
  upg?: string[];
  /** Signal-flag capacity (maxEquippedFlags). */
  flags?: number;
}
