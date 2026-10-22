/**
 * Per-map plan-session state: everything the tactics page keeps BESIDES the
 * plan documents themselves — the selected battle mode, the (author-moved)
 * capture-point layout that mode instantiated, the fleet lineup, the
 * auto-mirror toggle and the profile's display name. One JSON blob per
 * space id in localStorage; the profile exporter folds it into the TOML
 * meta so a shared archive reconstructs the whole session.
 *
 * Pure module (DOM-free apart from localStorage) — unit-testable.
 */
import type { CapSpec } from "./modes";
import type { HeatLayerMode } from "./heatLayer";
import { sanitizeEntry, type Lineup } from "./lineup";

export interface TacticalSession {
  /** ModePreset id (modes.ts); null = the map was never set up. */
  modeId: string | null;
  /** Raw match-group of the applied LEARNED layout — the corpus/local key
   *  the heat overlay resolves against (template presets carry null here;
   *  heatLayer maps their modeId onto the same keys instead). */
  modeGroup: string | null;
  /** World-space capture layout (moved by the author off the template). */
  caps: CapSpec[];
  /** Fleet lineup (lineup.ts persistence shape). */
  lineup: Lineup;
  /** Auto-mirror orders between sides. */
  mirror: boolean;
  /** Corpus heat-overlay state (off / track / spawn). */
  heat: HeatLayerMode;
  /** Profile display name ("" = derived from the file name). */
  profileName: string;
  /** The confirmed silent save target (absolute path); null = the save
   *  button runs the dialog flow. Fixed when the map is boarded. */
  profilePath: string | null;
  /** Generated archive base name (date-time + map + sequence) — the save
   *  dialog's seed and the top-right tag's fallback label. */
  fileName: string | null;
}

export function emptySession(): TacticalSession {
  return {
    modeId: null,
    modeGroup: null,
    caps: [],
    lineup: { ally: [], enemy: [] },
    mirror: false,
    heat: "off",
    profileName: "",
    profilePath: null,
    fileName: null,
  };
}

function sessionKey(spaceId: string): string {
  return `wowsp:tactics:session:v1:${spaceId}`;
}

function sanitizeLineupSide(raw: unknown): Lineup["ally"] {
  // Delegates to lineup.ts's shared entry sanitizer (keeps the per-hull
  // build alive across reloads and profile imports — the session blob is
  // the lineup's LIVE persistence path).
  if (!Array.isArray(raw)) return [];
  const out: Lineup["ally"] = [];
  for (const e of raw) {
    const entry = sanitizeEntry(e);
    if (entry) out.push(entry);
  }
  return out;
}

function sanitizeCaps(raw: unknown): CapSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: CapSpec[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c == null) continue;
    const rec = c as Record<string, unknown>;
    const at = rec.at as Record<string, unknown> | undefined;
    if (
      !at ||
      typeof at.x !== "number" ||
      !Number.isFinite(at.x) ||
      typeof at.z !== "number" ||
      !Number.isFinite(at.z)
    ) {
      continue;
    }
    const team =
      rec.team === "ally" || rec.team === "enemy" || rec.team === null ? rec.team : null;
    out.push({
      letter: typeof rec.letter === "string" && rec.letter ? rec.letter : "?",
      at: { x: at.x, z: at.z },
      radius: typeof rec.radius === "number" && rec.radius > 0 ? rec.radius : 700 / 30,
      team,
      ...(typeof rec.appearT === "number" && Number.isFinite(rec.appearT)
        ? { appearT: rec.appearT }
        : {}),
      ...(rec.station === true ? { station: true } : {}),
    });
  }
  return out;
}

export function loadSession(spaceId: string): TacticalSession {
  try {
    const raw = window.localStorage.getItem(sessionKey(spaceId));
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Partial<TacticalSession> | null;
    if (typeof parsed !== "object" || parsed == null) return emptySession();
    return {
      modeId: typeof parsed.modeId === "string" ? parsed.modeId : null,
      modeGroup:
        typeof parsed.modeGroup === "string" && parsed.modeGroup ? parsed.modeGroup : null,
      caps: sanitizeCaps(parsed.caps),
      lineup: {
        ally: sanitizeLineupSide(parsed.lineup?.ally),
        enemy: sanitizeLineupSide(parsed.lineup?.enemy),
      },
      mirror: parsed.mirror === true,
      heat: parsed.heat === "track" || parsed.heat === "spawn" ? parsed.heat : "off",
      profileName: typeof parsed.profileName === "string" ? parsed.profileName : "",
      profilePath: typeof parsed.profilePath === "string" && parsed.profilePath ? parsed.profilePath : null,
      fileName: typeof parsed.fileName === "string" && parsed.fileName ? parsed.fileName : null,
    };
  } catch {
    return emptySession();
  }
}

export function saveSession(spaceId: string, session: TacticalSession): void {
  try {
    window.localStorage.setItem(sessionKey(spaceId), JSON.stringify(session));
  } catch {
    // storage full/disabled — the session stays for this view only
  }
}

/** Rebuild a session from an opened profile's meta block (profile.ts).
 *  Every field is optional on the wire — a field the archive lacks keeps
 *  the empty default rather than guessing. */
export function sessionFromProfileMeta(meta: unknown): TacticalSession {
  const out = emptySession();
  if (typeof meta !== "object" || meta == null) return out;
  const m = meta as Record<string, unknown>;
  if (typeof m.modeId === "string" && m.modeId) out.modeId = m.modeId;
  if (typeof m.modeGroup === "string" && m.modeGroup) out.modeGroup = m.modeGroup;
  if (Array.isArray(m.caps)) out.caps = sanitizeCaps(m.caps);
  if (typeof m.lineup === "object" && m.lineup != null) {
    const lu = m.lineup as Record<string, unknown>;
    out.lineup = {
      ally: sanitizeLineupSide(lu.ally),
      enemy: sanitizeLineupSide(lu.enemy),
    };
  }
  if (m.mirror === true) out.mirror = true;
  if (m.heat === "track" || m.heat === "spawn") out.heat = m.heat;
  if (typeof m.profileName === "string") out.profileName = m.profileName;
  // The archive's meta never carries the local save path (that is machine
  // state, not plan data); the file name rides along as the label seed.
  if (typeof m.fileName === "string" && m.fileName) out.fileName = m.fileName;
  return out;
}
