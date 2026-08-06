"""Decrypt WoWS client pyc files (Python 2.7 marshal + const[3] XOR scheme).

Layout: magic(4) + timestamp(4) + marshal(code).
Encryption (per lpcvoid's writeup): co_consts[3] is XORed byte-wise with
co_code (cycled), then base64, then zlib.
"""

import base64
import marshal
import struct
import sys
import zlib
import zipfile

NULL = ord("0")
NONE = ord("N")
TRUE = ord("T")
FALSE = ord("F")
INT = ord("i")
LONG = ord("l")
FLOAT = ord("d")
STRING = ord("s")
UNICODE = ord("u")
TUPLE = ord("(")
INTERNED = ord("t")
REF = ord("R")
CODE = ord("c")
LIST = ord("[")
DICT = ord("{")
STOPITER = ord("S")
ELLIPSIS = ord("E")
INT64 = ord("I")
BINARY_FLOAT = ord("g")
COMPLEX = ord("x")
BINARY_COMPLEX = ord("y")


class P2Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.refs: list = []

    def u8(self) -> int:
        v = self.data[self.pos]
        self.pos += 1
        return v

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def read(self, n: int) -> bytes:
        v = self.data[self.pos : self.pos + n]
        self.pos += n
        return v

    def parse(self):
        return self._obj()

    def _obj(self):
        t = self.u8()
        if t == NULL:
            return None
        if t == NONE:
            return None
        if t == TRUE:
            return True
        if t == FALSE:
            return False
        if t == INT:
            return self.i32()
        if t == LONG:
            n = self.i32()
            digits = self.i32() * n  # 30-bit digits, little endian
            return digits
        if t == FLOAT:
            return struct.unpack("<d", self.read(8))[0]
        if t in (STRING, INTERNED):
            n = self.i32()
            v = self.read(n)
            self.refs.append(v)
            return v
        if t == UNICODE:
            n = self.i32()
            raw = self.read(n)
            if n % 4 == 0 and n >= 4:
                try:
                    return raw.decode("utf-16-be")
                except Exception:
                    pass
            try:
                return raw.decode("utf-8")
            except Exception:
                return raw
        if t == TUPLE:
            n = self.i32()
            items = [self._obj() for _ in range(n)]
            self.refs.append(items)
            return tuple(items)
        if t == LIST:
            n = self.i32()
            items = [self._obj() for _ in range(n)]
            self.refs.append(items)
            return items
        if t == DICT:
            d = {}
            while True:
                k = self._obj()
                if k is None:  # TYPE_NULL terminates the dict in 2.7
                    break
                v = self._obj()
                d[k] = v
            self.refs.append(d)
            return d
        if t == STOPITER:
            return Ellipsis
        if t == ELLIPSIS:
            return Ellipsis
        if t == INT64:
            return struct.unpack_from("<q", self.data, self.pos)[0]
        if t == BINARY_FLOAT:
            return struct.unpack_from("<d", self.data, self.pos)[0]
        if t in (COMPLEX, BINARY_COMPLEX):
            return complex(struct.unpack_from("<d", self.data, self.pos)[0], 0)
        if t == REF:
            idx = self.i32()
            if idx < len(self.refs):
                return self.refs[idx]
            return None
        if t == CODE:
            argcount = self.i32()
            nlocals = self.i32()
            stacksize = self.i32()
            flags = self.i32()
            code = self._obj()
            consts = self._obj()
            names = self._obj()
            varnames = self._obj()
            freevars = self._obj()
            cellvars = self._obj()
            filename = self._obj()
            name = self._obj()
            firstlineno = self.i32()
            lnotab = self._obj()
            obj = {
                "code": code,
                "consts": consts,
                "names": names,
                "varnames": varnames,
            }
            self.refs.append(obj)
            return obj
        raise ValueError(f"unknown marshal type {t} at {self.pos}")


def decrypt_pyc(data: bytes) -> bytes | None:
    """Returns the decrypted marshalled code bytes (Python 2.7 code object),
    or None if decryption is not applicable."""
    code = P2Reader(data[8:]).parse()
    co_code = code["code"]
    consts = code["consts"]
    if len(consts) < 4 or len(co_code) < 16:
        return None
    enc = consts[3]
    if not isinstance(enc, bytes) or len(enc) < 16:
        return None
    try:
        decrypted = bytes(
            b ^ co_code[i % len(co_code)] for i, b in enumerate(enc)
        )
    except TypeError:
        return None
    # base64
    try:
        b64 = base64.b64decode(decrypted)
    except Exception:
        return None
    # zlib
    try:
        plain = zlib.decompress(b64)
    except Exception:
        return None
    return plain


def scan_strings(blob: bytes):
    import re

    out = []
    for m in re.finditer(rb"[\x20-\x7e]{4,}", blob):
        out.append(m.group().decode("ascii"))
    return out


def main() -> int:
    zpath = r"D:\SteamLibrary\steamapps\common\World of Warships\bin\12830008\res\scripts.zip"
    z = zipfile.ZipFile(zpath)
    targets = [
        "scripts/BattleResultsUtils.pyc",
        "scripts/mcdad06da/BattleResultsSystem.pyc",
        "scripts/mcdad06da/BattleResultsStructuredSystem.pyc",
        "scripts/ModsShell/API_v_1_0/BattleResultUtils.pyc",
        "scripts/dhcomponents/BattleResultsComponent.pyc",
        "scripts/dhcomponents/BattleResultsStructured.pyc",
    ]
    for name in targets:
        data = z.read(name)
        plain = decrypt_pyc(data)
        if plain is None:
            print(f"== {name}: decrypt failed")
            continue
        print(f"== {name}: decrypted {len(plain)} bytes")
        strs = scan_strings(plain)
        hits = [
            s
            for s in strs
            if any(
                k in s.lower()
                for k in [
                    "ribbon", "frag", "assist", "citadel", "caliber",
                    "torpedo", "detail", "damage", "survived", "kills",
                    "burn", "flood", "capture", "defense", "planekills",
                    "score",
                ]
            )
        ]
        for h in hits[:40]:
            print("   ", h)
    return 0


if __name__ == "__main__":
    sys.exit(main())
