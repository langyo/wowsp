"""Decode and execute WoWS client Python-2.7 bytecode — stdlib only.

The live client ships its game scripts as a plain zip,
``bin/<build>/res/scripts.zip``, full of ``.pyc`` files for CPython 2.7
(magic 03 F3 0D 0A) behind four obfuscation layers:

  1. three wrapper stages — ``consts`` XOR ``co_code`` -> base64 -> zlib,
     then a 256-entry permutation + ``bitop`` + reverse, then a
     ``<<<>>>``-split base64/zlib payload (see :func:`decode_real`);
  2. junk bytes spliced into ``co_code`` (unreachable; skipped via
     :func:`reachable_mask` instead of being NOP-ed in place);
  3. basic-block shuffling with leading ``JUMP_ABSOLUTE`` entries;
  4. identifier renaming of module/class/local names, recoverable from the
     module's ``__all__`` order (:func:`apply_renames`) — string VALUES are
     never encrypted.

The :class:`Frame` mini-VM executes only what static-data modules need
(dict / set / class-body / generator-expression construction); it is not a
general interpreter. Built for
``scripts/ClientCrewSkills/CrewSkillRecomendationPresets`` (the in-game
recommended-skill table) and reusable for future static-data recovery.

Provenance: extends ``scripts/pyc_deob/deob_pyc.py`` (BattleResults session)
with a full-fidelity marshal reader and a bytecode-execution approach.
"""
from __future__ import annotations

import base64
import struct
import sys
import zlib

# ── Python 2.7 opcode tables (generated from xdis opcode_27) ──────────────
HAVE_ARGUMENT = 90
OPNAME = (
    ('STOP_CODE', 'POP_TOP', 'ROT_TWO', 'ROT_THREE', 'DUP_TOP', 'ROT_FOUR', '<6>', '<7>', '<8>', 'NOP', 'UNARY_POSITIVE', 'UNARY_NEGATIVE', 'UNARY_NOT', 'UNARY_CONVERT', '<14>', 'UNARY_INVERT', '<16>', '<17>', '<18>', 'BINARY_POWER', 'BINARY_MULTIPLY', 'BINARY_DIVIDE', 'BINARY_MODULO', 'BINARY_ADD', 'BINARY_SUBTRACT', 'BINARY_SUBSCR', 'BINARY_FLOOR_DIVIDE', 'BINARY_TRUE_DIVIDE', 'INPLACE_FLOOR_DIVIDE', 'INPLACE_TRUE_DIVIDE', 'SLICE+0', 'SLICE+1', 'SLICE+2', 'SLICE+3', '<34>', '<35>', '<36>', '<37>', '<38>', '<39>', 'STORE_SLICE+0', 'STORE_SLICE+1', 'STORE_SLICE+2', 'STORE_SLICE+3', '<44>', '<45>', '<46>', '<47>', '<48>', '<49>', 'DELETE_SLICE+0', 'DELETE_SLICE+1', 'DELETE_SLICE+2', 'DELETE_SLICE+3', 'STORE_MAP', 'INPLACE_ADD', 'INPLACE_SUBTRACT', 'INPLACE_MULTIPLY', 'INPLACE_DIVIDE', 'INPLACE_MODULO', 'STORE_SUBSCR', 'DELETE_SUBSCR', 'BINARY_LSHIFT', 'BINARY_RSHIFT', 'BINARY_AND', 'BINARY_XOR', 'BINARY_OR', 'INPLACE_POWER', 'GET_ITER', '<69>', 'PRINT_EXPR', 'PRINT_ITEM', 'PRINT_NEWLINE', 'PRINT_ITEM_TO', 'PRINT_NEWLINE_TO', 'INPLACE_LSHIFT', 'INPLACE_RSHIFT', 'INPLACE_AND', 'INPLACE_XOR', 'INPLACE_OR', 'BREAK_LOOP', 'WITH_CLEANUP', 'LOAD_LOCALS', 'RETURN_VALUE', 'IMPORT_STAR', 'EXEC_STMT', 'YIELD_VALUE', 'POP_BLOCK', 'END_FINALLY', 'BUILD_CLASS', 'STORE_NAME', 'DELETE_NAME', 'UNPACK_SEQUENCE', 'FOR_ITER', 'LIST_APPEND', 'STORE_ATTR', 'DELETE_ATTR', 'STORE_GLOBAL', 'DELETE_GLOBAL', 'DUP_TOPX', 'LOAD_CONST', 'LOAD_NAME', 'BUILD_TUPLE', 'BUILD_LIST', 'BUILD_SET', 'BUILD_MAP', 'LOAD_ATTR', 'COMPARE_OP', 'IMPORT_NAME', 'IMPORT_FROM', 'JUMP_FORWARD', 'JUMP_IF_FALSE_OR_POP', 'JUMP_IF_TRUE_OR_POP', 'JUMP_ABSOLUTE', 'POP_JUMP_IF_FALSE', 'POP_JUMP_IF_TRUE', 'LOAD_GLOBAL', '<117>', '<118>', 'CONTINUE_LOOP', 'SETUP_LOOP', 'SETUP_EXCEPT', 'SETUP_FINALLY', '<123>', 'LOAD_FAST', 'STORE_FAST', 'DELETE_FAST', '<127>', '<128>', '<129>', 'RAISE_VARARGS', 'CALL_FUNCTION', 'MAKE_FUNCTION', 'BUILD_SLICE', 'MAKE_CLOSURE', 'LOAD_CLOSURE', 'LOAD_DEREF', 'STORE_DEREF', '<138>', '<139>', 'CALL_FUNCTION_VAR', 'CALL_FUNCTION_KW', 'CALL_FUNCTION_VAR_KW', 'SETUP_WITH', '<144>', 'EXTENDED_ARG', 'SET_ADD', 'MAP_ADD', '<148>', '<149>', '<150>', '<151>', '<152>', '<153>', '<154>', '<155>', '<156>', '<157>', '<158>', '<159>', '<160>', '<161>', '<162>', '<163>', '<164>', '<165>', '<166>', '<167>', '<168>', '<169>', '<170>', '<171>', '<172>', '<173>', '<174>', '<175>', '<176>', '<177>', '<178>', '<179>', '<180>', '<181>', '<182>', '<183>', '<184>', '<185>', '<186>', '<187>', '<188>', '<189>', '<190>', '<191>', '<192>', '<193>', '<194>', '<195>', '<196>', '<197>', '<198>', '<199>', '<200>', '<201>', '<202>', '<203>', '<204>', '<205>', '<206>', '<207>', '<208>', '<209>', '<210>', '<211>', '<212>', '<213>', '<214>', '<215>', '<216>', '<217>', '<218>', '<219>', '<220>', '<221>', '<222>', '<223>', '<224>', '<225>', '<226>', '<227>', '<228>', '<229>', '<230>', '<231>', '<232>', '<233>', '<234>', '<235>', '<236>', '<237>', '<238>', '<239>', '<240>', '<241>', '<242>', '<243>', '<244>', '<245>', '<246>', '<247>', '<248>', '<249>', '<250>', '<251>', '<252>', '<253>', '<254>', '<255>',)
)
CMP_OP = ("<", "<=", "==", "!=", ">", ">=", "in", "not in", "is", "is not",
          "exc match", "BAD", "else", "classname")
LOAD_LOCALS_OP = OPNAME.index("LOAD_LOCALS")
JABS, JFWD, RET = 113, 110, 83
COND = {111, 112, 114, 115}  # *_OR_POP, POP_JUMP_IF_FALSE/TRUE
FOR_ITER, CONTINUE_LOOP = 93, 119
SETUP = {120, 121, 122}


def _s(x):
    return x.decode("utf-8", "replace") if isinstance(x, bytes) else x


# ── marshal reader (py2.7, full fidelity) ─────────────────────────────────

NULL, NONE, TRUE, FALSE = ord("0"), ord("N"), ord("T"), ord("F")
INT, LONG, FLOAT = ord("i"), ord("l"), ord("d")
STRING, UNICODE, TUPLE, INTERNED, REF, CODE = ord("s"), ord("u"), ord("("), ord("t"), ord("r"), ord("c")
LIST, DICT, STOPITER, ELLIPSIS = ord("["), ord("{"), ord("S"), ord("E")
INT64, BINARY_FLOAT = ord("I"), ord("g")


class CodeDict(dict):
    """Hashable dict standing in for a marshal code object."""

    def __hash__(self):
        return id(self)


class Uni(object):
    __slots__ = ("raw", "text")

    def __init__(self, raw, text):
        self.raw = raw
        self.text = text

    def __repr__(self):
        return "Uni(%r)" % self.text


class FullReader(object):
    """py2.7 marshal reader keeping ALL code fields + raw unicode bytes.

    ``ref_mode`` controls which objects register for 'r'/'R' back-references:
    'all' (strings, tuples, lists, dicts, code), 'nocode' (same minus code),
    'str' (strings/unicode only) — WG modules vary; decode_real auto-detects.
    """

    REG = {"all": 0xFF, "nocode": 0xFF ^ 0x04, "str": 0x01}

    def __init__(self, data, ref_mode="str"):
        self.data = data
        self.pos = 0
        self.refs = []
        self.ref_mode = self.REG.get(ref_mode, 0xFF)

    def u8(self):
        v = self.data[self.pos]
        self.pos += 1
        return v

    def i32(self):
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def read(self, n):
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v

    def parse(self):
        return self._obj()

    def _obj(self):
        t = self.u8()
        if t in (NULL, NONE):
            return None
        if t == TRUE:
            return True
        if t == FALSE:
            return False
        if t == INT:
            return self.i32()
        if t == INT64:
            v = struct.unpack_from("<q", self.data, self.pos)[0]
            self.pos += 8
            return v
        if t == LONG:
            n = self.i32()
            neg = n < 0
            n = abs(n)
            v = 0
            for i in range(n):
                v |= struct.unpack_from("<H", self.data, self.pos + 2 * i)[0] << (15 * i)
            self.pos += 2 * n
            return -v if neg else v
        if t == BINARY_FLOAT:
            v = struct.unpack_from("<d", self.data, self.pos)[0]
            self.pos += 8
            return v
        if t == FLOAT:
            end = self.data.index(b"\n", self.pos)
            s = self.read(end - self.pos)
            self.pos += 1
            return float(s)
        if t in (STRING, INTERNED):
            n = self.i32()
            v = self.read(n)
            if self.ref_mode & 0x01:
                self.refs.append(v)
            return v
        if t == UNICODE:
            n = self.i32()
            raw = self.read(n)
            try:
                text = raw.decode("utf-8")
            except Exception:
                text = raw.decode("utf-8", "replace")
            if self.ref_mode & 0x01:
                self.refs.append(raw)
            return Uni(raw, text)
        if t == TUPLE:
            n = self.i32()
            items = tuple(self._obj() for _ in range(n))
            if self.ref_mode & 0x02:
                self.refs.append(items)
            return items
        if t == LIST:
            n = self.i32()
            items = [self._obj() for _ in range(n)]
            if self.ref_mode & 0x02:
                self.refs.append(items)
            return items
        if t == DICT:
            d = {}
            while True:
                k = self._obj()
                if k is None:
                    break
                v = self._obj()
                d[k] = v
            if self.ref_mode & 0x02:
                self.refs.append(d)
            return d
        if t == STOPITER:
            return StopIteration
        if t == ELLIPSIS:
            return Ellipsis
        if t in (REF, ord("R")):  # 'r' and the WG-variant 'R' back-reference
            idx = self.i32()
            if idx < len(self.refs):
                return self.refs[idx]
            raise ValueError("ref out of range %d/%d" % (idx, len(self.refs)))
        if t == CODE:
            obj = CodeDict({
                "__code__": True,
                "argcount": self.i32(), "nlocals": self.i32(),
                "stacksize": self.i32(), "flags": self.i32(),
                "code": self._obj(), "consts": self._obj(),
                "names": self._obj(), "varnames": self._obj(),
                "freevars": self._obj(), "cellvars": self._obj(),
                "filename": self._obj(), "name": self._obj(),
                "firstlineno": self.i32(), "lnotab": self._obj(),
            })
            if self.ref_mode & 0x04:
                self.refs.append(obj)
            return obj
        raise ValueError("unknown marshal type 0x%02x at %d" % (t, self.pos))


def bitop(b, A, C):
    return ((b ^ A) & 126 | ((b ^ A) >> 7) & 1 | ((b ^ A) & 1) << 7) ^ C


def find_perm(obj, seen=None):
    """Locate the 256-entry permutation (dict/list of ints 0..255) in a wrapper."""
    if seen is None:
        seen = set()
    if id(obj) in seen:
        return None
    seen.add(id(obj))
    if isinstance(obj, dict) and len(obj) == 256:
        try:
            if all(isinstance(k, int) and isinstance(v, int) and 0 <= v < 256 for k, v in obj.items()):
                return obj
        except Exception:
            pass
    if isinstance(obj, (bytes, list, tuple)) and len(obj) == 256:
        try:
            if all(isinstance(x, int) and 0 <= x < 256 for x in obj):
                return list(obj)
        except Exception:
            pass
    if isinstance(obj, dict):
        for v in obj.values():
            r = find_perm(v, seen)
            if r is not None:
                return r
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            r = find_perm(v, seen)
            if r is not None:
                return r
    return None


def decode_real(pyc_data, verbose=False):
    """Three-stage decode -> the real module's code-object dict."""
    # stage 1: consts XOR co_code -> base64 -> zlib = stage-2 marshal
    s1 = FullReader(pyc_data[8:]).parse()
    code1 = s1["code"]
    plain = None
    for enc in [c for c in s1["consts"] if isinstance(c, bytes) and len(c) >= 64]:
        dec = bytes(b ^ code1[i % len(code1)] for i, b in enumerate(enc))
        try:
            plain = zlib.decompress(base64.b64decode(dec))
            break
        except Exception:
            continue
    if plain is None:
        raise ValueError("no const decrypts to zlib(base64) blob")
    wrapper = FullReader(plain).parse()
    # stage 2: permutation -> bitop -> reverse = stage-3 marshal
    perm = find_perm(wrapper)
    if perm is None:
        raise ValueError("no 256-entry permutation found in wrapper")
    stage3 = None
    last_err = None
    for A, C in ((38, 89),):
        blob = bytes(bitop(perm[b], A, C) for b in code1)[::-1]
        try:
            s3 = FullReader(blob).parse()
        except Exception as e:
            last_err = e
            continue
        if b"<<<>>>" in s3["code"]:
            stage3 = s3
            if verbose:
                print("  bitop A=%d C=%d" % (A, C))
    if stage3 is None:
        for A in range(256):
            for C in range(256):
                blob = bytes(bitop(perm[b], A, C) for b in code1)[::-1]
                try:
                    s3 = FullReader(blob).parse()
                except Exception as e:
                    last_err = e
                    continue
                if b"<<<>>>" in s3["code"]:
                    stage3 = s3
                    break
            if stage3 is not None:
                break
    if stage3 is None:
        raise ValueError("stage-3 parse failed: %r" % last_err)
    # stage 3: <<<>>>-split payload -> base64 -> zlib = real module marshal
    parts = stage3["code"].split(b"<<<>>>")
    zdata = zlib.decompress(base64.b64decode(parts[1][::-1]))
    last_err = None
    for mode in ("all", "str", "nocode"):
        try:
            real = FullReader(zdata, ref_mode=mode).parse()
        except Exception as e:
            last_err = e
            continue
        if all(isinstance(n, bytes) for n in real["names"]):
            return real
    raise ValueError("no ref mode produced sane names: %r" % last_err)


# ── junk-byte reachability (py2.7 CFG walk) ───────────────────────────────
# NOTE: EXTENDED_ARG (144) is not modelled here or in the VM; WG's shipped
# modules have not used it. Revisit if a future build fails to decode.

def reachable_mask(code):
    """1 = offset belongs to a reachable instruction; junk bytes stay 0."""
    n = len(code)
    mask = bytearray(n)
    stack = [0]
    while stack:
        off = stack.pop()
        while 0 <= off < n and not mask[off]:
            op = code[off]
            if op >= HAVE_ARGUMENT:
                if off + 3 > n:
                    return bytes(mask)  # trailing partial instruction: junk
                mask[off] = mask[off + 1] = mask[off + 2] = 1
                arg = code[off + 1] | (code[off + 2] << 8)
                if op == JABS:
                    stack.append(arg)
                    break
                if op == JFWD:
                    stack.append(off + 3 + arg)
                    break
                if op in COND:
                    stack.append(arg)
                    off += 3
                    continue
                if op == FOR_ITER:
                    stack.append(off + 3 + arg)
                    off += 3
                    continue
                if op in SETUP:
                    stack.append(arg)
                    off += 3
                    continue
                if op == CONTINUE_LOOP:
                    stack.append(arg)
                    break
                off += 3
            else:
                mask[off] = 1
                if op == RET:
                    break
                off += 1
    return bytes(mask)


def walk_ops(code):
    """Yield (offset, opname, arg) for reachable instructions."""
    c = code["code"]
    try:
        mask = reachable_mask(c)
    except Exception:
        mask = bytes(len(c))
    off = 0
    n = len(c)
    while off < n:
        if not mask[off]:
            off += 1
            continue
        op = c[off]
        arg = None
        if op >= HAVE_ARGUMENT:
            if off + 3 > n:
                break
            arg = c[off + 1] | (c[off + 2] << 8)
        yield off, OPNAME[op], arg
        off += 3 if op >= HAVE_ARGUMENT else 1


def has_op(code, name):
    return any(nm == name for _, nm, _ in walk_ops(code))


# ── mini VM (static-data modules only) ────────────────────────────────────

class Py2Func(object):
    def __init__(self, code, module, defaults=()):
        self.code = code
        self.module = module
        self.defaults = defaults
        self.name = _s(code["name"])

    def __repr__(self):
        return "<func %s>" % self.name


class PyClass(object):
    def __init__(self, name, bases, attrs):
        self.__name__ = _s(name)
        self.attrs = attrs
        self.bases = bases

    def get(self, name):
        if name in self.attrs:
            return self.attrs[name]
        for b in self.bases:
            if isinstance(b, PyClass):
                r = b.get(name)
                if r is not None:
                    return r
        return None

    def __repr__(self):
        return "<class %s>" % self.__name__


class Module(object):
    def __init__(self, name):
        self.name = name
        self.ns = {}
        self.assign_log = []
        # Keys in here were seeded by the caller (injected providers); the
        # module's own assignments must not shadow them mid-execution.
        self.frozen = set()

    def __repr__(self):
        return "<module %s>" % self.name


class YieldSignal(Exception):
    def __init__(self, value):
        self.value = value


class Dummy(object):
    """Inert value for unresolvable imports: any attr, any call, empty iter."""

    def __getattr__(self, name):
        return DUMMY

    def __call__(self, *a, **kw):
        return DUMMY

    def __iter__(self):
        return iter(())

    def __eq__(self, o):
        return False

    def __ne__(self, o):
        return True

    def __hash__(self):
        return 0

    def __repr__(self):
        return "<dummy>"


DUMMY = Dummy()


class _SysStub(object):
    maxint = 2147483647
    maxsize = 2147483647
    platform = "win32"
    version = "2.7.18"

    def __getattr__(self, name):
        return DUMMY


GLOBALS = {
    "sys": _SysStub(),
    "frozenset": frozenset, "set": set, "sorted": sorted, "dict": dict,
    "list": list, "tuple": tuple, "len": len, "object": object, "str": str,
    "int": int, "float": float, "iter": iter, "enumerate": enumerate,
    "True": True, "False": False, "None": None,
}


def get_attr(obj, name):
    name = _s(name)
    if isinstance(obj, PyClass):
        v = obj.get(name)
        if v is None:
            if LENIENT:
                MISSED.add((obj.__name__, "class-attr", _s(name)))
                return DUMMY
            raise AttributeError("%s.%s" % (obj.__name__, name))
        return v
    if isinstance(obj, Module):
        if name in obj.ns:
            return obj.ns[name]
        if LENIENT:
            MISSED.add((obj.name, "module-attr", _s(name)))
            return DUMMY
        raise AttributeError("%s: no attr %s" % (obj.name, name))
    if name == "iteritems":
        return lambda: list(obj.items())
    if name == "iterkeys":
        return lambda: list(obj.keys())
    if name == "itervalues":
        return lambda: list(obj.values())
    if name == "has_key":
        return lambda k: k in obj
    try:
        return getattr(obj, name)
    except AttributeError:
        if LENIENT:
            return DUMMY
        raise


class Frame(object):
    def __init__(self, code, module, args):
        self.code = code
        self.names = [_s(n) for n in code["names"]]
        self.consts = code["consts"]
        self.varnames = [_s(v) for v in code["varnames"]]
        self.stack = []
        self.blocks = []
        self.module = module
        self.locals = {}
        self._is_class_body = None
        argcount = code["argcount"]
        for i, a in enumerate(args[:argcount]):
            self.locals[self.varnames[i]] = a
        if self.varnames and self.varnames[0] == ".0" and len(args) == 1:
            self.locals[".0"] = args[0]
        self.saved_off = 0

    def is_class_body(self):
        if self._is_class_body is None:
            self._is_class_body = has_op(self.code, "LOAD_LOCALS")
        return self._is_class_body

    def step(self):
        code = self.code["code"]
        n = len(code)
        off = self.saved_off
        self.saved_off = 0
        while off < n:
            op = code[off]
            nm = OPNAME[op]
            arg = None
            size = 1
            if op >= HAVE_ARGUMENT:
                arg = code[off + 1] | (code[off + 2] << 8)
                size = 3
            try:
                off = self.exec_op(nm, arg, off, size)
            except YieldSignal as y:
                self.saved_off = off + size
                return ("yield", y.value)
            if off is None:
                return ("return", self.stack.pop() if self.stack else None)
        return ("return", None)

    def exec_op(self, nm, arg, off, size):
        """Returns the next offset, or None on RETURN."""
        st = self.stack
        if nm == "LOAD_CONST":
            st.append(self.consts[arg])
        elif nm == "LOAD_NAME":
            key = self.names[arg]
            if key in self.locals:
                st.append(self.locals[key])
            elif key in self.module.ns:
                st.append(self.module.ns[key])
            elif key in GLOBALS:
                st.append(GLOBALS[key])
            elif LENIENT:
                MISSED.add((self.module.name, "name", key))
                st.append(DUMMY)
            else:
                raise NameError(key)
        elif nm == "STORE_NAME":
            key = self.names[arg]
            v = st.pop()
            self.locals[key] = v
            if key not in self.module.frozen:
                self.module.ns[key] = v
                self.module.assign_log.append((key, v))
        elif nm == "LOAD_FAST":
            st.append(self.locals[self.varnames[arg]])
        elif nm == "STORE_FAST":
            self.locals[self.varnames[arg]] = st.pop()
        elif nm == "LOAD_GLOBAL":
            key = self.names[arg]
            if key in GLOBALS:
                st.append(GLOBALS[key])
            elif key in self.module.ns:
                st.append(self.module.ns[key])
            else:
                MISSED.add((self.module.name, "global", key))
                if LENIENT:
                    st.append(DUMMY)
                else:
                    raise NameError("global %s" % key)
        elif nm == "LOAD_ATTR":
            st.append(get_attr(st.pop(), self.names[arg]))
        elif nm == "STORE_ATTR":
            v = st.pop()
            setattr(st.pop(), self.names[arg], v)
        elif nm == "IMPORT_STAR":
            mod = st.pop()
            if hasattr(mod, "ns"):
                for k, v in mod.ns.items():
                    if not k.startswith("_"):
                        self.module.ns[k] = v
        elif nm == "IMPORT_NAME":
            st.pop()  # fromlist
            st.append(import_module(self.names[arg]))
        elif nm == "IMPORT_FROM":
            st.append(get_attr(st[-1], self.names[arg]))
        elif nm == "POP_TOP":
            st.pop()
        elif nm in ("BUILD_TUPLE", "BUILD_LIST", "BUILD_SET"):
            items = st[len(st) - arg:] if arg else []
            if arg:
                del st[len(st) - arg:]
            st.append(tuple(items) if nm == "BUILD_TUPLE" else
                      (set(items) if nm == "BUILD_SET" else items))
        elif nm == "MAP_ADD":
            key, value = st[-2], st[-1]
            mi = -3
            while not isinstance(st[mi], dict):
                mi -= 1
            st[mi][key] = value
            del st[-2:]
        elif nm == "BUILD_MAP":
            st.append({})
        elif nm == "STORE_MAP":
            key = st.pop()
            value = st.pop()
            st[-1][key] = value
        elif nm in ("MAKE_FUNCTION", "MAKE_CLOSURE"):
            if arg & 0x08:
                st.pop()
            c = st.pop()
            defaults = ()
            if arg & 0x01:
                defaults = st.pop()
            st.append(Py2Func(c, self.module, defaults))
        elif nm == "CALL_FUNCTION":
            args = st[len(st) - arg:] if arg else []
            if arg:
                del st[len(st) - arg:]
            st.append(call_value(st.pop(), args))
        elif nm == "BUILD_CLASS":
            d = st.pop()
            bases = st.pop()
            name = _s(st.pop())
            attrs = dict(d) if isinstance(d, dict) else dict(d())
            st.append(PyClass(name, bases if isinstance(bases, tuple) else (bases,), attrs))
        elif nm == "GET_ITER":
            st.append(iter(st.pop()))
        elif nm == "FOR_ITER":
            try:
                st.append(next(st[-1]))
            except StopIteration:
                st.pop()
                return off + 3 + arg
        elif nm in ("SETUP_LOOP", "SETUP_EXCEPT", "SETUP_FINALLY"):
            self.blocks.append((nm, arg))
        elif nm == "POP_BLOCK":
            if self.blocks:
                self.blocks.pop()
        elif nm == "BREAK_LOOP":
            _, target = self.blocks.pop()
            return target
        elif nm == "JUMP_ABSOLUTE":
            return arg
        elif nm == "JUMP_FORWARD":
            return off + 3 + arg
        elif nm == "POP_JUMP_IF_FALSE":
            if not st.pop():
                return arg
        elif nm == "POP_JUMP_IF_TRUE":
            if st.pop():
                return arg
        elif nm == "JUMP_IF_FALSE_OR_POP":
            if not st[-1]:
                return arg
            st.pop()
        elif nm == "JUMP_IF_TRUE_OR_POP":
            if st[-1]:
                return arg
            st.pop()
        elif nm == "COMPARE_OP":
            b = st.pop()
            a = st.pop()
            op = CMP_OP[arg]
            st.append(a < b if op == "<" else a <= b if op == "<=" else
                      a == b if op == "==" else a != b if op == "!=" else
                      a > b if op == ">" else a >= b if op == ">=" else
                      a in b if op == "in" else a not in b if op == "not in" else
                      a is b if op == "is" else a is not b)
        elif nm == "RETURN_VALUE":
            return None
        elif nm == "YIELD_VALUE":
            raise YieldSignal(st.pop())
        elif nm == "DUP_TOP":
            st.append(st[-1])
        elif nm == "ROT_TWO":
            st[-1], st[-2] = st[-2], st[-1]
        elif nm == "ROT_THREE":
            st[-1], st[-2], st[-3] = st[-2], st[-3], st[-1]
        elif nm == "UNPACK_SEQUENCE":
            items = list(st.pop())
            for x in reversed(items):
                st.append(x)
        elif nm == "LIST_APPEND":
            v = st.pop()
            st[-arg].append(v)
        elif nm == "BINARY_SUBSCR":
            k = st.pop()
            st.append(st.pop()[k])
        elif nm == "STORE_SUBSCR":
            k = st.pop()
            o = st.pop()
            o[k] = st.pop()
        elif nm in ("BINARY_ADD", "INPLACE_ADD"):
            b = st.pop()
            st.append(st.pop() + b)
        elif nm in ("BINARY_SUBTRACT", "INPLACE_SUBTRACT"):
            b = st.pop()
            st.append(st.pop() - b)
        elif nm in ("BINARY_MULTIPLY", "INPLACE_MULTIPLY"):
            b = st.pop()
            st.append(st.pop() * b)
        elif nm in ("BINARY_DIVIDE", "BINARY_TRUE_DIVIDE", "INPLACE_DIVIDE", "INPLACE_TRUE_DIVIDE"):
            b = st.pop()
            st.append(st.pop() / b)
        elif nm in ("BINARY_FLOOR_DIVIDE", "INPLACE_FLOOR_DIVIDE"):
            b = st.pop()
            st.append(st.pop() // b)
        elif nm == "BINARY_MODULO":
            b = st.pop()
            st.append(st.pop() % b)
        elif nm in ("BINARY_AND", "INPLACE_AND"):
            b = st.pop()
            st.append(st.pop() & b)
        elif nm in ("BINARY_OR", "INPLACE_OR"):
            b = st.pop()
            st.append(st.pop() | b)
        elif nm in ("BINARY_XOR", "INPLACE_XOR"):
            b = st.pop()
            st.append(st.pop() ^ b)
        elif nm in ("BINARY_POWER", "INPLACE_POWER"):
            b = st.pop()
            st.append(st.pop() ** b)
        elif nm in ("BINARY_LSHIFT", "INPLACE_LSHIFT"):
            b = st.pop()
            st.append(st.pop() << b)
        elif nm in ("BINARY_RSHIFT", "INPLACE_RSHIFT"):
            b = st.pop()
            st.append(st.pop() >> b)
        elif nm in ("PRINT_ITEM", "PRINT_NEWLINE"):
            st.pop()
        elif nm == "LOAD_LOCALS":
            st.append(self.locals)
        else:
            raise NotImplementedError("opcode %s at %d" % (nm, off))
        return off + size


def is_generator(code):
    return has_op(code, "YIELD_VALUE")


def call_value(f, args):
    if isinstance(f, Py2Func):
        if is_generator(f.code):
            out = []
            fr = Frame(f.code, f.module, args)
            while True:
                kind, v = fr.step()
                if kind == "return":
                    break
                out.append(v)
            return out
        fr = Frame(f.code, f.module, args)
        kind, v = fr.step()
        if fr.is_class_body():
            return dict(fr.locals)
        return v
    if callable(f):
        return f(*args)
    return DUMMY  # WG code sometimes "calls" inert objects; tolerate


# ── scripts.zip module loading ────────────────────────────────────────────

Z = None
MODULE_CACHE = {}
LENIENT = True
# Every LENIENT fallback (unresolved name/attr) is recorded here so callers
# can assert that a data extraction resolved all references.
MISSED = set()
# Some WG modules ship real top-level names (no ``__all__``-order renaming
# needed); renaming then only corrupts bindings. Toggle per run.
APPLY_RENAMES = True


def open_zip(zpath):
    global Z, MODULE_CACHE
    import zipfile
    Z = zipfile.ZipFile(zpath)
    MODULE_CACHE = {}


def find_pyc(name):
    name = _s(name)
    exact = "scripts/%s.pyc" % name.replace(".", "/")
    for n in Z.namelist():
        if n == exact:
            return n
    short = name.split(".")[-1]
    for n in Z.namelist():
        if n.endswith("/%s.pyc" % short):
            return n
    raise KeyError(name)


def apply_renames(mod):
    """``__all__``-order mapping: junk identifier -> real export name."""
    allnames = mod.ns.get("__all__")
    if not allnames:
        return
    allnames = [_s(x) for x in allnames]
    exported = [(k, v) for (k, v) in mod.assign_log
                if isinstance(v, (PyClass, Py2Func, dict, list, set, frozenset))
                and k not in allnames]
    if len(exported) >= len(allnames):
        chosen = exported[len(exported) - len(allnames):] if len(exported) > len(allnames) else exported
        for nm, (k, v) in zip(allnames, chosen):
            mod.ns[nm] = v


def import_module(name, seed=None):
    name = _s(name)
    if name in MODULE_CACHE:
        return MODULE_CACHE[name]
    MODULE_CACHE[name] = StubModule(name)  # cycle guard
    try:
        path = find_pyc(name)
    except KeyError:
        print("!! stub module: %s" % name, file=sys.stderr)
        return MODULE_CACHE[name]
    real = decode_real(Z.read(path))
    mod = Module(name)
    MODULE_CACHE[name] = mod
    mod.ns["__name__"] = name
    mod.ns["__builtins__"] = {}
    # Pre-seeded bindings stand in for globals the obfuscation wrapper would
    # inject at runtime (e.g. the skill-enum provider the presets module
    # reads as `ST`); module-level assignments may later shadow them.
    if seed:
        mod.ns.update(seed)
        mod.frozen.update(seed)
    fr = Frame(real, mod, [])
    try:
        fr.step()
    except Exception as e:
        # The half-executed module stays in the cache: name bindings made
        # before the failure remain valid for the tables we read.
        print("!! exec failed for %s: %r" % (name, e), file=sys.stderr)
        return MODULE_CACHE[name]
    MODULE_CACHE[name] = mod
    if APPLY_RENAMES:
        apply_renames(mod)
    return mod


def run_module(name, seed=None):
    """Decode + execute a module from scripts.zip; returns its Module."""
    return import_module(name, seed)


class StubModule(object):
    def __init__(self, name):
        self.name = name
        self.ns = {}
        self.assign_log = []

    def __getattr__(self, name):
        return DUMMY

    def __repr__(self):
        return "<stub %s>" % self.name
