/**
 * Plan-profile archive (the 档案 the tactics page names, saves and shares):
 * a zip the Rust side writes/reads — `profile.toml` (format + app/game
 * versions, the map, the battle mode, the capture layout, the lineup) plus
 * one JSON document per plan branch (`plans/<n>.json`). The webui assembles
 * and applies the payload; bytes and TOML live in
 * packages/app/tauri/src/commands/tactics_profile.rs.
 */
import { api } from "@/api";
import type { Lineup } from "./lineup";
import type { CapSpec } from "./modes";
import type { TacticalSession } from "./session";
import {
  DEFAULT_SLOT_ID,
  exportBundle,
  slotDocPath,
  loadSlots,
  saveSlots,
} from "./planSlots";
import { docStorageKey, parseDoc, serializeDoc } from "./model";

export const TACTICS_PROFILE_FORMAT = "wowsp-tactics-profile";
export const TACTICS_PROFILE_VERSION = 1;

/** The TOML metadata block (Rust serialises it; field names are the wire). */
export interface TacticsProfileMeta {
  format: typeof TACTICS_PROFILE_FORMAT;
  version: number;
  appVersion: string;
  gameVersion: string | null;
  exportedAt: string;
  mapId: string;
  mapName: string;
  modeId: string | null;
  profileName: string;
  mirror: boolean;
  caps: CapSpec[];
  lineup: Lineup;
}

export interface TacticsProfilePlan {
  name: string;
  json: string;
  /** Index of the forked-from plan in the same payload (see plan bundles). */
  parent?: string;
  branchT?: number;
}

export interface TacticsProfilePayload {
  meta: TacticsProfileMeta;
  plans: TacticsProfilePlan[];
}

/** Save-dialog + zip write; returns the saved path, or null when the user
 * cancelled. Throws on a non-Tauri host (the caller falls back to a toast). */
export async function saveTacticsProfile(
  payload: TacticsProfilePayload,
): Promise<string | null> {
  return api.saveTacticsProfile(payload.meta, payload.plans);
}

/** Open-dialog + zip read; null = cancelled. Throws on a bad archive; the
 *  meta block is validated (profileMetaOk) before the cast. */
export async function openTacticsProfile(): Promise<TacticsProfilePayload | null> {
  const payload = await api.openTacticsProfile();
  if (!payload) return null;
  if (!profileMetaOk(payload.meta)) {
    throw new Error("not a WoWSP tactics profile");
  }
  return payload as TacticsProfilePayload;
}

/** Sanity check on an opened payload's meta block. */
export function profileMetaOk(meta: unknown): meta is TacticsProfileMeta {
  if (typeof meta !== "object" || meta == null) return false;
  const m = meta as Partial<TacticsProfileMeta>;
  return m.format === TACTICS_PROFILE_FORMAT && typeof m.version === "number" && typeof m.mapId === "string";
}

/** Assemble the payload for the CURRENT map: the session + every plan
 *  branch (inventory + documents) out of localStorage. */
export function buildProfilePayload(
  spaceId: string,
  mapName: string,
  session: TacticalSession,
  versions: { appVersion: string; gameVersion: string | null },
): TacticsProfilePayload {
  // exportBundle already resolves fork pointers to ENTRY INDICES, which is
  // exactly what an archive carries — parents on the wire are plan indices.
  const bundle = exportBundle(spaceId);
  const plans: TacticsProfilePlan[] = bundle.slots.map((entry, i) => ({
    name: entry.name || `Plan ${i + 1}`,
    json: JSON.stringify(entry.doc),
    ...(entry.parent != null ? { parent: String(entry.parent) } : {}),
    ...(entry.branchT != null ? { branchT: entry.branchT } : {}),
  }));
  return {
    meta: {
      format: TACTICS_PROFILE_FORMAT,
      version: TACTICS_PROFILE_VERSION,
      appVersion: versions.appVersion,
      gameVersion: versions.gameVersion,
      exportedAt: new Date().toISOString(),
      mapId: spaceId,
      mapName,
      modeId: session.modeId,
      profileName: session.profileName,
      mirror: session.mirror,
      caps: session.caps,
      lineup: session.lineup,
    },
    plans,
  };
}

/** Land an opened profile on this machine: session keys for its map, plan
 *  documents renumbered from the default slot (same contract as a plan
 *  bundle import), stale slot keys removed. Returns the profile's map id —
 *  the caller switches the board to it. */
export function applyProfilePayload(payload: TacticsProfilePayload): string {
  const spaceId = payload.meta.mapId;
  const stale = loadSlots(spaceId)
    .filter((s) => s.id !== DEFAULT_SLOT_ID)
    .map((s) => s.id);
  const slots = payload.plans.map((plan, i) => {
    const id = String(i);
    try {
      // Round-trip through parseDoc so a tampered plan never lands.
      const doc = parseDoc(plan.json);
      window.localStorage.setItem(
        docStorageKey(slotDocPath(spaceId, id)),
        doc ? serializeDoc(doc) : serializeDoc({ version: 1, elements: [], steps: [] }),
      );
    } catch {
      // storage full — the slot shows empty rather than blocking the rest
    }
    // A plan's parent is its forked-from plan's INDEX in the payload — the
    // renumbered slot id is exactly String(index). Out-of-range drops it.
    const parentIndex =
      plan.parent != null && plan.parent !== "" ? Number(plan.parent) : Number.NaN;
    return {
      id,
      name: plan.name,
      ...(Number.isInteger(parentIndex) && parentIndex >= 0 && parentIndex < payload.plans.length
        ? { parent: String(parentIndex) }
        : {}),
      ...(plan.branchT != null ? { branchT: plan.branchT } : {}),
    };
  });
  saveSlots(spaceId, slots);
  for (const id of stale) {
    if (!slots.some((s) => s.id === id)) {
      try {
        window.localStorage.removeItem(docStorageKey(slotDocPath(spaceId, id)));
      } catch {
        // already gone
      }
    }
  }
  return spaceId;
}
