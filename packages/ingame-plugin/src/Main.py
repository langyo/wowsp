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
    come from the per-tick relation walk (entity_walk); the row order
    follows the client's OWN TAB sort keys when the ship-component probe
    delivers them (sort_key_probe), else the walk's arena rule. No
    companion answer means no panel - the transparent-overlay view mode
    simply never turns the bridge on.

Still measured for diagnostics:
  1. load + heartbeat (heartbeat.json, phase port/battle),
  2. the full raw schema of battle.getPlayersInfo() (roster_raw.json),
  3. the sandbox API surface (dir() of every injected module, once),
  4. request/response file bridge + Tab/Alt/V key events.

Keep the syntax conservative (no f-strings, 3.6-level) and never let an
exception escape a callback: the game keeps running but the mod dies.
Never name an exception class in an `except` clause either — Lesta's
ModsAPI sandbox omits the exception classes from its builtin whitelist,
so `except Exception:` itself raises NameError there; handlers must use
bare `except:` (with `_exc_text` for the message).

Stronger still: the CORE paths (roster projection, request/telemetry
writes, the panel payload) never look up a builtin name at all —
%-formatting, bound methods, comprehensions and `__dict__` access carry
them, so a whitelist that also drops `str`/`int`/`sorted`/`dir`/`getattr`
cannot empty the roster. `len`/`open` and the `True`/`False` constants
(builtin globals on py2.7) are the only builtins the shipped file still
resolves by name — all live-proven on Lesta since the first shipped
revision — and a census line reports them at import. `import time` is
the sole imported module. `scripts/check_ingame_plugin.py`
proves this offline: it execs this file under a crippled builtins set
and drives a full battle — run it on every change here.
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
    # dict.copy() is a bound method — no `dict(...)` name lookup on the
    # import path (the harness proves the crippled-builtins run).
    cfg = CONFIG_DEFAULTS.copy()
    try:
        # Relative open only — no `os`, no `__file__`: the PnFMods loader
        # runs mods with their own directory as the CWD (every bridge file
        # in this mod relies on that convention), while `import os` and
        # `__file__` are not resolvable in every client's sandbox (Lesta's
        # ModsAPI whitelists imports/builtins selectively — the 2026-10-08
        # import crash chain started exactly here).
        with open('../../wowsp.toml', 'r') as handle:
            body = handle.read()
        header = '[tools."battle.ingame.stats"]'
        lines = body.splitlines()
        # Indexed walk by hand: `range`/`enumerate` are builtin NAMES the
        # Lesta whitelist may withhold, and a bare except would silently
        # drop the table (the old code did exactly that).
        total = len(lines)
        idx = 0
        found = False
        while idx < total:
            if lines[idx].strip() == header:
                found = True
                break
            idx += 1
        if found:
            pos = idx + 1
            while pos < total:
                stripped = lines[pos].strip()
                pos += 1
                if stripped.startswith('['):
                    break  # next table — ours ended
                if '=' not in stripped or stripped.startswith('#'):
                    continue
                key, _, raw = stripped.partition('=')
                key = key.strip()
                raw = raw.split('#', 1)[0].strip()
                if key in CONFIG_DEFAULTS and raw.lstrip('-').isdigit():
                    cfg[key] = _to_int(raw)
    except:
        pass
    return cfg


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


# ── sandbox-proof primitives ────────────────────────────────────────────
# The Lesta ModsAPI sandbox resolves builtins through a whitelist that
# omits the class AND reflection machinery wholesale: `Exception` and
# `object` each killed the mod at import (2026-10-08), and a missing
# `str`/`int`/`sorted`/`isinstance` would silently empty the roster path
# these helpers replace. Everything below is pure syntax and protocol
# access — %-formatting is a C-level bytecode operation, `.index`/`.sort`/
# `.copy` are bound methods, subscript/attribute lookups need no names —
# so the core paths keep working under ANY builtin subset.
_DIGITS = '0123456789'


def _fmt(value):
    """`str(value)` without the builtin: %s-formatting never looks a
    name up in `__builtins__`."""
    try:
        return '%s' % (value,)
    except:
        return '?'


def _json_string(value):
    """JSON string literal for one bridge value (nickname, key).

    Primary path: the client's own utils.jsonEncode on the bare value —
    its escaping is the exact table the game's own jsonDecode expects
    (astral-char nicknames included). Fallback (the encoder has
    build-dependent quirks — 15.9 raised on payloads 15.8 accepted, live
    2026-10-09): a char-loop that quotes, backslash-escapes and DROPS
    control characters (raw control bytes would break the JSON; dropping
    one pathological nickname character beats losing the whole payload).
    """
    try:
        return utils.jsonEncode(value)
    except:
        pass
    try:
        chars = value.decode('utf-8')
    except:
        chars = value
    out = ['"']
    for ch in chars:
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        elif ch < ' ':
            pass
        else:
            out.append(ch)
    out.append('"')
    # utf-8 bytes flow through unchanged; a unicode text encodes to utf-8
    # (a lone surrogate raises — return it raw and let the file write's own
    # guard degrade).
    text = ''.join(out)
    try:
        return text.encode('utf-8')
    except:
        return text


def _json_encode(value):
    """Minimal JSON writer for the bridge payload shapes (dicts, lists,
    tuples, str/unicode, int/long/bool, None) — the same vocabulary
    utils.jsonEncode serves, without touching a single builtin name.
    Anything outside the shapes degrades to a quoted string (parseable,
    type-loose) so one odd value can never kill the file write."""
    try:
        pairs = value.items()
    except:
        pairs = None
    if pairs is not None:
        parts = []
        for key, item in pairs:
            try:
                parts.append(_json_string(key) + ':' + _json_encode(item))
            except:
                continue
        return '{' + ','.join(parts) + '}'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if value is None:
        return 'null'
    # Strings BEFORE numbers: py2's %d accepts digit strings, and the
    # bridge's 'session' value is ALWAYS a digit string — a number-typed
    # session would make the app's strict serde parse skip the whole
    # stats cycle for the battle.
    try:
        probe = value + ''
    except:
        probe = None
    if probe is not None:
        return _json_string(value)
    try:
        return '%d' % (value,)
    except:
        pass
    parts = []
    try:
        for item in value:
            parts.append(_json_encode(item))
    except:
        return _json_string(_fmt(value))
    return '[' + ','.join(parts) + ']'


def json_encode_safe(value):
    """utils.jsonEncode with the hand-rolled writer as the fallback —
    the bridge files (telemetry first) must flow even when the client's
    own encoder raises on a payload shape it used to accept."""
    try:
        return utils.jsonEncode(value)
    except:
        return _json_encode(value)


def _parse_int(s):
    """Digit-string -> int by hand (sign honoured, surrounding blanks
    tolerated, junk -> 0)."""
    s = s.strip()
    neg = s[:1] == '-'
    if neg or s[:1] == '+':
        s = s[1:]
    n = 0
    for ch in s:
        try:
            d = _DIGITS.index(ch)
        except:
            return 0
        n = n * 10 + d
    return -n if neg else n


def _to_int(value):
    """`int(value)` without the builtin: %d formats int/long/bool and
    truncates floats exactly like int() (and, on py2, even accepts digit
    strings); anything else falls back to the %s form."""
    try:
        return _parse_int('%d' % (value,))
    except:
        pass
    try:
        return _parse_int(('%s' % (value,)).strip())
    except:
        return 0


def _to_float(value):
    """`float(value)` without the builtin — enough for timestamp strings
    and numbers ('12.5', u'12.5', 12, 12.5, '-3.25'); junk -> 0.0.
    Known divergences from float(), none reachable at the one call site
    (a seconds-since-epoch flag stamp): bool -> 0.0, exponents/NaN/inf
    -> 0.0, a second dot is tolerated."""
    try:
        text = ('%s' % (value,)).strip()
        whole, _, frac = text.partition('.')
        base = _to_int(whole)
        if not frac:
            return base * 1.0
        scale = 1
        for _ in frac:
            scale = scale * 10
        part = (_to_int(frac) * 1.0) / scale
        # The sign lives on the whole part: -3.25 is -3 MINUS .25.
        if text[:1] == '-':
            return base - part
        return base + part
    except:
        return 0.0


def _is_kind(value, *names):
    """Class-name probe without `isinstance`/`object`. Exact class names
    only — subclasses of dict/list would not match where isinstance did;
    callers feed it codec-produced containers (exact dict/list), so the
    difference is unreachable."""
    try:
        return value.__class__.__name__ in names
    except:
        return False


def _is_num(value):
    """Number probe without `isinstance`: for int/long/float (and bool)
    `value + 0 == value`; strings concatenate or raise, everything else
    raises or compares unequal. Divergences kept in mind: py2 long and
    complex pass, NaN fails — callers only see numbers their own codec
    produced (jsonDecode rows, jsonEncode echoes)."""
    try:
        return value + 0 == value
    except:
        return False


def _is_callable(value):
    """`callable(value)` without the builtin."""
    try:
        value.__call__
        return True
    except:
        return False


def _public_names(obj):
    """Diagnostic name enumeration without `dir`/`sorted`: `__dict__` is
    plain attribute access and list.sort is a bound method. Drops
    INHERITED names `dir()` used to include — diagnostics only, and the
    namespaces this walks (injected modules, component classes) keep
    their API in their own __dict__."""
    try:
        names = [n for n in obj.__dict__]
    except:
        try:
            names = [n for n in obj]
        except:
            return []
    names = [n for n in names if not n.startswith('_')]
    names.sort()
    return names


def _has_builtin(table, name):
    """Membership probe for the census: `__builtins__` is a dict on some
    builds and a module on others."""
    try:
        return name in table
    except:
        try:
            return name in table.__dict__
        except:
            return False


def _exc_text(limit):
    """Sandbox-safe current-exception text.

    Lesta's ModsAPI sandbox omits the exception classes from its builtins:
    the NAME `Exception` itself raises NameError the first time any
    handler evaluates (2026-10-08: the mod died at import that way,
    silencing telemetry, the in-game panel and the roster files for every
    Lesta battle). Bare `except:` needs no name, and the live exception
    still reaches this helper via sys.exc_info() when the sandbox allows
    the import.
    """
    try:
        import sys
        return ('%s' % (sys.exc_info()[1],))[:limit]
    except:
        return '?'


# Deliberately AFTER the helper block: `load_tool_config` calls `_to_int`,
# and name resolution happens at CALL time — while this statement ran
# above the helpers, the NameError was swallowed by the loader's bare
# except and res_mods/wowsp.toml was silently ignored (caught by the
# round-2 review; the harness now pins it with a planted wowsp.toml).
TOOL_CONFIG = load_tool_config()
JOURNAL_LIMIT = TOOL_CONFIG['journal_limit']


def log(message):
    utils.logInfo(PREFIX + message)


def bare_name(name):
    """Avatar-entity names carry the clan tag ('[RCCK]Laneigedc') while
    roster names (the stats/telemetry keys) are bare — strip the tag."""
    return name.split(']', 1)[-1] if name.startswith('[') else name


# One-shot sandbox census: Lesta's ModsAPI resolves builtins through a
# narrow whitelist that omits the class machinery (both `Exception` and
# `object` crashed the mod at import in the field — 2026-10-08). Dump the
# reachable names AND whether the handful the legacy paths still use are
# present, so any remaining gap is diagnosable from python.log alone.
# Pure syntax + bare excepts: no `list`, no `dir`, no `sorted`.
try:
    _bi = __builtins__
    _names = []
    try:
        for _n in _bi.keys():
            _names.append(_fmt(_n))
    except:
        try:
            for _n in _bi.__dict__:
                _names.append(_fmt(_n))
        except:
            pass
    # The survivors the shipped file still resolves by NAME: `len`/`open`
    # (protocol primitives with no pure-syntax substitute), `True`/`False`
    # (builtin globals on the game's py2.7 — LOAD_GLOBAL, not compiler
    # constants as on py3; the plugin has used them since the first
    # shipped revision, so they are live-proven present, but the census
    # names them so a crippled host is diagnosable at a glance).
    _miss = [n for n in ('len', 'open', 'True', 'False') if not _has_builtin(_bi, n)]
    _miss_mod = [n for n in ('ui',) if not _has_builtin(_bi, n)]
    utils.logInfo(PREFIX + 'sandbox builtins=' + _fmt(_names)
                  + ' legacy_missing=' + _fmt(_miss)
                  + ' module_missing=' + _fmt(_miss_mod))
except:
    try:
        utils.logInfo(PREFIX + 'sandbox census failed')
    except:
        pass


# Lesta's ModsAPI injects no `ui` module at all (live census 2026-10-08:
# events/utils/battle/callbacks/dataHub/constants yes, `ui` no). Resolve it
# ONCE here behind a guard so every panel path checks a plain value instead
# of naming `ui` (the eager name reference in __init__'s diagnostic tuple
# was the crash that killed the mod at load).
try:
    _UI = ui
except:
    _UI = None


class Probe:
    # Old-style on purpose: `object` is not in the Lesta sandbox's
    # builtin whitelist (`class Probe(object)` was the 2026-10-08 14:04
    # import crash, one fix past the Exception one). Nothing here needs
    # new-style machinery — no super(), no properties.

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
        # {…} - {…} instead of set([]): set literals/differences compile
        # to display + arithmetic opcodes, so the Lesta sandbox's builtin
        # whitelist is never consulted for the empty-set construction.
        self.known_events = {None} - {None}
        self.event_log_count = 0
        self.key_log_count = 0
        self.v_down = False
        self.last_raw = ''
        self.latest_raw = {}
        self.raw_isalive_seen = False
        self.discovered = False
        self.journal = []
        self.empty_ticks = 0
        self.dead_latch = {None} - {None}
        self.dh = None
        self.const = None
        # False = not yet resolved; None = resolution failed (see _cc).
        self.cc_cache = False
        self.api_dumped = False
        self.comp_dumped = False
        # In-game panel state: Tab visibility, the two sides' TAB order,
        # the answered stats rows keyed by name, the companion's column
        # labels, the freshest entity states (shared with the telemetry
        # writer) and the last panel body (change gate for the UI update).
        self.tab = False
        self.order = {'ally': [], 'enemy': []}
        self.alive_last = {'ally': {}, 'enemy': {}}
        self.sort_keys = {}
        self.stats = {}
        self.labels = {}
        self.states = {}
        self.last_panel = ''
        self.resolve_api()
        self.api_probe('load')
        try:
            events.onPlayersListUpdated(self.on_players_list)
        except:
            log('onPlayersListUpdated failed=' + _exc_text(120))
        try:
            stream = open(ROSTER_JOURNAL_FILE, 'r')
            seeded = []
            for line in stream.read(2097152).split('\n'):
                if not line:
                    continue
                try:
                    utils.jsonDecode(line)
                    seeded.append(line)
                except:
                    pass  # drop malformed lines from earlier probe builds
            self.journal = seeded
            stream.close()
        except:
            pass
        # Lazy getters on purpose: building a tuple of bare names evaluates
        # ALL of them before the first handler runs, and Lesta's ModsAPI
        # injects no `ui` module (census 2026-10-08) — the eager tuple
        # raised NameError straight out of __init__ and killed the whole
        # mod at load. Each getter resolves inside its own guard now.
        for name, getter in (('battle', lambda: battle), ('events', lambda: events),
                             ('ui', lambda: _UI), ('callbacks', lambda: callbacks),
                             ('utils', lambda: utils)):
            try:
                log('api ' + name + ' ' + _fmt(_public_names(getter())))
            except:
                log('api ' + name + ' dump failed=' + _exc_text(80))
        try:
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': _to_int(time.time() * 1000), 'phase': 'load'})
        except:
            log('heartbeat write failed=' + _exc_text(120))
        try:
            # ModsAPI logs an engine error before raising for a missing file;
            # seed the mailbox once so battle ticks do not flood python.log.
            stream = open(MANUAL_FLAG, 'w')
            stream.write('0')
            stream.close()
        except:
            log('flag seed failed=' + _exc_text(120))
        try:
            self.put('wowspProbe.status', {'message': 'probe ' + PROBE_VERSION + ' loaded', 'version': PROBE_VERSION})
        except:
            log('ui entity create failed=' + _exc_text(120))
        events.onSFMEvent(self.event)
        events.onBattleQuit(self.quit)
        events.onBattleStart(self.start)
        events.onKeyEvent(self.key_event)
        self.schedule()
        log('probe ' + PROBE_VERSION + ' loaded')

    # -- file bridge ------------------------------------------------------

    def write_json(self, name, data):
        stream = open(name, 'w')
        stream.write(json_encode_safe(data) + '\n')
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
        if _UI is None:
            # No `ui` module on this client (Lesta): the in-game panel is
            # unavailable — a silent no-op, not an error.
            return
        try:
            if key not in self.entities:
                entity = _UI.createUiElement()
                _UI.addDataComponentWithId(entity, key, data)
                self.entities[key] = entity
            else:
                _UI.updateUiElementData(self.entities[key], data)
        except:
            self.soft('ui put failed=' + _exc_text(80))

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
        except:
            self.dh = None
        try:
            self.const = constants
        except:
            self.const = None
        if self.dh is None:
            try:
                import dataHub as dh_module
                self.dh = dh_module
            except:
                log('dataHub resolve failed=' + _exc_text(400))
        if self.const is None:
            try:
                import constants as const_module
                self.const = const_module
            except:
                log('constants resolve failed=' + _exc_text(160))

    def on_players_list(self, *args):
        try:
            self.journal_mark('playersListUpdated')
        except:
            self.soft('players list journal failed=' + _exc_text(120))

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
                except:
                    pass
            log('injected names=' + _fmt(found))
            if self.const is not None:
                try:
                    names = _public_names(self.const.UiComponents)
                    log('CC names=' + _fmt(names)[:3800])
                except:
                    log('CC dir failed=' + _exc_text(120))
            if self.dh is not None:
                try:
                    log('dataHub dir=' + _fmt(_public_names(self.dh))[:2000])
                except:
                    log('dataHub dir failed=' + _exc_text(120))
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
                    for comp_name in _public_names(self.const.UiComponents):
                        # __dict__ subscript: comp_name came from
                        # _public_names (i.e. IS a __dict__ key) — no getattr.
                        comp_class = self.const.UiComponents.__dict__[comp_name]
                        try:
                            if comp_class in entity:
                                present[comp_name] = True
                        except:
                            pass
                    self.comp_dumped = True
                    log('entity components present=' + _fmt(present.keys())[:3000])
                except:
                    log('component enum failed=' + _exc_text(120))
            log('api[%s] avatar entities=%d' % (phase, counted))
        except:
            log('api[%s] entity collections failed=%s' % (phase, _exc_text(160)))

    def _cc(self):
        """UiComponents resolved ONCE behind a guard. On Lesta the
        constants module RAISES on this attribute (live 2026-10-08:
        'CC dir failed=?' at load, then roster_raw.json and telemetry.json
        failing every tick) — the bare `cc = self.const.UiComponents` sat
        OUTSIDE the entity walks' guards, so the exception skipped both
        file writes while request/heartbeat/journal kept flowing and the
        companion never got its roster. None = the entity walks stand
        down and the records-driven paths (teamId relations, the roster
        records' own isAlive) carry the battle alone."""
        if self.cc_cache is False:
            self.cc_cache = None
            try:
                self.cc_cache = self.const.UiComponents
            except:
                log('UiComponents unavailable - entity walks disabled, records carry the battle')
        return self.cc_cache

    def entity_states(self):
        """Per-avatar live state from entity components (health path is
        TeamHP-proven; enemy values are spotting-dependent per its notes).
        Diagnostics-only since the panel moved to entity_walk()."""
        cc = self._cc()
        if cc is None or self.dh is None or self.const is None:
            return {}
        states = {}
        try:
            for entity in self.dh.getEntityCollections('avatar'):
                try:
                    avatar = entity[cc.avatar]
                    name = _fmt(avatar.name)
                except:
                    continue
                row = {}
                try:
                    health = entity[cc.health]
                    row['hp'] = _fmt(health.value) + '/' + _fmt(health.max)
                    row['alive'] = 'True' if health.isAlive else 'False'
                except:
                    pass
                try:
                    row['relation'] = _fmt(entity[cc.relation].value)
                except:
                    pass
                states[name] = row
        except:
            self.soft('entity states failed=' + _exc_text(120))
        return states

    def sort_key_probe(self):
        """The game's OWN per-player TAB sort keys, constants-free.

        ShipSystem.add writes the client's Tab key onto every ship
        component — str(SORT_ORDER.index(subtype)) + str(100 - level)
        + str(NATION.SORT_ORDER.index(nation)) + shortName (decompiled
        build 13357625; Lesta's live keys carry its own nation table —
        russia FIRST — and an internal shortName code, observed
        2026-10-10). The client's Tab table sorts by that key — the
        WG family appends the avatar name (__sortKeyAlive: ship.sortKey
        + component.name) while Lesta breaks EQUAL keys by the roster's
        own order (live 2026-10-10) — so the panel fold below sorts by
        the keys alone, stable. CN's HUD renders a different order
        altogether (its scripts still compute these keys); the companion
        stands the override down there.

        The path avoids UiComponents/imports entirely (Lesta raises on
        the constants attribute and omits every ModsShell import — both
        live-proven 2026-10-08/09), duck-typing the components off the
        two SYNCED collections the ModAPI dataHub serves by NAME:
        'avatar' entries carry the real Avatar component (its `.ship`
        slot is an Entity reference to the player's ship entity), and
        'ship' entries carry the real Ship component (`.sortKey`). The
        reference's entity id matches the ship collection's entry id.

        Returns {bare name: sortKey} for every avatar the walk can pair
        with a ship; any shape change or withholding degrades to {} and
        the companion falls back to its offline per-realm inference.
        """
        keys = {}
        if self.dh is None:
            return keys
        ship_by_id = {}
        try:
            for ent in self.dh.getEntityCollections('ship'):
                try:
                    sid = _to_int(ent.id)
                except:
                    continue
                try:
                    for comp in ent.components.values():
                        try:
                            key = comp.sortKey
                        except:
                            continue
                        if key:
                            ship_by_id[sid] = _fmt(key)
                            break
                except:
                    continue
        except:
            self.soft('ship collection failed=' + _exc_text(120))
            return keys
        if not ship_by_id:
            return keys
        try:
            for ent in self.dh.getEntityCollections('avatar'):
                try:
                    name = ''
                    ref_id = 0
                    for comp in ent.components.values():
                        try:
                            ref = comp.ship.ref
                        except:
                            continue
                        if ref is None:
                            continue
                        try:
                            name = bare_name(_fmt(comp.name))
                            ref_id = _to_int(ref.id)
                        except:
                            continue
                        break
                    if not name or not ref_id:
                        continue
                    key = ship_by_id.get(ref_id)
                    if key:
                        keys[name] = key
                except:
                    continue
        except:
            self.soft('avatar pairing failed=' + _exc_text(120))
        return keys

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
        cc = self._cc()
        if cc is None or self.dh is None or self.const is None:
            return {}, {'ally': [], 'enemy': []}
        try:
            ally_relations = (self.const.PlayerRelation.SELF, self.const.PlayerRelation.ALLY)
            self_relation = self.const.PlayerRelation.SELF
        except:
            self.soft('PlayerRelation resolve failed=' + _exc_text(120))
            return {}, {'ally': [], 'enemy': []}
        states = {}
        sides = {'ally': [], 'enemy': []}
        self_name = ''
        try:
            for entity in self.dh.getEntityCollections('avatar'):
                try:
                    name = bare_name(_fmt(entity[cc.avatar].name))
                except:
                    continue
                if not name:
                    continue
                alive = True
                row = {}
                try:
                    health = entity[cc.health]
                    alive = True if health.isAlive else False
                    row['hp'] = _fmt(health.value) + '/' + _fmt(health.max)
                except:
                    pass
                # Death latch (#716): isAlive can flicker back for a tick
                # while the sinking animation settles; random battles have
                # no resurrects — once dead in this battle, stay dead. The
                # latch is SET in write_telemetry (where the game's own
                # roster record confirms the death) and only HONORED here:
                # this walk's read is deliberately NOT strong enough to
                # latch on alone — a single doubting read of a one-way
                # latch marks a player dead for the whole battle, and the
                # walk reads a live component over changing entities (the
                # record is the game's own verdict).
                if name in self.dead_latch:
                    alive = False
                row['alive'] = 'True' if alive else 'False'
                side = 'enemy'
                try:
                    if cc.relation in entity:
                        if entity[cc.relation].value in ally_relations:
                            side = 'ally'
                        if entity[cc.relation].value == self_relation:
                            self_name = name
                    row['relation'] = _fmt(entity[cc.relation].value)
                except:
                    pass
                states[name] = row
                sides[side].append((name, alive))
        except:
            self.soft('entity walk failed=' + _exc_text(120))
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
            # The client's OWN alive-block order: sort the front by the
            # ship components' sortKey ALONE, stable — the live 2026-10-10
            # Lesta capture showed the client breaks EQUAL keys by the
            # roster's own order, not the '+ name' concatenation the WG
            # decompile appends (two same-key Turenne rows, a human and a
            # ':bot:', rendered in record order; the name tie would put
            # the bot's ':' first and swap them). Equal keys therefore
            # keep the fold's incoming order here (the walk order — the
            # roster order's stand-in). Applied only when EVERY front
            # name carries a key; any gap keeps the walk order outright
            # (game-true and walk-order rows must not interleave). The
            # tail keeps its sinking chronology either way — the
            # friendlier in-game panel read (the client's own dead block
            # re-sorts by key; documented as the panel's one cosmetic
            # difference).
            keys = {}
            for nm in front:
                key = self.sort_keys.get(nm)
                if not key:
                    keys = None
                    break
                keys[nm] = key
            if keys and len(front) > 1:
                front.sort(key=lambda nm: keys[nm])
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
            names = _public_names(CC)
            log('shell[%s] CC %d names=%s' % (phase, len(names), _fmt(names)[:3800]))
        except:
            log('shell[%s] CC failed=%s' % (phase, _exc_text(120)))
        try:
            from dh import DataHubStorage
            hub = DataHubStorage.getDataHub(DataHubStorage.CLIENT_HUB)
            names = _public_names(hub)
            log('shell[%s] hub type=%s dir=%s' % (phase, _fmt(hub.__class__), _fmt(names)[:2000]))
        except:
            log('shell[%s] hub failed=%s' % (phase, _exc_text(120)))
        try:
            from ModsShell.API_v_1_0 import battleGate
            names = _public_names(battleGate)
            log('shell[%s] battleGate=%s' % (phase, _fmt(names)[:2000]))
        except:
            log('shell[%s] battleGate failed=%s' % (phase, _exc_text(120)))
        try:
            import BigWorld
            ents = BigWorld.entities
            count = len(ents)
            sample = [eid for eid in ents][:8]
            log('shell[%s] bigworld entities=%d sampleIds=%s' % (phase, count, _fmt(sample)))
            for eid in sample:
                entity = ents[eid]
                names = _public_names(entity)
                if names:
                    log('shell[%s] entity %s type=%s attrs=%s' % (phase, eid, _fmt(entity.__class__), _fmt(names)[:1200]))
                    break
        except:
            log('shell[%s] bigworld failed=%s' % (phase, _exc_text(120)))

    def quit(self, *args):
        self.roster = []
        self.latest_raw = {}
        self.raw_isalive_seen = False
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
        self.dead_latch = {None} - {None}
        try:
            stream = open(TELEMETRY_FILE, 'w')
            stream.write(json_encode_safe({'t': _to_int(time.time() * 1000),
                                           'battle': self.session or '',
                                           'players': {}}) + '\n')
            stream.close()
        except:
            self.soft('telemetry clear failed=' + _exc_text(120))
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
        self.sort_keys = {}
        self.dead_latch = {None} - {None}
        self.raw_isalive_seen = False
        self.stats = {}
        self.labels = {}
        # The SELF latch rides the same reset story as the rest of the
        # battle state (a new battle must not inherit the previous one's
        # local player).
        self.self_name = ''
        self.last_panel = ''

    def clear_players(self):
        if _UI is None:
            self.entities = {}
            return
        for key in [k for k in self.entities]:
            if key != 'wowspProbe.status':
                try:
                    _UI.deleteUiElement(self.entities.pop(key))
                except:
                    self.soft('entity delete failed=' + _exc_text(120))

    def players_raw(self):
        try:
            return battle.getPlayersInfo() or {}
        except:
            self.soft('players error=' + _exc_text(120))
            return {}

    def players(self, records):
        result = []
        try:
            for key, p in records.items():
                if p['isBot'] or not p['name'] or p['name'].startswith(':'):
                    continue
                try:
                    aid = _to_int(p['accountDBID'])
                except:
                    aid = 0
                # The record carries the player's realm (the game's own
                # roster data — see the design doc's evidence table).
                # Reporting it lets the companion route each row to ITS
                # cluster instead of inferring one realm for the whole
                # battle; '' when a build stops exposing it, and the
                # companion falls back to its detection chain.
                try:
                    realm = _fmt(p['realm'] or '')
                except:
                    realm = ''
                result.append({'name': p['name'], 'account_id': (aid if aid > 0 else 0),
                               'avatar_id': _to_int(key), 'ship_id': _to_int(p['shipParamsId']),
                               'realm': realm})
        except:
            self.soft('players error=' + _exc_text(120))
            return []
        # list.sort is a bound method (no builtin-name lookup) and py2.7
        # supports the key argument — the same order sorted() produced.
        result.sort(key=lambda p: p['name'])
        return result[:64]

    def journal_mark(self, kind):
        self.journal.append('{"t":' + _fmt(_to_int(time.time() * 1000)) + ',"ev":' + json_encode_safe(kind) + '}')
        self.journal_flush()

    def journal_flush(self):
        # The sandbox open() has no append mode (it returns None for 'a'), so
        # the journal is rewritten whole from an in-memory ring buffer.
        del self.journal[:-JOURNAL_LIMIT]
        try:
            stream = open(ROSTER_JOURNAL_FILE, 'w')
            stream.write('\n'.join(self.journal) + '\n')
            stream.close()
        except:
            self.soft('journal flush failed=' + _exc_text(120))

    def read_field(self, record, key):
        try:
            value = record[key]
        except:
            try:
                # __dict__ only (no getattr): a property/__getattr__-
                # exposed field can slip the PROJECTION fallback — the
                # encoder path that keeps every field is unaffected, and
                # this path only runs when the encoder rejected the
                # record outright.
                value = record.__dict__[key]
            except:
                return None
        if _is_callable(value):
            return None
        return _fmt(value)[:48]

    def project_record(self, record):
        """Full JSON encode when possible (keeps every field), else the
        guessed-field projection for records the encoder cannot handle.
        NOTE: the RAISE is the dispatch — utils.jsonEncode stays raw here
        (json_encode_safe never raises, so the guessed-projection arm
        would go dead and roster_raw's players would degrade to quoted
        strings). Only the load-bearing file writers use the safe
        wrapper."""
        try:
            return _fmt(utils.jsonEncode(record))[:1200]
        except:
            # Dict comprehension: pure syntax, no `dict(...)` name lookup.
            return {k: v for k, v in ((k, self.read_field(record, k))
                                      for k in GUESS_FIELDS) if v is not None}

    def discover(self, record):
        """One-shot battery: what does a SafeClass record actually expose?"""
        for label, call in (('jsonEncode', lambda: utils.jsonEncode(record)),
                            ('str', lambda: _fmt(record)),
                            ('keys', lambda: [k for k in record.keys()]),
                            ('iter', lambda: [v for v in record]),
                            ('names', lambda: [k for k in record.__dict__])):
            try:
                log('discovery ' + label + '=' + _fmt(call())[:3000])
            except:
                log('discovery ' + label + ' failed=' + _exc_text(80))
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
                projection[_fmt(key)] = self.project_record(p)
            body = json_encode_safe({'players': projection, 'states': self.entity_states()})
            if body != self.last_raw:
                first = self.last_raw == ''
                self.last_raw = body
                stamp = _fmt(_to_int(time.time() * 1000))
                try:
                    stream = open(ROSTER_RAW_FILE, 'w')
                    stream.write('{"t":' + stamp + ',' + body[1:] + '\n')
                    stream.close()
                except:
                    self.soft('roster_raw write failed=' + _exc_text(120))
                if records and not self.discovered:
                    # First POPULATED snapshot of this battle: document the
                    # schema (the port-empty write must not consume this).
                    self.discovered = True
                    # First key of the records mapping, without list():
                    # subscript with a break is pure iteration syntax.
                    record = None
                    for _key in records:
                        record = records[_key]
                        break
                    try:
                        self.discover(record)
                    except:
                        log('discovery crashed=' + _exc_text(120))
                # body starts with '{'; splice it open so the line is one
                # flat object: {"t":...,"players":...,"states":...}
                self.journal.append('{"t":' + stamp + ',' + body[1:])
                self.journal_flush()
        except:
            self.soft('roster_raw failed=' + _exc_text(120))

    # -- request/response ----------------------------------------------------

    def request(self, manual):
        if not self.session or not self.roster or self.busy or time.time() - self.last_request < 5:
            return
        self.last_request = time.time()
        self.revision = -1
        try:
            self.write_json(REQUEST_FILE, {'version': 1, 'created': self.last_request,
                                           'session': self.session, 'manual': True if manual else False,
                                           'players': self.roster})
            # Empty response mailbox: read_json treats a file without the
            # trailing newline as absent, and no engine error is logged for
            # a missing file while the companion has not answered yet.
            stream = open(RESPONSE_FILE, 'w')
            stream.close()
            self.busy = True
            log('request written players=' + _fmt(len(self.roster)) + ' manual=' + ('True' if manual else 'False'))
        except:
            self.soft('request write failed=' + _exc_text(120))

    def read_response(self):
        try:
            data = self.read_json(RESPONSE_FILE, 262145)
            if data is None:
                return
            if data.get('session') != self.session or data.get('revision', -1) <= self.revision:
                return
            rows = data.get('rows', [])
            if not _is_kind(rows, 'list') or len(rows) > 64:
                return
            allowed = {p['name'] for p in self.roster}
            stats = self.stats.copy()
            for row in rows:
                name = row.get('name', '')
                if not name or name not in allowed:
                    continue
                stats[name] = row
            labels = data.get('labels')
            if _is_kind(labels, 'dict'):
                self.labels = labels
            self.stats = stats
            self.revision = data.get('revision', -1)
            self.busy = False
            self.refresh_panel()
            log('response applied revision=' + _fmt(self.revision) + ' rows=' + _fmt(len(rows)))
        except:
            # No response file yet is the normal state while nobody answers.
            self.soft('response read failed=' + _exc_text(120))

    # -- events ---------------------------------------------------------------

    def event(self, name, data):
        try:
            if name and name not in self.known_events:
                self.known_events.add(name)
                if self.event_log_count < 400:
                    self.event_log_count += 1
                    log('sfm event ' + _fmt(name))
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
            if name == 'window.hide' and _is_kind(data, 'dict') and data.get('windowName') == 'Battle':
                self.quit()
        except:
            self.soft('event error=' + _exc_text(120))

    def key_event(self, event):
        try:
            key = event.key
            down = event.isKeyDown()
            if self.key_log_count < 200 and key in (15, 47, 56, 184):
                self.key_log_count += 1
                log('key code=' + _fmt(key) + ' down=' + ('True' if down else 'False') + ' alt=' + ('True' if event.isAltDown() else 'False'))
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
        except:
            self.soft('key event error=' + _exc_text(120))

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
            except:
                self.soft('tick error=' + _exc_text(160))
            self.schedule()
        handle[0] = callbacks.callback(1 if self.session else 2, tick)

    def tick(self):
        records = self.players_raw()
        # Stash this tick's raw roster records: write_telemetry reads their
        # isAlive as the authoritative alive source (see there — the entity
        # walk alone is not a strong enough death signal).
        self.latest_raw = records or {}
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
                self.dead_latch = {None} - {None}
                self.session = _fmt(_to_int(time.time() * 1000))
                self.details_reset()
                self.busy = False
                self.last_request = 0
                self.request(False)
                log('roster stable players=' + _fmt(len(roster)) + ' sample=' + json_encode_safe(roster[0]))
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
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': _to_int(time.time() * 1000),
                                             'phase': 'battle' if self.session else 'port',
                                             'players': len(self.roster), 'revision': self.revision})
        except:
            self.soft('heartbeat failed=' + _exc_text(120))
        self.write_telemetry()
        if not self.session:
            return
        try:
            stream = open(MANUAL_FLAG, 'r')
            stamp = stream.read(100)
            stream.close()
            if stamp != self.manual_stamp:
                self.manual_stamp = stamp
                if 0 <= time.time() - _to_float(stamp) < 10:
                    self.request(True)
        except:
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
            # The game's own TAB sort keys (see sort_key_probe): read BEFORE
            # the panel fold so merge_order can sort the in-game panel's
            # alive block with them too, and carried in the payload below.
            self.sort_keys = self.sort_key_probe()
            # Shared with the panel builder so alive flags + sides cost one
            # entity walk per tick, not two.
            self.states = states
            self.merge_order(sides)
            players = {}
            identity = {}
            # The game's own roster records carry an isAlive that tracks
            # the client's table (validated name by name against a real Tab
            # capture's dead rows over battle-long journals, 2026-10-07), so
            # it is the AUTHORITATIVE alive source. The avatar-entity walk
            # supplies hp and is a fallback only: this plugin once reported
            # a LIVING player — the local one — dead for a whole battle
            # (reconstructed from his Tab capture: the telemetry's sunk set
            # named him while his row was up), and the old walk-fed one-way
            # latch was the only route that could have produced it. Latching
            # now requires the record's own verdict, so a single doubting
            # read can never pin anyone again; the record also supersedes
            # the walk when it says alive.
            raw_alive = {}
            for p in self.latest_raw.values():
                try:
                    nm = p['name']
                    if not nm:
                        continue
                    verdict = p['isAlive']
                    # Only a recognizable verdict counts as "the field
                    # exists": a build returning some other shape must not
                    # disable the legacy walk fallback for the battle.
                    if verdict is True or verdict is False or _fmt(verdict) in ('True', 'False'):
                        self.raw_isalive_seen = True
                    raw_alive[nm] = _fmt(verdict) != 'False'
                except:
                    continue
            for p in self.roster:
                name = p['name']
                row = states.get(name)
                raw_val = raw_alive.get(name)
                if name in self.dead_latch:
                    alive = False
                elif raw_val is False:
                    # The game says dead: report it and latch. Random
                    # battles have no resurrects — once dead, stay dead
                    # (this latch is also what absorbs a same-tick walk
                    # flicker back to "alive" while the sinking animation
                    # settles).
                    self.dead_latch.add(name)
                    alive = False
                elif raw_val is True:
                    # The game says alive: supersede the walk. THIS override
                    # is load-bearing — a walk-side False here would be
                    # reported (and, without the gate below, latched) and
                    # pin a living player dead for the rest of the battle.
                    alive = True
                else:
                    # This name has no record verdict right now — either a
                    # transient empty getPlayersInfo() (battle boundaries,
                    # the local death screen) or a build that never carries
                    # the field. Report the walk's read, and latch from it
                    # ONLY when no record verdict was EVER seen this battle
                    # (a build predating the field, i.e. the legacy
                    # behavior): once the field has been seen, its absence
                    # is an outage, not evidence — a one-way latch on it
                    # would re-arm the exact bug this gate exists for.
                    walk_dead = row is not None and row.get('alive') == 'False'
                    if walk_dead and not self.raw_isalive_seen:
                        self.dead_latch.add(name)
                    alive = not walk_dead
                players[name] = alive
                # Write the authoritative verdict back into this tick's walk
                # states: the panel rows (panel_rows, below) read them, so
                # the in-game panel shows the same truth as the telemetry
                # instead of the walk's raw read.
                if name in states:
                    states[name]['alive'] = 'True' if alive else 'False'
                if p.get('account_id') or p.get('realm'):
                    identity[name] = {'account_id': p.get('account_id', 0),
                                      'realm': p.get('realm', '')}
            self_name = self.__dict__.get('self_name') or ''
            if not self_name:
                # The entity walk is the primary self latch, but it stands
                # down when UiComponents cannot resolve (Lesta) — the game
                # API's own self view carries the name instead.
                try:
                    self_name = bare_name(_fmt(battle.getSelfPlayerInfo()['name']))
                except:
                    self_name = ''
            # The per-player client sort keys (sort_key_probe above): the
            # game-true Tab-order ingredients, keyed by bare name. An empty
            # map (a sandbox withholding the ship collection) keys the
            # offline per-realm inference in the companion; a covered roster
            # keys its exact-order grade (except on the CN client, whose
            # HUD renders an order the keys cannot express — the companion
            # stands the override down there).
            sort_keys = self.sort_keys
            self_realm = ''
            for p in self.roster:
                if p['name'] == self_name and p.get('realm'):
                    self_realm = p['realm']
                    break
            body = json_encode_safe({'t': _to_int(time.time() * 1000),
                                     'battle': self.session,
                                     'players': players,
                                     'sortKeys': sort_keys,
                                     'self': {'name': self_name, 'realm': self_realm},
                                     'identity': identity})
            stream = open(TELEMETRY_FILE, 'w')
            stream.write(body + '\n')
            stream.close()
        except:
            self.soft('telemetry failed=' + _exc_text(120))
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
        if not _is_num(wr):
            return 0xB4FFFFFF  # translucent white (no data)
        if wr >= 53:
            return 0xFF66FF66  # green
        if wr >= 50:
            return 0xFFFFEE66  # pale yellow
        if wr >= 45:
            return 0xFFFF9933  # orange
        return 0xFFFF5555      # red

    def pr_color(self, pr):
        if not _is_num(pr):
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
            wr = row.get('wr') if _is_kind(row, 'dict') else None
            pr = row.get('pr') if _is_kind(row, 'dict') else None
            rows.append({'name': name,
                         'wr': ('%.1f%%' % wr) if _is_num(wr) else '--',
                         'pr': _fmt(_to_int(pr)) if _is_num(pr) else '--',
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
            data = {'visible': True if (self.tab and (ally or enemy)) else False,
                    'ally': ally,
                    'enemy': enemy,
                    'labels': self.labels}
            body = json_encode_safe(data)
            if body == self.last_panel:
                return
            self.last_panel = body
            self.put(PANEL_KEY, data)
        except:
            self.soft('panel failed=' + _exc_text(120))

    def soft(self, message):
        # Deduplicated soft logging: a repeating error should appear once.
        if message != self.last_error:
            log(message)
            self.last_error = message


probe = Probe()
