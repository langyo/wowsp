# -*- coding: utf-8 -*-
"""WoWSP in-game bridge probe (stage-A experiment).

Runs inside the game client via the WG Mods API (PnFMods loader). The
sandbox has no networking, so this probe only observes and bridges:
everything it learns goes to python.log (prefix WOWSP_PROBE) and to flat
JSON files next to this Main.py. The wowsp companion process is expected
to read request.json and write response.json back.

Product direction under test: the mod renders NOTHING in game. It is a
precision telemetry source - while the transparent overlay window keeps
doing the display, the mod feeds it the exact live ordering of the TAB
team table (priority: mod telemetry > screen-capture inference > static
roster order). No unbound overrides means no per-game-version UI copies.

What this version measures:
  1. load + heartbeat (heartbeat.json, phase port/battle),
  2. the full raw schema of battle.getPlayersInfo() (roster_raw.json,
     rewritten whenever any projected field changes - diff consecutive
     writes during a battle to see which fields drive the TAB re-sort),
  3. the sandbox API surface (dir() of every injected module, once),
  4. request/response file bridge + Tab/Alt/V key events,
  5. ui.createUiElement data components (later UI groundwork).

Keep the syntax conservative (no f-strings, 3.6-level) and never let an
exception escape a callback: the game keeps running but the mod dies.
"""
API_VERSION = 'API_v1.0'

PROBE_VERSION = '0.2.3'
PREFIX = 'WOWSP_PROBE '
HEARTBEAT_FILE = 'heartbeat.json'
REQUEST_FILE = 'request.json'
RESPONSE_FILE = 'response.json'
MANUAL_FLAG = 'manual_refresh.flag'
ROSTER_RAW_FILE = 'roster_raw.json'
ROSTER_JOURNAL_FILE = 'roster_journal.jsonl'
JOURNAL_LIMIT = 300

# SafeClass records hide their keys from dir(); probe likely field names so
# the projection works even when no enumeration path succeeds.
GUESS_FIELDS = ('name', 'accountDBID', 'shipParamsId', 'isBot', 'teamId', 'id',
                'vehicleId', 'shipId', 'shipName', 'score', 'frags', 'kills',
                'deaths', 'damageDealt', 'isAlive', 'isHidden', 'isTeamKiller',
                'clanAbbrev', 'clanID', 'level', 'relation', 'planeKills',
                'maxHealth', 'currHealth')

import time


def log(message):
    utils.logInfo(PREFIX + message)


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
        try:
            stream = open(ROSTER_JOURNAL_FILE, 'r')
            self.journal = [line for line in stream.read(2097152).split('\n') if line]
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
        log('battle start')

    def quit(self, *args):
        self.roster = []
        self.session = ''
        self.previous = None
        self.stable = 0
        self.busy = False
        self.details_reset()
        self.clear_players()
        self.last_raw = ''
        self.discovered = False
        log('battle cleared')

    def details_reset(self):
        self.revision = -1
        self.v_down = False

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
                result.append({'name': p['name'], 'account_id': max(0, aid),
                               'avatar_id': int(key), 'ship_id': int(p['shipParamsId'])})
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
        """Project every record and rewrite roster_raw.json on change; also
        append every distinct state to the journal so one battle shows the
        field-change sequence around TAB re-sorts and sinks."""
        try:
            projection = {}
            for key, p in records.items():
                projection[str(key)] = self.project_record(p)
            body = utils.jsonEncode(projection)
            if body != self.last_raw:
                first = self.last_raw == ''
                self.last_raw = body
                stamp = str(int(time.time() * 1000))
                try:
                    stream = open(ROSTER_RAW_FILE, 'w')
                    stream.write('{"t":' + stamp + ',"players":' + body + '}\n')
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
                self.journal.append('{"t":' + stamp + ',"players":' + body + '}')
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
            for row in rows:
                name = row.get('name', '')
                if not name or name not in allowed:
                    continue
                self.put('wowspProbe.player.' + name, row)
            self.revision = data.get('revision', -1)
            self.busy = False
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
            callbacks.cancel(handle[0])
            try:
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
                self.session = str(int(time.time() * 1000))
                self.details_reset()
                self.busy = False
                self.last_request = 0
                self.request(False)
                log('roster stable players=' + str(len(roster)) + ' sample=' + utils.jsonEncode(roster[0]))
        elif self.session:
            self.quit()
        try:
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': int(time.time() * 1000),
                                             'phase': 'battle' if self.session else 'port',
                                             'players': len(self.roster), 'revision': self.revision})
        except Exception as exc:
            self.soft('heartbeat failed=' + str(exc)[:120])
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

    def soft(self, message):
        # Deduplicated soft logging: a repeating error should appear once.
        if message != self.last_error:
            log(message)
            self.last_error = message


probe = Probe()
