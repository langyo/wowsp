#!/usr/bin/env python
"""Generate the per-version Avatar/Vehicle client-method id table used by the
replay packet decoder (`packages/app/tauri/src/commands/method_tables.rs`).

Why: the wire method id in EntityMethod (0x08) packets is the method's index in
the entity's client-method table sorted by wire size (BigWorld "exposed index";
stable sort so equal-size methods keep XML order). The tables drift with every
game version, so the decoder must pick the table matching the replay's client
version instead of hardcoding ids.

Source of truth: MarshalPartyByJack's `replay_unpack` entity definitions (the
`.def` XML files shipped per game version), as vendored inside the local
minimap_renderer reference checkout:

    <reference>/src/replay_unpack/clients/wows/versions/<ver>/scripts/entity_defs/

Usage:

    python scripts/gen_method_tables.py <path-to-minimap_renderer>/src \
        > packages/app/tauri/src/commands/method_tables.rs

The output is committed; CI never runs this script.
"""

import os
import re
import sys


AVATAR_METHODS = [
    "receiveArtilleryShots",
    "receiveTorpedoes",
    "receiveExplosions",
    "receiveTorpedoDirection",
    "receive_addSquadron",
    "receive_updateSquadron",
    "receive_addMinimapSquadron",
    "receive_updateMinimapSquadron",
    "receive_removeMinimapSquadron",
    "receive_wardAdded",
    "receive_wardRemoved",
    "receiveShotKills",
    "receiveDamageStat",
    "onChatMessage",
    "onAchievementEarned",
]

# Fields emitted as `Option<i32>`: the reference entity defs don't expose every
# method the replay stream carries, so a missing def resolves to `None` (the
# decoder then leaves that stream empty) instead of a bogus id.
OPTIONAL_FIELDS = {"avatar_receive_damage_stat"}

# Fields whose def-derived id is NOT trusted yet: newer reference defs started
# shipping `receiveDamageStat` (they used to be absent — hence the Option), but
# the per-version ids have not been validated against real captures. Keep the
# def-derived value suppressed (`None`) so regeneration stays stable and the
# stream stays empty until each version is pinned empirically; the 15.8.0
# empirical override below still carries its capture-verified id.
DEF_ID_SUPPRESSED = {"avatar_receive_damage_stat"}

# Rows for versions the reference entity definitions don't ship yet, derived
# empirically from captured replays (decode a real 15.8 .wowsreplay, identify
# each method by wire shape). Each override merges over the nearest older
# generated row; the id drift it captures is documented per version below.
EMPIRICAL_OVERRIDES: dict[tuple[int, int, int], dict[str, int]] = {
    # 15.8.0: three avatar methods inserted below the battle-effect cluster
    # shift it +3 (artillery 123→126, torpedoes 124→127, shotKills 127→130,
    # updateSquadron 142→145); squadron add/minimap ids keep their 15.7
    # values; receiveDamageStat sits at 163 (verified: 137 calls on the
    # recorder's avatar in a full-battle capture — newer reference defs also
    # expose the method, but those ids are still suppressed pending
    # per-version validation, see DEF_ID_SUPPRESSED).
    (15, 8, 0): {
        "avatar_receive_artillery_shots": 126,
        "avatar_receive_torpedoes": 127,
        "avatar_receive_shot_kills": 130,
        "avatar_receive_update_squadron": 145,
        "avatar_receive_ward_removed": 50,
        "avatar_receive_damage_stat": 163,
        "avatar_on_chat_message": 151,
        "avatar_on_achievement_earned": 58,
    },
}

EMPIRICAL_NOTES = {
    (
        15,
        8,
        0,
    ): """    // 15.8.0 has no reference entity definitions yet — this row is derived
    // empirically from captured 15.8 replays (see `EMPIRICAL_OVERRIDES` in
    // scripts/gen_method_tables.py): three avatar methods inserted below the
    // battle-effect cluster shift it +3 (artillery 123→126, torpedoes
    // 124→127, shotKills 127→130, updateSquadron 142→145), while the
    // squadron add/minimap ids keep their 15.7 values; receiveDamageStat
    // sits at 163. onChatMessage sits at 151 (args decode as plaintext
    // chat: `i32 playerId, STRING namespace, STRING message, STRING unk` —
    // "battle_team" namespaces and real CJK/Latin text observed);
    // onAchievementEarned stays at 58 with args `i32 playerId, u32
    // achievementId` whose ids match the playersPublicInfo achievement
    // list in the same capture.""",
}


def to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def version_key(dir_name: str):
    return tuple(int(x) for x in dir_name.split("_"))


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    # Pure-LF output so `>` redirection on Windows doesn't inject CRLF that
    # `cargo fmt` would then strip (keeping regeneration fmt-stable).
    sys.stdout.reconfigure(newline="\n")
    src_root = sys.argv[1]
    sys.path.insert(0, src_root)
    from replay_unpack.clients.wows.helper import get_definitions  # noqa: E402

    versions_dir = os.path.join(
        src_root, "replay_unpack", "clients", "wows", "versions"
    )
    versions = sorted(
        (d for d in os.listdir(versions_dir) if d[0].isdigit()), key=version_key
    )

    rows = []
    for v in versions:
        try:
            defs = get_definitions(v)
        except Exception as exc:  # noqa: BLE001 - report and skip broken defs
            print(f"WARNING: {v}: {exc}", file=sys.stderr)
            continue
        entry = {"version": version_key(v)}
        for entity, methods in (("Avatar", AVATAR_METHODS),):
            try:
                exposed = defs.get_entity_def_by_name(entity).client().get_exposed_index_map()
            except KeyError:
                continue
            names = {m.get_name(): idx for idx, m in enumerate(exposed)}
            for m in methods:
                field = f"{entity.lower()}_{to_snake(m)}"
                if field in DEF_ID_SUPPRESSED:
                    continue
                if m in names:
                    entry[field] = names[m]
        rows.append(entry)

    # Empirical rows for versions newer than the reference defs: merge each
    # override over the nearest older generated row, then append ascending.
    # An override whose version the defs now ship is dropped — the generated
    # row is authoritative and must not be shadowed by a stale capture.
    for ver, overrides in EMPIRICAL_OVERRIDES.items():
        if any(row["version"] == ver for row in rows):
            continue
        base = None
        for row in rows:
            if row["version"] < ver:
                base = row
        merged = dict(base) if base else {}
        merged["version"] = ver
        merged.update(overrides)
        rows.append(merged)
    rows.sort(key=lambda r: r["version"])

    fields = [f"avatar_{to_snake(m)}" for m in AVATAR_METHODS]

    # Per-field doc comments emitted into the struct. Keep the semantics of
    # Option fields ("unpinned id → empty stream") visible at the use site.
    FIELD_DOCS = {
        "avatar_receive_damage_stat": [
            "    /// Server-authoritative cumulative damage stats (receiveDamageStat).",
            "    /// `None` for versions whose exposed id hasn't been pinned yet — the",
            "    /// decoder then leaves the stream empty and the frontend falls back to",
            "    /// its HP-delta heuristic.",
        ],
        "avatar_on_chat_message": [
            "    /// Battle chat broadcast (onChatMessage): `i32 playerId, STRING",
            "    /// namespace, STRING message, STRING unk`.",
        ],
        "avatar_on_achievement_earned": [
            "    /// In-battle achievement award (onAchievementEarned): `i32 playerId,",
            "    /// u32 achievementId` — ids join to GameParams Achievement entries.",
        ],
    }

    out = sys.stdout
    w = out.write
    w("//! AUTO-GENERATED by `scripts/gen_method_tables.py` — do not edit by hand.\n")
    w("//!\n")
    w("//! Per-game-version ids of the Avatar/Vehicle client methods the replay\n")
    w("//! decoder consumes. The wire id in EntityMethod (0x08) packets is the\n")
    w("//! method's index in the entity's client-method table sorted by wire size\n")
    w("//! (BigWorld exposed index; stable sort — equal sizes keep XML order). The\n")
    w("//! mapping drifts every game version; see the generator's docstring for the\n")
    w("//! source of truth (replay_unpack entity definitions).\n\n")
    w("/// The method ids one game version's entity definitions resolve to.\n")
    w("#[derive(Debug, Clone, Copy)]\n")
    w("pub struct MethodIds {\n")
    for f in fields:
        for line in FIELD_DOCS.get(f, []):
            w(line + "\n")
        ty = "Option<i32>" if f in OPTIONAL_FIELDS else "i32"
        w(f"    pub {f}: {ty},\n")
    w("}\n\n")
    w("/// (major, minor, patch) → ids, ascending. Produced from every version the\n")
    w("/// reference entity definitions ship.\n")
    w("pub static METHOD_TABLES: &[((u16, u16, u16), MethodIds)] = &[\n")
    for e in rows:
        ver = e["version"]
        note = EMPIRICAL_NOTES.get(ver)
        if note:
            w(note + "\n")
        # Emission shape matches `cargo fmt` canonical formatting exactly
        # (tuple + struct literal wrapped across lines) so regeneration is
        # fmt-stable.
        w(f"    (\n        ({ver[0]}, {ver[1]}, {ver[2]}),\n        MethodIds {{\n")
        for f in fields:
            if f in OPTIONAL_FIELDS:
                w(f"            {f}: {f'Some({e[f]})' if f in e else 'None'},\n")
            else:
                w(f"            {f}: {e.get(f, -1)},\n")
        w("        },\n    ),\n")
    w("];\n")
    w("""
/// Resolve the method-id table for a `clientVersionFromExe` descriptor value
/// (comma-separated `major,minor,patch[,build]`). Exact version first, else the
/// newest table not newer than the replay, else the oldest table (legacy
/// replays predate the shipped definitions) / newest table (replays from a
/// client newer than every shipped table — ids mostly append, so the newest
/// table is the best guess). `None` (no version string) assumes the newest.
pub fn method_ids_for_version(client_version: Option<&str>) -> &'static MethodIds {
    let key = client_version.and_then(parse_version_key);
    let idx = match key {
        Some(k) => {
            let mut chosen = 0usize;
            for (i, (v, _)) in METHOD_TABLES.iter().enumerate() {
                if *v <= k {
                    chosen = i;
                }
            }
            chosen
        },
        None => METHOD_TABLES.len() - 1,
    };
    &METHOD_TABLES[idx].1
}

/// `\"15,0,0,11791718\"` → `(15, 0, 0)`; malformed input yields `None`.
fn parse_version_key(v: &str) -> Option<(u16, u16, u16)> {
    let mut parts = v.split(',');
    let (Some(a), Some(b), Some(c)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    Some((
        a.trim().parse().ok()?,
        b.trim().parse().ok()?,
        c.trim().parse().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Version selection: exact, older-than-all, newer-than-all, malformed.
    #[test]
    fn selects_table_by_version() {
        // Newer than every shipped table falls back to the newest one.
        let newest = method_ids_for_version(Some("99,0,0,1"));
        let last = METHOD_TABLES[METHOD_TABLES.len() - 1].1;
        assert_eq!(
            newest.avatar_receive_explosions,
            last.avatar_receive_explosions
        );
        // Older than every shipped table falls back to the oldest one.
        let oldest = method_ids_for_version(Some("0,9,9,1"));
        let first = &METHOD_TABLES[0].1;
        assert_eq!(
            oldest.avatar_receive_artillery_shots,
            first.avatar_receive_artillery_shots
        );
        assert!(method_ids_for_version(None).avatar_receive_artillery_shots > 0);
        assert!(method_ids_for_version(Some("garbage")).avatar_receive_artillery_shots > 0);
    }

    /// Every table carries the ids the decoder needs (no -1 placeholders in the
    /// shipped versions — a -1 would silently disable that event stream).
    #[test]
    fn all_tables_fully_populated() {
        for (v, t) in METHOD_TABLES {
            for id in [
                t.avatar_receive_artillery_shots,
                t.avatar_receive_torpedoes,
                t.avatar_receive_explosions,
                t.avatar_receive_add_minimap_squadron,
                t.avatar_receive_update_minimap_squadron,
                t.avatar_receive_remove_minimap_squadron,
                t.avatar_receive_ward_added,
                t.avatar_receive_ward_removed,
                t.avatar_receive_shot_kills,
                t.avatar_receive_torpedo_direction,
                t.avatar_receive_add_squadron,
                t.avatar_receive_update_squadron,
            ] {
                assert!(id > 0, "unpopulated id in table {v:?}");
            }
        }
    }
}
""")


if __name__ == "__main__":
    main()
