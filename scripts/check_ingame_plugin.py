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
    SHIP_KEYS),
  - heartbeat.json / request.json written with the roster count,
  - the scheduler survives tick-over-tick (no swallowed exception text).

The GAME-TRUE sort-key path (sort_key_probe: the 'ship' collection walk
plus the avatar ship-slot pairing) is what the ship passes exist for —
until 2026-10-10 every pass planted no ship entities and could only
assert the empty-map degradation, while the Lesta sandbox's behavior
toward the 'ship' collection stays unverified in a real battle (the
design doc's open item). The passes now pin, OFFLINE:
  - the WG shape (ship components carrying sortKey, avatar `.ship` slot
    references whose `.ref.id` matches a ship entry id): the exact key
    table lands in telemetry AND the panel fold sorts its alive block by
    the keys alone, stable — equal keys keep the roster's own order
    (live 2026-10-10: the client rendered two same-key rows in record
    order against the key + name concatenation's ':'-first tie);
    avatar-entity names carry clan tags (the real client's shape), so
    the bare-name keying of the map is asserted too;
  - the LESTA shape (UiComponents raising): the key table still lands —
    the path duck-types the components and must never need constants;
  - a partial-coverage shape (one avatar's reference resolves to no ship
    entry): the key map stays partial AND that side's panel fold keeps
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
        # telemetry.json froze at its quit-clear while heartbeat/request
        # shaped differently). The load-bearing writers must fall back to
        # the hand-rolled serializer and keep every file flowing.
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
            return json.dumps(value._f)
        return json.dumps(value, default=self._encode_default)

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

    def getPlayersInfo(self):
        return dict(self.players)

    def getSelfPlayerInfo(self):
        return self._self


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
                 hp=24400.0, hp_max=24400.0, ship_slot=None):
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


def build_roster(self_name="langyo"):
    players = {}
    for i in range(ROSTER_SIZE - ENEMY_COUNT):
        name = self_name if i == 0 else "Ally%02d" % i
        players[100 + i] = FakeRecord(name=name, accountDBID=310000000 + i,
                                      realm="ru", shipParamsId=418000000 + i,
                                      isBot=False, teamId=1, isAlive=True)
    for i in range(ENEMY_COUNT):
        players[200 + i] = FakeRecord(name="Foe%02d" % i, accountDBID=320000000 + i,
                                      realm="ru", shipParamsId=428000000 + i,
                                      isBot=False, teamId=2, isAlive=True)
    players[300] = FakeRecord(name=BOT_NAME, accountDBID=0, realm="",
                              shipParamsId=438000000, isBot=True, teamId=2,
                              isAlive=True)
    return players


# The planted client sort keys — ShipSystem.add's own concatenation
# (class rank + str(100 - tier) + nation rank + shortName; nation ranks
# follow the client's NATION.SORT_ORDER: japan 0, usa 1, russia 2,
# germany 3, uk 4, france 5, pan_asia 7). Deliberately chosen so the
# game-true sort (the keys alone, a STABLE sort per the live 2026-10-10
# Lesta capture) is OBSERVABLE: it differs from the entity-walk order on
# both sides, so the assertions below prove the panel fold really sorted
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
             raising_constants, fail_plain, ships, failures):
    label = "encode=%s manifest=%s ui=%s cc=%s plain=%s ships=%s" % (
        "records" if encode_records else "projection",
        "yes" if with_manifest else "missing",
        "yes" if with_ui else "absent",
        "raising" if raising_constants else "ok",
        "reject" if fail_plain else "ok",
        ships)
    utils = StubUtils(encode_records, fail_plain)
    battle = StubBattle()
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
    roster = build_roster()
    dh_avatars = []
    dh_ships = []
    # Iteration follows build_roster's insertion order (the py3.7+ dict
    # guarantee) — the walk-order expectations below are coupled to it.
    for slot, rec in roster.items():
        name = rec["name"]
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
        dh_avatars.append(
            FakeAvatarEntity(cc, name=entity_name, relation=relation,
                             alive=True,
                             ship_slot=(FakeShipSlot(ship_id)
                                        if ship_id is not None else None)))
        if ship_id is not None and ship_id != UNPAIRED_SHIP_ID:
            dh_ships.append(FakeShipEntity(ship_id, SHIP_KEYS[name]))
    if ships == "full":
        dh_ships.append(FakeShipEntity(NOISE_SHIP_ID, None))
    env = {
        "__builtins__": crippled_builtins(),
        "__name__": "__sandbox__",
        "utils": utils,
        "battle": battle,
        "events": events,
        "callbacks": callbacks,
        "dataHub": StubDataHub(dh_avatars, dh_ships),
        "constants": (RaisingConstants() if raising_constants
                      else StubConstants()),
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
        with open(os.path.join(workdir, "bin", "8867689", "res_mods", "wowsp.toml"), "w") as fh:
            fh.write('[tools."battle.ingame.stats"]\npanel_fade_ticks = 7\njournal_limit = 123\n')
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
        expected_cfg = ({"panel_fade_ticks": 7, "journal_limit": 123}
                        if with_manifest else {"panel_fade_ticks": 3, "journal_limit": 300})
        if env.get("TOOL_CONFIG") != expected_cfg:
            failures.append("[%s] TOOL_CONFIG=%r, expected %r"
                            % (label, env.get("TOOL_CONFIG"), expected_cfg))
            return

        # Battle start: records become available, then drive the tick loop
        # (each tick re-schedules itself; call the latest pending callback).
        battle.players = build_roster()
        start = events.handlers.get("onBattleStart")
        if start is None:
            failures.append("[%s] onBattleStart was never registered" % label)
            return
        start()
        for _ in range(5):
            fn = callbacks.pending
            callbacks.pending = None
            if fn is None:
                failures.append("[%s] scheduler stopped re-arming" % label)
                return
            fn()

        # ── artifact assertions ──────────────────────────────────────────
        expected_names = set()
        for rec in battle.players.values():
            if rec["isBot"] or rec["name"].startswith(":"):
                continue
            expected_names.add(rec["name"])

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
        identity = tele.get("identity")
        if not isinstance(identity, dict):
            failures.append("[%s] telemetry identity is not a mapping: %r"
                            % (label, identity))
            identity = {}
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
        if tele.get("sortKeys") != expected_keys:
            failures.append("[%s] telemetry sortKeys mismatch (ships=%s): %r"
                            % (label, ships, tele.get("sortKeys")))

        # Bots must SURVIVE into roster_raw.json: the app's synthesizer
        # keeps ':Name:' rows because they hold co-op table rows and team
        # sizes, exactly like the WG arena file's bot entries.
        if not any(str(v).find(BOT_NAME) >= 0 for v in players.values()):
            failures.append("[%s] roster_raw.json dropped the %s bot record"
                            % (label, BOT_NAME))

        with open("heartbeat.json") as fh:
            hb = json.load(fh)
        if hb.get("players") != len(expected_names):
            failures.append("[%s] heartbeat players=%r (expected %d)"
                            % (label, hb.get("players"), len(expected_names)))

        with open("request.json") as fh:
            req = json.load(fh)
        if len(req.get("players", [])) != len(expected_names):
            failures.append("[%s] request.json players=%d (expected %d)"
                            % (label, len(req.get("players", [])), len(expected_names)))
        if req.get("manual") is not False:
            failures.append("[%s] request manual is %r (must be the bool False)"
                            % (label, req.get("manual")))
        # Numeric ids must land as real numbers with real values — a
        # silently-zeroed conversion (the swallowed-NameError class)
        # would otherwise pass unnoticed.
        for row in req.get("players", []):
            if not isinstance(row.get("account_id"), int) or row["account_id"] <= 0:
                failures.append("[%s] request row account_id invalid: %r"
                                % (label, row.get("account_id")))
            if not isinstance(row.get("ship_id"), int) or row["ship_id"] <= 0:
                failures.append("[%s] request row ship_id invalid: %r"
                                % (label, row.get("ship_id")))

        # The panel path: with `ui` injected (WG-family clients) the panel
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
            for side in ("ally", "enemy"):
                if probe.order.get(side) != expected_order[side]:
                    failures.append(
                        "[%s] panel %s order wrong (ships=%s): %r"
                        % (label, side, ships, probe.order.get(side)))
        if "roster stable players=" not in joined:
            failures.append("[%s] the roster never stabilized; probe log:\n%s"
                            % (label, joined[-2000:]))
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
    # short).
    for (encode_records, with_manifest, with_ui, raising_constants,
         fail_plain, ships) in (
            (True, True, False, False, False, "none"),
            (False, True, False, False, False, "none"),
            (True, False, False, False, False, "none"),
            (True, True, True, False, False, "none"),
            (True, True, False, True, False, "none"),
            (True, True, False, False, True, "none"),
            (True, True, False, False, False, "full"),
            (True, True, False, True, False, "full"),
            (True, True, False, False, True, "full"),
            (True, True, False, False, False, "partial")):
        with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
            run_once(plugin_src, workdir, encode_records, with_manifest,
                     with_ui, raising_constants, fail_plain, ships, failures)

    if failures:
        print("SANDBOX CONFORMANCE: FAIL (%d)" % len(failures))
        for line in failures:
            print(" - " + line)
        return 1
    print("SANDBOX CONFORMANCE: PASS (10 passes, %s, crippled builtins: %s)"
          % (os.path.basename(os.path.normpath(plugin)), ", ".join(SAFE_BUILTINS)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
