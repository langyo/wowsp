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
  - telemetry.json: per-name alive flags + the self identity,
  - heartbeat.json / request.json written with the roster count,
  - the scheduler survives tick-over-tick (no swallowed exception text).

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
    def __init__(self, encode_records):
        self.lines = []
        # True = the sandbox encoder accepts SafeClass records (produces
        # the DOUBLE-ENCODED string shape on disk); False = it rejects
        # them (the guessed-projection shape).
        self.encode_records = encode_records
        self.log_info_calls = 0

    def logInfo(self, message):
        self.log_info_calls += 1
        self.lines.append(str(message))

    def jsonEncode(self, value):
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

    def getPlayersInfo(self):
        return dict(self.players)


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
    def __init__(self, entities=None):
        self.entities = entities or []

    def getEntityCollections(self, kind):
        return self.entities


class FakeComponent(object):
    def __init__(self, **fields):
        self.__dict__.update(fields)


class FakeAvatarEntity(object):
    """One dataHub avatar entity: component subscripts + `in` membership
    (the walk's contract)."""

    def __init__(self, component_class, name, relation, alive=True,
                 hp=24400.0, hp_max=24400.0):
        self._map = {
            component_class.avatar: FakeComponent(name=name),
            component_class.health: FakeComponent(value=hp, max=hp_max,
                                                  isAlive=alive),
            component_class.relation: FakeComponent(value=relation),
        }

    def __getitem__(self, key):
        return self._map[key]

    def __contains__(self, key):
        return key in self._map


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


def crippled_builtins():
    import builtins as host
    table = {}
    for name in SAFE_BUILTINS:
        table[name] = getattr(host, name)
    return table


def run_once(plugin_src, workdir, encode_records, with_manifest, with_ui, failures):
    label = "encode=%s manifest=%s ui=%s" % (
        "records" if encode_records else "projection",
        "yes" if with_manifest else "missing",
        "yes" if with_ui else "absent")
    utils = StubUtils(encode_records)
    battle = StubBattle()
    events = StubEvents()
    callbacks = StubCallbacks()
    cc = StubConstants.UiComponents
    entities = [
        FakeAvatarEntity(cc, name=rec["name"],
                         relation=(StubConstants.PlayerRelation.SELF
                                   if rec["name"] == "langyo"
                                   else (StubConstants.PlayerRelation.ALLY
                                         if rec["teamId"] == 1
                                         else StubConstants.PlayerRelation.ENEMY)),
                         alive=True)
        for rec in build_roster().values()
    ]
    env = {
        "__builtins__": crippled_builtins(),
        "__name__": "__sandbox__",
        "utils": utils,
        "battle": battle,
        "events": events,
        "callbacks": callbacks,
        "dataHub": StubDataHub(entities),
        "constants": StubConstants(),
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
    # Two encodings with the manifest present (the config path proves it is
    # READ), one no-manifest pass proving the fallback path — and the
    # handler-type evaluation on it — stays sandbox-safe, and one ui-present
    # pass (Lesta injects no `ui`; the WG-family clients do, and the panel
    # path must still work there).
    for encode_records, with_manifest, with_ui in (
            (True, True, False), (False, True, False), (True, False, False),
            (True, True, True)):
        with tempfile.TemporaryDirectory(prefix="wowsp-sandbox-") as workdir:
            run_once(plugin_src, workdir, encode_records, with_manifest, with_ui, failures)

    if failures:
        print("SANDBOX CONFORMANCE: FAIL (%d)" % len(failures))
        for line in failures:
            print(" - " + line)
        return 1
    print("SANDBOX CONFORMANCE: PASS (4 passes, %s, crippled builtins: %s)"
          % (os.path.basename(os.path.normpath(plugin)), ", ".join(SAFE_BUILTINS)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
