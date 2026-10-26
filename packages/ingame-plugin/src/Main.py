# -*- coding: utf-8 -*-
"""WoWSP in-game telemetry probe.

Runs inside the game client via the WG Mods API (PnFMods loader). The
sandbox has no networking, so this probe observes and bridges out:

  - everything it learns goes to python.log (prefix WOWSP_PROBE) and to
    flat JSON files next to this Main.py (heartbeat, roster_raw, the
    roster journal, telemetry, order_probe) for the wowsp companion
    process to read,
  - live alive flags are bridged out as telemetry for the transparent
    overlay window (priority: mod telemetry > screen-capture inference >
    static roster order), together with the game's own Tab sort keys
    (sortKeys), the roster's record sequence (rosterOrder — the tie base
    for equal client keys), the records' localized ship names
    (shipNames — the CN name-order segment verbatim), the crosshair
    aim verdict ('aim', see entity_walk), the records' own AI
    verdicts ('bots', see bot_names — the aim card suppresses AI
    targets off it) and the walk's side membership ('sides' — the
    records-dead build class's only team split, the companion's
    probe-arena synthesizer's frame fallback),
  - each battle's full-roster BUILD bridge (builds.json): once the
    roster stabilizes, every player's raw SHIP_CONFIG blob
    (shipConfigDump: units/modernizations/exteriors/ensigns/consumables)
    plus the captain-skill picks (crewModifiersCompactParams.learnedSkills,
    the WG-family crewParams shape as the fallback) go out for the app's
    /live build lookup — the roster records carry these from the game's
    own shared data, enemies included (vehicle props are ALL_CLIENTS);
  - the ONE thing still rendered is the capture side channel's barcode
    strips: the unbound view (WoWSPProbe.unbound, installed to
    gui/unbound2/mods/ where the game auto-discovers + mounts battle
    views) watches this file's single 'wowspProbe.panel' data component
    and draws the ally/enemy strips while Tab is held. The sides come
    from the per-tick relation walk (entity_walk); the row order
    follows the client's OWN TAB sort keys when the ship-component probe
    delivers them (sort_key_probe), else the walk's arena rule. There is
    NO in-game stats rendering and NO request/response bridge — the
    app's in-game panel view mode was retired on 2026-10-19 and this
    file no longer writes request.json/response.json at all.

Still measured for diagnostics:
  1. load + heartbeat (heartbeat.json, phase port/battle),
  2. the full raw schema of battle.getPlayersInfo() (roster_raw.json),
  3. the sandbox API surface (dir() of every injected module, once).

Keep the syntax conservative (no f-strings, 3.6-level) and never let an
exception escape a callback: the game keeps running but the mod dies.
Never name an exception class in an `except` clause either — Lesta's
ModsAPI sandbox omits the exception classes from its builtin whitelist,
so `except Exception:` itself raises NameError there; handlers must use
bare `except:` (with `_exc_text` for the message).

Stronger still: the CORE paths (roster projection, telemetry writes,
the strip payload) never look up a builtin name at all —
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
ROSTER_RAW_FILE = 'roster_raw.json'
ROSTER_JOURNAL_FILE = 'roster_journal.jsonl'
TELEMETRY_FILE = 'telemetry.json'
ORDER_PROBE_FILE = 'order_probe.json'
BUILDS_FILE = 'builds.json'

# Tool config: WoWSP maintains res_mods/wowsp.toml and seeds our table
# ([tools."battle.ingame.stats"]) with these values; the keys below are the
# contract, hand edits to the file survive WoWSP rewrites. JOURNAL_LIMIT
# stays as the fallback default for a missing/unreadable manifest.
# `barcode` gates the capture side channel's strips: the overlay watcher
# upserts it to 1 when the overlay view mode starts, so exactly one
# consumer owns the screen while a mode is running (the app's in-game
# panel view mode was retired on 2026-10-19 — its panel/aim/aim_offset
# keys are gone with it). A missing manifest keeps the strips OFF: the
# overlay side asks for them by writing the key.
CONFIG_DEFAULTS = {
    'panel_fade_ticks': 3,
    'journal_limit': 300,
    'barcode': 0,
}
JOURNAL_LIMIT = CONFIG_DEFAULTS['journal_limit']

# Battle ticks a session may stay unset before the probe synthesizes one
# from the best available roster source (see synthesize_session). The
# roster normally stabilizes within three ticks; the 2026-10-18/19 field
# reports (Steam 13357625 + CN360 13357822) showed a build class where it
# NEVER does — getPlayersInfo empty, failing or churning all battle — so
# write_telemetry's session gate stood closed and telemetry.json appeared
# only as the battle-end quit-clear (the companion read alive=0 at the
# exact battle-end millisecond). Five ticks (~10 s at the pre-session
# cadence) sits well inside the companion's ~30 s absence grace: a
# degraded build still gets its stream before the WARN arms, and a
# healthy build never reaches the count.
ROSTER_GRACE_TICKS = 5

# builds.json bounds (see write_builds). The bridge carries the roster's
# raw SHIP_CONFIG blobs; the app caps the roster at 64 players, an encoded
# dump over the char bound is skipped (one oversized record must never
# blow up the file), and the retry counter bounds the old-build shape
# whose records exist but carry no build fields at all — after a handful
# of ticks the battle is declared build-less instead of re-reading the
# roster forever.
BUILDS_MAX_PLAYERS = 64
BUILDS_MAX_DUMP_CHARS = 8192
BUILDS_MAX_TRIES = 3

# The barcode strip's frozen geometry contract (see the design doc's
# capture side-channel section): the overlay's decoder is written against
# these exact numbers; changing any of them is a coordinated spec bump on
# both sides of the channel.
BARCODE_BLOCK = 6      # px per bit block
BARCODE_HGAP = 2       # horizontal gap between blocks
BARCODE_VGAP = 3       # vertical gap between rows
BARCODE_PAD = 4        # backdrop padding around the block grid
BARCODE_CELLS = 8      # blocks per row: [1,0] sync + 5 index bits + parity
BARCODE_MARGIN = 24    # screen-edge margin (same anchor px as the panel)
BARCODE_ON = 0xFFF2F2F2
BARCODE_OFF = 0xFF303030
BARCODE_BACK = 0xFF101010

# The aim panel's frozen detection contract (build 13357625 decompile +
# the client's own views): the marker an avatar entity carries is drawn
# from the SAME avatar collection this probe walks, and the client's own
# lock icon lights up on `target.flags & LOCKABLE_WEAPONS` —
# gui/unbound2/pc/shared/constants.unbound freezes that mask as
# "1<<0 | 1<<1 | 1<<2 | 1<<6 | 1<<7 | 1<<8 | 1<<10 | 1<<12 | 1<<13"
# over the WEAPON_* bit enum (bit index = weapon type). The main-battery
# bits (UNKNOWN/MAIN_AP/MAIN_HE = bits 0-2) are preferred when several
# entities are targeted at once (guns on one ship, torpedoes locked on
# another). Changing either number is a spec bump against the client.
AIM_LOCKABLE = 0x35C7
AIM_MAIN_BITS = 0x7


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


# The strips' single data component: the unbound view watches this
# key (getPrimWatcher(CC.mods_DataComponent, ...)) and redraws on every
# updateUiElementData. All payload decisions (visibility, rows, rank
# words) are made here so the view stays a dumb template.
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
    # Strings BEFORE numbers: py2's %d accepts digit strings, and a
    # digit-string value (a session stamp, a roster key) must stay a
    # JSON string, never flip to a number.
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


def _bridge_write(name, text):
    """Write one bridge file as UTF-8 BYTES.

    py2 text mode encodes a `unicode` payload with the locale codec
    (ASCII on the client), so a body the client's own encoder echoed as
    unicode — non-ASCII nicknames or localized ship names — raises
    UnicodeEncodeError and freezes the file while heartbeat
    (ASCII bodies) keep flowing. Binary mode plus an explicit utf-8
    encoding makes the writer payload-agnostic: str bytes pass through,
    unicode is encoded, and the file always ends with one newline.

    'wb' is not among the sandbox modes already live-proven ('r'/'w'
    are, 'a' is rejected), so a rejected/None binary open falls back to
    text mode and writes the already-encoded bytes raw (py2 'w' does
    not re-encode a byte str); the py3 harness path decodes back only
    if text mode is somehow reached there.
    """
    try:
        data = text + '\n'
    except:
        data = text
    try:
        data = data.encode('utf-8')
    except:
        pass
    stream = None
    try:
        stream = open(name, 'wb')
    except:
        stream = None
    if stream is None:
        stream = open(name, 'w')
    try:
        stream.write(data)
    except:
        stream.write(data.decode('utf-8'))
    stream.close()


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


def _is_kind(value, *names):
    """Class-name probe without `isinstance`/`object`. Exact class names
    only — subclasses of dict/list would not match where isinstance did;
    callers feed it codec-produced containers (exact dict/list), so the
    difference is unreachable."""
    try:
        return value.__class__.__name__ in names
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
    silencing telemetry, the strips and the roster files for every
    Lesta battle). Bare `except:` needs no name, and the live exception
    still reaches this helper via sys.exc_info() when the sandbox allows
    the import.
    """
    try:
        import sys
        return ('%s' % (sys.exc_info()[1],))[:limit]
    except:
        return '?'


# ── builds-bridge primitives (builds.json) ────────────────────────────
# The per-battle build bridge: every roster record's raw SHIP_CONFIG blob
# (shipConfigDump — the game's own shared-data field, ALL_CLIENTS on the
# vehicle entity) plus the captain-skill compact params (learnedSkills).
# No binascii/base64 exists in the sandbox, so the bodies ride out as hex
# with a pre-built %-formatting table; the one base64-shape client (Lesta's
# SafeClass repr hands the field over base64) is detected and passed
# through as dump_enc='b64'. Everything below is pure syntax / bound
# methods: no builtin NAME is looked up (the Lesta whitelist withholds
# str/chr/int/range/sorted — same discipline as the core helpers above).
_B64_CHARS = ('ABCDEFGHIJKLMNOPQRSTUVWXYZ'
              'abcdefghijklmnopqrstuvwxyz0123456789+/=')


def _build_hex_table():
    """char -> two-digit hex for the py2-str fallback; %-formatting only
    (a %c / %02x conversion is a bytecode operation, never a name
    lookup), so a whitelist that drops chr/range cannot empty it."""
    table = {}
    i = 0
    while i < 256:
        table['%c' % (i,)] = '%02x' % (i,)
        i += 1
    return table


_HEX_TABLE = _build_hex_table()


def _char_text(ch):
    """One iteration element as a one-char string: py2 str / py3 str
    already yield chars, py3 bytes and both bytearrays yield ints."""
    if _is_kind(ch, 'int', 'long'):
        try:
            return '%c' % (ch,)
        except:
            return None
    return ch


def _looks_base64(value):
    """True for a printable base64 body (Lesta's SafeClass dump repr):
    every element in the base64 alphabet, length a multiple of four. A
    binary SHIP_CONFIG can never pass — its leading 0x01 fails the
    alphabet. False on any uniterable/odd value (never raises)."""
    try:
        count = 0
        for ch in value:
            text = _char_text(ch)
            if text is None or text not in _B64_CHARS:
                return False
            count += 1
        return count >= 16 and (count % 4) == 0
    except:
        return False


def _as_text(value):
    """JSON text for a base64 body (py3 bytes/bytearray decoded; a py2 str
    is already text). None when it cannot be decoded."""
    if _is_kind(value, 'bytes', 'bytearray'):
        try:
            return value.decode('ascii')
        except:
            return None
    return value


def _hex_encode(value):
    """Hex body with NO binascii: the py2 str 'hex' codec first (a bound
    method call, no builtin lookup), then the %-formatting table per
    element for py3 bytes/bytearray (ints) and py2 str (chars). None = the
    value is not a byte string this sandbox can encode."""
    try:
        return value.encode('hex')
    except:
        pass
    out = []
    try:
        for ch in value:
            text = None
            try:
                text = '%02x' % (ch,)
            except:
                text = _HEX_TABLE.get(ch)
            if text is None:
                return None
            out.append(text)
    except:
        return None
    return ''.join(out)


def _encode_dump(value):
    """(dump_enc, body) for one shipConfigDump value, or (None, None).

    Two live shapes: the WG family hands raw SHIP_CONFIG bytes (archive
    logs 2026-10-10/25 show the version/ship_params_id/element_count u32
    header), Lesta hands the same field over in its base64 repr shape.
    Base64 is probed FIRST so a textual body is never hex-encoded into
    garbage; a real blob cannot be mistaken for it (leading control byte)."""
    if value is None:
        return None, None
    try:
        if _looks_base64(value):
            text = _as_text(value)
            if text is not None:
                return 'b64', text
    except:
        pass
    try:
        body = _hex_encode(value)
    except:
        body = None
    if body:
        return 'hex', body
    return None, None


def _record_field(record, key):
    """One raw record field: SafeClass subscript first (the live-proven
    contract), __dict__ second; None when the field is not exposed."""
    try:
        return record[key]
    except:
        try:
            return record.__dict__[key]
        except:
            return None


def _record_int(record, key, default=0):
    """One integer record field with the same guarded read as
    _record_field; callables and unreadable shapes fall back to default."""
    value = _record_field(record, key)
    if value is None or _is_callable(value):
        return default
    try:
        return _to_int(value)
    except:
        return default


def _crew_field(obj, key):
    """One crew-params field, three levels, each its own bare except:
    subscript (SafeClass contract), attribute SYNTAX (LOAD_ATTR — no
    builtin name lookup, so the Lesta whitelist is never consulted), then
    __dict__ (the object's own storage, the read_field fallback idiom)."""
    try:
        return obj[key]
    except:
        pass
    try:
        if key == 'learnedSkills':
            return obj.learnedSkills
        if key == 'paramsId':
            return obj.paramsId
        if key == 'isInAdaptation':
            return obj.isInAdaptation
    except:
        pass
    try:
        return obj.__dict__[key]
    except:
        return None


def _crew_int(obj, key):
    """Integer crew field, None when absent/unreadable (the caller omits
    the key rather than fabricating a value)."""
    value = _crew_field(obj, key)
    if value is None or _is_callable(value):
        return None
    try:
        return _to_int(value)
    except:
        return None


def _skills_matrix(value):
    """learnedSkills as JSON-safe list-of-lists of ints (alias.xml's
    ARRAY<ARRAY<UINT8>>), or None when the shape is unreadable. Strings
    are rejected outright: iterating one would forge a per-character
    matrix. Bounded (64x64) so a pathological wrapper cannot stall the
    tick; the real table is small."""
    if value is None or _is_callable(value):
        return None
    if _is_kind(value, 'str', 'unicode', 'bytes', 'bytearray'):
        return None
    rows = []
    try:
        for row in value:
            cells = []
            for cell in row:
                cells.append(_to_int(cell))
            rows.append(cells)
            if len(rows) >= 64:
                break
    except:
        return None
    return rows


def _crew_from(obj, depth=0):
    """Crew block off one crew-params object, or None when no readable
    learnedSkills exist (the caller then OMITS the crew key entirely —
    never fabricates one). WG-family records answer crewParams as a
    two-slot list, so a list/tuple is walked element by element (bounded
    depth) looking for the real object instead of guessed indices."""
    if obj is None or depth > 2:
        return None
    learned = _skills_matrix(_crew_field(obj, 'learnedSkills'))
    if learned is not None:
        crew = {'learned_skills': learned}
        params = _crew_int(obj, 'paramsId')
        if params is not None:
            crew['params_id'] = params
        flag = _crew_int(obj, 'isInAdaptation')
        if flag is not None:
            crew['is_in_adaptation'] = flag
        return crew
    if _is_kind(obj, 'str', 'unicode', 'bytes', 'bytearray'):
        return None
    items = []
    if _is_kind(obj, 'list', 'tuple'):
        items = obj
    else:
        # The ModsAPI's own container wrappers do not carry the codec class
        # names: WG's two-slot crewParams reaches us as a SafeClass
        # list-like, so a bounded duck iteration is the only way to reach
        # the crew object inside it. Four items is generous for a two-slot
        # wrapper; anything that is not iterable degrades to None.
        try:
            for item in obj:
                items.append(item)
                if len(items) >= 4:
                    break
        except:
            return None
    for item in items:
        found = _crew_from(item, depth + 1)
        if found is not None:
            return found
    return None


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
        # The game's own battle-start event fired (onBattleStart) and the
        # matching quit has not — drives the heartbeat's phase INDEPENDENT
        # of roster stabilization, so a build whose getPlayersInfo drifts
        # (2026-10-11 CN360: session never set) still reports battle and
        # the companion's telemetry-absent WARN can fire.
        self.in_battle = False
        self.last_error = ''
        self.entities = {}
        # {…} - {…} instead of set([]): set literals/differences compile
        # to display + arithmetic opcodes, so the Lesta sandbox's builtin
        # whitelist is never consulted for the empty-set construction.
        self.known_events = {None} - {None}
        self.event_log_count = 0
        self.last_raw = ''
        self.latest_raw = {}
        self.last_order_cache = None
        # The per-battle bot-name cache (see bot_names): None = nothing
        # derived yet this battle.
        self.last_bots_cache = None
        self.raw_isalive_seen = False
        self.discovered = False
        # builds.json bookkeeping (see write_builds): the one-shot guard
        # and the retry counter for the old-build shape whose records
        # exist but carry no build fields at all.
        self.builds_written = False
        self.builds_tries = 0
        self.journal = []
        self.empty_ticks = 0
        self.dead_latch = {None} - {None}
        # Sticky name -> avatar ENTITY id (see entity_walk): the id space
        # the client's sortedAlive collection carries, bots included.
        self.avatar_entity_ids = {}
        self.dh = None
        self.const = None
        # False = not yet resolved; None = resolution failed (see _cc).
        self.cc_cache = False
        self.api_dumped = False
        self.comp_dumped = False
        # Barcode strip state: Tab visibility, the two sides' TAB row
        # order, the freshest entity states (shared with the telemetry
        # writer) and the last panel body (change gate for the UI update).
        self.tab = False
        self.order = {'ally': [], 'enemy': []}
        self.alive_last = {'ally': {}, 'enemy': {}}
        self.sort_keys = {}
        self.states = {}
        self.last_panel = ''
        # Aim state: the current target walk verdict ({name, flags} or
        # None — latched by entity_walk, cleared per battle; it rides
        # telemetry every tick) and the UiComponents `target` attribute
        # resolved behind its own guard (False = not yet resolved,
        # None = unavailable — see _cc_target).
        self.aim = None
        self.cc_target_cache = False
        self.aim_log_last = ''
        # One-shot per stabilized session: the client's own TAB-order source
        # probe (see client_order_probe). It runs on the first stabilized
        # tick, once the data hub's splitting/sorting collections exist.
        self.order_probe_done = False
        # The degraded-roster fallback bookkeeping (see synthesize_session):
        # battle ticks elapsed without a session, the last non-empty roster
        # attempt (records that never stabilized), and the source the
        # current session was synthesized from ('' = the stabilized path).
        self.grace_ticks = 0
        self.last_unstable = []
        self.session_fallback = ''
        # Entities the LAST write_telemetry walk saw (0 before the first
        # post-session tick): a walk-sourced session's battle-end signal
        # (see tick's empty branch).
        self.walk_seen = 0
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
        events.onSFMEvent(self.event)
        events.onBattleQuit(self.quit)
        events.onBattleStart(self.start)
        self.schedule()
        log('probe ' + PROBE_VERSION + ' loaded')

    # -- file bridge ------------------------------------------------------

    def write_json(self, name, data):
        _bridge_write(name, json_encode_safe(data))

    def write_builds(self, records):
        """One-shot per battle: bridge the whole roster's build data.

        Every live roster record carries the game's own shared-data build
        fields (the vehicle entity's ALL_CLIENTS props): the raw
        SHIP_CONFIG blob (shipConfigDump — units, modernizations, exterior
        slots/signals, ensigns, abilities, ...) and a crew-params object
        whose learnedSkills are the captain's skill picks (Lesta:
        crewModifiersCompactParams; the WG-family records answer the same
        data under crewParams). Both are bridged verbatim; the app decodes
        the blob with its replay-RPC parser and maps the GameParam ids
        offline, so the probe invents nothing.

        Contract: builds.json is written ONCE per roster session
        (builds_written), retrying at most BUILDS_MAX_TRIES ticks for the
        old-build shape whose records exist but expose no build fields;
        quit() writes the quit-clear (empty players). A missing file means
        "this probe build predates the bridge" — consumers degrade.
        """
        if self.builds_written or not self.session:
            return
        if not records:
            return
        if self.builds_tries >= BUILDS_MAX_TRIES:
            self.builds_written = True
            log('builds unavailable records=' + _fmt(len(records)))
            return
        self.builds_tries += 1
        players = {}
        skipped = 0
        try:
            for key in records:
                if len(players) >= BUILDS_MAX_PLAYERS:
                    break
                record = records[key]
                name = _record_field(record, 'name')
                if name is None or _is_callable(name):
                    continue
                if name in players:
                    continue
                row = {'team': _record_int(record, 'teamId'),
                       'ship_params_id': _record_int(record, 'shipParamsId')}
                enc, body = _encode_dump(_record_field(record, 'shipConfigDump'))
                if not body:
                    # No dump field (older build) or an unencodable shape:
                    # skip that player, never fabricate one.
                    skipped += 1
                    continue
                if len(body) > BUILDS_MAX_DUMP_CHARS:
                    skipped += 1
                    self.soft('builds dump too large name=' + _fmt(name))
                    continue
                row['dump_enc'] = enc
                row['dump'] = body
                crew = None
                for field in ('crewModifiersCompactParams', 'crewParams'):
                    crew = _crew_from(_record_field(record, field))
                    if crew is not None:
                        break
                if crew is not None:
                    row['crew'] = crew
                players[name] = row
            if not players:
                if self.builds_tries >= BUILDS_MAX_TRIES:
                    self.builds_written = True
                    log('builds unavailable records=' + _fmt(len(records)))
                return
            self.builds_written = True
            data = {'v': 1,
                    't': _to_int(time.time() * 1000),
                    'battle': self.session,
                    'players': players}
            self_team = self.self_team_of(records)
            if self_team is not None:
                data['self_team'] = self_team
            _bridge_write(BUILDS_FILE, json_encode_safe(data))
            log('builds written players=' + _fmt(len(players)) +
                ' skipped=' + _fmt(skipped))
        except:
            # One failed assembly must neither retry forever nor leave a
            # half-written file: mark the battle attempted and log the
            # sandbox-safe exception text. An absent file = no build data.
            self.builds_written = True
            self.soft('builds failed=' + _exc_text(120))

    def self_team_of(self, records):
        """The local player's record teamId (0/1) for builds.json's
        self_team, or None when the roster never names the local player
        (the walk-sourced classes). Name resolution order: the walk's own
        self latch (entity_walk), then the game API's self view."""
        self_name = ''
        try:
            self_name = self.self_name or ''
        except:
            self_name = ''
        if not self_name:
            try:
                self_name = bare_name(_fmt(battle.getSelfPlayerInfo()['name']))
            except:
                self_name = ''
        if not self_name:
            return None
        try:
            for key in records:
                record = records[key]
                name = _record_field(record, 'name')
                if name is None:
                    continue
                if bare_name(_fmt(name)) != self_name:
                    continue
                team = _record_field(record, 'teamId')
                if team is None or _is_callable(team):
                    return None
                return _to_int(team)
        except:
            return None
        return None

    # -- UI data components (stage-B groundwork) ---------------------------

    def put(self, key, data):
        if _UI is None:
            # No `ui` module on this client (Lesta): the strips' data
            # component is unavailable — a silent no-op, not an error.
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
        # Before anything else: the heartbeat must report battle from the
        # game's own event, not from roster stabilization (see __init__).
        self.in_battle = True
        # Re-read the tool config each battle (in-place update, so every
        # TOOL_CONFIG reader sees it): the companion upserts the barcode
        # mode key when the overlay view mode starts, and a settings flip
        # between battles must apply without relaunching the game.
        try:
            TOOL_CONFIG.update(load_tool_config())
        except:
            pass
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
        file writes while heartbeat/journal kept flowing and the
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

    def _cc_target(self):
        """The UiComponents `target` attribute, resolved ONCE behind its own
        guard: a client can serve UiComponents yet withhold the attribute
        (the aim walk's duck-typed fallback then carries that client), and
        per-entity attribute misses must never re-raise the lookup."""
        if self.cc_target_cache is False:
            self.cc_target_cache = None
            cc = self._cc()
            if cc is not None:
                try:
                    self.cc_target_cache = cc.target
                except:
                    self.cc_target_cache = None
        return self.cc_target_cache

    def aim_flags_of(self, entity):
        """One entity's target-flags, or None when it carries no target
        component. Primary path: the UiComponents `target` class via the
        entity's `in`/subscript protocol (the census-proven component
        access) — a resolvable cc whose key misses is an AUTHORITATIVE
        negative (no duck probing: a third-party component that happens
        to carry `.flags` would otherwise fabricate a target). Fallback
        (cc.target withheld while UiComponents itself resolves — a
        per-client withholding, NOT the whole-attribute raise that stands
        the entire walk down): duck-type the raw components mapping for
        an object with `.flags` but no `.reasons` (CanHit carries both;
        the marker views read flags off target and reasons off canHit —
        build 13357625 views)."""
        cc_target = self._cc_target()
        if cc_target is not None:
            try:
                if cc_target in entity:
                    return _to_int(entity[cc_target].flags)
            except:
                pass
            return None
        try:
            for comp in entity.components.values():
                try:
                    flags = comp.flags
                except:
                    continue
                try:
                    comp.reasons
                    continue  # CanHit shape — not the target component
                except:
                    pass
                return _to_int(flags)
        except:
            pass
        return None

    def aim_latch(self, hits):
        """Fold this walk's [(name, flags)] hits into the aim verdict: the
        main-battery target wins, else the first lockable hit. Logged on
        change so a replay tail (python.log) shows the recorded player's
        aim switches as they happen."""
        chosen = None
        for name, flags in hits:
            if not name:
                continue
            if flags & AIM_MAIN_BITS:
                chosen = (name, flags)
                break
        if chosen is None:
            for name, flags in hits:
                if name:
                    chosen = (name, flags)
                    break
        verdict = {'name': chosen[0], 'flags': chosen[1]} if chosen else None
        was = self.aim['name'] if _is_kind(self.aim, 'dict') else ''
        now = verdict['name'] if chosen else ''
        if was != now:
            # Name switches only — flags ride telemetry every tick, and a
            # flags-only change (an AP/HE swap flipping bits on the same
            # target) must not earn a log line per tick. A normal telemetry
            # line, NOT soft(): the latch stays empty in a healthy battle
            # (the harness pins this) — aim switches are expected traffic,
            # replay tails read them.
            line = ('aim ' + (now or 'none') +
                    (' flags=' + _fmt(verdict['flags']) if chosen else ''))
            if line != self.aim_log_last:
                log(line)
                self.aim_log_last = line
        self.aim = verdict

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
        own order (live 2026-10-10) — so the row fold below sorts by
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

    # -- client order probe -------------------------------------------------
    # The TAB table's row order is the client's OWN rendered sequence. The
    # client builds it in AvatarSystem (scripts/mcb5884c1/m9be68bb6.pyc:
    # __createCollections -> 'byTeams', 'byTeamsSortedAlive', 'sortedAlive',
    # 'sortedLeftTeam', 'realPlayers' via dh.Splitting / dh.Sorting), and
    # the unbound view reads it as
    #   $datahub.getCollection(CC.avatar).getChildByPath('team.ally.sortedAlive').
    # The injected `dataHub` wrapper flattens entity collections to a list
    # and exposes no getCollection/getChildByPath (the 2026-09 finding),
    # but the battleGate module that backs `battle` carries an INTERNAL
    # getCollection(componentId) returning the raw dh collection object —
    # the one that does have getChildByPath. Whether the SafeClass wrapper
    # forwards that internal name, and which SYNCED collection names answer
    # at all, is build-dependent and exactly what this one-shot probe
    # records. It is DIAGNOSTIC ONLY: nothing here feeds the strips,
    # telemetry or the companion's ordering.

    def _collection_order(self, collection, cc, limit):
        """One collection's own iteration sequence as [{id,name,alive}].
        For an AvatarSystem sorting child this IS the client's rendered
        row order; for the raw avatar collection it is insertion order.
        Bounded and fault-tolerant: one odd entity cannot kill the probe."""
        order = []
        count = 0
        try:
            for entity in collection:
                count += 1
                if count > limit:
                    break
                row = {}
                try:
                    row['id'] = _to_int(entity.id)
                except:
                    row['id'] = 0
                try:
                    row['name'] = bare_name(_fmt(entity[cc.avatar].name))
                except:
                    pass
                try:
                    row['alive'] = _fmt(entity[cc.health].isAlive)
                except:
                    pass
                order.append(row)
        except:
            self.soft('order collection iteration failed=' + _exc_text(120))
        return order

    def _sample_collection(self, cols, comp_class, limit):
        """Bounded projection of one served component collection: entity
        id, any `list` field (the Children tree edges), public field
        names and data keys. A failing field is skipped; an uniterable
        collection raises to the caller (which records the negative
        result instead of aborting the tick)."""
        sample = []
        seen = 0
        for ent in cols:
            seen += 1
            if seen > limit:
                break
            row = {}
            try:
                row['id'] = _to_int(ent.id)
            except:
                pass
            if comp_class is not None:
                try:
                    comp = ent[comp_class]
                except:
                    comp = None
                if comp is not None:
                    try:
                        row['list'] = [_to_int(x) for x in comp.list]
                    except:
                        pass
                    try:
                        row['fields'] = _public_names(comp)[:24]
                    except:
                        pass
                    try:
                        data = comp.data
                        try:
                            row['dataKeys'] = data.keys()
                        except:
                            row['dataKind'] = _fmt(data.__class__.__name__)
                    except:
                        pass
            sample.append(row)
        return sample

    def client_order_probe(self):
        """One-shot per stabilized session: verify which in-client order
        source this build exposes and dump the evidence to order_probe.json."""
        cc = self._cc()
        if cc is None:
            return
        evidence = {'t': _to_int(time.time() * 1000),
                    'battle': self.session,
                    'apis': {}, 'collections': {}, 'paths': {},
                    'players': [], 'allPlayers': []}

        # 1. Which entry points does the injected `battle` SafeClass
        # forward? Direct attribute reads under bare excepts (no getattr:
        # Lesta's whitelist may withhold it, and a Dummy lookalike is
        # proven only by the call below, never by an `is callable` guess).
        try:
            battle.getCollection
            evidence['apis']['getCollection'] = 'present'
        except:
            evidence['apis']['getCollection'] = 'missing'
        try:
            battle.getCollections
            evidence['apis']['getCollections'] = 'present'
        except:
            evidence['apis']['getCollections'] = 'missing'
        try:
            battle.getAllPlayers
            evidence['apis']['getAllPlayers'] = 'present'
        except:
            evidence['apis']['getAllPlayers'] = 'missing'
        try:
            battle.getPlayersInfo
            evidence['apis']['getPlayersInfo'] = 'present'
        except:
            evidence['apis']['getPlayersInfo'] = 'missing'
        try:
            battle.getPlayerInfo
            evidence['apis']['getPlayerInfo'] = 'present'
        except:
            evidence['apis']['getPlayerInfo'] = 'missing'
        try:
            battle.getSelfPlayerInfo
            evidence['apis']['getSelfPlayerInfo'] = 'present'
        except:
            evidence['apis']['getSelfPlayerInfo'] = 'missing'
        try:
            battle.getAllShips
            evidence['apis']['getAllShips'] = 'present'
        except:
            evidence['apis']['getAllShips'] = 'missing'

        # The raw avatar collection: the object getChildByPath lives on.
        raw_avatar = None
        if evidence['apis'].get('getCollection') == 'present':
            try:
                raw_avatar = battle.getCollection(cc.avatar)
                evidence['apis']['getCollection(avatar)'] = 'ok'
            except:
                evidence['apis']['getCollection(avatar)'] = 'failed=' + _exc_text(80)
            if raw_avatar is not None:
                # The exact paths the client's own UI resolves. 'team' /
                # 'ally' are the grouping split; the leaf names are the
                # AvatarSystem collections (live unbound path: team.ally.
                # sortedAlive). The bare leaves cover builds without the
                # grouping prefix.
                for path in ('team.ally.sortedAlive',
                             'team.enemy.sortedAlive',
                             'team.ally.byTeamsSortedAlive',
                             'team.enemy.byTeamsSortedAlive',
                             'team.ally.sortedLeftTeam',
                             'team.enemy.sortedLeftTeam',
                             'team.ally.realPlayers',
                             'team.enemy.realPlayers',
                             'sortedAlive', 'byTeamsSortedAlive',
                             'sortedLeftTeam', 'realPlayers'):
                    try:
                        child = raw_avatar.getChildByPath(path)
                        evidence['paths']['avatar/' + path] = self._collection_order(child, cc, 32)
                    except:
                        evidence['paths']['avatar/' + path] = 'failed=' + _exc_text(80)

        # 2. Which collections answer through the two documented doors?
        # `dataHub.getEntityCollections(name)` is the SYNCED-whitelist
        # path the probe already uses for avatar/ship; `battle.
        # getCollection(componentId)` is the raw door (if forwarded).
        # Candidates stay bounded: each wrapper call materializes the
        # whole collection on the live client.
        for name in ('dataComponent', 'mods_DataComponent', 'children',
                     'parent', 'battleTeamScore', 'teamScore', 'battleInfo',
                     'battleUIInfo', 'battleState', 'vehicle', 'health',
                     'relation', 'playerMode', 'divisionMember'):
            cols = None
            if self.dh is not None:
                try:
                    cols = self.dh.getEntityCollections(name)
                    evidence['collections'][name] = len(cols)
                except:
                    evidence['collections'][name] = 'failed=' + _exc_text(60)
            else:
                evidence['collections'][name] = 'no-dataHub'
            # The SYNCED path is the one that answers on 15.9; sample the
            # containers it serves. `children` is the UI data hub's tree
            # edges: each Children.list is an ordered entity-id sequence,
            # a candidate for the client's own row order.
            if cols is not None and name in ('children', 'battleInfo',
                                             'battleState',
                                             'mods_DataComponent',
                                             'dataComponent'):
                comp_class = None
                try:
                    comp_class = cc.__dict__[name]
                except:
                    comp_class = None
                try:
                    sample = self._sample_collection(cols, comp_class, 40)
                    evidence['collections'][name + '#sample'] = sample
                except:
                    evidence['collections'][name + '#sample'] = 'failed=' + _exc_text(60)
            klass = None
            try:
                klass = cc.__dict__[name]
            except:
                klass = None
            if klass is not None and evidence['apis'].get('getCollection') == 'present':
                try:
                    raw = battle.getCollection(klass)
                    evidence['collections'][name + '#raw'] = 'ok'
                    if name in ('dataComponent', 'mods_DataComponent'):
                        # Sample the data component nodes: their `data`
                        # payloads are where the UI's tree leaves live.
                        sample = []
                        seen = 0
                        for ent in raw:
                            seen += 1
                            if seen > 12:
                                break
                            row = {}
                            try:
                                row['id'] = _to_int(ent.id)
                            except:
                                pass
                            try:
                                data = ent[klass].data
                                try:
                                    row['keys'] = data.keys()
                                except:
                                    row['kind'] = _fmt(data.__class__.__name__)
                            except:
                                pass
                            sample.append(row)
                        evidence['collections'][name + '#sample'] = sample
                except:
                    evidence['collections'][name + '#raw'] = 'failed=' + _exc_text(60)

        # 3. The Player record's prebattle slot: the one roster field the
        # probe never bridged. If the client renders the table from it,
        # its values ARE the order; if it is always 0, it is not.
        try:
            records = self.latest_raw or battle.getPlayersInfo()
            rows = []
            for key, p in records.items():
                row = {'key': _fmt(key)}
                for field in ('name', 'teamId', 'prebattleIndex',
                              'shipParamsId', 'isAlive', 'isBot',
                              'avatarId', 'id'):
                    try:
                        row[field] = _fmt(p[field])
                    except:
                        pass
                rows.append(row)
                if len(rows) >= 64:
                    break
            evidence['players'] = rows
        except:
            evidence['players'] = 'failed=' + _exc_text(80)

        # 4. getAllPlayers(): if it forwards a Player list, its sequence
        # is a candidate too (PlayersInfo.getAllPlayers backs
        # getPlayersInfo on the same module).
        if evidence['apis'].get('getAllPlayers') == 'present':
            try:
                rows = []
                for player in battle.getAllPlayers():
                    row = {}
                    for field in ('name', 'teamId', 'id', 'avatarId',
                                  'shipId', 'prebattleIndex', 'isAlive'):
                        try:
                            row[field] = _fmt(player[field])
                        except:
                            pass
                    rows.append(row)
                    if len(rows) >= 64:
                        break
                evidence['allPlayers'] = rows
            except:
                evidence['apis']['getAllPlayers()'] = 'failed=' + _exc_text(80)

        # 5. The flash bridge (flashGate exports call/addExternalCallback):
        # present on both client families, but whether the battle HUD
        # exposes a row-order function through it is unknown — record the
        # surface only, never call an unidentified UI function.
        try:
            flash
            evidence['apis']['flash'] = 'present'
            try:
                flash.call
                evidence['apis']['flash.call'] = 'present'
            except:
                evidence['apis']['flash.call'] = 'missing'
        except:
            evidence['apis']['flash'] = 'missing'

        try:
            self.write_json(ORDER_PROBE_FILE, evidence)
        except:
            self.soft('order probe write failed=' + _exc_text(120))
        try:
            log('order probe ' + json_encode_safe(evidence)[:3800])
        except:
            self.soft('order probe log failed=' + _exc_text(120))

    def entity_walk(self):
        """ONE entity walk feeding the strips + telemetry: per-avatar live
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
        leak the previous battle's name — and the avatar ENTITY ids into
        self.avatar_entity_ids (sticky, bots included): the same id space
        the client's sortedAlive collection items carry, which is what
        the barcode byId map and the overlay's row attribution
        key on. The roster records' own avatarId field is a DIFFERENT id
        (their mapping key), so the walk is the authoritative source.
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
        aim_hits = []
        try:
            for entity in self.dh.getEntityCollections('avatar'):
                try:
                    name = bare_name(_fmt(entity[cc.avatar].name))
                except:
                    continue
                if not name:
                    continue
                # The avatar entity's own id, latched sticky: sunk ships
                # tear their entities down mid-battle while the client's
                # sortedAlive collection still lists them, so a once-seen
                # id must survive the entity's disappearance.
                try:
                    eid = _to_int(entity.id)
                    if eid:
                        self.avatar_entity_ids[name] = eid
                except:
                    pass
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
                # The aim verdict rides the same walk: an entity whose
                # target component carries a lockable-weapon bit is a
                # candidate (see aim_flags_of/aim_latch).
                try:
                    aim_flags = self.aim_flags_of(entity)
                    if aim_flags is not None and aim_flags & AIM_LOCKABLE:
                        aim_hits.append((name, aim_flags))
                except:
                    pass
        except:
            self.soft('entity walk failed=' + _exc_text(120))
        self.self_name = self_name
        self.aim_latch(aim_hits)
        return states, sides

    def merge_order(self, sides):
        """Fold one walk's sides into the strip row order. Alive rows keep
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
            # tail keeps its sinking chronology either way (the client's
            # own dead block re-sorts by key — the fold's one cosmetic
            # difference from the client).
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
        # The finished battle's id for the build bridge's quit-clear: the
        # session itself clears below, exactly like telemetry's own clear.
        battle_id = self.session or ''
        self.roster = []
        self.latest_raw = {}
        self.raw_isalive_seen = False
        self.session = ''
        self.previous = None
        self.stable = 0
        self.details_reset()
        self.states = {}
        self.clear_players()
        self.last_raw = ''
        self.discovered = False
        self.comp_dumped = False
        self.empty_ticks = 0
        self.dead_latch = {None} - {None}
        try:
            _bridge_write(TELEMETRY_FILE, json_encode_safe({'t': _to_int(time.time() * 1000),
                                                            'battle': self.session or '',
                                                            'players': {},
                                                            'sortKeys': {},
                                                            'rosterOrder': [],
                                                            'shipNames': {},
                                                            'bots': []}))
        except:
            self.soft('telemetry clear failed=' + _exc_text(120))
        # The build bridge's quit-clear: a leftover builds.json from a
        # closed client must never keep presenting yesterday's loadouts.
        try:
            _bridge_write(BUILDS_FILE, json_encode_safe({'v': 1,
                                                        't': _to_int(time.time() * 1000),
                                                        'battle': battle_id,
                                                        'players': {}}))
        except:
            self.soft('builds clear failed=' + _exc_text(120))
        log('battle cleared')

    def details_reset(self):
        # Per-battle latches: the roster skip latch (players) re-arms so the
        # next battle re-documents a still-drifting schema once, and the
        # battle phase latch stands down (quit lands here too).
        self.skipped_records = {}
        self.in_battle = False
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
        self.avatar_entity_ids = {}
        self.raw_isalive_seen = False
        self.last_order_cache = None
        # The bot-name cache is per battle with the rest of the roster
        # derivations (see bot_names).
        self.last_bots_cache = None
        # The aim verdict is per-battle too.
        self.aim = None
        # Re-arm the aim log gate: the next battle's first switch must
        # log even when its line is byte-identical to the last battle's.
        self.aim_log_last = ''
        # The SELF latch rides the same reset story as the rest of the
        # battle state (a new battle must not inherit the previous one's
        # local player).
        self.self_name = ''
        self.last_panel = ''
        # The client order probe is per battle: a stale verdict must not
        # describe the next battle's roster.
        self.order_probe_done = False
        # The build bridge re-arms per battle: one write per roster
        # session, never one battle's frame inherited by the next.
        self.builds_written = False
        self.builds_tries = 0
        # The degraded-roster fallback re-arms per battle too: grace
        # counting starts over and the next battle's session reports its
        # own (or no) fallback source.
        self.grace_ticks = 0
        self.last_unstable = []
        self.session_fallback = ''
        # Defensive: the walk-width latch is refreshed by write_telemetry
        # before any walk-sourced consumption could read it, but a future
        # tick() reordering must not inherit the previous battle's width.
        self.walk_seen = 0

    def clear_players(self):
        if _UI is None:
            self.entities = {}
            return
        for key in [k for k in self.entities]:
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
        """Roster rows off the raw records, per-record fault-tolerant: one
        drifted record (a build renaming or dropping a field) skips THAT
        row, never the whole roster. The old single-try loop returned []
        on the first missing key, so a schema drift on one client build
        silenced every battle it played (2026-10-11 CN360: two battles,
        quit-clears only, the roster never stabilized). `isBot` missing
        reads as human — the ':' prefix below still filters the game's
        scripted names, and one wrongly-kept row is recoverable while a
        dead roster channel is not. A skipped record logs once per battle
        (the skip latch; a plain log() here would repeat every 2 s tick).
        """
        result = []
        for key, p in records.items():
            try:
                name = p['name']
                if not name or name.startswith(':'):
                    continue
                try:
                    if p['isBot']:
                        continue
                except:
                    pass
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
                result.append({'name': name, 'account_id': (aid if aid > 0 else 0),
                               'avatar_id': _to_int(key), 'ship_id': _to_int(p['shipParamsId']),
                               'realm': realm})
            except:
                self.note_skipped_record(key)
                continue
        # list.sort is a bound method (no builtin-name lookup) and py2.7
        # supports the key argument — the same order sorted() produced.
        result.sort(key=lambda p: p['name'])
        return result[:64]

    def note_skipped_record(self, key):
        """One python.log line per drifted record per battle (dict-as-set —
        the sandbox withholds the set() builtin; see the __init__ census).
        Evidence for exactly the CN360 schema-drift class: which record
        key failed, once, without flooding the 2 s tick loop."""
        skipped = self.__dict__.get('skipped_records')
        if skipped is None:
            skipped = {}
            self.skipped_records = skipped
        if key not in skipped:
            skipped[key] = 1
            log('roster record skipped key=' + _fmt(key))

    def journal_mark(self, kind):
        self.journal.append('{"t":' + _fmt(_to_int(time.time() * 1000)) + ',"ev":' + json_encode_safe(kind) + '}')
        self.journal_flush()

    def journal_flush(self):
        # The sandbox open() has no append mode (it returns None for 'a'), so
        # the journal is rewritten whole from an in-memory ring buffer.
        del self.journal[:-JOURNAL_LIMIT]
        try:
            _bridge_write(ROSTER_JOURNAL_FILE, '\n'.join(self.journal))
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

    def roster_order(self, records):
        """The roster's OWN sequence plus per-player localized ship names,
        straight off the game's records mapping.

        The records mapping iterates in ONE deterministic sequence per key
        set, and the live Lesta capture (2026-10-10) showed the client's
        Tab breaks EQUAL sort keys by that roster-record order (two
        same-key Turennes rendered in record order, not name order) — so
        the sequence is order-bearing evidence the companion cannot
        reconstruct offline (its Lesta roster synthesis sorts (name, id)).
        `shipName` rides the same records when the client's roster data
        carries it: the CN HUD orders rows by the LOCALIZED ship name, a
        string the app's offline DB can only approximate — the record's
        own value is the exact segment the client renders. A build whose
        records lack the field yields an empty map and the companion
        keeps its DB names; nothing here ever raises.

        Returns (order, ship_names): order is the flat list of record
        names (bots included — they hold table rows too), ship_names maps
        name -> localized ship name for the records that carry one.
        """
        order = []
        ship_names = {}
        try:
            for p in records.values():
                try:
                    nm = p['name']
                except:
                    continue
                if not nm:
                    continue
                order.append(nm)
                try:
                    ship_name = p['shipName']
                except:
                    ship_name = None
                if ship_name:
                    ship_names[nm] = _fmt(ship_name)
        except:
            self.soft('roster order failed=' + _exc_text(120))
        return order, ship_names

    def bot_names(self):
        """This battle's AI names, straight off the game's own roster
        records: every `isBot` row plus the scripted-name styles the
        records can carry (':' bots, 'IDS_*' text keys, '#Name' scenario
        units). Bridged so consumers can suppress AI targets without
        trusting name style alone — the event PvEvP modes field bots
        under NORMAL nicknames, and only the record's own flag tells
        those apart from humans. A missing `isBot` reads as human (the
        players() contract); a drifted record skips, never the list.

        Cached per battle: a transient empty getPlayersInfo (the local
        death screen) must not blank the list mid-battle — the
        rosterOrder story. Degraded builds with no records at all yield
        [] and the consumer's own name-style rule carries the judgment.
        """
        names = []
        try:
            for p in self.latest_raw.values():
                try:
                    nm = p['name']
                except:
                    continue
                if not nm:
                    continue
                flagged = False
                try:
                    if p['isBot']:
                        flagged = True
                except:
                    pass
                if not flagged:
                    # The name-style half under its own guard: a record
                    # whose name field holds a non-string skips (the
                    # per-record drift contract), never the whole list.
                    try:
                        if nm.startswith(':') or nm.startswith('IDS_') or nm.startswith('#'):
                            flagged = True
                    except:
                        pass
                if not flagged:
                    continue
                if nm not in names:
                    names.append(nm)
        except:
            self.soft('bot names failed=' + _exc_text(120))
        if names:
            self.last_bots_cache = names
            return names
        return self.last_bots_cache or []

    def observe_raw(self, records):
        """Project roster records plus entity-component state; rewrite
        roster_raw.json on change and append every distinct state to the
        journal so one battle shows the change sequence around TAB re-sorts."""
        try:
            projection = {}
            for key, p in records.items():
                projection[_fmt(key)] = self.project_record(p)
            order, _ = self.roster_order(records)
            body = json_encode_safe({'players': projection,
                                     'states': self.entity_states(),
                                     'order': order})
            if body != self.last_raw:
                first = self.last_raw == ''
                self.last_raw = body
                stamp = _fmt(_to_int(time.time() * 1000))
                try:
                    _bridge_write(ROSTER_RAW_FILE,
                                  '{"t":' + stamp + ',' + body[1:])
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

    # -- events ---------------------------------------------------------------

    def event(self, name, data):
        try:
            if name and name not in self.known_events:
                self.known_events.add(name)
                if self.event_log_count < 400:
                    self.event_log_count += 1
                    log('sfm event ' + _fmt(name))
            if name == 'input.tabModeIn' or name == 'input.tabModeOut':
                # The strips' visibility driver: fires <=3 ms after the key
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

    def walk_roster(self):
        """Roster rows off the entity walk alone — the records path's
        last-resort stand-in (see synthesize_session). The walk's sides
        carry the same names the strips fold; ':'-prefixed bots and
        duplicates drop exactly like players() drops them. Rows carry no
        account ids/realms/ship ids: the identity bridge stays empty and
        the companion falls back to its own realm routing (degraded but
        alive beats a silent stream). Sorted and capped like players().
        On a client whose UiComponents withholds (the Lesta shape) the
        walk stands down and this returns [] — nothing is invented."""
        rows = []
        seen = {}
        try:
            states, sides = self.entity_walk()
            for side in ('ally', 'enemy'):
                for name, alive in sides.get(side, []):
                    if not name or name.startswith(':') or name in seen:
                        continue
                    seen[name] = True
                    rows.append({'name': name, 'account_id': 0,
                                 'avatar_id': 0, 'ship_id': 0, 'realm': ''})
        except:
            self.soft('walk roster failed=' + _exc_text(120))
        rows.sort(key=lambda p: p['name'])
        return rows[:64]

    def synthesize_session(self, roster):
        """Open the telemetry session from the best available roster when
        the records path never stabilizes (ROSTER_GRACE_TICKS battle ticks,
        see tick). Sources in order: this tick's records attempt, the last
        non-empty one (a churning roster beats none — the rows keep their
        account ids, so the identity bridge survives), else the entity
        walk (records dead outright). The session_fallback source rides
        the heartbeat ('fb') so the companion can log the degradation;
        a walk that yields nothing leaves the session unset."""
        rows = roster or self.last_unstable or self.walk_roster()
        if not rows:
            return
        source = 'records' if (roster or self.last_unstable) else 'walk'
        self.clear_players()
        self.roster = rows
        self.dead_latch = {None} - {None}
        self.session = _fmt(_to_int(time.time() * 1000))
        self.details_reset()
        self.session_fallback = source
        log('roster fallback session source=' + source +
            ' players=' + _fmt(len(rows)))

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
            # Remember every non-empty attempt: a roster that churns every
            # tick never stabilizes, but its rows are still the best
            # identity the fallback session has (see synthesize_session).
            self.last_unstable = roster
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
                log('roster stable players=' + _fmt(len(roster)) + ' sample=' + json_encode_safe(roster[0]))
        elif self.session:
            if self.session_fallback == 'walk':
                # A walk-sourced session has no records whose emptiness
                # could end the battle (they were never populated — the
                # records-dead field class). Its liveness signal is the
                # ENTITY WALK itself: the client tears the avatars down at
                # battle end, and a persistently empty walk is the fade
                # signal the records path uses getPlayersInfo() for. The
                # counter is one tick stale by construction (write_telemetry
                # produces it at the END of each tick) — the fade window
                # absorbs that. Without this branch the records-empty quit
                # below fired panel_fade_ticks after synthesis and tore the
                # stream down MID-BATTLE (round-1 review), leaving the
                # heartbeat reporting port while the client still fought.
                if self.walk_seen:
                    self.empty_ticks = 0
                else:
                    self.empty_ticks += 1
                    if self.empty_ticks >= TOOL_CONFIG['panel_fade_ticks']:
                        self.quit()
            else:
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
        # The degraded-roster fallback: a battle whose records never
        # stabilize (empty, failing or churning every tick — the
        # 2026-10-18/19 Steam/CN360 field class) still deserves a
        # telemetry stream instead of a battle-end quit-clear as its only
        # write. The in_battle gate (the game's own battleStart event)
        # keeps port ticks — records empty BY DESIGN there — from ever
        # synthesizing a session.
        if not self.session and self.in_battle:
            self.grace_ticks += 1
            if self.grace_ticks >= ROSTER_GRACE_TICKS:
                self.synthesize_session(roster)
        else:
            self.grace_ticks = 0
        try:
            self.write_json(HEARTBEAT_FILE, {'v': PROBE_VERSION, 't': _to_int(time.time() * 1000),
                                             'phase': 'battle' if self.session or self.in_battle else 'port',
                                             'players': len(self.roster),
                                             'rec': len(self.latest_raw),
                                             'fb': self.session_fallback})
        except:
            self.soft('heartbeat failed=' + _exc_text(120))
        self.write_telemetry()
        if not self.session:
            return
        # The build bridge: one builds.json per battle, written on the
        # first post-stabilization tick that yields readable build fields
        # (a bounded retry covers the old-build shape); see write_builds.
        if not self.builds_written:
            self.write_builds(self.latest_raw)
        # One-shot client order source probe (see client_order_probe): run
        # on the FIRST stabilized tick — a replay can stop a second later,
        # and the AvatarSystem collections are already built by then. It
        # never feeds the strips or telemetry.
        if not self.order_probe_done:
            self.client_order_probe()
            self.order_probe_done = True

    def write_telemetry(self):
        """The M2 consumer file: name-keyed alive flags for the whole
        roster, rewritten EVERY battle tick (the fresh `t` is the
        heartbeat) — wowsp's 2 s poller then broadcasts once per poll
        whether or not anything sank and whether or not Tab is held, and
        consumers can tell a live stream from a dead one by freshness
        instead of a timeout. Cleared once (empty players) on battle
        quit; port ticks write nothing. The same walk feeds the strips'
        rows + row order (see entity_walk).

        Since the realm-reporting change the payload also carries the
        roster's GROUND-TRUTH identity straight off the game's own
        records — `self` (the local player's bare name + realm, so the
        companion stops inferring the realm from logs/install kind) and
        `identity` (name → {account_id, realm}, so cross-server Clan
        Battles rows resolve on their own cluster with no guessing).
        Both stay in every battle write; consumers treat missing/empty
        values as "probe build predates this" and fall back.

        The ordering raw material rides the same write: `rosterOrder`
        (the records mapping's own sequence — the Lesta tie base for
        EQUAL client keys, live 2026-10-10) and `shipNames` (each
        record's localized ship name when the client's roster data
        carries it — the CN HUD's name-order segment verbatim; see
        roster_order). Both are order-preserving lists/maps that survive
        either encoder, and both clear on quit. `bots` (bot_names
        above) rides with them: the game's own per-record AI verdicts,
        so the aim-card consumer can suppress AI targets the nickname
        styles cannot catch (event PvEvP bots under normal names); the
        fail-safe body omits it — an absent field means "no fresh
        verdict", never "no bots". `sides` rides for the same
        consumers-can-fallback reason: the walk's ally/enemy membership
        (the strip fold's own lists, bots included), the records-dead
        build class's only team split — its roster_raw stays empty all
        battle, so the companion's probe-arena synthesizer seats that
        battle's rows off these lists when the records projection has
        nothing; the fail-safe body omits it (no players map there
        either — an outage frame registers no battle).
        """
        if not self.session:
            return
        # Stage markers: the soft-error text is often hidden by the
        # sandbox ('telemetry failed=?'), so the stage name makes a
        # recurring write failure diagnosable from python.log alone.
        stage = 'walk'
        # Pre-seeded so the fail-safe write below can emit the pieces that
        # did make it through this tick. `players_complete` gates the
        # alive map: consumers treat a present `players` object as
        # authoritative, so a partial/empty map must never be published.
        players = {}
        players_complete = False
        try:
            states, sides = self.entity_walk()
            # The walk's width this tick: a walk-sourced session's liveness
            # signal (see tick's empty branch). Latched BEFORE anything can
            # fail below so a mid-stage exception still counts as "walk
            # alive" for this tick.
            self.walk_seen = len(sides.get('ally', [])) + len(sides.get('enemy', []))
            stage = 'sortkeys'
            # The game's own TAB sort keys (see sort_key_probe): read BEFORE
            # the fold so merge_order can sort the strips' alive block with
            # them too, and carried in the payload below.
            self.sort_keys = self.sort_key_probe()
            # Shared with the strip row builder so alive flags + sides cost
            # one entity walk per tick, not two.
            self.states = states
            stage = 'fold'
            self.merge_order(sides)
            stage = 'alive'
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
            stage = 'alive-raw'
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
            stage = 'alive-roster'
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
                # states: the strip rows (panel_rows, below) read them, so
                # the strips show the same truth as the telemetry instead
                # of the walk's raw read.
                if name in states:
                    states[name]['alive'] = 'True' if alive else 'False'
                stage = 'alive-identity'
                if p.get('account_id') or p.get('realm'):
                    identity[name] = {'account_id': p.get('account_id', 0),
                                      'realm': p.get('realm', '')}
            players_complete = True
            stage = 'self'
            self_name = ''
            try:
                self_name = self.self_name or ''
            except:
                self_name = ''
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
            # The roster's own record sequence + the records' localized
            # ship names (roster_order above): the Lesta tie base (equal
            # client keys keep the roster order, live 2026-10-10) and the
            # CN name-order segment's client-exact input. Empty list/map
            # (an old probe build, or a records shape without shipName)
            # reads as "absent" in the companion and changes nothing.
            # A TRANSIENT empty getPlayersInfo (the local death screen
            # blanks it for a second or two — see tick's empty_ticks)
            # must not blank the order mid-battle: `players` survives it
            # off the stable roster, so the raw-material fields hold the
            # last non-empty derivation for the same one-two seconds
            # instead of flapping the companion's tie base to null.
            stage = 'order'
            roster_order, ship_names = self.roster_order(self.latest_raw)
            if roster_order:
                self.last_order_cache = (roster_order, ship_names)
            elif self.roster and self.last_order_cache is not None:
                roster_order, ship_names = self.last_order_cache
            # This battle's AI names (bot_names above): the aim-card
            # consumer suppresses AI targets off it — the records' own
            # isBot flag is the one judgment a nickname style cannot
            # fake. Same caching story as the order fields.
            stage = 'bots'
            bots = self.bot_names()
            # Distinct from the earlier 'self' stage (the self_name
            # resolution): a failure here logs the realm scan precisely.
            stage = 'self-realm'
            self_realm = ''
            try:
                for p in self.roster:
                    if p['name'] == self_name and p.get('realm'):
                        self_realm = p['realm']
                        break
            except:
                self_realm = ''
            # The aim verdict the walk latched earlier THIS tick (a plain
            # dict read — nothing here can fail, so no stage of its own).
            aim_now = self.aim if _is_kind(self.aim, 'dict') else None
            stage = 'encode'
            body = json_encode_safe({'t': _to_int(time.time() * 1000),
                                     'battle': self.session,
                                     'players': players,
                                     'sortKeys': sort_keys,
                                     'rosterOrder': roster_order,
                                     'shipNames': ship_names,
                                     'bots': bots,
                                     # The walk's side membership (the same
                                     # fold lists the strips render): the
                                     # records-dead build class's ONLY team
                                     # split — its roster_raw stays empty all
                                     # battle, so the companion's probe-arena
                                     # synthesizer falls back to these name
                                     # lists to seat the battle's rows. Bots
                                     # included (they hold table rows); the
                                     # self row stays inside 'ally' (the
                                     # relation walk files SELF under ally).
                                     'sides': {'ally': self.order.get('ally', []),
                                               'enemy': self.order.get('enemy', [])},
                                     'self': {'name': self_name, 'realm': self_realm},
                                     'identity': identity,
                                     # The aim verdict every tick (empty name
                                     # = no target): the replay/live monitor
                                     # reads this to watch aim switches.
                                     'aim': {'name': aim_now['name'] if aim_now else '',
                                             'flags': aim_now['flags'] if aim_now else 0}})
            stage = 'write'
            _bridge_write(TELEMETRY_FILE, body)
        except:
            self.soft('telemetry failed@' + stage + '=' + _exc_text(120))
            # Fail-safe: one auxiliary stage must not freeze the whole
            # telemetry stream. Emit what was actually collected; publish
            # the alive map only when the roster loop completed (a
            # present `players` object is authoritative to consumers, so
            # an empty/partial map would falsely assert "everyone alive").
            # Without `players` the consumers ignore the frame and the
            # app's stale-stream fallback still applies.
            try:
                fallback = {'t': _to_int(time.time() * 1000),
                            'battle': self.session,
                            'sortKeys': self.sort_keys,
                            'rosterOrder': [],
                            'shipNames': {},
                            'self': {'name': '', 'realm': ''},
                            'identity': {}}
                if players_complete:
                    fallback['players'] = players
                _bridge_write(TELEMETRY_FILE, json_encode_safe(fallback))
            except:
                pass
        self.refresh_panel()

    # -- barcode strips ------------------------------------------------------
    # One data component ('wowspProbe.panel') carries the strips' whole
    # payload: visibility (Tab held) and both sides' rows in fold order,
    # each with its roster-rank barcode word. Everything the strips show
    # is decided HERE so the unbound view stays a dumb template that
    # cannot rot per game version. (The in-game stats tables and the
    # crosshair aim panel were cut with the app's in-game view mode on
    # 2026-10-19; the aim verdict itself rides telemetry.)

    def panel_rows(self, side):
        rows = []
        # The avatar id is the key the client's own sortedAlive collection
        # iterates; the unbound view maps each collection entry to its
        # strip row by this id (names carry clan tags there, ids do not).
        # The WALK's sticky entity ids are authoritative (they share the
        # collection's id space and cover the bots, whose roster records
        # carry no avatarId at all — a co-op side keyed on the records'
        # mapping keys would pair nothing); the roster record's avatar_id
        # stays as the fallback for a name the walk has not seen yet.
        ids = self.avatar_entity_ids
        for p in self.roster:
            try:
                aid = _to_int(p.get('avatar_id', 0))
                nm = p.get('name')
                if aid and nm and nm not in ids:
                    ids[nm] = aid
            except:
                pass
        # The canonical rank every row carries: its position in the
        # rosterOrder bridge (the records mapping's own sequence, bots
        # included) — the SAME list the companion's telemetry publishes,
        # so the overlay's barcode decoder resolves rank -> name through
        # the telemetry it already holds. Sourced from the cached
        # derivation so a transient empty getPlayersInfo cannot renumber
        # the rows mid-battle.
        roster_order, _ship_names = self.roster_order(self.latest_raw)
        if not roster_order and self.last_order_cache is not None:
            roster_order = self.last_order_cache[0]
        ranks = {}
        pos = 0
        for nm in roster_order:
            if nm and nm not in ranks:
                ranks[nm] = pos
                pos += 1
        for name in self.order.get(side, []):
            if not name:
                continue
            state = self.states.get(name)
            # Latched names are dead even with their entity gone.
            alive = name not in self.dead_latch and (
                state is None or state.get('alive') != 'False')
            rank = ranks.get(name, -1)
            # A rankless row (a name the records never carried) renders a
            # parity-INVALID word, never an empty array: the DSL indexes
            # bits[0..5] unguarded, and the decoder's parity check fails
            # the row — it must never guess a rank.
            bits = self.barcode_bits(rank) if 0 <= rank < 32 else \
                [True, False, False, False, False, False, False, False]
            rows.append({'name': name,
                         'avatar_id': ids.get(name, 0),
                         'idx': rank,
                         'bits': bits,
                         'alive': alive})
        return rows

    def barcode_bits(self, rank):
        """The capture side channel's per-row word (see the design doc for
        the frozen contract): [1, 0] sync + 5 index bits MSB-first + one
        EVEN parity bit over the five — six booleans the unbound strip
        renders as on/off blocks and the overlay's decoder reads back.
        Pure arithmetic on ints/bools; no builtins."""
        out = [True, False]
        parity = 0
        for shift in (16, 8, 4, 2, 1):
            bit = (rank & shift) != 0
            if bit:
                parity += 1
            out.append(True if bit else False)
        out.append(parity % 2 == 0)
        return out

    def refresh_panel(self):
        if not self.session:
            return
        try:
            ally = self.panel_rows('ally')
            enemy = self.panel_rows('enemy')
            ally_by_id = {}
            for row in ally:
                aid = row.get('avatar_id', 0)
                if aid:
                    ally_by_id[_fmt(aid)] = row
            enemy_by_id = {}
            for row in enemy:
                aid = row.get('avatar_id', 0)
                if aid:
                    enemy_by_id[_fmt(aid)] = row
            data = {'visible': True if (self.tab and (ally or enemy)) else False,
                    'barcode': TOOL_CONFIG.get('barcode', 0) == 1,
                    'ally': ally,
                    'enemy': enemy,
                    'allyById': ally_by_id,
                    'enemyById': enemy_by_id}
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
