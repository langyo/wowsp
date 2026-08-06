"""FINAL SOLUTION: WoWS v2 obfuscation — full 3-stage decode of BattleResultsUtils.pyc.

Stage 1 (known): consts[3] XOR co_code -> base64 -> zlib -> stage-2 marshal (wrapper template)
Stage 2 (NEW): the wrapper's loader reads sys._getframe().f_back.f_code.co_code
    (= the STAGE-1 wrapper's co_code, 15572B) and applies:
    swapMap permutation -> bitop((b^38)&126 | ((b^38)>>7)&1 | ((b^38)&1)<<7) ^ 89 -> reverse
    -> marshal of the stage-3 code object
Stage 3 (NEW): stage-3 code's own co_code.split(b'<<<>>>')[1] -> [::-1]
    -> binascii.a2b_base64 -> zlib.decompress -> marshal = THE REAL MODULE
"""
import sys, zipfile, base64, zlib, io
sys.path.insert(0, r"C:\Users\langy\AppData\Local\Temp\opencode")
from pyc_decrypt import P2Reader, decrypt_pyc

ZPATH = r"D:\SteamLibrary\steamapps\common\World of Warships\bin\12830008\res\scripts.zip"


def bitop(b, A=38, C=89):
    return ((b ^ A) & 126 | ((b ^ A) >> 7) & 1 | ((b ^ A) & 1) << 7) ^ C


def decode_real_module(pyc_data: bytes):
    """Full pipeline -> real module code object (P2Reader dict)."""
    # ---- stage 1 ----
    plain = decrypt_pyc(pyc_data)                       # 7968B stage-2 marshal (wrapper)
    # ---- stage 2: transform the stage-1 wrapper's co_code ----
    s1 = P2Reader(pyc_data[8:]).parse()                 # stage-1 wrapper code object
    wrapper = P2Reader(plain).parse()                   # stage-2 wrapper code object
    swap_map = wrapper["consts"][8]["consts"][1]        # f123's 256-entry permutation dict
    stage3_blob = bytes(bitop(swap_map[b]) for b in s1["code"])[::-1]
    stage3 = P2Reader(stage3_blob).parse()              # stage-3 code object
    # ---- stage 3: split / reverse / base64 / zlib / marshal ----
    parts = stage3["code"].split(b"<<<>>>")
    assert len(parts) == 2, parts
    zdata = zlib.decompress(base64.b64decode(parts[1][::-1]))
    real = P2Reader(zdata).parse()                      # THE REAL MODULE
    return real


def collect_strings(obj):
    out = []
    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, (list, tuple)):
            for x in o:
                walk(x)
        elif isinstance(o, bytes):
            out.append(o)
    walk(obj)
    return out


def main():
    z = zipfile.ZipFile(ZPATH)
    targets = [
        "scripts/BattleResultsUtils.pyc",
        "scripts/mcdad06da/BattleResultsSystem.pyc",
        "scripts/mcdad06da/BattleResultsStructuredSystem.pyc",
        "scripts/ModsShell/API_v_1_0/BattleResultUtils.pyc",
        "scripts/dhcomponents/BattleResultsComponent.pyc",
        "scripts/dhcomponents/BattleResultsStructured.pyc",
    ]
    keys = ["frag", "assist", "citadel", "caliber", "torpedo", "damage",
            "survived", "kills", "ribbon", "burn", "flood", "capture",
            "defense", "planekills", "score", "detail", "destroyed"]
    buf = io.StringIO()
    for name in targets:
        try:
            data = z.read(name)
        except KeyError:
            buf.write(f"\n== {name}: NOT FOUND\n")
            continue
        try:
            real = decode_real_module(data)
        except Exception as e:
            buf.write(f"\n== {name}: DECODE FAILED: {e}\n")
            continue
        strings = collect_strings(real)
        hits = sorted({s.decode("ascii", "replace") for s in strings
                       if any(k in s.decode("ascii", "replace").lower() for k in keys)})
        buf.write(f"\n== {name}: code={len(real['code'])}B strings={len(strings)} hits={len(hits)}\n")
        for h in hits:
            buf.write(f"    {h}\n")
    out = buf.getvalue()
    print(out)
    open(r"C:\Users\langy\AppData\Local\Temp\opencode\FINAL_STRINGS.txt", "w", encoding="utf-8").write(out)


if __name__ == "__main__":
    main()
