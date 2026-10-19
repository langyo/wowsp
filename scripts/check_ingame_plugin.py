#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline sandbox-conformance harness for the in-game probe's Main.py.

THE problem this exists for: the Lesta (Мир кораблей) ModsAPI sandbox
resolves builtins through a whitelist that omits the class and reflection
machinery wholesale. `except Exception:` and `class Probe(object)` each
killed the mod AT IMPORT on a live 2026-10-08 session, and every fix
round-trip cost the user a game restart. This harness makes that class of
bug detectable OFFLINE: it executes the shipped plugin under a
DELIBERATELY CRIPPLED builtins set — the only survivors are the names the
plugin's proven-on-Lesta paths may rely on (`open`, `len`, `__import__`;
plus `__build_class__`, a py3-only artifact of class statements that
py2.7 compiles with no builtin at all — and note the game's py2.7 ALSO
resolves `True`/`False` as builtin globals, which this py3 harness cannot
withhold; the client-side census reports them) — with the injected mods
stubbed.
ModsShell/dh/BigWorld module imports are deliberately LEFT MISSING: the
engine-diagnostic blocks that use them may legally degrade, and builtins
used ONLY there are outside this harness's contract. It drives a full
battle (records in, bridge files out) and asserts the artifacts the
companion app consumes:

  - roster_raw.json: every roster record present, in BOTH probe encodings
    (the double-encoded string shape and the guessed-projection shape —
    the app's Lesta roster synthesizer parses both),
  - telemetry.json: per-name alive flags + the self identity + the
    client sort-key map (EMPTY in the ship-less passes — the withheld
    shape — and the full planted client table in the ship passes, see
    SHIP_KEYS), plus the roster's OWN record sequence (rosterOrder — the
    Lesta equal-key tie base) and the records' localized ship names
    (shipNames — the CN name-order segment; EMPTY when the records carry
    no such field), and roster_raw.json mirrors the sequence as `order`
    for the Rust synthesizer's order preservation,
  - heartbeat.json written with the roster count,
  - the scheduler survives tick-over-tick (no swallowed exception text).

The GAME-TRUE sort-key path (sort_key_probe: the 'ship' collection walk
plus the avatar ship-slot pairing) is what the ship passes exist for —
until 2026-10-10 every pass planted no ship entities and could only
assert the empty-map degradation, while the Lesta sandbox's behavior
toward the 'ship' collection stays unverified in a real battle (the
design doc's open item). The passes now pin, OFFLINE:
  - the WG shape (ship components carrying sortKey, avatar `.ship` slot
    references whose `.ref.id` matches a ship entry id): the exact key
    table lands in telemetry AND the row fold sorts its alive block by
    the keys alone, stable — equal keys keep the roster's own order
    (live 2026-10-10: the client rendered two same-key rows in record
    order against the key + name concatenation's ':'-first tie);
    avatar-entity names carry clan tags (the real client's shape), so
    the bare-name keying of the map is asserted too;
  - the LESTA shape (UiComponents raising): the key table still lands —
    the path duck-types the components and must never need constants;
  - a partial-coverage shape (one avatar's reference resolves to no ship
    entry): the key map stays partial AND that side's row fold keeps
    the walk order (game-true and walk-order rows never interleave),
    while the fully covered side still sorts;
  - the 15.9 encoder quirk: the key table survives the hand-rolled
    serializer when the client's own encoder rejects the payload.

Anything the plugin does beyond that set must sit behind a bare `except:`
so it degrades instead of dying — the harness proves the core paths never
need it.

Run:  python scripts/check_ingame_plugin.py [path/to/Main.py]
Exit: 0 = pass; 1 = a fatal gap (printed with the exact missing name).

Keep this dependency-free (stdlib only) so CI and humans can run it
anywhere; it is the "constraints list" harness the plugin design doc
(docs/en/designs/ingame-stats-plugin.md) promises.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback

DEFAULT_PLUGIN = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    os.pardir, "packages", "ingame-plugin", "src", "Main.py",
)

# Builtins the crippled run keeps: `open` (file bridge — proven on Lesta),
# `len` (protocol primitive, no pure-syntax substitute), `__import__`
# (the module does `import time`; proven on Lesta), and `__build_class__`
# — a PY3-ONLY harness artifact: CPython 3 compiles every `class` statement
# to LOAD_BUILD_CLASS, while the game's py2.7 compiles it to the BUILD_CLASS
# opcode that consults no builtin at all (live evidence: the class statement
# itself executed on Lesta — it died inside its `object` base lookup).
SAFE_BUILTINS = ("open", "len", "__import__", "__build_class__")

ROSTER_SIZE = 12
ENEMY_COUNT = 6
BOT_NAME = ":TesterBot:"


class FakeRecord(object):
    """One battle.getPlayersInfo() record: subscripts work, dict protocol
    does NOT (the live SafeClass contract)."""

    def __init__(self, **fields):
        self._f = fields

    def __getitem__(self, key):
        return self._f[key]


class StubUtils(object):
    def __init__(self, encode_records, fail_plain=False):
        self.lines = []
        # True = the sandbox encoder accepts SafeClass records (produces
        # the DOUBLE-ENCODED string shape on disk); False = it rejects
        # them (the guessed-projection shape).
        self.encode_records = encode_records
        # True = the 15.9-style quirk: the encoder RAISES on plain dict
        # payloads it accepted in earlier builds (live WG 2026-10-09 —
        # telemetry.json froze at its quit-clear while the other bridge
        # files shaped differently). The load-bearing writers must fall
        # back to the hand-rolled serializer and keep every file flowing.
        self.fail_plain = fail_plain
        self.log_info_calls = 0

    def logInfo(self, message):
        self.log_info_calls += 1
        self.lines.append(str(message))

    def jsonEncode(self, value):
        if self.fail_plain and isinstance(value, dict):
            raise TypeError("15.9-style plain-dict rejection")
        if isinstance(value, FakeRecord):
            if not self.encode_records:
                raise TypeError("encoder rejects SafeClass")
            return json.dumps(value._f, ensure_ascii=False)
        return json.dumps(value, default=self._encode_default,
                          ensure_ascii=False)

    @staticmethod
    def _encode_default(obj):
        if isinstance(obj, FakeRecord):
            return obj._f
        raise TypeError("not encodable: %r" % (obj,))

    def jsonDecode(self, text):
        return json.loads(text)


class StubBattle(object):
    def __init__(self):
        self.players = {}
        # The game API's own self view (name carries the clan tag, like
        # the live client's) — the entity-walk-independent self source.
        self._self = FakeRecord(name="[RUQL]langyo")
        # The raw dh collection door the decompiled battleGate carries
        # internally. The live 15.9 SafeClass does NOT forward it (the
        # order_probe records 'missing'); the harness still plants it so
        # the probe's raw-collection branch stays covered for clients
        # (and future builds) where the wrapper does expose it.
        self.avatar_collection = None
        # Degraded-roster modes (the 2026-10-18/19 Steam-13357625 +
        # CN360-13357822 field class): None = the healthy shape;
        # "empty" = getPlayersInfo answers {} all battle (records dead);
        # "churn" = one player's accountDBID flips every call, so the
        # roster list differs each tick and NEVER stabilizes.
        self.degraded = None
        self._churn_flip = 0

    def getPlayersInfo(self):
        if self.degraded == "empty":
            return {}
        if self.degraded == "churn":
            players = dict(self.players)
            base = players[101]._f
            self._churn_flip += 1
            fields = dict(base)
            fields["accountDBID"] = base["accountDBID"] + (self._churn_flip % 2)
            players[101] = FakeRecord(**fields)
            return players
        return dict(self.players)

    def getSelfPlayerInfo(self):
        return self._self

    def getCollection(self, component_id):
        if component_id == "cc.avatar":
            return self.avatar_collection
        return []


class StubBattleNoRaw(StubBattle):
    """The live 15.9 `battle` SafeClass shape: the internal getCollection
    helper is NOT forwarded. The probe must record 'missing', skip the
    paths and still write order_probe.json."""

    @property
    def getCollection(self):
        raise AttributeError("getCollection")


class StubEvents(object):
    def __init__(self):
        self.handlers = {}
        for name in ("onPlayersListUpdated", "onSFMEvent", "onBattleQuit",
                     "onBattleStart", "onKeyEvent"):
            setattr(self, name, self._recorder(name))

    def _recorder(self, name):
        def record(*args):
            # Keep the registered CALLBACK (first positional argument).
            self.handlers[name] = args[0] if args else None
        return record


class StubCallbacks(object):
    def __init__(self):
        self.pending = None

    def callback(self, interval, fn):
        self.pending = fn
        return 1

    def cancel(self, handle):
        pass


class StubUi(object):
    """The optional `ui` module. Lesta's ModsAPI does NOT inject it (live
    census 2026-10-08) — the default passes leave it out entirely, which is
    exactly the environment that used to crash the mod at load."""

    def __init__(self):
        self.calls = 0

    def createUiElement(self):
        self.calls += 1
        return object()

    def addDataComponentWithId(self, entity, key, data):
        self.calls += 1

    def updateUiElementData(self, entity, data):
        self.calls += 1

    def deleteUiElement(self, entity):
        self.calls += 1


class StubDataHub(object):
    """The injected dataHub: collections served BY NAME, like the real
    ModAPI hub ('avatar' and 'ship' are both on its SYNCED whitelist;
    anything else comes back empty — unknown kinds were previously fed
    the avatars, which the real hub never does)."""

    def __init__(self, avatars=None, ships=None):
        self.collections = {"avatar": avatars or [], "ship": ships or []}

    def getEntityCollections(self, kind):
        return self.collections.get(kind, [])


class FakeComponent(object):
    def __init__(self, **fields):
        self.__dict__.update(fields)


class FakeAvatarEntity(object):
    """One dataHub avatar entity: component subscripts + `in` membership
    (the entity walk's contract) AND the raw `.components` mapping (the
    sort-key probe's contract — it duck-types components without
    UiComponents). `ship_slot` models the avatar component's `.ship`
    reference; None = an avatar that pairs with no ship entry."""

    def __init__(self, component_class, name, relation, alive=True,
                 hp=24400.0, hp_max=24400.0, ship_slot=None, entity_id=0,
                 target_flags=None):
        # `.id` models the avatar ENTITY id — the id space the client's
        # sortedAlive collection items carry and the sticky walk map
        # latches (deliberately DIFFERENT from the roster record's
        # avatar_id mapping key: the two must never be confused).
        self.id = entity_id
        avatar = FakeComponent(name=name, ship=ship_slot)
        health = FakeComponent(value=hp, max=hp_max, isAlive=alive)
        relation_comp = FakeComponent(value=relation)
        self._map = {
            component_class.avatar: avatar,
            component_class.health: health,
            component_class.relation: relation_comp,
        }
        self.components = {"avatar": avatar, "health": health,
                           "relation": relation_comp}
        if target_flags is not None:
            # The aim walk's component: `.flags` only, no `.reasons` — the
            # duck-typed fallback distinguishes it from CanHit (which
            # carries both) exactly this way.
            target_comp = FakeComponent(flags=target_flags)
            self._map[getattr(component_class, "target", "cc.target")] = target_comp
            self.components["target"] = target_comp

    def __getitem__(self, key):
        return self._map[key]

    def __contains__(self, key):
        return key in self._map


class FakeEntityRef(object):
    """An entity reference: `.id` names the entity (a ship collection
    entry's own `id`, reached through the slot chain below)."""

    def __init__(self, entity_id):
        self.id = entity_id


class FakeShipSlot(object):
    """The avatar component's `.ship` slot: a wrapper whose `.ref.id`
    names the ship collection entry — the exact pairing chain
    sort_key_probe reads (`comp.ship.ref.id`)."""

    def __init__(self, entity_id):
        self.ref = FakeEntityRef(entity_id)


class FakeShipEntity(object):
    """One dataHub SHIP entity: `id` plus a components mapping whose
    Ship component carries the client's own Tab sortKey (ShipSystem.add's
    class+tier+nation+shortName string). `sort_key=None` models an entity
    whose components carry no key at all — the probe must skip it
    silently (a per-entity degrade, never a death)."""

    def __init__(self, entity_id, sort_key):
        self.id = entity_id
        if sort_key is None:
            self.components = {"position": FakeComponent(value=(1.0, 2.0, 3.0))}
        else:
            self.components = {"ship": FakeComponent(sortKey=sort_key)}


class FakeRawAvatarCollection(object):
    """The RAW dh avatar collection battle.getCollection(CC.avatar)
    returns on builds where the SafeClass forwards it: iterable, with the
    client's splitting/sorting children reachable by path. The planted
    'team.ally.sortedAlive' child is the exact rendered order the probe
    must capture verbatim (never the walk order)."""

    def __init__(self, entities, paths):
        self._entities = entities
        self._paths = paths

    def __iter__(self):
        return iter(self._entities)

    def getChildByPath(self, path):
        if path not in self._paths:
            raise KeyError(path)
        return self._paths[path]


class RaisingConstants(object):
    """The LESTA-shape constants module: the UiComponents attribute
    access itself raises (live 2026-10-08, 'CC dir failed=?') — the
    default StubConstants models the WG-family shape where it resolves."""

    class PlayerRelation(object):
        SELF = 0
        ALLY = 1
        ENEMY = 2

    @property
    def UiComponents(self):
        raise AttributeError("UiComponents unavailable on this client")


class StubConstants(object):
    class PlayerRelation(object):
        SELF = 0
        ALLY = 1
        ENEMY = 2

    class UiComponents(object):
        avatar = "cc.avatar"
        health = "cc.health"
        relation = "cc.relation"
        target = "cc.target"


class StubConstantsNoTargetCC(object):
    """The WG-family shape with the `target` attribute withheld: UiComponents
    resolves but carries no target class, so the aim walk must fall back to
    duck-typing the raw components mapping (a client-side withholding, not
    the Lesta whole-attribute raise)."""

    PlayerRelation = StubConstants.PlayerRelation

    class UiComponents(object):
        avatar = "cc.avatar"
        health = "cc.health"
        relation = "cc.relation"


# The records' localized ship names (the CN HUD's name-order segment —
# the field the client's roster data carries when it carries it at all).
# Planted as zh strings so every pass proves the utf-8 round trip through
# BOTH encoders; the ship-name-less pass plants no field at all and pins
# the degrade shape (an EMPTY map, never an absent keying crash).
SHIP_LOCALIZED = {
    "langyo": "河内",        # Kawachi
    "Ally01": "博加特里",    # Bogatyr
    "Ally02": "长安",        # Chengan
    "Ally03": "河内",        # Kawachi (the tie pair sails the same ship)
    "Ally04": "柏勒罗丰",    # Bellerophon
    "Ally05": "勃艮第",      # Bourgogne
    "Foe00": "白龙",         # Hakuryu
    "Foe01": "中途岛",       # Midway
    "Foe02": "诺维克",       # Novik
    "Foe03": "岛风",         # Shimakaze
    "Foe04": "普鲁士",       # Preussen
    "Foe05": "斐济",         # Fiji
    BOT_NAME: "勇敢",        # Derzki (the bot)
}

# The records mapping's own iteration sequence — insertion order under the
# harness's py3.7+ dicts, standing in for the py2 dict order the real
# client's records iterate in (deterministic per key set). This is the
# rosterOrder telemetry the companion consumes as the Lesta equal-key tie
# base, and the `order` array roster_raw.json carries for the Rust
# synthesizer's order preservation.
def build_roster_order():
    order = []
    for i in range(ROSTER_SIZE - ENEMY_COUNT):
        order.append("langyo" if i == 0 else "Ally%02d" % i)
    for i in range(ENEMY_COUNT):
        order.append("Foe%02d" % i)
    order.append(BOT_NAME)
    return order


def build_roster(self_name="langyo", with_ship_names=True, drift_records=False):
    players = {}
    for i in range(ROSTER_SIZE - ENEMY_COUNT):
        name = self_name if i == 0 else "Ally%02d" % i
        fields = {"name": name, "accountDBID": 310000000 + i,
                  "realm": "ru", "shipParamsId": 418000000 + i,
                  "isBot": False, "teamId": 1, "isAlive": True}
        if with_ship_names:
            fields["shipName"] = SHIP_LOCALIZED[name]
        if drift_records and name == "Ally02":
            # The drifted shape (the 2026-10-11 CN360 failure class): the
            # record carries no `isBot` at all. The probe must treat it as
            # human — the ':' name marker still filters scripted rows.
            del fields["isBot"]
        if drift_records and name == "Ally04":
            # A record without a `name` has no row to key — the probe must
            # skip THIS record, never the whole roster (the old single-try
            # loop returned [] and the battle never stabilized).
            del fields["name"]
        players[100 + i] = FakeRecord(**fields)
    for i in range(ENEMY_COUNT):
        name = "Foe%02d" % i
        players[200 + i] = FakeRecord(name=name, accountDBID=320000000 + i,
                                      realm="ru", shipParamsId=428000000 + i,
                                      isBot=False, teamId=2, isAlive=True,
                                      **({"shipName": SHIP_LOCALIZED[name]}
                                         if with_ship_names else {}))
    players[300] = FakeRecord(name=BOT_NAME, accountDBID=0, realm="",
                              shipParamsId=438000000, isBot=True, teamId=2,
                              isAlive=True,
                              **({"shipName": SHIP_LOCALIZED[BOT_NAME]}
                                 if with_ship_names else {}))
    return players


# The planted client sort keys — ShipSystem.add's own concatenation
# (class rank + str(100 - tier) + nation rank + shortName; nation ranks
# follow the client's NATION.SORT_ORDER: japan 0, usa 1, russia 2,
# germany 3, uk 4, france 5, pan_asia 7). Deliberately chosen so the
# game-true sort (the keys alone, a STABLE sort per the live 2026-10-10
# Lesta capture) is OBSERVABLE: it differs from the entity-walk order on
# both sides, so the assertions below prove the row fold really sorted
# rather than kept insertion order. The co-op bot carries one too — on
# the real client bots are ordinary ship entities.
SHIP_KEYS = {
    "langyo": "1970Kawachi",        # battleship T3 japan — SAME ship/key as
                                    # Ally03: the equal-key TIE pair (live
                                    # 2026-10-10: the client keeps the
                                    # roster's own order on equal keys, NOT
                                    # the key + name concatenation)
    "Ally01": "2972Bogatyr",        # cruiser T3 russia
    "Ally02": "3967Chengan",        # destroyer T4 pan_asia
    "Ally03": "1970Kawachi",        # battleship T3 japan (the tie pair)
    "Ally04": "1974Bellerophon",    # battleship T3 uk
    "Ally05": "1905Bourgogne",      # battleship T10 france
    "Foe00": "0900Hakuryu",         # carrier T10 japan
    "Foe01": "0901Midway",          # carrier T10 usa
    "Foe02": "2962Novik",           # cruiser T4 russia
    "Foe03": "3900Shimakaze",       # destroyer T10 japan
    "Foe04": "1903Preussen",        # battleship T10 germany
    "Foe05": "2964Fiji",            # cruiser T4 uk
    BOT_NAME: "3982Derzki",         # destroyer T2 russia (the bot)
}
# What merge_order's alive-block sort must produce on each side: a
# STABLE sort by the key alone over the walk order — distinct keys land
# by key ascending, and the equal-key pair keeps the walk order (langyo
# walks first). The retired key + name rule would flip the pair
# ("1970KawachiAlly03" < "1970Kawachilangyo"), so this literal pins the
# live-observed tie behavior.
SHIP_KEY_ORDERS = {
    "ally": ["Ally05", "langyo", "Ally03", "Ally04", "Ally01", "Ally02"],
    "enemy": ["Foe00", "Foe01", "Foe04", "Foe02", "Foe05", "Foe03", BOT_NAME],
}
# Ship entity ids derive from the roster record keys below; the two named
# outliers model the shapes the probe must tolerate. No roster record
# uses either id.
SHIP_ENTITY_BASE = 500
UNPAIRED_SHIP_ID = 5555  # partial pass: langyo's slot resolves to nothing
NOISE_SHIP_ID = 4999     # full pass: a ship entity with no sortKey comp


def crippled_builtins():
    import builtins as host
    table = {}
    for name in SAFE_BUILTINS:
        table[name] = getattr(host, name)
    return table


def run_once(plugin_src, workdir, encode_records, with_manifest, with_ui,
             raising_constants, fail_plain, ships, with_ship_names,
             drift_records, failures, raw_collection=True, aim_duck=False,
             degraded=None):
    label = ("encode=%s manifest=%s ui=%s cc=%s plain=%s ships=%s shipNames=%s drift=%s raw=%s aimduck=%s degraded=%s"
             % ("records" if encode_records else "projection",
                "yes" if with_manifest else "missing",
                "yes" if with_ui else "absent",
                "raising" if raising_constants else "ok",
                "reject" if fail_plain else "ok",
                ships,
                "yes" if with_ship_names else "withheld",
                "yes" if drift_records else "no",
                "yes" if raw_collection else "missing",
                "yes" if aim_duck else "no",
                degraded or "no"))
    utils = StubUtils(encode_records, fail_plain)
    battle = StubBattle() if raw_collection else StubBattleNoRaw()
    events = StubEvents()
    callbacks = StubCallbacks()
    cc = StubConstants.UiComponents
    # The entity collections, built per the pass's ship mode:
    #   "none"    — no ship entities at all (the withheld shape; every
    #               avatar pairs with nothing);
    #   "full"    — every avatar (bot included) pairs with a ship entity
    #               carrying its planted sortKey, plus one keyless noise
    #               entity nobody references;
    #   "partial" — langyo's slot resolves to a nonexistent ship id, so
    #               the key map comes back one short of the roster.
    roster = build_roster(with_ship_names=with_ship_names,
                          drift_records=drift_records)
    dh_avatars = []
    dh_ships = []
    avatar_by_name = {}
    # Iteration follows build_roster's insertion order (the py3.7+ dict
    # guarantee) — the walk-order expectations below are coupled to it.
    for slot, rec in roster.items():
        try:
            name = rec["name"]
        except KeyError:
            # The drift pass's nameless record has no avatar to key —
            # exactly the shape the entity walk meets on the real client.
            continue
        # Avatar-entity names carry a clan tag on the real client while
        # roster/telemetry keys stay BARE (bare_name strips it) — plant
        # the tagged shape so every keying assertion covers the strip
        # (bots' names carry no tag).
        entity_name = name if name.startswith(":") else "[RUQL]" + name
        relation = (StubConstants.PlayerRelation.SELF if name == "langyo"
                    else (StubConstants.PlayerRelation.ALLY
                          if rec["teamId"] == 1
                          else StubConstants.PlayerRelation.ENEMY))
        ship_id = SHIP_ENTITY_BASE + slot if ships != "none" else None
        if ships == "partial" and name == "langyo":
            ship_id = UNPAIRED_SHIP_ID
        # Avatar entity ids live in their OWN space (7000+) — deliberately
        # disjoint from the roster record keys (100/200/300) and their
        # avatar_id fields, pinning the "walk id is authoritative" rule.
        entity_id = 7000 + slot
        # The aim pass's planted target flags: Foe03 holds the MAIN-battery
        # bits (1<<1|1<<2 = AP|HE) while Foe01 carries a NON-main lockable
        # bit (1<<6) — the walk's main-battery preference must pick Foe03
        # even though Foe01 walks first. Both match the frozen client mask
        # (target.flags & LOCKABLE_WEAPONS, build 13357625 views).
        target_flags = None
        if name == "Foe03":
            target_flags = (1 << 1) | (1 << 2)
        elif name == "Foe01":
            target_flags = 1 << 6
        dh_avatars.append(
            FakeAvatarEntity(cc, name=entity_name, relation=relation,
                             alive=True, entity_id=entity_id,
                             target_flags=target_flags,
                             ship_slot=(FakeShipSlot(ship_id)
                                        if ship_id is not None else None)))
        avatar_by_name[name] = dh_avatars[-1]
        if ship_id is not None and ship_id != UNPAIRED_SHIP_ID:
            dh_ships.append(FakeShipEntity(ship_id, SHIP_KEYS[name]))
    if ships == "full":
        dh_ships.append(FakeShipEntity(NOISE_SHIP_ID, None))
    # The client's own splitting/sorting child: the SHIP_KEY_ORDERS ally
    # sequence, deliberately different from the walk order, so the probe's
    # order_probe.json must reproduce IT (not the fold) name for name.
    planted_order = [n for n in SHIP_KEY_ORDERS["ally"] if n in avatar_by_name]
    planted_entities = [avatar_by_name[n] for n in planted_order]
    battle.avatar_collection = FakeRawAvatarCollection(
        dh_avatars,
        {"team.ally.sortedAlive": planted_entities})
    env = {
        "__builtins__": crippled_builtins(),
        "__name__": "__sandbox__",
        "utils": utils,
        "battle": battle,
        "events": events,
        "callbacks": callbacks,
        "dataHub": StubDataHub(dh_avatars, dh_ships),
        "constants": (RaisingConstants() if raising_constants
                      else (StubConstantsNoTargetCC() if aim_duck
                            else StubConstants())),
    }
    # `ui` only in the explicit ui-present pass: Lesta's ModsAPI injects no
    # `ui` module (census 2026-10-08), and the harness must be at least as
    # strict as the client it protects — the old runs injected a StubUi
    # everywhere and therefore missed the eager `ui` reference that killed
    # the mod at load on the real client.
    ui = None
    if with_ui:
        ui = StubUi()
        env["ui"] = ui
    # Mirror the on-disk layout (bin/<build>/res_mods/PnFMods/<Mod>/) so
    # the plugin's relative `../../wowsp.toml` open resolves exactly like
    # on a real install; the manifest itself is optional per pass (see the
    # TOOL_CONFIG expectation below).
    mod_dir = os.path.join(workdir, "bin", "8867689", "res_mods",
                           "PnFMods", "WoWSPProbe")
    os.makedirs(mod_dir)
    if with_manifest:
        # The degraded passes pin the FIELD default fade (3): the walk-
        # sourced session must survive records-empty ticks at exactly the
        # shipped value (a teardown there is the round-1 review's bug).
        # The healthy passes keep 7 to prove the config is READ (see the
        # TOOL_CONFIG expectation below).
        fade = 3 if degraded else 7
        with open(os.path.join(workdir, "bin", "8867689", "res_mods", "wowsp.toml"), "w") as fh:
            fh.write('[tools."battle.ingame.stats"]\npanel_fade_ticks = %d\njournal_limit = 123\nbarcode = 0\n' % fade)
    cwd = os.getcwd()
    os.chdir(mod_dir)
    try:
        try:
            code = compile(plugin_src, "Main.py", "exec")
            exec(code, env)
        except NameError as e:
            failures.append("[%s] IMPORT DIED on a missing builtin: %s" % (label, e))
            return
        except Exception as e:
            failures.append("[%s] IMPORT DIED: %s" % (label, traceback.format_exc(limit=3)))
            return
        # With the manifest planted, the import-time load_tool_config must
        # have READ it: the call runs below the helper block it depends on
        # (a round-2 ordering bug hid here as "just the defaults"), and a
        # bare except could hide a NameError the same way. With the
        # manifest ABSENT the open() failure must land on the DEFAULT
        # fallback — evaluating the handler TYPE there is the whole point:
        # a reintroduced `except Exception:` raises NameError on Lesta's
        # whitelist and this pass catches it (the round-1 crash class).
        expected_cfg = ({"panel_fade_ticks": 3 if degraded else 7,
                         "journal_limit": 123, "barcode": 0}
                        if with_manifest else
                        {"panel_fade_ticks": 3, "journal_limit": 300,
                         "barcode": 0})
        if env.get("TOOL_CONFIG") != expected_cfg:
            failures.append("[%s] TOOL_CONFIG=%r, expected %r"
                            % (label, env.get("TOOL_CONFIG"), expected_cfg))
            return

        # Battle start: records become available, then drive the tick loop
        # (each tick re-schedules itself; call the latest pending callback).
        battle.players = build_roster(with_ship_names=with_ship_names,
                                      drift_records=drift_records)
        if degraded:
            battle.degraded = degraded
        start = events.handlers.get("onBattleStart")
        if start is None:
            failures.append("[%s] onBattleStart was never registered" % label)
            return
        start()
        # Drive the FIRST tick alone and pin the heartbeat's phase: one
        # tick cannot have stabilized a roster yet (stability needs three
        # sightings), so only the game's own battleStart latch can make
        # the phase read 'battle' here. That latch is the CN360 drift
        # class's lifeline — a build whose getPlayersInfo never stabilizes
        # still reports battle, and the companion's telemetry-absent WARN
        # can fire off it.
        first_tick = callbacks.pending
        callbacks.pending = None
        if first_tick is None:
            failures.append("[%s] scheduler stopped re-arming" % label)
            return
        first_tick()
        try:
            with open("heartbeat.json") as fh:
                hb_first = json.load(fh)
            if hb_first.get("phase") != "battle":
                failures.append(
                    "[%s] heartbeat phase=%r one tick after battleStart "
                    "(expected battle via the battleStart latch)"
                    % (label, hb_first.get("phase")))
        except Exception as e:
            failures.append("[%s] heartbeat.json unreadable after the first "
                            "tick: %r" % (label, e))
        # The degraded passes need the probe's ROSTER_GRACE_TICKS to lapse
        # (5 ticks) plus enough post-synthesis ticks to prove DURABILITY:
        # the field-default panel_fade_ticks (3, planted in the manifest
        # above) would tear a fragile session down at tick 8 — twelve ticks
        # leaves that failure mode firmly inside the assertion window. The
        # healthy passes stabilize within three.
        for _ in range(12 if degraded else 4):
            fn = callbacks.pending
            callbacks.pending = None
            if fn is None:
                failures.append("[%s] scheduler stopped re-arming" % label)
                return
            fn()

        # ── artifact assertions ──────────────────────────────────────────
        # The expected rows mirror the probe's drift contract: a record
        # without `isBot` still rows (the ':' marker filters scripted
        # names), a record without `name` has no row at all. Derived from
        # the AVATAR-BUILDING roster (identical content to battle.players
        # on the healthy passes) so the degraded-empty pass — whose
        # battle.players answers {} — still expects the entity walk's
        # names.
        expected_names = set()
        for rec in roster.values():
            try:
                if rec["isBot"]:
                    continue
            except KeyError:
                pass
            try:
                name = rec["name"]
            except KeyError:
                continue
            if not name or name.startswith(":"):
                continue
            expected_names.add(name)

        try:
            with open("roster_raw.json") as fh:
                raw = json.load(fh)
            players = raw.get("players", {})
        except Exception as e:
            failures.append("[%s] roster_raw.json unreadable: %r" % (label, e))
            return
        seen = set()
        for key, value in players.items():
            record = json.loads(value) if isinstance(value, str) else value
            name = record.get("name")
            if name and not name.startswith(":"):
                seen.add(name)
        if degraded != "empty":
            # The degraded-empty pass legitimately carries no records —
            # roster_raw.json holds the empty projection there and the
            # telemetry (below) is the assertion that matters.
            missing = expected_names - seen
            if missing:
                failures.append("[%s] roster_raw.json misses players: %s"
                                % (label, sorted(missing)))

        try:
            with open("telemetry.json") as fh:
                tele = json.load(fh)
        except Exception as e:
            failures.append("[%s] telemetry.json unreadable: %r" % (label, e))
            return
        tele_players = tele.get("players", {})
        if set(tele_players) != expected_names:
            failures.append("[%s] telemetry.json players mismatch: %d vs %d expected"
                            % (label, len(tele_players), len(expected_names)))
        if not all(v is True for v in tele_players.values()):
            failures.append("[%s] telemetry.json reports a live roster as not-alive" % label)
        self_block = tele.get("self") or {}
        if self_block.get("name") != "langyo":
            failures.append("[%s] telemetry self.name wrong: %r" % (label, self_block.get("name")))

        # Identity block: the app routes each roster row to its cluster
        # off this; a dropped/zeroed entry silently misroutes lookups.
        # The degraded-empty pass synthesizes its roster off the entity
        # walk (no account ids at all) — the identity bridge must be an
        # EMPTY map there, and the companion's own realm routing takes
        # over; the churn pass latched the records' rows, so the full
        # identity survives.
        identity = tele.get("identity")
        if not isinstance(identity, dict):
            failures.append("[%s] telemetry identity is not a mapping: %r"
                            % (label, identity))
            identity = {}
        if degraded == "empty":
            if identity != {}:
                failures.append("[%s] walk-sourced identity must stay empty: %r"
                                % (label, identity))
        else:
            if identity.get("langyo", {}).get("account_id") != 310000000:
                failures.append("[%s] telemetry identity missing/misrouted: %r"
                                % (label, identity.get("langyo")))
            if not identity.get("langyo", {}).get("realm"):
                failures.append("[%s] telemetry identity carries no realm" % label)
        if type(tele.get("t")) is not int:
            failures.append("[%s] telemetry t is %s (must be int)"
                            % (label, type(tele.get("t")).__name__))
        # The game-true sort-key map. The ship-less passes pin the
        # WITHHELD shape (a sandbox that serves no ship entities — Lesta
        # until a live battle proves otherwise): the probe must degrade
        # to an EMPTY mapping, but the FIELD itself must be present (its
        # absence is exactly what keys the app's offline-inference
        # fallback). The ship passes pin the game-true path: the exact
        # planted table lands (the fail_plain variant proves the
        # hand-rolled serializer carries it too), short exactly the
        # unpaired avatar on the partial pass.
        expected_keys = {} if ships == "none" else dict(SHIP_KEYS)
        if ships == "partial":
            del expected_keys["langyo"]
        if drift_records and ships != "none":
            # The nameless drifted record has no avatar, so no sort key.
            del expected_keys["Ally04"]
        if tele.get("sortKeys") != expected_keys:
            failures.append("[%s] telemetry sortKeys mismatch (ships=%s): %r"
                            % (label, ships, tele.get("sortKeys")))

        # The roster's OWN record sequence (rosterOrder): the companion
        # consumes it as the Lesta equal-key tie base — it must carry the
        # records' iteration order verbatim (bots included; they hold
        # table rows too) through BOTH encoders, and as a LIST so no
        # parser can reorder it. The drift pass's nameless record drops
        # out (there is no name to sequence); the degraded-empty pass has
        # no records at all, so the sequence stays EMPTY (the companion
        # reads empty as "absent" and keeps its offline inference).
        expected_sequence = ([n for n in build_roster_order()
                              if n != "Ally04"] if drift_records
                             else build_roster_order())
        if degraded == "empty":
            expected_sequence = []
        if tele.get("rosterOrder") != expected_sequence:
            failures.append("[%s] telemetry rosterOrder mismatch: %r"
                            % (label, tele.get("rosterOrder")))
        # The records' localized ship names (shipNames): the CN HUD's
        # name-order segment, bridged verbatim (zh round trip included)
        # when the records carry the field; a records shape WITHOUT it
        # must degrade to an EMPTY map — the key stays present, the
        # companion treats empty as "absent". The degraded-empty pass has
        # no records, so its map is empty for the same reason.
        expected_localized = dict(SHIP_LOCALIZED) if with_ship_names else {}
        if drift_records and with_ship_names:
            del expected_localized["Ally04"]
        if degraded == "empty":
            expected_localized = {}
        if tele.get("shipNames") != expected_localized:
            failures.append("[%s] telemetry shipNames mismatch: %r"
                            % (label, tele.get("shipNames")))
        # The aim verdict (the target-flags walk): Foe03's main-battery bits
        # beat Foe01's earlier-walked non-main lockable bit. The raising-cc
        # (Lesta) passes stand the whole walk down — the field must still
        # be present with the EMPTY verdict, never absent. The aim_duck
        # pass proves the components-mapping fallback (no
        # UiComponents.target) lands the same pick.
        expected_aim = ({"name": "", "flags": 0} if raising_constants
                        else {"name": "Foe03", "flags": 6})
        if tele.get("aim") != expected_aim:
            failures.append("[%s] telemetry aim=%r, expected %r"
                            % (label, tele.get("aim"), expected_aim))
        # roster_raw.json carries the same sequence as its `order` array —
        # the Rust synthesizer preserves it instead of sorting (name, id).
        if raw.get("order") != expected_sequence:
            failures.append("[%s] roster_raw order mismatch: %r"
                            % (label, raw.get("order")))

        # Bots must SURVIVE into roster_raw.json: the app's synthesizer
        # keeps ':Name:' rows because they hold co-op table rows and team
        # sizes, exactly like the WG arena file's bot entries. (The
        # degraded-empty pass carries no records at all — nothing to
        # survive there; its telemetry is the assertion that matters.)
        if degraded != "empty" and not any(
                str(v).find(BOT_NAME) >= 0 for v in players.values()):
            failures.append("[%s] roster_raw.json dropped the %s bot record"
                            % (label, BOT_NAME))

        with open("heartbeat.json") as fh:
            hb = json.load(fh)
        if hb.get("players") != len(expected_names):
            failures.append("[%s] heartbeat players=%r (expected %d)"
                            % (label, hb.get("players"), len(expected_names)))
        if hb.get("phase") != "battle":
            # The battle phase must hold from the game's own battleStart
            # event even when the roster never stabilizes (the CN360 drift
            # class) — pin it on the stabilized path here.
            failures.append("[%s] heartbeat phase=%r (expected battle)"
                            % (label, hb.get("phase")))
        # The degraded-roster marker: '' on the stabilized path, the
        # synthesis source on the degraded ones; the records counter is
        # the companion's evidence channel for which side died.
        expected_fb = {"empty": "walk", "churn": "records"}.get(degraded, "")
        if hb.get("fb", "") != expected_fb:
            failures.append("[%s] heartbeat fb=%r (expected %r)"
                            % (label, hb.get("fb"), expected_fb))
        if degraded == "empty" and hb.get("rec") != 0:
            failures.append("[%s] heartbeat rec=%r (expected 0 on dead records)"
                            % (label, hb.get("rec")))

        # The panel path: with `ui` injected (WG-family clients) the strip
        # must actually be driven; without it (Lesta) the paths must be a
        # silent no-op — the zero-`is not defined` contract above already
        # proves the latter.
        if with_ui and (ui is None or ui.calls == 0):
            failures.append("[%s] ui was injected but the panel never wrote to it" % label)

        # `?` conversion fallbacks would mean a core conversion failed.
        joined = "\n".join(utils.lines)
        # The hard contract: NOT ONE `is not defined` may appear in the
        # probe log. Any such line is a NameError from a builtin the
        # crippled set withheld — i.e. a path still depending on a name
        # the Lesta whitelist has not been proven to carry. Diagnostics
        # may degrade for OTHER reasons (missing ModsShell modules in this
        # harness, record-shape differences) — those stay legal.
        named_err = [l for l in utils.lines if "is not defined" in l]
        if named_err:
            failures.append("[%s] NameError degradations in the probe log: %s"
                            % (label, " || ".join(named_err[:10])))
        # The census line reports which survivor builtins the host had.
        census = [l for l in utils.lines if "sandbox builtins=" in l]
        if not census:
            failures.append("[%s] the sandbox census never ran" % label)
        elif "legacy_missing=['len']" in census[0]:
            failures.append("[%s] census reports the harness withheld len: %s"
                            % (label, census[0]))
        # Beyond the log: the probe's own soft-error latch must be EMPTY.
        # Some guards record the failure only here (no log line), so a
        # bare-name reference inside a guarded block would otherwise slip
        # through — the latch closes that blind spot. In a healthy run
        # every path succeeds and nothing lands here.
        probe = env.get("probe")
        if probe is not None and probe.last_error:
            failures.append("[%s] probe recorded a soft error: %r"
                            % (label, probe.last_error))
        # The in-game panel's row order (merge_order's fold of the walk).
        # With FULL key coverage the alive block sorts by the keys alone,
        # stable — the live-observed client rule (equal keys keep the
        # roster's own order);
        # with a gap (the partial pass: langyo unpaired) that side keeps
        # the WALK order (game-true and walk-order rows never interleave)
        # while the still-covered side sorts. The raising-cc (Lesta)
        # passes stand the entity WALK down — it is the walk that
        # resolves UiComponents (the fold only folds what the walk
        # produced, and sort_key_probe needs no constants at all) — so
        # those passes assert the key table above and skip this block.
        if ships != "none" and not raising_constants and probe is not None:
            expected_order = {
                "ally": (["langyo"] + ["Ally%02d" % i for i in range(1, 6)]
                         if ships == "partial" else SHIP_KEY_ORDERS["ally"]),
                "enemy": SHIP_KEY_ORDERS["enemy"],
            }
            if drift_records:
                # The nameless drifted record walks no avatar — its row is
                # simply absent from the fold's ally side.
                expected_order["ally"] = [n for n in expected_order["ally"]
                                          if n != "Ally04"]
            for side in ("ally", "enemy"):
                if probe.order.get(side) != expected_order[side]:
                    failures.append(
                        "[%s] panel %s order wrong (ships=%s): %r"
                        % (label, side, ships, probe.order.get(side)))
        # The client-order probe: the fake raw avatar collection exposes
        # the planted 'team.ally.sortedAlive' child in SHIP_KEY_ORDERS
        # order (NOT the walk order); order_probe.json must capture that
        # exact sequence and report the raw door as present. The
        # raising-cc (Lesta) passes stand _cc() down, so the probe never
        # runs there.
        if not raising_constants and probe is not None:
            try:
                with open("order_probe.json") as fh:
                    order_probe = json.load(fh)
                rows = order_probe.get("paths", {}).get("avatar/team.ally.sortedAlive")
                got = ([r.get("name") for r in rows]
                       if isinstance(rows, list) else rows)
                apis = order_probe.get("apis", {})
                if raw_collection:
                    if got != planted_order:
                        failures.append(
                            "[%s] order_probe sortedAlive=%r, expected %r"
                            % (label, got, planted_order))
                    if apis.get("getCollection") != "present":
                        failures.append(
                            "[%s] order_probe did not report getCollection present"
                            % label)
                else:
                    if apis.get("getCollection") != "missing":
                        failures.append(
                            "[%s] no-raw order_probe getCollection=%r, expected missing"
                            % (label, apis.get("getCollection")))
                    if order_probe.get("paths"):
                        failures.append(
                            "[%s] no-raw order_probe captured paths: %r"
                            % (label, order_probe.get("paths")))
            except Exception as e:
                failures.append("[%s] order_probe.json unreadable: %r"
                                % (label, e))
        # The strip payload's row fields: every row carries the
        # WALK-sourced avatar entity id (bots included — the harness bot's
        # record has no avatar_id at all), a canonical idx (its rank in
        # the rosterOrder bridge) and its 8-slot barcode word. The byId
        # maps key on the walk ids — planting disjoint id spaces pins
        # "walk id is authoritative" against the roster records' mapping
        # keys.
        if probe is not None:
            roster_order, _ = probe.roster_order(probe.latest_raw)
            ranks = {n: i for i, n in enumerate(roster_order)}
            for side in ("ally", "enemy"):
                rows = probe.panel_rows(side)
                if not rows:
                    continue
                for row in rows:
                    name = row["name"]
                    # The harness's walk ids are 7000 + the record slot;
                    # resolve via the sticky map the probe itself built.
                    got_id = row.get("avatar_id", 0)
                    if got_id and got_id < 7000:
                        failures.append(
                            "[%s] %s avatar_id %r is a roster key, not a walk id"
                            % (label, name, got_id))
                    idx = row.get("idx", -2)
                    want_rank = ranks.get(name, -1)
                    if idx != want_rank:
                        failures.append(
                            "[%s] %s idx=%r, expected rosterOrder rank %r"
                            % (label, name, idx, want_rank))
                    bits = row.get("bits")
                    if want_rank < 0:
                        # A rankless row carries a parity-INVALID 8-slot
                        # word (never an empty array — the DSL indexes
                        # bits[0..5] unguarded): the decoder's parity
                        # check must reject it. No harness pass walks a
                        # rankless avatar today; the shape is pinned by
                        # the direct barcode_bits(-1) probe below.
                        if bits != [True, False, False, False, False,
                                    False, False, False]:
                            failures.append(
                                "[%s] %s rankless row carries bits %r"
                                % (label, name, bits))
                        continue
                    if not isinstance(bits, list) or len(bits) != 8:
                        failures.append("[%s] %s bits=%r, expected 8 slots"
                                        % (label, name, bits))
                        continue
                    if bits[0] is not True or bits[1] is not False:
                        failures.append("[%s] %s bits sync prefix=%r"
                                        % (label, name, bits[:2]))
                    word = (16 if bits[2] is True else 0) \
                        | (8 if bits[3] is True else 0) \
                        | (4 if bits[4] is True else 0) \
                        | (2 if bits[5] is True else 0) \
                        | (1 if bits[6] is True else 0)
                    if word != idx:
                        failures.append(
                            "[%s] %s bits decode to %r, idx says %r"
                            % (label, name, word, idx))
                    ones = sum(1 for b in bits[2:7] if b is True)
                    if bits[7] is not (ones % 2 == 0):
                        failures.append("[%s] %s bits parity wrong: %r"
                                        % (label, name, bits))
            # The mode flag the payload forwards comes from the probe's
            # OWN module config (the exec env's TOOL_CONFIG): the default
            # keeps the strips off (the overlay watcher upserts barcode=1
            # when its mode starts). The rankless-row invalid word is
            # pinned by the literal in the row loop above (no harness
            # pass walks a rankless avatar).
            env_cfg = env.get("TOOL_CONFIG") or {}
            if env_cfg.get("barcode") != 0:
                failures.append("[%s] default mode flag flipped: %r"
                                % (label, env_cfg))
        # The session-opening log line: the stabilized path announces
        # 'roster stable players=', the degraded ones announce their
        # synthesis source instead — a degraded pass must NEVER show the
        # stable line (its records never stabilized) and a healthy pass
        # must never show the fallback line.
        if degraded:
            if "roster fallback session source=" not in joined:
                failures.append("[%s] the fallback session never opened; probe log:\n%s"
                                % (label, joined[-2000:]))
            if "roster stable players=" in joined:
                failures.append("[%s] a degraded battle claims a stabilized roster" % label)
        elif "roster stable players=" not in joined:
            failures.append("[%s] the roster never stabilized; probe log:\n%s"
                            % (label, joined[-2000:]))
        # Battle quit: the quit-clear telemetry must blank EVERY keyed
        # field (players, sortKeys AND the ordering raw material —
        # rosterOrder/shipNames), so a leftover file from a closed client
        # can never keep pinning a consumer's tie base or name segment.
        if probe is not None:
            probe.quit()
            try:
                with open("telemetry.json") as fh:
                    cleared = json.load(fh)
            except Exception as e:
                failures.append("[%s] quit telemetry.json unreadable: %r" % (label, e))
            else:
                if cleared.get("players") != {} or cleared.get("sortKeys") != {}:
                    failures.append("[%s] quit telemetry did not clear the keyed maps: %r"
                                    % (label, cleared))
                if cleared.get("rosterOrder") != [] or cleared.get("shipNames") != {}:
                    failures.append("[%s] quit telemetry did not clear the order bridge: %r"
                                    % (label, cleared))
    finally:
        os.chdir(cwd)


def main(argv):
    plugin = argv[1] if len(argv) > 1 else os.path.normpath(DEFAULT_PLUGIN)
    with open(plugin, encoding="utf-8") as fh:
        plugin_src = fh.read()

    failures = []
    # Six ship-less passes (the historical matrix: two encodings with the
    # manifest present — the config path proves it is READ —, one
    # no-manifest pass proving the fallback path — and the handler-type
    # evaluation on it — stays sandbox-safe, one ui-present pass (Lesta
    # injects no `ui`; the WG-family clients do, and the panel path must
    # still work there), one raising-constants pass (Lesta's
    # UiComponents attribute), and one 15.9-quirk pass where the client's
    # own jsonEncode REJECTS plain dict payloads (live WG 2026-10-09 —
    # telemetry.json froze at its quit-clear) and every bridge file must
    # still flow through the hand-rolled serializer) — then four ship
    # passes pinning the game-true sort-key path itself (see the module
    # docstring): the WG shape, the Lesta shape (raising UiComponents —
    # the walk must not need it), the encoder quirk (the key table must
    # survive the hand-rolled serializer), and partial coverage (an
    # unpaired avatar keeps that side on the walk order, keys stay one
    # short) — plus one ship-name-withheld pass pinning the empty-map
    # degrade of the new shipNames bridge (a records shape with no
    # shipName field at all), and one DRIFT pass planting schema-drifted
    # records (one without `isBot`, one without `name` — the 2026-10-11
    # CN360 failure class where a single missing field used to silence
    # the whole roster): the isBot-less row must stay, the nameless row
    # must drop, and the battle must still stabilize.
    passes = [
            (True, True, False, False, False, "none", True, False),
            (False, True, False, False, False, "none", True, False),
            (True, False, False, False, False, "none", True, False),
            (True, True, True, False, False, "none", True, False),
            (True, True, False, True, False, "none", True, False),
            (True, True, False, False, True, "none", True, False),
            (True, True, False, False, False, "full", True, False),
            (True, True, False, True, False, "full", True, False),
            (True, True, False, False, True, "full", True, False),
            (True, True, False, False, False, "partial", True, False),
            (True, True, False, False, False, "full", False, False),
            (True, True, False, False, False, "full", True, True)]
    for (encode_records, with_manifest, with_ui, raising_constants,
         fail_plain, ships, with_ship_names, drift_records) in passes:
        with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
            run_once(plugin_src, workdir, encode_records, with_manifest,
                     with_ui, raising_constants, fail_plain, ships,
                     with_ship_names, drift_records, failures)
    # The live 15.9 `battle` SafeClass does NOT forward the internal
    # getCollection helper. One extra pass pins that shape: the probe must
    # record 'missing', capture no paths and still write its file.
    with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
        run_once(plugin_src, workdir, True, True, False, False, False,
                 "none", True, False, failures, raw_collection=False)
    # The aim-duck pass: UiComponents resolves but carries no `target`
    # attribute, so the aim walk must fall back to duck-typing the raw
    # components mapping — same Foe03 pick, asserted through telemetry's
    # per-tick 'aim' verdict.
    with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
        run_once(plugin_src, workdir, True, True, False, False, False,
                 "full", True, False, failures, aim_duck=True)
    # The degraded-roster passes (the 2026-10-18/19 Steam-13357625 +
    # CN360-13357822 field class: telemetry.json appeared only as the
    # battle-end quit-clear because the roster NEVER stabilized and the
    # session gate stood closed all battle):
    #   "empty"  — getPlayersInfo answers {} every tick. The probe must
    #              synthesize its session off the ENTITY WALK after the
    #              grace ticks: telemetry flows with the walk's names and
    #              alive flags, the identity bridge stays empty (no ids to
    #              route), the heartbeat reports fb=walk rec=0, and the
    #              sortKeys/aim/self bridges keep working (their sources
    #              are records-independent);
    #   "churn"  — one player's accountDBID flips every call, so the
    #              roster differs each tick and never stabilizes. The
    #              synthesis latches the records' rows: the FULL identity
    #              (account ids + realms) survives, fb=records.
    with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
        run_once(plugin_src, workdir, True, True, False, False, False,
                 "full", True, False, failures, degraded="empty")
    with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
        run_once(plugin_src, workdir, True, True, False, False, False,
                 "full", True, False, failures, degraded="churn")

    if failures:
        print("SANDBOX CONFORMANCE: FAIL (%d)" % len(failures))
        for line in failures:
            print(" - " + line)
        return 1
    print("SANDBOX CONFORMANCE: PASS (%d passes, %s, crippled builtins: %s)"
          % (len(passes) + 4, os.path.basename(os.path.normpath(plugin)),
             ", ".join(SAFE_BUILTINS)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
