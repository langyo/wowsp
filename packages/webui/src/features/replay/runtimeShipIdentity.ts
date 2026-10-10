/**
 * Runtime ship-identity resolver: the App-side half of the unknown-ship
 * fallback. The baked `ship_names.json` is a build-time snapshot, so ships a
 * game update (or a collaboration event) adds AFTER the bake are invisible
 * to it — their rows render blank, sort last and wear a wrong class icon.
 * When the live roster carries such a shipId, this module asks the player's
 * OWN client for that ship's GameParams subtree (`get_ship_gameparams`) and
 * registers the derived identity (tier / species / nation / display name)
 * into `utils/runtimeShipDb`, where every consumer's existing fallback chain
 * picks it up: the Tab sort key (utils/shipClass), the ship-offline-entry
 * readers (modelLoader → LiveShipMeta's identity strip), the share-shot
 * pipeline.
 *
 * Fire-and-forget by contract: a background enhancement that must never
 * surface in the UI — errors are swallowed, nothing toasts, nothing blocks.
 * Each (gameRoot, shipId) pair is attempted at most ONCE per session (the
 * resolution is deterministic — a miss would miss again; a re-install under
 * a different root is a different key and may retry); the store itself is
 * plain state, so `runtimeShipEpoch` counts registrations as the reactive
 * trigger the render layer watches.
 *
 * Name derivation mirrors the bake script's `prettify_entity_name`
 * (scripts/model_convert/extract_ship_names.py): GameParams `shortName` is
 * the client's own sort/display name; the entity name
 * ("PJSB719_Hotaka_1944") degrades to its tail after the first underscore
 * with the rest spaced; the raw index ("PJSB719") is the last resort before
 * giving up. Names register under the "en" key — `shipNameFromOfflineDb`'s
 * fallback order (lang → en → first value) serves it to every locale.
 */
import { ref } from "vue";

import { api } from "@/api";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { registerRuntimeShipEntry } from "@/utils/runtimeShipDb";

/** Bumped once per registration — the render layer's re-render trigger
 *  (runtimeShipDb is deliberately non-reactive; see its module docs). */
export const runtimeShipEpoch = ref(0);

/** Already-tried (gameRoot#shipId) keys — success AND failure both count:
 *  no per-battle retry loop against a several-second GameParams unpack. */
const attempted = new Set<string>();
/** In-flight keys, so a roster re-read while a probe is pending cannot
 *  double-fire the same request. */
const inflight = new Set<string>();

/** The fields this module knows how to read off a raw GameParams entry.
 *  Everything arrives as `unknown` over the RPC boundary — narrowed below. */
interface RawGameparamsEntry {
  level?: unknown;
  index?: unknown;
  shortName?: unknown;
  name?: unknown;
  typeinfo?: unknown;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function typeinfoOf(raw: RawGameparamsEntry): {
  species: string | null;
  nation: string | null;
} {
  const ti = raw.typeinfo;
  if (typeof ti !== "object" || ti === null) return { species: null, nation: null };
  const rec = ti as { species?: unknown; nation?: unknown };
  return {
    species: asNonEmptyString(rec.species),
    nation: asNonEmptyString(rec.nation)?.toLowerCase() ?? null,
  };
}

/** The bake script's `prettify_entity_name`: the tail after the FIRST
 *  underscore, remaining underscores spaced ("PJSB719_Hotaka_1944" →
 *  "Hotaka 1944"); a name without any underscore passes through as-is. */
function prettifyEntityName(entityName: string): string {
  const cut = entityName.indexOf("_");
  if (cut < 0) return entityName;
  return entityName.slice(cut + 1).replace(/_/g, " ");
}

/** Resolve every roster shipId the baked DB cannot explain against the game
 *  install's GameParams, registering whatever resolves. Safe to call on
 *  every roster refresh: known ids, tried keys and pending probes are all
 *  skipped, and an empty gameRoot still probes (the shell resolves the
 *  matched install server-side — mobile / cached paths answer too). */
export function resolveRuntimeShips(
  shipIds: Array<number | string | null | undefined>,
  gameRoot: string,
): void {
  for (const id of shipIds) {
    // Null/0 shipIds are the roster's "no ship" placeholders, not unknowns.
    if (id == null || id === 0 || id === "") continue;
    // Known to the bake OR already registered (the offline-entry readers
    // cover runtime registrations too). The latter is deliberate on a game
    // root switch: the derived identity is install-independent GameParams
    // data, so an entry registered under an older root is reused as-is —
    // only ids NO source ever answered re-probe under the new root (their
    // attempt key carries the root).
    if (shipOfflineEntry(id)) continue;
    const key = `${gameRoot}#${id}`;
    if (attempted.has(key) || inflight.has(key)) continue;
    attempted.add(key);
    inflight.add(key);
    void api
      .getShipGameparams(Number(id), gameRoot)
      .then((raw) => {
        registerDerived(id, raw);
      })
      .catch(() => {
        // A background enhancement: a failed probe (no install, unpack
        // error, ship genuinely absent) just leaves the ship unknown.
      })
      .finally(() => {
        inflight.delete(key);
      });
  }
}

function registerDerived(shipId: number | string, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const entry = raw as RawGameparamsEntry;
  const tier = typeof entry.level === "number" ? entry.level : null;
  const { species, nation } = typeinfoOf(entry);
  // Name chain: shortName → prettified entity name → raw index.
  const shortName = asNonEmptyString(entry.shortName);
  const entityName = asNonEmptyString(entry.name);
  const basicName =
    shortName ??
    (entityName ? prettifyEntityName(entityName) : null) ??
    asNonEmptyString(entry.index);
  // A subtree answering nothing usable (shouldn't happen for a real ship)
  // must not register an all-empty entry — the unknown sentinels stay.
  if (tier == null && species == null && nation == null && basicName == null) {
    return;
  }
  registerRuntimeShipEntry(shipId, {
    index: asNonEmptyString(entry.index),
    tier,
    type: species,
    nation,
    names: basicName ? { en: basicName } : null,
  });
  runtimeShipEpoch.value += 1;
}

/** Test hook: forget the attempt ledger and the epoch (pair with
 *  `resetRuntimeShipEntries` — the registrations themselves live there). */
export function resetRuntimeShipIdentityForTests(): void {
  attempted.clear();
  inflight.clear();
  runtimeShipEpoch.value = 0;
}
