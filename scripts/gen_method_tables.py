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

    # Cross-check the 15.8.0 row and the embedded full table against the
    # entity defs extracted from the local game install (E10; offline —
    # extract once with the vendored CLI, see scripts/experiments/):
    #   cargo build -p wowsunpack --release
    #   ./target/release/wowsunpack.exe -g <game_dir> extract \
    #       -o scripts/experiments/out/defs "/scripts/entity_defs/**" \
    #       "/scripts/entities*"
    python scripts/gen_method_tables.py <reference>/src \
        --defs scripts/experiments/out/defs/scripts \
        > packages/app/tauri/src/commands/method_tables.rs

The output is committed; CI never runs this script. `--defs` only validates —
the emitted file is byte-identical with or without it (the pinned ids always
win; disagreements are reported to stderr, never written).
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
]

# Fields emitted as `Option<i32>`: the reference entity defs don't expose every
# method the replay stream carries, so a missing def resolves to `None` (the
# decoder then leaves that stream empty) instead of a bogus id.
OPTIONAL_FIELDS = {"avatar_receive_damage_stat"}

# Doc comment emitted above the optional field in the generated struct.
FIELD_DOCS = {
    "avatar_receive_damage_stat": (
        "Server-authoritative cumulative damage stats (receiveDamageStat).\n"
        "`None` for versions whose exposed id hasn't been pinned yet — the\n"
        "decoder then leaves the stream empty and the frontend falls back to\n"
        "its HP-delta heuristic."
    ),
}

# Rows for versions the reference entity definitions don't ship yet, derived
# empirically from captured replays (decode a real 15.8 .wowsreplay, identify
# each method by wire shape). Each override merges over the nearest older
# generated row; the id drift it captures is documented per version below.
#
# E10 cross-check (2026-09-20): the full 15.8.0 exposed table was recomputed
# from the authoritative entity defs of game build 13187581 (the exact build
# the captured replay records with) via `scripts/experiments/exposed_index.py`
# — the algorithm replays `wowsunpack`'s `parse_scripts` (interface
# inheritance, first-occurrence dedup, stable sort by wire size with
# VariableLengthHeaderSize added after 0xffff saturation). It reproduces the
# anchors 11/13 exact, plus damageStat=163 with its verified 137-call count
# landing on the same id. The two disagreements are STALE PINS, not rule
# errors, and the pins deliberately win (decode behaviour must not change
# silently):
#   - explosions: def-derived 131 (the whole battle-effect cluster shifted +3
#     from 15.7: artillery 123→126, torps 124→127, shotKills 127→130,
#     updateSquadron 142→145 — every one of those verified on the wire and
#     matching the defs; explosions is the same +3: 128→131). The shipped 128
#     is the unshifted 15.7 carryover; ids 128–131 are all silent in the
#     verification replay (no missiles fired, no explosion stream), so the
#     pin was never falsified there.
#   - wardRemoved: def-derived 51 (and 15.7's verified row also says 51). The
#     shipped 50 is a misattribution: id 50 is `receive_removeSquadron` — in
#     the verification replay ids 49 (removeMinimapSquadron) and 50 fire as
#     perfectly paired events (same 237 PLANE_IDs at identical timestamps),
#     while wardAdded (id 112, also def-derived and matching its pin) never
#     fires and no wardAdded-shaped payload exists anywhere — no ward can be
#     removed that was never added. Both methods are single-PLANE_ID calls,
#     which is how the shapes were confused.
# Resolving either pin is a deliberate decode-behaviour change for a future
# PR; until then the table below stays authoritative for decoding.
EMPIRICAL_OVERRIDES: dict[tuple[int, int, int], dict[str, int]] = {
    # 15.8.0: three avatar methods inserted below the battle-effect cluster
    # shift it +3 (artillery 123→126, torpedoes 124→127, shotKills 127→130,
    # updateSquadron 142→145); squadron add/minimap ids keep their 15.7
    # values; receiveDamageStat — absent from every shipped def table so far
    # — sits at 163 (verified: 137 calls on the recorder's avatar in a
    # full-battle capture).
    (15, 8, 0): {
        "avatar_receive_artillery_shots": 126,
        "avatar_receive_torpedoes": 127,
        "avatar_receive_shot_kills": 130,
        "avatar_receive_update_squadron": 145,
        # E10 def-derived corrections, adopted 2026-09-21 (user-approved
        # decode behaviour change): explosions rides the same +3 battle-
        # effect cluster shift as artillery/torps/shotKills (128 is the
        # unshifted 15.7 carryover); id 50 is receive_removeSquadron (fires
        # paired with removeMinimapSquadron@49 on identical PLANE_IDs while
        # wardAdded never fires), wardRemoved sits at 51.
        "avatar_receive_explosions": 131,
        "avatar_receive_ward_removed": 51,
        "avatar_receive_damage_stat": 163,
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
    // squadron add/minimap ids keep their 15.7 values; receiveDamageStat —
    // absent from every shipped def table so far — sits at 163.
    // E10 (2026-09-20): recomputed from the authoritative entity defs of
    // game build 13187581 — 11/13 anchors reproduce exactly (incl.
    // damageStat 163, whose verified 137-call count lands on the same id).
    // Two pins are stale but deliberately kept (decode behaviour must not
    // change silently): the defs say explosions=131 (the same +3 cluster
    // shift as artillery/torps/shotKills; 128 is the unshifted 15.7
    // carryover) and wardRemoved=51 (id 50 is receive_removeSquadron — it
    // fires paired with removeMinimapSquadron@49 on identical PLANE_IDs,
    // while wardAdded@112 never fires; the def-derived full table lives in
    // the tests module with the evidence).""",
}


# The complete 15.8.0 Avatar exposed-method table (E10): id -> method name for
# every client method, recomputed from the authoritative entity defs of game
# build 13187581 (the exact build the captured 15.8.0 replay records with) via
# `scripts/experiments/exposed_index.py` — the same algorithm the vendored
# wowsunpack `parse_scripts` implements. Wire-validated on the full-battle
# capture: 100% of the 64 distinct method ids observed on avatar entities
# (66,186 calls) resolve to a name in this table. Emitted into the tests
# module of the generated file (research artifact for upcoming decoders:
# updateMinimapVisionInfo=155, clientInsideSmoke=33, squadronConsumableUsed=149,
# ownSmokeCreated=32, vehicleLeaveSmoke=10, notifyAboutSmokePenalty=11, ...).
# `--defs` re-verifies this list against a fresh extraction and hard-fails on
# any diff (the defs are the source of truth, this literal is a snapshot).
AVATAR_TABLE_15_8_0: list[tuple[int, str]] = [
    (0, "commitStats"),
        (1, "onBattleEnd"),
        (2, "onBattleInterrupted"),
        (3, "onEndTerrainCollision"),
        (4, "onWorldStateReceived"),
        (5, "createDynamicDivision"),
        (6, "leaveDynamicDivision"),
        (7, "clearSubmarineHydrophone"),
        (8, "hideIntuitionIndicator"),
        (9, "hideHydrophoneIndicator"),
        (10, "vehicleLeaveSmoke"),
        (11, "notifyAboutSmokePenalty"),
        (12, "ownSmokeStartsFade"),
        (13, "capturedAsAGoal"),
        (14, "setIntuitionAngle"),
        (15, "setSubSkillAlert"),
        (16, "updateDetectionBySurfaceHydrophone"),
        (17, "diplomacyRejection"),
        (18, "onEvaluationAccepted"),
        (19, "updateMissileThreatStatus"),
        (20, "onLeaveDivision"),
        (21, "onConsumableModeChanged"),
        (22, "targetLoss"),
        (23, "receive_victoryPoints"),
        (24, "receiveShootDC"),
        (25, "onEndShipCollision"),
        (26, "artilleryAlert"),
        (27, "changePreBattleGrants"),
        (28, "onActionFailed"),
        (29, "startAppearing"),
        (30, "startDissapearing"),
        (31, "surfaceHydrophoneRemoveTarget"),
        (32, "ownSmokeCreated"),
        (33, "clientInsideSmoke"),
        (34, "updateBuoyancyRudderCruise"),
        (35, "onOwnerChanged"),
        (36, "onInviteRevoked"),
        (37, "onInviteRejected"),
        (38, "onInviteAccepted"),
        (39, "revokeInvite"),
        (40, "ownSmokeTimeLifeChanges"),
        (41, "onOilLeakStateChanged"),
        (42, "receiveTorpedoArmed"),
        (43, "receiveTorpedoSwitch"),
        (44, "receiveTorpedoSwitchAcoustic"),
        (45, "receiveTorpedoChasingSwitch"),
        (46, "torpedoParamsUpdate"),
        (47, "onSuccessiveTeamShots"),
        (48, "killMinefield"),
        (49, "receive_removeMinimapSquadron"),
        (50, "receive_removeSquadron"),
        (51, "receive_wardRemoved"),
        (52, "receive_startManeuvering"),
        (53, "receive_stopManeuvering"),
        (54, "receive_squadronOutOfFuel"),
        (55, "receive_dropJato"),
        (56, "onCheckGamePing"),
        (57, "onCheckCellPing"),
        (58, "onAchievementEarned"),
        (59, "receive_deactivateSquadron"),
        (60, "receive_squadronOutOfBounds"),
        (61, "receive_squadronNotify"),
        (62, "receive_changeThrottleMode"),
        (63, "receive_changeTurnMode"),
        (64, "receive_changeTurnDirection"),
        (65, "squadronConsumablePaused"),
        (66, "ownSquadronConsumableInterrupted"),
        (67, "squadronConsumableInterrupted"),
        (68, "squadronConsumableStopWorking"),
        (69, "receive_squadronInsideEnemyAura"),
        (70, "receive_squadronAuraThreatCount"),
        (71, "receive_squadronUnderFighterAttack"),
        (72, "receive_squadronUnderAimedFire"),
        (73, "receive_squadronChangeTeamAtMinimap"),
        (74, "receive_squadronChangeTeamAtWorld"),
        (75, "receive_fireExtinguishingStateChanged"),
        (76, "onShutdownTime"),
        (77, "deactivateAirSupport"),
        (78, "receive_changeState"),
        (79, "receive_squadronVisibilityChanged"),
        (80, "squadronConsumableSelected"),
        (81, "squadronConsumableEnabled"),
        (82, "receiveAcousticTargetID"),
        (83, "receiveVehicleDeath"),
        (84, "receive_squadronHealth"),
        (85, "receive_missileStateChanged"),
        (86, "receiveOilLeakPosition"),
        (87, "receive_squadronDamage"),
        (88, "beginOwnerlessTracers"),
        (89, "endOwnerlessTracers"),
        (90, "updateOwnerlessAuraState"),
        (91, "onMinimapAttention"),
        (92, "receiveMissileDamage"),
        (93, "receive_updateMinimapSquadron"),
        (94, "receive_squadronPlanesHealth"),
        (95, "onTerrainCollision"),
        (96, "updateOwnerlessTracersPosition"),
        (97, "receiveTorpedoSynchronization"),
        (98, "onShipCollision"),
        (99, "onDrawMinefieldPrediction"),
        (100, "receiveMissileKill"),
        (101, "receive_addMinimapSquadron"),
        (102, "drawDebugCross"),
        (103, "receive_teleportSquadron"),
        (104, "drawSphere"),
        (105, "receiveTorpedoManeuverEnd"),
        (106, "activateAirSupport"),
        (107, "drawDebugCircle"),
        (108, "receive_waterLaunchpadGenerated"),
        (109, "drawDebugLine"),
        (110, "drawCylinder"),
        (111, "drawCapsule"),
        (112, "receive_wardAdded"),
        (113, "receiveTorpedoDirection"),
        (114, "drawBoundingBox"),
        (115, "receiveMissile"),
        (116, "receive_addSquadron"),
        (117, "receiveSignedCommand"),
        (118, "receivePublicIntStat"),
        (119, "receivePublicFloatStat"),
        (120, "debugExec"),
        (121, "drawDebugLines"),
        (122, "onConnected"),
        (123, "receiveShellInfo"),
        (124, "onGameRoomStateChanged"),
        (125, "onNewPlayerSpawnedInBattle"),
        (126, "receiveArtilleryShots"),
        (127, "receiveTorpedoes"),
        (128, "updateMissileWaypoints"),
        (129, "resetMissileWaypoints"),
        (130, "receiveShotKills"),
        (131, "receiveExplosions"),
        (132, "receivePlaneProjectilePack"),
        (133, "receivePlaneSkipBombPacks"),
        (134, "receivePlaneRocketPacks"),
        (135, "receiveDepthChargesPacks"),
        (136, "receiveLaserBeams"),
        (137, "receiveSectorWaveShots"),
        (138, "receivePingerShots"),
        (139, "receivePingerShotKills"),
        (140, "addMinefield"),
        (141, "receiveMines"),
        (142, "receiveMineKills"),
        (143, "receiveProjectileTrace"),
        (144, "receiveDamageReport"),
        (145, "receive_updateSquadron"),
        (146, "receive_resetWaypoints"),
        (147, "receive_planeDeath"),
        (148, "receive_refresh"),
        (149, "squadronConsumableUsed"),
        (150, "receive_CommonCMD"),
        (151, "onChatMessage"),
        (152, "onDisconnectedFromServer"),
        (153, "onArenaStateReceived"),
        (154, "receiveChatHistory"),
        (155, "updateMinimapVisionInfo"),
        (156, "onBattleAchievementsRestored"),
        (157, "receiveAvatarInfo"),
        (158, "onEnterPreBattle"),
        (159, "receivePlayerData"),
        (160, "updatePreBattlesInfo"),
        (161, "onBuildingSpawned"),
        (162, "onBuildingsDataChanged"),
        (163, "receiveDamageStat"),
        (164, "inviteToPreBattle"),
        (165, "onInviteSent"),
        (166, "rejectInvite"),
        (167, "updateCoolDown"),
        (168, "updateSurfaceHydrophone"),
        (169, "updateSurfaceHydrophoneBroadcast"),
        (170, "increaseConsumablesCount"),
        (171, "increaseSquadronsConsumablesCount"),
        (172, "onPlaySound"),
        (173, "receiveScreenMessage"),
        (174, "receiveLowerLogMessage"),
        (175, "updateGameParams"),
        (176, "receiveOwnerlessBubbles"),
        (177, "onFeedback"),
        (178, "dev_receiveNavigationDebugData"),
        (179, "receivePingerLaunchPosition"),
]

# The complete 15.8.0 Vehicle exposed-method table, same provenance as
# AVATAR_TABLE_15_8_0. Wire-validated on the same capture: 100% of the 30
# distinct method ids observed on Vehicle (type-2) entities (11,178 calls)
# resolve here.
VEHICLE_TABLE_15_8_0: list[tuple[int, str]] = [
    (0, "makeShipCracksActive"),
    (1, "stopVarys"),
    (2, "forceReloadTorpedoes"),
    (3, "resetResettableWaveEnemyHits"),
    (4, "onNewWaveHornWave"),
    (5, "onCrashCrewEnable"),
    (6, "onCrashCrewDisable"),
    (7, "onCollisionWarningStateChanged"),
    (8, "syncTorpedoState"),
    (9, "useAntiMissile"),
    (10, "resetPinger"),
    (11, "onConsumableInterrupted"),
    (12, "onConsumablePaused"),
    (13, "stopFullScreenEffect"),
    (14, "onWeaponStateSwitched"),
    (15, "onConsumableSelected"),
    (16, "onConsumableEnabled"),
    (17, "onAirDefenseAimedFireStateChanged"),
    (18, "changeFireImmunity"),
    (19, "forceSink"),
    (20, "bodySinkPartLurched"),
    (21, "shootATBAGuns"),
    (22, "syncSurfacingTime"),
    (23, "receiveMirrorDamage"),
    (24, "onManualAirFireSet"),
    (25, "setNewSpeed"),
    (26, "useMissile"),
    (27, "shootOnClient"),
    (28, "chargeGuns"),
    (29, "stopShootingGuns"),
    (30, "shootWaveGun"),
    (31, "onPingDeactivated"),
    (32, "resetEnemyHit"),
    (33, "receiveHitLocationStateChange"),
    (34, "setAmmoForWeapon"),
    (35, "shootDepthCharge"),
    (36, "syncRageMode"),
    (37, "receivePingerShot"),
    (38, "onRespawned"),
    (39, "prepareChargeLaser"),
    (40, "updateWaveEnemyHit"),
    (41, "syncWaveGun"),
    (42, "teleport"),
    (43, "receiveUpdateAcousticHitFromEnemy"),
    (44, "drawSplash"),
    (45, "syncTorpedoTube"),
    (46, "drawDebugCross"),
    (47, "drawSphere"),
    (48, "shootTorpedo"),
    (49, "onPingerWaveEnemyHit"),
    (50, "drawDebugCircle"),
    (51, "receiveWaveFromEnemy"),
    (52, "drawDebugLine"),
    (53, "drawCylinder"),
    (54, "drawCapsule"),
    (55, "drawBoundingBox"),
    (56, "kill"),
    (57, "receiveBubbles"),
    (58, "debugExec"),
    (59, "drawDebugLines"),
    (60, "receiveSomeSplashInfo"),
    (61, "dev_receiveHitLocationDamage"),
    (62, "setTimesToBurn"),
    (63, "onPlayEffect"),
    (64, "onPlaySound"),
    (65, "addSubmarineHydrophoneTargets"),
    (66, "syncGun"),
    (67, "syncShipCracks"),
    (68, "setUniqueSkills"),
    (69, "setConsumables"),
    (70, "setSqsConsumables"),
    (71, "uniqueTriggerActivated"),
    (72, "onConsumableUsed"),
    (73, "setAirDefenseState"),
    (74, "receiveGunSyncRotations"),
    (75, "updateInvisibleWavedPoint"),
    (76, "receiveEnemyHitWaveDump"),
    (77, "setWildFireState"),
    (78, "reloadWeapon"),
    (79, "startFullScreenEffect"),
    (80, "receiveHitLocationsInitialState"),
    (81, "receiveDamagesOnShip"),
    (82, "syncShipPhysics"),
    (83, "setReloadingStateForWeapon"),
]


def to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def version_key(dir_name: str):
    return tuple(int(x) for x in dir_name.split("_"))


def validate_against_defs(defs_dir: str, rows: list) -> None:
    """E10: recompute the 15.8.0 exposed tables from the game-install defs.

    Two checks, both informational for the emitted output (the pinned ids
    always win): (1) the embedded full-table snapshots must match the fresh
    computation exactly — a diff hard-fails, the defs are the source of truth;
    (2) the pinned 15.8.0 ids are compared against the def-derived values —
    the two known-stale pins (explosions, wardRemoved; see the comment above
    EMPIRICAL_OVERRIDES for the evidence) report as DIFF and keep the pin.
    """
    from pathlib import Path

    sys.path.insert(
        0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "experiments")
    )
    from exposed_index import exposed_index  # noqa: E402

    fresh = {
        "Avatar": exposed_index(Path(defs_dir), "Avatar"),
        "Vehicle": exposed_index(Path(defs_dir), "Vehicle"),
    }
    for name, snapshot in (
        ("Avatar", AVATAR_TABLE_15_8_0),
        ("Vehicle", VEHICLE_TABLE_15_8_0),
    ):
        got = sorted((idx, n) for n, idx in fresh[name].items())
        if got != snapshot:
            sys.exit(
                f"--defs: {name} table differs from the embedded 15.8.0 "
                "snapshot — the extraction and the snapshot disagree; "
                "recompute the snapshot before regenerating."
            )
    row = next((r for r in rows if r["version"] == (15, 8, 0)), None)
    if row is None:
        sys.exit("--defs: no 15.8.0 row to validate")
    print("--defs: full tables recompute cleanly from the defs", file=sys.stderr)
    anchors = list(AVATAR_METHODS)
    if "receiveDamageStat" not in anchors:
        anchors.append("receiveDamageStat")
    for m in anchors:
        pin = row.get(f"avatar_{to_snake(m)}")
        got = fresh["Avatar"].get(m)
        tag = "OK  " if pin == got else "DIFF"
        print(f"--defs: {tag} {m}: pin={pin} defs={got}", file=sys.stderr)


def main() -> None:
    args = sys.argv[1:]
    defs_dir = None
    if "--defs" in args:
        i = args.index("--defs")
        if i + 1 >= len(args):
            sys.exit("--defs requires a directory argument")
        defs_dir = args[i + 1]
        del args[i : i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    # Pure-LF output so `>` redirection on Windows doesn't inject CRLF that
    # `cargo fmt` would then strip (keeping regeneration fmt-stable).
    sys.stdout.reconfigure(newline="\n")
    src_root = args[0]
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
                if m == "receiveDamageStat":
                    # The reference defs DO resolve this id, but it is
                    # deliberately left `None` for historical versions: no
                    # capture has ever wire-verified those rows (the decoder
                    # ignored the stream before 15.8.0), so populating them
                    # would silently change decode behaviour on old replays.
                    # 15.8.0's id comes from EMPIRICAL_OVERRIDES instead.
                    continue
                if m in names:
                    entry[f"{entity.lower()}_{to_snake(m)}"] = names[m]
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

    if defs_dir is not None:
        validate_against_defs(defs_dir, rows)

    fields = [f"avatar_{to_snake(m)}" for m in AVATAR_METHODS]

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
        if f in FIELD_DOCS:
            for line in FIELD_DOCS[f].splitlines():
                w(f"    /// {line}\n")
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
    tail = """
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

@@EXPOSED_TABLES@@

    /// The exposed tables are canonical: ids strictly ascending from 0 with
    /// no gaps, names unique.
    #[test]
    fn exposed_tables_15_8_have_canonical_shape() {
        for table in [AVATAR_METHODS_15_8_0, VEHICLE_METHODS_15_8_0] {
            assert!(!table.is_empty());
            assert_eq!(table[0].0, 0, "ids start at 0");
            for (i, (id, _)) in table.iter().enumerate() {
                assert_eq!(*id, i as i32, "ids are dense and ascending");
            }
            let mut names: Vec<&str> = table.iter().map(|(_, n)| *n).collect();
            names.sort_unstable();
            let dense = names.windows(2).all(|w| w[0] != w[1]);
            assert!(dense, "duplicate method names");
        }
    }

    /// The full 15.8.0 Avatar table agrees with the pinned 15.8.0 row on
    /// 11/13 ids; the two disagreements are the documented stale pins (see
    /// the row's comment): the defs (and the whole +3-shifted cluster around
    /// them) say explosions=131 and wardRemoved=51, while the row keeps the
    /// empirically-shipped 128 and 50. This test pins the residual in code —
    /// whoever resolves the two stale pins must update it deliberately.
    #[test]
    fn exposed_table_15_8_matches_pinned_row() {
        let row = method_ids_for_version(Some("15,8,0,13187581"));
        // The 11 verified pins resolve to the row's exact ids.
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_artillery_shots),
            Some("receiveArtilleryShots")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_torpedoes),
            Some("receiveTorpedoes")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_torpedo_direction),
            Some("receiveTorpedoDirection")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_add_squadron),
            Some("receive_addSquadron")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_update_squadron),
            Some("receive_updateSquadron")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_add_minimap_squadron),
            Some("receive_addMinimapSquadron")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_update_minimap_squadron),
            Some("receive_updateMinimapSquadron")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_remove_minimap_squadron),
            Some("receive_removeMinimapSquadron")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_ward_added),
            Some("receive_wardAdded")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_shot_kills),
            Some("receiveShotKills")
        );
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_damage_stat.unwrap()),
            Some("receiveDamageStat")
        );
        // Stale pin #1: explosions. The row ships the 15.7 carryover 128
        // (updateMissileWaypoints in the def-derived table); the defs place
        // receiveExplosions at 131, +3 like every verified neighbour in the
        // battle-effect cluster.
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_explosions),
            Some("updateMissileWaypoints")
        );
        assert_eq!(avatar_method_name_15_8_0(131), Some("receiveExplosions"));
        // Stale pin #2: wardRemoved. The row ships 50, which the defs (and
        // the wire — it fires paired with removeMinimapSquadron on identical
        // PLANE_IDs while wardAdded never fires) identify as
        // receive_removeSquadron; receive_wardRemoved sits at 51.
        assert_eq!(
            avatar_method_name_15_8_0(row.avatar_receive_ward_removed),
            Some("receive_removeSquadron")
        );
        assert_eq!(avatar_method_name_15_8_0(51), Some("receive_wardRemoved"));
    }

    /// E10 against the real replay (skips without `WOWSP_TEST_REPLAY`): every
    /// method id observed on Avatar (type 1) and Vehicle (type 2) entities
    /// must resolve to a name in the 15.8.0 exposed tables. On the reference
    /// capture both cover 100% of distinct ids (64 avatar, 30 vehicle).
    #[test]
    fn exposed_tables_cover_real_replay() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return;
        };
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let mut cur = 8;
        let mut client_version: Option<String> = None;
        for i in 0..block_count {
            let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
            cur += 4;
            if i == 0 {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes[cur..cur + bl])
                {
                    client_version = json
                        .get("clientVersionFromExe")
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                }
            }
            cur += bl;
        }
        let decoded = crate::commands::packets::decode_replay(
            &bytes[cur..],
            &std::collections::HashSet::new(),
            client_version.as_deref(),
        )
        .expect("decode must succeed");
        // (entity_type -> method id -> calls) on the wire.
        let mut per_id: std::collections::BTreeMap<(i16, i32), u32> =
            std::collections::BTreeMap::new();
        for (_, eid, mid, _) in &decoded.method_histogram {
            let Some(et) = decoded.kinds.get(eid).map(|k| k.entity_type) else {
                continue;
            };
            *per_id.entry((et, *mid)).or_default() += 1;
        }
        let mut stats: std::collections::BTreeMap<i16, (usize, usize, usize, usize)> =
            std::collections::BTreeMap::new();
        for ((et, mid), n) in &per_id {
            let hit = match et {
                1 => avatar_method_name_15_8_0(*mid).is_some(),
                2 => vehicle_method_name_15_8_0(*mid).is_some(),
                _ => continue,
            };
            let e = stats.entry(*et).or_default();
            e.0 += 1;
            e.2 += *n as usize;
            if hit {
                e.1 += 1;
                e.3 += *n as usize;
            }
        }
        let is_15_8 = client_version.as_deref().and_then(parse_version_key) == Some((15, 8, 0));
        for (et, (distinct, resolved, calls, cov)) in stats {
            eprintln!(
                "[e10] type {et}: {resolved}/{distinct} distinct ids ({:.0}%), \
{cov}/{calls} calls ({:.0}%)",
                100.0 * resolved as f64 / distinct as f64,
                100.0 * cov as f64 / calls as f64,
            );
            if is_15_8 {
                assert!(
                    resolved * 20 >= distinct * 19,
                    "type {et}: only {resolved}/{distinct} ids resolve in the 15.8.0 tables"
                );
            }
        }
        let unresolved: Vec<String> = per_id
            .keys()
            .filter(|(et, mid)| match et {
                1 => avatar_method_name_15_8_0(*mid).is_none(),
                2 => vehicle_method_name_15_8_0(*mid).is_none(),
                _ => false,
            })
            .map(|(et, mid)| format!("type {et} id {mid}"))
            .collect();
        if !unresolved.is_empty() {
            eprintln!("[e10] unresolved: {}", unresolved.join(", "));
        }
    }
}
"""

    def rust_exposed_static(name: str, table: list, doc: str) -> str:
        entries = "".join(f'        ({idx}, "{n}"),\n' for idx, n in table)
        lines = "".join(f"    /// {line}\n" for line in doc.splitlines())
        return f"{lines}    static {name}: &[(i32, &str)] = &[\n{entries}    ];\n"

    exposed_tables = (
        rust_exposed_static(
            "AVATAR_METHODS_15_8_0",
            AVATAR_TABLE_15_8_0,
            "The complete 15.8.0 Avatar exposed-method table (E10): id -> name\n"
            "for all 180 client methods, recomputed from the entity defs of\n"
            "game build 13187581 (the exact build 15.8.0 replays record with)\n"
            "and wire-validated on a full-battle capture (100% of the 64\n"
            "distinct ids / 66,186 calls observed on avatar entities resolve).\n"
            "Research artifact for upcoming decoders — the packet decoder\n"
            "keeps reading the pinned row above.",
        )
        + "\n"
        + rust_exposed_static(
            "VEHICLE_METHODS_15_8_0",
            VEHICLE_TABLE_15_8_0,
            "The complete 15.8.0 Vehicle exposed-method table, same provenance\n"
            "as AVATAR_METHODS_15_8_0 (84 methods; 100% of the 30 distinct ids\n"
            "/ 11,178 calls observed on Vehicle entities resolve).",
        )
        + "\n"
        + "    /// Binary-search a 15.8.0 exposed table by method id.\n"
        + "    fn exposed_lookup(table: &'static [(i32, &'static str)], id: i32) -> Option<&'static str> {\n"
        + "        table\n"
        + "            .binary_search_by(|(i, _)| i.cmp(&id))\n"
        + "            .ok()\n"
        + "            .map(|idx| table[idx].1)\n"
        + "    }\n"
        + "\n"
        + "    /// Look a 15.8.0 Avatar wire method id up in the exposed table.\n"
        + "    fn avatar_method_name_15_8_0(id: i32) -> Option<&'static str> {\n"
        + "        exposed_lookup(AVATAR_METHODS_15_8_0, id)\n"
        + "    }\n"
        + "\n"
        + "    /// Look a 15.8.0 Vehicle wire method id up in the exposed table.\n"
        + "    fn vehicle_method_name_15_8_0(id: i32) -> Option<&'static str> {\n"
        + "        exposed_lookup(VEHICLE_METHODS_15_8_0, id)\n"
        + "    }"
    )
    tail = tail.replace("@@EXPOSED_TABLES@@", exposed_tables)
    w(tail)


if __name__ == "__main__":
    main()
