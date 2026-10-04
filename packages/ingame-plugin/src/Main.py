# -*- coding: utf-8 -*-
"""WoWSP in-game bridge probe.

Runs inside the game client via the WG Mods API (PnFMods loader). The
sandbox has no networking, so this probe observes, bridges and (since the
in-game display mode landed) renders:

  - everything it learns goes to python.log (prefix WOWSP_PROBE) and to
    flat JSON files next to this Main.py; the wowsp companion process is
    expected to read request.json and write response.json back,
  - live alive flags are bridged out as telemetry for the transparent
    overlay window (priority: mod telemetry > screen-capture inference >
    static roster order),
  - when the companion answers response.json, the stats rows are rendered
    INSIDE the game: the unbound view (WoWSPProbe.unbound, installed to
    gui/unbound2/mods/ where the game auto-discovers + mounts battle
    views) watches this file's single 'wowspProbe.panel' data component
    and draws the ally/enemy stat columns while Tab is held. The sides
    and row order come from the per-tick relation walk (entity_walk);
    no companion answer means no panel - the transparent-overlay view
    mode simply never turns the bridge on.

Still measured for diagnostics:
  1. load + heartbeat (heartbeat.json, phase port/battle),
  2. the full raw schema of battle.getPlayersInfo() (roster_raw.json),
  3. the sandbox API surface (dir() of every injected module, once),
  4. request/response file bridge + Tab/Alt/V key events.

Keep the syntax conservative (no f-strings, 3.6-level) and never let an
exception escape a callback: the game keeps running but the mod dies.
"""
API_VERSION = 'API_v1.0'

# Owner decision: the probe reports itself as 0.1.0 for the whole
# experiment; iterate via git history only, never this constant.
PROBE_VERSION = '0.1.0'
PREFIX = 'WOWSP_PROBE '
HEARTBEAT_FILE = 'heartbeat.json'
REQUEST_FILE = 'request.json'
RESPONSE_FILE = 'response.json'
MANUAL_FLAG = 'manual_refresh.flag'
ROSTER_RAW_FILE = 'roster_raw.json'
ROSTER_JOURNAL_FILE = 'roster_journal.jsonl'
TELEMETRY_FILE = 'telemetry.json'

# Tool config: WoWSP maintains res_mods/wowsp.toml and seeds our table
# ([tools."battle.ingame.stats"]) with these values; the keys below are the
# contract, hand edits to the file survive WoWSP rewrites. JOURNAL_LIMIT
# stays as the fallback default for a missing/unreadable manifest.
CONFIG_DEFAULTS = {
    'panel_fade_ticks': 3,
    'journal_limit': 300,
}
JOURNAL_LIMIT = CONFIG_DEFAULTS['journal_limit']


def load_tool_config():
    """Read integer keys from [tools."battle.ingame.stats"] in the
    res_mods/wowsp.toml WoWSP maintains two levels above this file.

    A conservative 3.6-level scanner — only `key = <int>` lines under our
    own table header matter, so no full TOML parser is warranted inside
    the sandbox. Any problem (missing file, changed layout, odd values)
    falls back to CONFIG_DEFAULTS; never raises.
    """
    cfg = dict(CONFIG_DEFAULTS)
    try:
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, os.pardir, os.pardir, 'wowsp.toml')
        with open(path, 'r') as handle:
            body = handle.read()
        header = '[tools."battle.ingame.stats"]'
        lines = body.splitlines()
        for idx in range(len(lines)):
            if lines[idx].strip() != header:
                continue
            for line in lines[idx + 1:]:
                stripped = line.strip()
                if stripped.startswith('['):
                    break  # next table — ours ended
                if '=' not in stripped or stripped.startswith('#'):
                    continue
                key, _, raw = stripped.partition('=')
                key = key.strip()
                raw = raw.split('#', 1)[0].strip()
                if key in CONFIG_DEFAULTS and raw.lstrip('-').isdigit():
                    cfg[key] = int(raw)
            break
    except Exception:
        pass
    return cfg


TOOL_CONFIG = load_tool_config()
JOURNAL_LIMIT = TOOL_CONFIG['journal_limit']

# The in-game panel's single data component: the unbound view watches this
# key (getPrimWatcher(CC.mods_DataComponent, ...)) and redraws on every
# updateUiElementData. All presentation decisions (colors, formatting) are
# made here so the view stays a dumb template.
PANEL_KEY = 'wowspProbe.panel'

# SafeClass records hide their keys from dir(); probe likely field names so
# the projection works even when no enumeration path succeeds.
GUESS_FIELDS = ('name', 'accountDBID', 'realm', 'shipParamsId', 'isBot', 'teamId', 'id',
                'vehicleId', 'shipId', 'shipName', 'score', 'frags', 'kills',
                'deaths', 'damageDealt', 'isAlive', 'isHidden', 'isTeamKiller',
                'clanAbbrev', 'clanID', 'level', 'relation', 'planeKills',
                'maxHealth', 'currHealth')

import time


def log(message):
    utils.logInfo(PREFIX + message)


def bare_name(name):
    """Avatar-entity names carry the clan tag ('[RCCK]Laneigedc') while
    roster names (the stats/telemetry keys) are bare — strip the tag."""
    return name.split(']', 1)[-1] if name.startswith('[') else name


class Probe(object):

    def __init__(self):
        self.session = ''
        self.roster = []
        self.previous = None
        self.stable = 0
        self.busy = False
        self.last_request = 0.0
        self.revision = -1
        self.manual_stamp = ''
        self.last_error = ''
        self.entities = {}
        self.known_events = set([])
        self.event_log_count = 0
        self.key_log_count = 0
        self.v_down = False
        self.last_raw = ''
        self.discovered = False
        self.journal = []
        self.empty_ticks = 0
        self.dead_latch = set()
        self.dh = None
        self.const = None
        self.api_dumped = False
        self.comp_dumped = False
        # In-game panel state: Tab visibility, the two sides' TAB order,
        # the answered stats rows keyed by name, the companion's column
        # labels, the freshest entity states (shared with the telemetry
        # writer) and the last panel body (change gate for the UI update).
        self.tab = False
        self.order = {'ally': [], 'enemy': []}
        self.alive_last = {'ally': {}, 'enemy': {}}
        self.stats = {}
        self.labels = {}
        self.states = {}
        self.last_panel = ''
        self.resolve_api()
        self.api_probe('load')
        try:
            events.onPlayersListUpdated(self.on_players_list)
        except Exception as exc:
            log('onPlayersListUpdated failed=' + str(exc)[:120])
        try:
            stream = open(ROSTER_JOURNAL_FILE, 'r')
            seeded = []
            for line in stream.read(2097152).split('\n'):
                if not line:
                    continue
                try:
                    utils.jsonDecode(line)
                    seeded.append(line)
                except Exception:
                    pass  # drop malformed lines from earlier probe builds
            self.journal = seeded
            stream.close()
        except Exception:
            pass
        for name, module in (('battle', battle), ('events', events), ('ui', ui),
                             ('callbacks', callbacks), ('utils', utils)):
            try:
                try:
                    names = sorted(dir(module))
                except Exception:
                    names = sorted(getattr(module, '__dict__', {}).keys())
                log('api ' + name + ' ' + str(names))
            except Exception as exc:
                log('api ' + name + ' dump failed=' + str(exc)[:80])
        try:
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': int(time.time() * 1000), 'phase': 'load'})
        except Exception as exc:
            log('heartbeat write failed=' + str(exc)[:120])
        try:
            # ModsAPI logs an engine error before raising for a missing file;
            # seed the mailbox once so battle ticks do not flood python.log.
            stream = open(MANUAL_FLAG, 'w')
            stream.write('0')
            stream.close()
        except Exception as exc:
            log('flag seed failed=' + str(exc)[:120])
        try:
            self.put('wowspProbe.status', {'message': 'probe ' + PROBE_VERSION + ' loaded', 'version': PROBE_VERSION})
        except Exception as exc:
            log('ui entity create failed=' + str(exc)[:120])
        events.onSFMEvent(self.event)
        events.onBattleQuit(self.quit)
        events.onBattleStart(self.start)
        events.onKeyEvent(self.key_event)
        self.schedule()
        log('probe ' + PROBE_VERSION + ' loaded')

    # -- file bridge ------------------------------------------------------

    def write_json(self, name, data):
        stream = open(name, 'w')
        stream.write(utils.jsonEncode(data) + '\n')
        stream.close()

    def read_json(self, name, limit):
        stream = open(name, 'r')
        raw = stream.read(limit)
        stream.close()
        if len(raw) >= limit or not raw.endswith('\n'):
            return None
        return utils.jsonDecode(raw)

    # -- UI data components (stage-B groundwork) ---------------------------

    def put(self, key, data):
        if key not in self.entities:
            entity = ui.createUiElement()
            ui.addDataComponentWithId(entity, key, data)
            self.entities[key] = entity
        else:
            ui.updateUiElementData(self.entities[key], data)

    # -- battle lifecycle --------------------------------------------------

    def start(self, *args):
        self.last_error = ''
        self.explore_shell('battleStart')
        self.api_probe('battleStart')
        log('battle start')

    # -- panel sides & order come from the per-tick entity walk (see
    # entity_walk): the sortedAlive collections the game's own team lists
    # render from have no Python-side getCollection, so a subscription
    # there can never fire.

    # -- verified ModsShell API access (TeamHP-proven patterns) -------------
    # The loader injects events/ui/utils/battle/callbacks/dataHub/constants
    # straight into the module namespace; imports of them fail harmlessly
    # (TeamHP/Intuitions wrap them in try/except pass), so resolve via
    # globals() and never shadow the injected bindings.

    def resolve_api(self):
        # Bare-name lookup is the only sandbox-safe way: builtins like
        # globals() and eval() are whitelisted away, but injected names
        # resolve normally and missing ones raise catchable NameError.
        try:
            self.dh = dataHub
        except Exception:
            self.dh = None
        try:
            self.const = constants
        except Exception:
            self.const = None
        if self.dh is None:
            try:
                import dataHub as dh_module
                self.dh = dh_module
            except Exception as exc:
                log('dataHub resolve failed=' + str(exc)[:400])
        if self.const is None:
            try:
                import constants as const_module
                self.const = const_module
            except Exception as exc:
                log('constants resolve failed=' + str(exc)[:160])

    def on_players_list(self, *args):
        try:
            self.journal_mark('playersListUpdated')
        except Exception as exc:
            self.soft('players list journal failed=' + str(exc)[:120])

    def api_probe(self, phase):
        if not self.api_dumped:
            self.api_dumped = True
            found = []
            for name, getter in (('events', lambda: events), ('ui', lambda: ui),
                                 ('utils', lambda: utils), ('battle', lambda: battle),
                                 ('callbacks', lambda: callbacks), ('dataHub', lambda: dataHub),
                                 ('constants', lambda: constants)):
                try:
                    getter()
                    found.append(name)
                except Exception:
                    pass
            log('injected names=' + str(found))
            if self.const is not None:
                try:
                    names = [n for n in dir(self.const.UiComponents) if not n.startswith('_')]
                    log('CC names=' + str(sorted(names))[:3800])
                except Exception as exc:
                    log('CC dir failed=' + str(exc)[:120])
            if self.dh is not None:
                try:
                    log('dataHub dir=' + str([n for n in dir(self.dh)
                                              if not n.startswith('_')])[:2000])
                except Exception as exc:
                    log('dataHub dir failed=' + str(exc)[:120])
        log('api[%s] dh=%s const=%s' % (phase, self.dh is not None, self.const is not None))
        # Enumerate which components actually exist on avatar entities; this
        # is the per-player data vocabulary and it only exists in battle.
        if self.dh is None or self.const is None or self.comp_dumped:
            return
        try:
            entities = self.dh.getEntityCollections('avatar')
            counted = 0
            present = {}
            for entity in entities:
                counted += 1
                if self.comp_dumped:
                    break
                try:
                    for comp_name in [n for n in dir(self.const.UiComponents) if not n.startswith('_')]:
                        comp_class = getattr(self.const.UiComponents, comp_name)
                        try:
                            if comp_class in entity:
                                present[comp_name] = True
                        except Exception:
                            pass
                    self.comp_dumped = True
                    log('entity components present=' + str(sorted(present.keys()))[:3000])
                except Exception as exc:
                    log('component enum failed=' + str(exc)[:120])
            log('api[%s] avatar entities=%d' % (phase, counted))
        except Exception as exc:
            log('api[%s] entity collections failed=%s' % (phase, str(exc)[:160]))

    def entity_states(self):
        """Per-avatar live state from entity components (health path is
        TeamHP-proven; enemy values are spotting-dependent per its notes).
        Diagnostics-only since the panel moved to entity_walk()."""
        if self.dh is None or self.const is None:
            return {}
        cc = self.const.UiComponents
        states = {}
        try:
            for entity in self.dh.getEntityCollections('avatar'):
                try:
                    avatar = entity[cc.avatar]
                    name = str(avatar.name)
                except Exception:
                    continue
                row = {}
                try:
                    health = entity[cc.health]
                    row['hp'] = str(health.value) + '/' + str(health.max)
                    row['alive'] = str(bool(health.isAlive))
                except Exception:
                    pass
                try:
                    row['relation'] = str(entity[cc.relation].value)
                except Exception:
                    pass
                states[name] = row
        except Exception as exc:
            self.soft('entity states failed=' + str(exc)[:120])
        return states

    def entity_walk(self):
        """ONE entity walk feeding the panel + telemetry: per-avatar live
        state plus the ally/enemy side split and row order.

        The unbound-side 'team.*.sortedAlive' collections have NO
        Python-side equivalent — the injected dataHub has no getCollection,
        so that subscription failed EVERY battle (observed 2026-09-30
        through 2026-10-01: 'order collection failed'). The side split is
        therefore the TeamHP-proven relation component
        (PlayerRelation.SELF/ALLY = ally, everything else = enemy), and
        the row order is the arena rule: first sighting keeps its spot,
        the dead re-append at the tail.

        Returns (states, sides): states keyed by the BARE name (entity
        names carry the clan tag), sides mapping 'ally'/'enemy' to
        [(name, alive), ...] in walk order. Also latches the SELF avatar's
        bare name onto self.self_name (the identity telemetry reports as
        the local player) — cleared up front so an early return cannot
        leak the previous battle's name.
        """
        self.self_name = ''
        if self.dh is None or self.const is None:
            return {}, {'ally': [], 'enemy': []}
        cc = self.const.UiComponents
        try:
            ally_relations = (self.const.PlayerRelation.SELF, self.const.PlayerRelation.ALLY)
            self_relation = self.const.PlayerRelation.SELF
        except Exception as exc:
            self.soft('PlayerRelation resolve failed=' + str(exc)[:120])
            return {}, {'ally': [], 'enemy': []}
        states = {}
        sides = {'ally': [], 'enemy': []}
        self_name = ''
        try:
            for entity in self.dh.getEntityCollections('avatar'):
                try:
                    name = bare_name(str(entity[cc.avatar].name))
                except Exception:
                    continue
                if not name:
                    continue
                alive = True
                row = {}
                try:
                    health = entity[cc.health]
                    alive = bool(health.isAlive)
                    row['hp'] = str(health.value) + '/' + str(health.max)
                except Exception:
                    pass
                # Death latch (#716): isAlive can flicker back for a tick
                # while the sinking animation settles; random battles have
                # no resurrects — once dead in this battle, stay dead. The
                # latch feeds telemetry, row order AND panel rows from this
                # single point, so a flicker can never resurrect a row.
                if name in self.dead_latch:
                    alive = False
                elif not alive:
                    self.dead_latch.add(name)
                    alive = False
                row['alive'] = str(alive)
                side = 'enemy'
                try:
                    if cc.relation in entity:
                        if entity[cc.relation].value in ally_relations:
                            side = 'ally'
                        if entity[cc.relation].value == self_relation:
                            self_name = name
                    row['relation'] = str(entity[cc.relation].value)
                except Exception:
                    pass
                states[name] = row
                sides[side].append((name, alive))
        except Exception as exc:
            self.soft('entity walk failed=' + str(exc)[:120])
        self.self_name = self_name
        return states, sides

    def merge_order(self, sides):
        """Fold one walk's sides into the panel row order. Alive rows keep
        their relative spots; the dead slide to a tail that preserves
        SINKING order (the previous tail first, then this tick's newly
        dead in their former front order); unseen names append in walk
        order. `self.alive_last` carries each side's previous alive map —
        without it a newly dead row would land by list position instead
        of chronology."""
        if not sides.get('ally') and not sides.get('enemy'):
            # A walk that saw nothing (no dataHub, PlayerRelation failure,
            # a mid-iteration abort) must not fold: empty pairs would
            # promote every dead row back to the front and wipe the sink
            # chronology. The next real walk folds as usual.
            return
        for side, pairs in sides.items():
            alive_now = {}
            for name, alive in pairs:
                if name and name not in alive_now:
                    alive_now[name] = alive
            # A latched name is dead even when its entity vanished from the
            # walk (sunk ships tear down) — without this a vanished wreck
            # would be treated as alive and promoted back to the front.
            for name in self.dead_latch:
                if alive_now.get(name) is not False:
                    alive_now[name] = False
            prev = self.order.get(side, [])
            last = self.alive_last.get(side, {})
            front = [n for n in prev if alive_now.get(n) is not False]
            tail = [n for n in prev if last.get(n) is False and alive_now.get(n) is False]
            tail += [n for n in prev if last.get(n) is not False and alive_now.get(n) is False]
            for name, alive in pairs:
                if name and name not in prev and name not in front and name not in tail:
                    if alive is not False:
                        front.append(name)
                    else:
                        tail.append(name)
            self.order[side] = front + tail
            self.alive_last[side] = alive_now

    def explore_shell(self, phase):
        """Map the wider ModsShell surface real modules expose.

        The injected globals are only the tip: shipped mods import
        ModsShell.API_v_1_0.* gates plus engine namespaces (BigWorld, dh).
        dir() works on these real modules, unlike SafeClass records.
        """
        try:
            from ModsShell.API_v_1_0.dataHub import ComponentClass as CC
            names = [n for n in dir(CC) if not n.startswith('_')]
            log('shell[%s] CC %d names=%s' % (phase, len(names), str(sorted(names))[:3800]))
        except Exception as exc:
            log('shell[%s] CC failed=%s' % (phase, str(exc)[:120]))
        try:
            from dh import DataHubStorage
            hub = DataHubStorage.getDataHub(DataHubStorage.CLIENT_HUB)
            names = [n for n in dir(hub) if not n.startswith('_')]
            log('shell[%s] hub type=%s dir=%s' % (phase, str(type(hub)), str(names)[:2000]))
        except Exception as exc:
            log('shell[%s] hub failed=%s' % (phase, str(exc)[:120]))
        try:
            from ModsShell.API_v_1_0 import battleGate
            names = [n for n in dir(battleGate) if not n.startswith('_')]
            log('shell[%s] battleGate=%s' % (phase, str(names)[:2000]))
        except Exception as exc:
            log('shell[%s] battleGate failed=%s' % (phase, str(exc)[:120]))
        try:
            import BigWorld
            ents = BigWorld.entities
            count = len(ents)
            sample = sorted(ents.keys())[:8]
            log('shell[%s] bigworld entities=%d sampleIds=%s' % (phase, count, str(sample)))
            for eid in sample:
                entity = ents[eid]
                names = [n for n in dir(entity) if not n.startswith('_')]
                if names:
                    log('shell[%s] entity %s type=%s attrs=%s' % (phase, eid, str(type(entity)), str(names)[:1200]))
                    break
        except Exception as exc:
            log('shell[%s] bigworld failed=%s' % (phase, str(exc)[:120]))

    def quit(self, *args):
        self.roster = []
        self.session = ''
        self.previous = None
        self.stable = 0
        self.busy = False
        self.details_reset()
        self.states = {}
        self.clear_players()
        self.last_raw = ''
        self.discovered = False
        self.comp_dumped = False
        self.empty_ticks = 0
        self.dead_latch = set()
        try:
            stream = open(TELEMETRY_FILE, 'w')
            stream.write(utils.jsonEncode({'t': int(time.time() * 1000),
                                           'battle': self.session or '',
                                           'players': {}}) + '\n')
            stream.close()
        except Exception as exc:
            self.soft('telemetry clear failed=' + str(exc)[:120])
        log('battle cleared')

    def details_reset(self):
        self.revision = -1
        self.v_down = False
        # Panel memory too: the entity itself goes away with clear_players,
        # so the change gate must reopen or the next battle's first body
        # (identical text) would be swallowed as "unchanged". The death
        # latch resets per battle as well (both quit and a new stable
        # roster land here).
        self.tab = False
        self.order = {'ally': [], 'enemy': []}
        self.alive_last = {'ally': {}, 'enemy': {}}
        self.dead_latch = set([])
        self.stats = {}
        self.labels = {}
        # The SELF latch rides the same reset story as the rest of the
        # battle state (a new battle must not inherit the previous one's
        # local player).
        self.self_name = ''
        self.last_panel = ''

    def clear_players(self):
        for key in list(self.entities):
            if key != 'wowspProbe.status':
                try:
                    ui.deleteUiElement(self.entities.pop(key))
                except Exception as exc:
                    self.soft('entity delete failed=' + str(exc)[:120])

    def players_raw(self):
        try:
            return battle.getPlayersInfo() or {}
        except Exception as exc:
            self.soft('players error=' + str(exc)[:120])
            return {}

    def players(self, records):
        result = []
        try:
            for key, p in records.items():
                if p['isBot'] or not p['name'] or p['name'].startswith(':'):
                    continue
                try:
                    aid = int(p['accountDBID'])
                except Exception:
                    aid = 0
                # The record carries the player's realm (the game's own
                # roster data — see the design doc's evidence table).
                # Reporting it lets the companion route each row to ITS
                # cluster instead of inferring one realm for the whole
                # battle; '' when a build stops exposing it, and the
                # companion falls back to its detection chain.
                try:
                    realm = str(p['realm'] or '')
                except Exception:
                    realm = ''
                result.append({'name': p['name'], 'account_id': max(0, aid),
                               'avatar_id': int(key), 'ship_id': int(p['shipParamsId']),
                               'realm': realm})
        except Exception as exc:
            self.soft('players error=' + str(exc)[:120])
            return []
        return sorted(result, key=lambda p: p['name'])[:64]

    def journal_mark(self, kind):
        self.journal.append('{"t":' + str(int(time.time() * 1000)) + ',"ev":' + utils.jsonEncode(kind) + '}')
        self.journal_flush()

    def journal_flush(self):
        # The sandbox open() has no append mode (it returns None for 'a'), so
        # the journal is rewritten whole from an in-memory ring buffer.
        del self.journal[:-JOURNAL_LIMIT]
        try:
            stream = open(ROSTER_JOURNAL_FILE, 'w')
            stream.write('\n'.join(self.journal) + '\n')
            stream.close()
        except Exception as exc:
            self.soft('journal flush failed=' + str(exc)[:120])

    def read_field(self, record, key):
        try:
            value = record[key]
        except Exception:
            try:
                value = getattr(record, key)
            except Exception:
                return None
        try:
            if callable(value):
                return None
        except Exception:
            pass
        return str(value)[:48]

    def project_record(self, record):
        """Full JSON encode when possible (keeps every field), else the
        guessed-field projection for records the encoder cannot handle."""
        try:
            return str(utils.jsonEncode(record))[:1200]
        except Exception:
            return dict((k, v) for k, v in ((k, self.read_field(record, k))
                                            for k in GUESS_FIELDS) if v is not None)

    def discover(self, record):
        """One-shot battery: what does a SafeClass record actually expose?"""
        for label, call in (('jsonEncode', lambda: utils.jsonEncode(record)),
                            ('str', lambda: str(record)),
                            ('keys', lambda: list(record.keys())),
                            ('iter', lambda: list(record)),
                            ('dir', lambda: [k for k in dir(record) if not k.startswith('_')])):
            try:
                log('discovery ' + label + '=' + str(call())[:3000])
            except Exception as exc:
                log('discovery ' + label + ' failed=' + str(exc)[:80])
        for field in GUESS_FIELDS:
            value = self.read_field(record, field)
            if value is not None:
                log('discovery field ' + field + '=' + value)

    def observe_raw(self, records):
        """Project roster records plus entity-component state; rewrite
        roster_raw.json on change and append every distinct state to the
        journal so one battle shows the change sequence around TAB re-sorts."""
        try:
            projection = {}
            for key, p in records.items():
                projection[str(key)] = self.project_record(p)
            body = utils.jsonEncode({'players': projection, 'states': self.entity_states()})
            if body != self.last_raw:
                first = self.last_raw == ''
                self.last_raw = body
                stamp = str(int(time.time() * 1000))
                try:
                    stream = open(ROSTER_RAW_FILE, 'w')
                    stream.write('{"t":' + stamp + ',' + body[1:] + '\n')
                    stream.close()
                except Exception as exc:
                    self.soft('roster_raw write failed=' + str(exc)[:120])
                if records and not self.discovered:
                    # First POPULATED snapshot of this battle: document the
                    # schema (the port-empty write must not consume this).
                    self.discovered = True
                    record = records[list(records)[0]]
                    try:
                        self.discover(record)
                    except Exception as exc:
                        log('discovery crashed=' + str(exc)[:120])
                # body starts with '{'; splice it open so the line is one
                # flat object: {"t":...,"players":...,"states":...}
                self.journal.append('{"t":' + stamp + ',' + body[1:])
                self.journal_flush()
        except Exception as exc:
            self.soft('roster_raw failed=' + str(exc)[:120])

    # -- request/response ----------------------------------------------------

    def request(self, manual):
        if not self.session or not self.roster or self.busy or time.time() - self.last_request < 5:
            return
        self.last_request = time.time()
        self.revision = -1
        try:
            self.write_json(REQUEST_FILE, {'version': 1, 'created': self.last_request,
                                           'session': self.session, 'manual': bool(manual),
                                           'players': self.roster})
            # Empty response mailbox: read_json treats a file without the
            # trailing newline as absent, and no engine error is logged for
            # a missing file while the companion has not answered yet.
            stream = open(RESPONSE_FILE, 'w')
            stream.close()
            self.busy = True
            log('request written players=' + str(len(self.roster)) + ' manual=' + str(bool(manual)))
        except Exception as exc:
            self.soft('request write failed=' + str(exc)[:120])

    def read_response(self):
        try:
            data = self.read_json(RESPONSE_FILE, 262145)
            if data is None:
                return
            if data.get('session') != self.session or data.get('revision', -1) <= self.revision:
                return
            rows = data.get('rows', [])
            if not isinstance(rows, list) or len(rows) > 64:
                return
            allowed = set(p['name'] for p in self.roster)
            stats = dict(self.stats)
            for row in rows:
                name = row.get('name', '')
                if not name or name not in allowed:
                    continue
                stats[name] = row
            labels = data.get('labels')
            if isinstance(labels, dict):
                self.labels = labels
            self.stats = stats
            self.revision = data.get('revision', -1)
            self.busy = False
            self.refresh_panel()
            log('response applied revision=' + str(self.revision) + ' rows=' + str(len(rows)))
        except Exception as exc:
            # No response file yet is the normal state while nobody answers.
            self.soft('response read failed=' + str(exc)[:120])

    # -- events ---------------------------------------------------------------

    def event(self, name, data):
        try:
            if name and name not in self.known_events:
                self.known_events.add(name)
                if self.event_log_count < 400:
                    self.event_log_count += 1
                    log('sfm event ' + str(name))
            if name == 'input.tabModeIn' or name == 'input.tabModeOut':
                # The panel's visibility driver: fires <=3 ms after the key
                # and never for Tab typed in battle chat (design-doc-proven).
                visible = name == 'input.tabModeIn'
                if self.tab != visible:
                    self.tab = visible
                    self.refresh_panel()
                self.journal_mark(name)
            if name == 'inputMapping.onAction':
                name, data = data[0], data[1]
            for prefix in ('action.', 'inputMapping.'):
                if name.startswith(prefix):
                    name = name[len(prefix):]
            if name == 'window.hide' and isinstance(data, dict) and data.get('windowName') == 'Battle':
                self.quit()
        except Exception as exc:
            self.soft('event error=' + str(exc)[:120])

    def key_event(self, event):
        try:
            key = event.key
            down = event.isKeyDown()
            if self.key_log_count < 200 and key in (15, 47, 56, 184):
                self.key_log_count += 1
                log('key code=' + str(key) + ' down=' + str(bool(down)) + ' alt=' + str(bool(event.isAltDown())))
            if key != 47:
                return
            if not down:
                self.v_down = False
                return
            if self.v_down:
                return
            self.v_down = True
            if event.isAltDown():
                log('alt+v pressed while session=' + (self.session or 'none'))
        except Exception as exc:
            self.soft('key event error=' + str(exc)[:120])

    # -- scheduler ----------------------------------------------------------

    def schedule(self):
        handle = [0]

        def tick():
            try:
                # cancel is INSIDE the guard: scene teardowns invalidate
                # pending handles, and an exception here used to escape
                # before self.schedule() — silently killing the loop for
                # the rest of the battle (observed 2026-09-30 15:37).
                callbacks.cancel(handle[0])
                self.tick()
            except Exception as exc:
                self.soft('tick error=' + str(exc)[:160])
            self.schedule()
        handle[0] = callbacks.callback(1 if self.session else 2, tick)

    def tick(self):
        records = self.players_raw()
        self.observe_raw(records)
        roster = self.players(records)
        if roster:
            self.empty_ticks = 0
            if roster == self.previous:
                self.stable += 1
            else:
                self.previous = roster
                self.stable = 0
            if self.stable >= 2 and roster != self.roster:
                # First stable sighting of this battle: sample one record for
                # the log so the roster schema is documented where it happens.
                self.clear_players()
                self.roster = roster
                self.dead_latch = set()
                self.session = str(int(time.time() * 1000))
                self.details_reset()
                self.busy = False
                self.last_request = 0
                self.request(False)
                log('roster stable players=' + str(len(roster)) + ' sample=' + utils.jsonEncode(roster[0]))
        elif self.session:
            # A transient empty roster happens MID-BATTLE: the player's own
            # death screen empties getPlayersInfo() for a second or two.
            # Quitting on the first sighting tore the session down mid-
            # battle (clear + rearm churn that killed the scheduler) —
            # require the emptiness to persist before believing it.
            self.empty_ticks += 1
            if self.empty_ticks >= TOOL_CONFIG['panel_fade_ticks']:
                self.quit()
        else:
            self.empty_ticks = 0
        try:
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': int(time.time() * 1000),
                                             'phase': 'battle' if self.session else 'port',
                                             'players': len(self.roster), 'revision': self.revision})
        except Exception as exc:
            self.soft('heartbeat failed=' + str(exc)[:120])
        self.write_telemetry()
        if not self.session:
            return
        try:
            stream = open(MANUAL_FLAG, 'r')
            stamp = stream.read(100)
            stream.close()
            if stamp != self.manual_stamp:
                self.manual_stamp = stamp
                if 0 <= time.time() - float(stamp) < 10:
                    self.request(True)
        except Exception:
            pass
        if self.busy:
            self.read_response()
            if time.time() - self.last_request > 180:
                self.busy = False
                self.soft('response timeout after 180s')

    def write_telemetry(self):
        """The M2 consumer file: name-keyed alive flags for the whole
        roster, rewritten EVERY battle tick (the fresh `t` is the
        heartbeat) — wowsp's 2 s poller then broadcasts once per poll
        whether or not anything sank and whether or not Tab is held, and
        consumers can tell a live stream from a dead one by freshness
        instead of a timeout. Cleared once (empty players) on battle
        quit; port ticks write nothing. The same walk feeds the panel's
        sides + row order (see entity_walk).

        Since the realm-reporting change the payload also carries the
        roster's GROUND-TRUTH identity straight off the game's own
        records — `self` (the local player's bare name + realm, so the
        companion stops inferring the realm from logs/install kind) and
        `identity` (name → {account_id, realm}, so cross-server Clan
        Battles rows resolve on their own cluster with no guessing).
        Both stay in every battle write; consumers treat missing/empty
        values as "probe build predates this" and fall back."""
        if not self.session:
            return
        try:
            states, sides = self.entity_walk()
            # Shared with the panel builder so alive flags + sides cost one
            # entity walk per tick, not two.
            self.states = states
            self.merge_order(sides)
            players = {}
            identity = {}
            for p in self.roster:
                name = p['name']
                row = states.get(name)
                # No entity yet (loading / never spotted-and-gone): alive.
                alive = row is None or row.get('alive') != 'False'
                # Death latch: the isAlive bit can flicker back for a tick
                # while the sinking animation settles. Random battles have
                # no resurrects — once dead in this battle, stay dead.
                if name in self.dead_latch:
                    alive = False
                elif not alive:
                    self.dead_latch.add(name)
                    alive = False
                players[name] = alive
                if p.get('account_id') or p.get('realm'):
                    identity[name] = {'account_id': p.get('account_id', 0),
                                      'realm': p.get('realm', '')}
            self_name = getattr(self, 'self_name', '') or ''
            self_realm = ''
            for p in self.roster:
                if p['name'] == self_name and p.get('realm'):
                    self_realm = p['realm']
                    break
            body = utils.jsonEncode({'t': int(time.time() * 1000),
                                     'battle': self.session,
                                     'players': players,
                                     'self': {'name': self_name, 'realm': self_realm},
                                     'identity': identity})
            stream = open(TELEMETRY_FILE, 'w')
            stream.write(body + '\n')
            stream.close()
        except Exception as exc:
            self.soft('telemetry failed=' + str(exc)[:120])
        self.refresh_panel()

    # -- in-game panel -------------------------------------------------------
    # One data component ('wowspProbe.panel') carries the whole template's
    # payload: visibility (Tab held), both sides' rows in walk order with
    # the answered stats merged in, and the companion's column labels.
    # Everything visible is decided HERE (formatting, colors) so the unbound
    # view stays a dumb template that cannot rot per game version.

    def wr_color(self, wr):
        # ARGB values, same form the unbound template literals use. Bands
        # mirror the overlay page's winrate coloring.
        if not isinstance(wr, (int, float)):
            return 0xB4FFFFFF  # translucent white (no data)
        if wr >= 53:
            return 0xFF66FF66  # green
        if wr >= 50:
            return 0xFFFFEE66  # pale yellow
        if wr >= 45:
            return 0xFFFF9933  # orange
        return 0xFFFF5555      # red

    def pr_color(self, pr):
        if not isinstance(pr, (int, float)):
            return 0xB4FFFFFF
        if pr >= 1700:
            return 0xFFCC66FF  # purple
        if pr >= 1450:
            return 0xFF66FF66  # green
        if pr >= 1150:
            return 0xFFFFEE66  # pale yellow
        return 0xFFCBBBBC      # grey

    def panel_rows(self, side):
        rows = []
        for name in self.order.get(side, []):
            if not name:
                continue
            state = self.states.get(name)
            # Latched names are dead even with their entity gone.
            alive = name not in self.dead_latch and (
                state is None or state.get('alive') != 'False')
            row = self.stats.get(name)
            wr = row.get('wr') if isinstance(row, dict) else None
            pr = row.get('pr') if isinstance(row, dict) else None
            rows.append({'name': name,
                         'wr': ('%.1f%%' % wr) if isinstance(wr, (int, float)) else '--',
                         'pr': str(int(pr)) if isinstance(pr, (int, float)) else '--',
                         'alive': alive,
                         'wrColor': self.wr_color(wr),
                         'prColor': self.pr_color(pr)})
        return rows

    def refresh_panel(self):
        if not self.session:
            return
        try:
            ally = self.panel_rows('ally')
            enemy = self.panel_rows('enemy')
            data = {'visible': bool(self.tab and (ally or enemy)),
                    'ally': ally,
                    'enemy': enemy,
                    'labels': self.labels}
            body = utils.jsonEncode(data)
            if body == self.last_panel:
                return
            self.last_panel = body
            self.put(PANEL_KEY, data)
        except Exception as exc:
            self.soft('panel failed=' + str(exc)[:120])

    def soft(self, message):
        # Deduplicated soft logging: a repeating error should appear once.
        if message != self.last_error:
            log(message)
            self.last_error = message


probe = Probe()
