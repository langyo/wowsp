# -*- coding: utf-8 -*-
"""CPython 3.10 mini-VM for Lesta script-shield modules (stdlib + xdis only).

The Lesta client (build 8867689) ships its game scripts as CPython 3.10 pycs
behind a script shield ("finalUnp"): every pyc body parses (via xdis) into a
wrapper whose consts carry one encoded blob;  XOR(blob, wrapper.co_code) ->
base64 -> zlib yields a second marshal stream — the generic loader "finalUnp".
The loader's root exec()s a nested "packed" code object with
{"globs": caller_globals}.  This module decodes that chain and executes the
packed code on a small wordcode VM, capturing the module globals it builds
(the skill-grid tables).

Static-data subset only: no generators/async, no __future__ semantics.
Run:  python wows_pyc3.py <zip-entry> [more entries...]   # from scripts3.zip
"""
import base64
import io
import os
import marshal
import struct
import sys
import types
import zipfile
import zlib

from xdis.load import load_module
from xdis.opcodes import opcode_310 as op310

OPNAME = op310.opname

MAGIC = bytes.fromhex("6f0d0d0a")
HDR = MAGIC + struct.pack("<III", 0, 0, 0)

def xdis_load_bytes(blob, tag="m"):
    """Parse a bare marshal stream as a 3.10 code object (header prepended)."""
    p = "%s/wpyc3_%d_%s.pyc" % (TMPDIR, id(blob) & 0xFFFFFF, tag)
    with open(p, "wb") as f:
        f.write(MAGIC + struct.pack("<III", 0, 0, len(blob)) + blob)
    print("  [xlb] file:", p, "blob:", len(blob), "head:", blob[:6])
    r = load_module(p)
    print("  [xlb] result types:", [type(x).__name__ for x in r])
    return r[3]

def stage1_decode(z, entry):
    """Decode one zip entry -> (loader code object, raw bytes). Bare modules
    (no wrapper blob) return their own code object directly."""
    data = z.read(entry)
    print("  [stage1] entry ok, bytes:", len(data), "TMPDIR:", TMPDIR)
    p0 = "%s/wpyc3_wrap.pyc" % TMPDIR
    with open(p0, "wb") as f:
        f.write(data)
    r0 = load_module(p0)
    print("  [stage1] load_module tuple len:", len(r0), "types:", [type(x).__name__ for x in r0])
    co0 = r0[3]
    print("  [stage1] co0:", type(co0).__name__, "consts:", len(co0.co_consts) if hasattr(co0, "co_consts") else "?")
    code1 = bytes(co0.co_code)
    for c in co0.co_consts:
        if isinstance(c, bytes) and len(c) >= 64:
            dec = bytes(b ^ code1[i % len(code1)] for i, b in enumerate(c))
            try:
                plain = zlib.decompress(base64.b64decode(dec))
            except Exception as e1:
                try:
                    plain = zlib.decompress(dec)
                except Exception as e2:
                    print("  [stage1] transform fail:", type(e1).__name__, "|", type(e2).__name__, str(e2)[:80])
                    continue
            try:
                r = xdis_load_bytes(plain, "loader")
            except Exception as e3:
                print("  [stage1] xdis_load_bytes fail:", type(e3).__name__, str(e3)[:120])
                continue
            return r, data
    # bare (unwrapped) module: body itself is the code object
    return co0, data

def packed_code(loader):
    for c in loader.co_consts:
        if hasattr(c, "co_code") and c.co_name.isdigit():
            return c
    raise ValueError("no packedCode")

# ── runtime value types ────────────────────────────────────────────────────
class Cell(object):
    __slots__ = ("cell_contents",)
    def __init__(self, v=None):
        self.cell_contents = v

class NameNS(object):
    """Stub namespace: attribute access yields the attribute name (ST.*)."""
    def __init__(self, tag=""):
        self.__tag__ = tag
    def __getattr__(self, k):
        return NameNS(self.__tag__ + "." + k if self.__tag__ else k)
    def __call__(self, *a, **k):
        return NameNS(self.__tag__ + "()")
    def __repr__(self):
        return "<NS %s>" % (self.__tag__ or "?")
    def __str__(self):
        return self.__repr__()
    def __hash__(self):
        return id(self)
    def __eq__(self, o):
        return self is o

class AutoStubDict(dict):
    """dict that materialises NameNS stubs for missing keys (module globs)."""
    def __init__(self, *a, **k):
        super(AutoStubDict, self).__init__(*a, **k)
    def __missing__(self, k):
        v = NameNS(k)
        dict.__setitem__(self, k, v)
        return v

class VMFunction(object):
    __slots__ = ("code", "globals", "defaults", "kwdefaults", "closure", "name")
    def __init__(self, code, glb, defaults, kwdefaults, closure, name):
        self.code = code; self.globals = glb
        self.defaults = defaults or (); self.kwdefaults = kwdefaults or {}
        self.closure = closure or (); self.name = name or code.co_name
    def __call__(self, *args, **kwargs):
        return call_vm(self, args, kwargs)
    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        import functools
        return functools.partial(self.__call__, obj)
    @property
    def __code__(self):
        return self.code
    @property
    def __globals__(self):
        return self.globals
    @property
    def __name__(self):
        return self.name

class VMFrame(object):
    def __init__(self, code, glb, builtins, args=(), kwargs=None, closure=(), back=None, name=""):
        self.code = code
        self.globals = glb
        self.builtins = builtins
        self.back = back
        self.name = name or getattr(code, "co_name", "?")
        kwargs = kwargs or {}
        nlocals = getattr(code, "co_nlocals", len(code.co_varnames))
        varnames = list(code.co_varnames)[:nlocals]
        loc = {}
        self.cells = [Cell() for _ in code.co_cellvars]
        free = list(code.co_freevars)
        self.free = list(closure)
        for i, n in enumerate(code.co_cellvars):
            for j, a in enumerate(args):
                if a == n:
                    self.cells[i].cell_contents = args[j]
        vi = 0
        for n in varnames:
            if n in code.co_cellvars:
                loc[n] = self.cells[code.co_cellvars.index(n)]
            else:
                if vi < len(args):
                    loc[n] = args[vi]
                elif n in kwargs:
                    loc[n] = kwargs[n]
                else:
                    loc[n] = None
            vi += 1
        self.locals = loc
        self.stack = []
        self.blocks = []
        self.lasti = 0

    def deref_cell(self, i):
        ncell = len(self.code.co_cellvars)
        if i < ncell:
            return self.cells[i]
        return self.free[i - ncell]

    def deref(self, i):
        ncell = len(self.code.co_cellvars)
        if i < ncell:
            return self.cells[i].cell_contents
        return self.free[i - ncell].cell_contents

    def set_deref(self, i, v):
        ncell = len(self.code.co_cellvars)
        if i < ncell:
            self.cells[i].cell_contents = v
        else:
            self.free[i - ncell].cell_contents = v

class StubModule(object):
    """Stub module: any attribute yields a NameNS stub (Lesta-internal names)."""
    def __init__(self, name):
        object.__setattr__(self, "__name__", name)
    def __getattr__(self, k):
        v = NameNS(k)
        object.__setattr__(self, k, v)
        return v

def IMPORTER(name, globs, fromlist, level):
    """Real import for stdlib (py2-compat attrs injected); stub for client names."""
    try:
        m = __import__(name, globs, None, fromlist or [], level or 0)
        if name == "copyreg" and not hasattr(m, "idMl"):
            setattr(m, "idMl", id(marshal.loads))
        return m
    except Exception:
        return StubModule(name)

class VMError(Exception):
    pass

class BreakEx(Exception):
    def __init__(self, where):
        Exception.__init__(self); self.where = where

class ReturnEx(Exception):
    def __init__(self, value):
        Exception.__init__(self); self.value = value

VM_EXEC = None  # set at bottom (recursive exec hook)

def cmp_op(idx, a, b):
    table = [
        lambda: a < b, lambda: a <= b, lambda: a == b, lambda: a != b,
        lambda: a > b, lambda: a >= b, lambda: a in b, lambda: a not in b,
        lambda: a is b, lambda: a is not b, lambda: False, lambda: False,
    ]
    i = idx & 0xFF if idx < 12 else (idx >> 4)
    if idx >= 12:
        i = idx >> 4
    return table[i if i < len(table) else 2]()

def binop(name, a, b):
    if name == "BINARY_ADD": return a + b
    if name == "BINARY_SUBTRACT": return a - b
    if name == "BINARY_MULTIPLY": return a * b
    if name == "BINARY_TRUE_DIVIDE": return a / b
    if name == "BINARY_FLOOR_DIVIDE": return a // b
    if name == "BINARY_MODULO": return a % b
    if name == "BINARY_POWER": return a ** b
    if name == "BINARY_LSHIFT": return a << b
    if name == "BINARY_RSHIFT": return a >> b
    if name == "BINARY_AND": return a & b
    if name == "BINARY_OR": return a | b
    if name == "BINARY_XOR": return a ^ b
    if name == "BINARY_SUBSCR": return a[b]
    if name == "BINARY_MATRIX_MULTIPLY": return a @ b
    raise VMError("binop " + name)

def inplace(name, a, b):
    m = {"INPLACE_ADD": "iadd", "INPLACE_SUBTRACT": "isub", "INPLACE_MULTIPLY": "imul",
         "INPLACE_TRUE_DIVIDE": "itruediv", "INPLACE_FLOOR_DIVIDE": "ifloordiv",
         "INPLACE_MODULO": "imod", "INPLACE_POWER": "ipow", "INPLACE_LSHIFT": "ilshift",
         "INPLACE_RSHIFT": "irshift", "INPLACE_AND": "iand", "INPLACE_OR": "ior",
         "INPLACE_XOR": "ixor", "INPLACE_MATRIX_MULTIPLY": "imatmul"}
    import operator
    fn = getattr(operator, m[name])
    return fn(a, b)

class DummyTB(object):
    def __getattr__(self, k):
        return DummyTB()

def vm_exec(code_obj, new_globals):
    """Our replacement for exec() on xdis code objects (recursive)."""
    if new_globals is None:
        new_globals = {}
    new_globals.setdefault("__builtins__", SAFE_BUILTINS)
    fr = VMFrame(code_obj, new_globals, SAFE_BUILTINS)
    return run_frame(fr)

def call_vm(fn, args, kwargs=None):
    return run_frame(VMFrame(fn.code, fn.globals, SAFE_BUILTINS, args, kwargs, fn.closure, name=fn.name))

def py_call(f, args, kwargs=None):
    kwargs = kwargs or {}
    if isinstance(f, VMFunction):
        return call_vm(f, args, kwargs)
    return f(*args, **kwargs)

def run_frame(fr):
    code = fr.code
    stack = fr.stack
    const = list(code.co_consts)
    names = list(code.co_names)
    varnames = list(code.co_varnames)
    lasti = 0
    exc_state = []  # current exception objects for RERAISE
    guard = 0
    trace = os.environ.get("WPYC3_TRACE")
    tf = open(trace, "a", encoding="utf-8") if trace else None
    while True:
        guard += 1
        if guard > 50_000_000:
            raise VMError("runaway")
        if lasti >= len(code.co_code):
            return None
        op = code.co_code[lasti]; arg = code.co_code[lasti + 1]; here = lasti
        lasti += 2
        name = OPNAME[op] if op < len(OPNAME) else "<%d>" % op
        if tf:
            tf.write("%s %d %d %d %s %r\n" % (getattr(code, "co_name", "?"), here, op, arg, name, stack[-1] if stack else None))
        if name == "EXTENDED_ARG":
            # fold into next op's arg by rewriting lazily: emulate by tracking
            nxt = lasti
            acc = arg
            while True:
                o2 = code.co_code[nxt]; a2 = code.co_code[nxt + 1]; nxt += 2
                if OPNAME[o2] == "EXTENDED_ARG":
                    acc = (acc << 8) | a2
                    continue
                acc = (acc << 8) | a2
                break
            # re-dispatch the folded op with acc
            op2name = OPNAME[o2]
            if op2name in ("CACHE",):
                continue
            r = step(fr, stack, op2name, acc, const, names, varnames, here, exc_state)
            if r is _JUMPED:
                lasti = fr.lasti
            elif isinstance(r, ReturnEx):
                return r.value
            elif isinstance(r, int):
                lasti = r
            continue
        if name == "CACHE":
            continue
        try:
            r = step(fr, stack, name, arg, const, names, varnames, here, exc_state)
        except Exception as e:
            if tf:
                tf.write("FAIL %d %s %s\n" % (here, name, str(e)[:200]))
                tf.close()
            raise
        if tf:
            tf.write("   -> depth %d\n" % len(stack))
        if False:
            r = step(fr, stack, name, arg, const, names, varnames, here, exc_state)
        if r is _JUMPED:
            lasti = fr.lasti
        elif isinstance(r, ReturnEx):
            return r.value
        elif isinstance(r, int):
            lasti = r

def _do_raise(fr, exc):
    # unwind to nearest SETUP_FINALLY
    while fr.blocks:
        b = fr.blocks.pop()
        if b[0] in ("EXCEPT", "FINALLY"):
            del fr.stack[b[2]:]
            fr.stack.append(exc)
            fr.lasti = b[1]
            return None
    raise exc

def step(fr, stack, name, arg, const, names, varnames, here, exc_state):
    code = fr.code
    if name == "LOAD_CONST":
        stack.append(const[arg]); return None
    if name == "LOAD_FAST":
        n = varnames[arg]
        v = fr.locals.get(n, None)
        if n in code.co_cellvars:
            v = fr.cells[code.co_cellvars.index(n)].cell_contents
        stack.append(v); return None
    if name == "STORE_FAST":
        n = varnames[arg]
        if n in code.co_cellvars:
            fr.cells[code.co_cellvars.index(n)].cell_contents = stack.pop()
        else:
            fr.locals[n] = stack.pop()
        return None
    if name == "DELETE_FAST":
        fr.locals.pop(varnames[arg], None); return None
    if name == "LOAD_GLOBAL":
        n = names[arg >> 1] if hasattr(code, "co_nlocals") and False else names[arg]
        v = fr.globals.get(n, _MISS)
        if v is _MISS:
            v = fr.builtins.get(n, _MISS)
        if v is _MISS:
            raise NameError("name %r is not defined (LOAD_GLOBAL)" % n)
        stack.append(v); return None
    if name == "STORE_GLOBAL":
        fr.globals[names[arg]] = stack.pop(); return None
    if name == "LOAD_NAME":
        n = names[arg]
        if n in fr.locals:
            v = fr.locals[n]
            if n in code.co_cellvars:
                v = fr.cells[code.co_cellvars.index(n)].cell_contents
        elif n in fr.globals:
            v = fr.globals[n]
        else:
            v = fr.builtins.get(n, _MISS)
            if v is _MISS:
                raise NameError("name %r is not defined" % n)
        stack.append(v); return None
    if name == "STORE_NAME":
        fr.globals[names[arg]] = stack.pop(); return None
    if name == "DELETE_NAME":
        fr.globals.pop(names[arg], None); return None
    if name == "LOAD_ATTR":
        stack.append(getattr(stack.pop(), names[arg])); return None
    if name == "STORE_ATTR":
        o = stack.pop(); setattr(o, names[arg], stack.pop()); return None
    if name == "LOAD_METHOD":
        o = stack.pop()
        f = getattr(o, names[arg])
        stack.append(f); stack.append(o); return None
    if name == "CALL_METHOD":
        args = [stack.pop() for _ in range(arg)]
        o = stack.pop(); f = stack.pop()
        stack.append(py_call(f, args)); return None
    if name == "CALL_FUNCTION":
        args = [stack.pop() for _ in range(arg)][::-1]
        f = stack.pop()
        stack.append(py_call(f, args)); return None
    if name == "CALL_FUNCTION_KW":
        kw_names = stack.pop()
        vals = [stack.pop() for _ in range(len(kw_names))][::-1]
        args = [stack.pop() for _ in range(arg - len(kw_names))][::-1]
        f = stack.pop()
        stack.append(py_call(f, args, dict(zip(kw_names, vals)))); return None
    if name == "CALL_FUNCTION_EX":
        kw = stack.pop() if arg & 1 else {}
        args = list(stack.pop())
        f = stack.pop()
        stack.append(py_call(f, args, kw)); return None
    if name == "LOAD_CLOSURE":
        stack.append(fr.deref_cell(arg)); return None
    if name == "LOAD_DEREF":
        stack.append(fr.deref(arg)); return None
    if name == "STORE_DEREF":
        fr.set_deref(arg, stack.pop()); return None
    if name == "LOAD_BUILD_CLASS":
        stack.append(build_class); return None
    if name == "MAKE_FUNCTION":
        c = stack.pop()
        defaults = kwdefaults = None; closure = ()
        if arg & 0x08: closure = stack.pop()
        if arg & 0x04: stack.pop()
        if arg & 0x02: kwdefaults = stack.pop()
        if arg & 0x01: defaults = stack.pop()
        stack.append(VMFunction(c, fr.globals, defaults, kwdefaults, closure, getattr(c, "co_name", "")))
        return None
    if name == "MAKE_CLOSURE":
        c = stack.pop()
        closure = stack.pop()
        defaults = kwdefaults = None
        if arg & 0x04: stack.pop()
        if arg & 0x02: kwdefaults = stack.pop()
        if arg & 0x01: defaults = stack.pop()
        stack.append(VMFunction(c, fr.globals, defaults, kwdefaults, closure, getattr(c, "co_name", "")))
        return None
    if name == "RETURN_VALUE":
        raise ReturnEx(stack.pop())
    if name == "POP_TOP":
        stack.pop(); return None
    if name == "DUP_TOP":
        stack.append(stack[-1]); return None
    if name == "DUP_TOP_TWO":
        stack.extend(stack[-2:]); return None
    if name == "ROT_TWO":
        stack[-1], stack[-2] = stack[-2], stack[-1]; return None
    if name == "ROT_THREE":
        v = stack.pop(); stack.insert(-2, v); return None
    if name == "ROT_FOUR":
        v = stack.pop(); stack.insert(-3, v); return None
    if name in BINOPS:
        b = stack.pop(); a = stack.pop(); stack.append(BINOPS[name](a, b)); return None
    if name in INOPS:
        b = stack.pop(); a = stack.pop(); stack.append(INOPS[name](a, b)); return None
    if name == "COMPARE_OP":
        b = stack.pop(); a = stack.pop(); idx = arg
        if idx >= 12: idx >>= 4
        if idx == 0: stack.append(a < b)
        elif idx == 1: stack.append(a <= b)
        elif idx == 2: stack.append(a == b)
        elif idx == 3: stack.append(a != b)
        elif idx == 4: stack.append(a > b)
        elif idx == 5: stack.append(a >= b)
        elif idx == 6: stack.append(a in b)
        elif idx == 7: stack.append(a not in b)
        elif idx == 8: stack.append(a is b)
        elif idx == 9: stack.append(a is not b)
        else: stack.append(False)
        return None
    if name == "IS_OP":
        b = stack.pop(); a = stack.pop(); stack.append((a is b) == (arg == 0)); return None
    if name == "CONTAINS_OP":
        b = stack.pop(); a = stack.pop(); stack.append((a in b) == (arg == 0)); return None
    if name == "CHECK_EXC_MATCH":
        exc = stack.pop(); cur = stack[-1]; stack.append(isinstance(cur, exc)); return None
    if name == "JUMP_IF_NOT_EXC_MATCH":
        exc = stack.pop(); cur = stack[-1]
        if not isinstance(cur, exc):
            fr.lasti = arg; return _JUMPED
        return None
    if name in ("JUMP_ABSOLUTE",):
        fr.lasti = arg; return _JUMPED
    if name == "JUMP_FORWARD":
        fr.lasti = here + 2 + arg; return _JUMPED
    if name == "POP_JUMP_IF_FALSE":
        v = stack.pop()
        if not v: fr.lasti = arg; return _JUMPED
        return None
    if name == "POP_JUMP_IF_TRUE":
        v = stack.pop()
        if v: fr.lasti = arg; return _JUMPED
        return None
    if name == "JUMP_IF_TRUE_OR_POP":
        if stack[-1]: fr.lasti = arg; return _JUMPED
        stack.pop(); return None
    if name == "JUMP_IF_FALSE_OR_POP":
        if not stack[-1]: fr.lasti = arg; return _JUMPED
        stack.pop(); return None
    if name == "GET_ITER":
        stack.append(iter(stack.pop())); return None
    if name == "FOR_ITER":
        it = stack[-1]
        try:
            stack.append(next(it)); return None
        except StopIteration:
            stack.pop(); fr.lasti = arg; return _JUMPED
    if name == "BUILD_TUPLE":
        items = [stack.pop() for _ in range(arg)][::-1]
        stack.append(tuple(items)); return None
    if name == "BUILD_LIST":
        items = [stack.pop() for _ in range(arg)][::-1]
        stack.append(items); return None
    if name == "BUILD_SET":
        items = [stack.pop() for _ in range(arg)][::-1]
        stack.append(set(items)); return None
    if name == "BUILD_MAP":
        d = {}
        for _ in range(arg):
            v = stack.pop(); k = stack.pop(); d[k] = v
        stack.append(d); return None
    if name == "BUILD_CONST_KEY_MAP":
        keys = stack.pop()
        vals = [stack.pop() for _ in range(arg)][::-1]
        stack.append(dict(zip(keys, vals))); return None
    if name == "BUILD_SLICE":
        items = [stack.pop() for _ in range(arg)][::-1]
        stack.append(slice(*items)); return None
    if name == "LIST_APPEND":
        v = stack.pop(); stack[-arg].append(v); return None
    if name == "LIST_EXTEND":
        v = stack.pop(); stack[-arg].extend(v); return None
    if name == "SET_ADD":
        v = stack.pop(); stack[-arg].add(v); return None
    if name == "MAP_ADD":
        v = stack.pop(); k = stack.pop(); stack[-arg][k] = v; return None
    if name == "DICT_UPDATE":
        v = stack.pop(); stack[-arg].update(v); return None
    if name == "DICT_MERGE":
        v = stack.pop(); stack[-arg].update(v); return None
    if name == "LIST_TO_TUPLE":
        stack.append(tuple(stack.pop())); return None
    if name == "UNPACK_SEQUENCE":
        items = list(stack.pop())[::-1]
        for x in items: stack.append(x)
        return None
    if name == "UNPACK_EX":
        before = arg & 0xFF; after = arg >> 8
        items = list(stack.pop())
        head = items[:before]; mid = items[before:len(items)-after] if after else items[before:]
        tail = items[len(items)-after:] if after else []
        for x in reversed(tail): stack.append(x)
        stack.append(mid)
        for x in reversed(head): stack.append(x)
        return None
    if name == "IMPORT_NAME":
        n = names[arg]
        fromlist = stack.pop(); level = stack.pop()
        stack.append(IMPORTER(n, fr.globals, fromlist, level)); return None
    if name == "IMPORT_STAR":
        m = stack.pop()
        for k in dir(m):
            if not k.startswith("_"):
                fr.globals[k] = getattr(m, k)
        return None
    if name == "IMPORT_FROM":
        stack.append(getattr(stack[-1], names[arg])); return None
    if name == "SETUP_FINALLY":
        fr.blocks.append(("EXCEPT", arg, len(stack))); return None
    if name == "POP_BLOCK":
        if fr.blocks: fr.blocks.pop()
        return None
    if name == "POP_EXCEPT":
        return None
    if name == "RERAISE":
        if arg:
            exc = fr.locals[varnames[arg - 1]]
        else:
            exc = stack.pop()
        r = _do_raise(fr, exc)
        return r
    if name == "RAISE_VARARGS":
        cause = tb = exc = None
        if arg == 2: cause = stack.pop()
        if arg >= 1: exc = stack.pop()
        if exc is None:
            r = _do_raise(fr, exc_state[-1] if exc_state else VMError("re-raise"))
            return r
        if isinstance(exc, type) and issubclass(exc, BaseException):
            exc = exc()
        r = _do_raise(fr, exc)
        return r
    if name == "WITH_EXCEPT_START":
        exc = stack[-1]
        exit_f = stack[-4]
        stack.append(exit_f(None, exc, DummyTB())); return None
    if name == "SETUP_WITH":
        mgr = stack.pop()
        res = mgr.__enter__()
        fr.blocks.append(("FINALLY", arg, len(stack) + 2))
        stack.append(mgr.__exit__)
        stack.append(res)
        return None
    if name == "BEGIN_FINALLY":
        fr.blocks.append(("FINALLY", arg, len(stack))); return None
    if name == "END_FINALLY":
        return None
    if name == "LOAD_ASSERTION_ERROR":
        stack.append(AssertionError); return None
    if name == "SETUP_ANNOTATIONS":
        fr.globals.setdefault("__annotations__", {}); return None
    if name == "FORMAT_VALUE":
        spec = stack.pop() if arg & 0x04 else None
        v = stack.pop()
        which = arg & 0x03
        if which == 1: v = str(v)
        elif which == 2: v = repr(v)
        elif which == 3: v = ascii(v)
        stack.append(format(v, spec) if spec is not None else str(v))
        return None
    if name == "BUILD_STRING":
        items = [stack.pop() for _ in range(arg)][::-1]
        stack.append("".join(items)); return None
    if name == "STORE_SUBSCR":
        v = stack.pop(); i = stack.pop(); o = stack.pop()
        try:
            o[i] = v
        except TypeError:
            setattr(o, str(i), v)
        return None
    if name == "DELETE_SUBSCR":
        i = stack.pop(); o = stack.pop(); del o[i]; return None
    if name == "PRINT_EXPR":
        sys.stdout.write(repr(stack.pop()) + "\n"); return None
    if name == "LIST_TO_SET" or name == "BUILD_LIST_UNPACK":
        pass
    if name.endswith("UNPACK"):
        pass
    if name == "COPY_DICT_WITHOUT_KEYS":
        keys = stack.pop(); d = stack.pop()
        stack.append({k: v for k, v in d.items() if k not in keys}); return None
    if name == "GET_AWAITABLE":
        return None
    if name == "LOAD_FINALLY" or name == "POP_FINALLY":
        # 3.7 remnants; unlikely
        return None
    raise VMError("unimplemented opcode: %s (arg=%d) at %s:%d" % (name, arg, getattr(code, "co_name", "?"), here))

BINOPS = {
    "BINARY_ADD": lambda a, b: a + b,
    "BINARY_SUBTRACT": lambda a, b: a - b,
    "BINARY_MULTIPLY": lambda a, b: a * b,
    "BINARY_TRUE_DIVIDE": lambda a, b: a / b,
    "BINARY_FLOOR_DIVIDE": lambda a, b: a // b,
    "BINARY_MODULO": lambda a, b: a % b,
    "BINARY_POWER": lambda a, b: a ** b,
    "BINARY_LSHIFT": lambda a, b: a << b,
    "BINARY_RSHIFT": lambda a, b: a >> b,
    "BINARY_AND": lambda a, b: a & b,
    "BINARY_OR": lambda a, b: a | b,
    "BINARY_XOR": lambda a, b: a ^ b,
    "BINARY_SUBSCR": lambda a, b: a[b],
    "BINARY_MATRIX_MULTIPLY": lambda a, b: a @ b,
}
INOPS = {
    "INPLACE_ADD": lambda a, b: a + b,
    "INPLACE_SUBTRACT": lambda a, b: a - b,
    "INPLACE_MULTIPLY": lambda a, b: a * b,
    "INPLACE_TRUE_DIVIDE": lambda a, b: a / b,
    "INPLACE_FLOOR_DIVIDE": lambda a, b: a // b,
    "INPLACE_MODULO": lambda a, b: a % b,
    "INPLACE_POWER": lambda a, b: a ** b,
    "INPLACE_LSHIFT": lambda a, b: a << b,
    "INPLACE_RSHIFT": lambda a, b: a >> b,
    "INPLACE_AND": lambda a, b: a & b,
    "INPLACE_OR": lambda a, b: a | b,
    "INPLACE_XOR": lambda a, b: a ^ b,
    "INPLACE_MATRIX_MULTIPLY": lambda a, b: a @ b,
}

class _Miss(object):
    pass
_MISS = _Miss()
_JUMPED = object()

def build_class(frame):
    """LOAD_BUILD_CLASS stub: call the class-body function with __name__ set."""
    return lambda *args, **kw: _build_class_impl(frame, *args, **kw)

def _build_class_impl(frame, func, name, bases=None, metaclass=None, **kwds):
    bases = bases or ()
    ns = {"__name__": frame.globals.get("__name__", "?"), "__qualname__": name}
    ns["__builtins__"] = frame.builtins
    call_vm(func, (), {}, ) if False else None
    f = VMFrame(func.code, ns, frame.builtins)
    f.locals.update(ns)
    try:
        run_frame(f)
    except ReturnEx:
        pass
    cls = type(name, tuple(bases), ns)
    frame.globals[name] = cls
    return cls

def frame_sys():
    class _F(object):
        pass
    f = _F()
    f.f_globals = {}
    fb = _F()
    fb.f_globals = {}
    f.f_back = fb
    s = _F()
    s._getframe = lambda *a, **k: f
    s.exc_info = lambda: (None, None, None)
    return s, f, fb

SAFE_BUILTINS = None  # set in main

def main():
    global TMPDIR, SAFE_BUILTINS
    TMPDIR = os.environ.get("TEMP", "/tmp")
    real_builtins = __builtins__ if isinstance(__builtins__, dict) else vars(__import__("builtins"))
    SAFE_BUILTINS = dict(real_builtins)
    # exec inside the VM must route to our VM exec
    SAFE_BUILTINS["exec"] = lambda *a, **k: vm_exec(*a, **k)
    zpath = sys.argv[1]
    entries = sys.argv[2:]
    z = zipfile.ZipFile(zpath)
    for entry in entries:
        print("=== %s ===" % entry)
        loader, raw = stage1_decode(z, entry)
        if loader.co_name.isdigit() and hasattr(loader, "co_code") and any(
            hasattr(c, "co_code") for c in loader.co_consts
        ) and not any(isinstance(c, str) and "import" in str(c) for c in loader.co_consts) and len(loader.co_consts) >= 10:
            # heuristic: wrapped (loader has digit-named packedCode + machinery strs)
            pc = packed_code(loader)
        else:
            pc = loader
        sysmod, frame_fake, fb = frame_sys()
        cap = AutoStubDict()
        cap["sys"] = sysmod
        cap["__builtins__"] = SAFE_BUILTINS
        g = {"globs": cap, "__builtins__": SAFE_BUILTINS}
        fr = VMFrame(pc, g, SAFE_BUILTINS, name=entry + "::packed")
        try:
            run_frame(fr)
        except ReturnEx as e:
            pass
        except VMError as e:
            print("VMError:", str(e)[:300])
            continue
        print("globals:", sorted([k for k in g.keys() if k not in ("globs", "__builtins__")]))
        for k, v in g.items():
            if k in ("globs", "__builtins__"): continue
            if isinstance(v, (dict, list, tuple)):
                print("  %s = %s len=%d" % (k, type(v).__name__, len(v)))
            elif hasattr(v, "co_code"):
                print("  %s = <code %s>" % (k, getattr(v, "co_name", "?")))
            else:
                print("  %s = %r" % (k, str(v)[:60]))
        # also anything the module wrote into cap
        extra = [k for k in cap.keys() if k not in ("sys", "__builtins__")]
        if extra:
            print("  wrote into globs:", extra[:40])

if __name__ == "__main__":
    main()
