#!/usr/bin/env python3
"""Bake the two-realm ship-data bundle for the app's data hot-update channel.

The app's armor/ballistics tab resolves ship ids against the user's own game
install (or the pairing-synced cache). Two cohorts have no install to answer
for them:

  * phones and any machine without a WoWG install — nothing to unpack;
  * the Lesta realm's ships on a WG-only setup — their ids exist only in the
    Lesta client's GameParams.

The committed Lesta-only slice pack (`build_lesta_shipdata.py`) covers the
second cohort, but it is welded into the app binary: refreshing it needs a
release, and the shared fleet still depends on a local install. This script
bakes the same slice shape for BOTH realms and writes it as a zip that
`scripts/publish_data_pack.py` publishes to the app's `data-latest`
hot-update channel, so clients can download a current slice set from our own
server instead of relying on an install or an app release.

Container: a DEFLATE zip, one compact JSON slice per ship plus a
`manifest.json`. Zip (not one big JSON) because a full WG dump's slices are
~136 MB of JSON (~13 MB compressed): inflating that into memory for a single
ship lookup is unacceptable, while a zip's central directory lets the client
extract exactly one entry. The archive is byte-deterministic — sorted
entries, fixed entry timestamps, no bake timestamp inside — so identical
input content keeps the same sha256 and a republish is a client no-op
(content-addressed manifest, see publish_data_pack.py).

Slices are the SAME payload as every other pack path (`__torpedoAmmo`
embedded, SLICE_FORMAT v2): `extract_gameparams.collect_ship_slices` does
the work, so WG, Lesta and the committed bundle can never drift apart.

Sources (both default to the orchestrator cache `run.py` fills):
  --wg-gameparams     decoded WG GameParams.json
  --lesta-gameparams  decoded Lesta GameParams.json (WOWSP_LESTA_GAMEPARAMS
                      works too; pullable without a client via
                      OpenKorabli/lgc-download + `game-assets game-params`)
  --wg-build / --lesta-build  build stamps recorded in the manifest
                      (default: the dumps' .build sidecars when present)

Usage:
    python scripts/extract/build_shipdata_bundle.py
    python scripts/extract/build_shipdata_bundle.py --selftest
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent))
from build_techtree import _params_root  # noqa: E402
from extract_gameparams import (  # noqa: E402
    SLICE_FORMAT,
    collect_ship_slices,
)

REPO_ROOT = SCRIPT_DIR.parent.parent
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
WG_DEFAULT = CACHE_DIR / "GameParams.json"
LESTA_DEFAULT = CACHE_DIR / "GameParams_lesta.json"
OUT_DEFAULT = CACHE_DIR / "shipdata-bundle.zip"
MANIFEST_ENTRY = "manifest.json"
# Fixed entry timestamp: the zip container must not carry the bake wall clock
# (content-addressing relies on byte-identical re-bakes of identical input).
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def _build_stamp(dump: Path, explicit: str | None) -> str | None:
    """Explicit stamp, else the dump's .build sidecar (one line, the
    client build the dump was cut from), else None."""
    if explicit:
        return explicit
    sidecar = Path(str(dump) + ".build")
    if sidecar.is_file():
        text = sidecar.read_text(encoding="ascii", errors="ignore").strip()
        return text or None
    return None


def load_slices(path: Path) -> dict[int, dict]:
    """ship id → v2 slice for one decoded GameParams dump."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    dump = _params_root(raw)
    if not dump:
        raise SystemExit(f"error: unrecognized GameParams root in {path}")
    return collect_ship_slices(dump)


def write_bundle(out: Path, realms: dict[str, tuple[dict[int, dict], str | None, str]]) -> dict:
    """Write the deterministic zip and return the manifest that landed in it.

    `realms` maps realm name → (slices, build stamp, source path label). WG
    ships are written first and Lesta ships second: on an id collision the
    Lesta slice wins, matching the lookup order (the Lesta snapshot answers
    its own ids before any install is consulted)."""
    merged: dict[int, dict] = {}
    realm_manifest: dict[str, dict] = {}
    for realm, (slices, build, source) in realms.items():
        for ship_id, slice_ in slices.items():
            merged[ship_id] = slice_
        realm_manifest[realm] = {
            "gameVersion": build or realm,
            "build": build,
            "ships": len(slices),
            "source": source,
        }
    manifest = {
        "format": 1,
        "sliceFormat": SLICE_FORMAT,
        "realms": realm_manifest,
        "totalShips": len(merged),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        info = zipfile.ZipInfo(MANIFEST_ENTRY, date_time=ZIP_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        zf.writestr(
            info,
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        )
        for ship_id in sorted(merged):
            body = json.dumps(merged[ship_id], ensure_ascii=False, separators=(",", ":")) + "\n"
            info = zipfile.ZipInfo(f"{ship_id}.json", date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, body)
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--wg-gameparams", type=Path, default=WG_DEFAULT)
    ap.add_argument(
        "--lesta-gameparams",
        type=Path,
        default=Path(os.environ.get("WOWSP_LESTA_GAMEPARAMS") or LESTA_DEFAULT),
    )
    ap.add_argument("--wg-build", default=None, help="WG build stamp for the manifest")
    ap.add_argument("--lesta-build", default=None, help="Lesta build stamp for the manifest")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--selftest", action="store_true", help="build from synthetic dumps and self-check")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    realms: dict[str, tuple[dict[int, dict], str | None, str]] = {}
    for realm, path, explicit in (
        ("wg", args.wg_gameparams, args.wg_build),
        ("lesta", args.lesta_gameparams, args.lesta_build),
    ):
        if not path.is_file():
            print(f"[shipdata] WARN: no {realm} dump at {path} — realm skipped", file=sys.stderr)
            continue
        print(f"[shipdata] loading {realm} {path} ...", flush=True)
        realms[realm] = (load_slices(path), _build_stamp(path, explicit), path.name)
    if not realms:
        raise SystemExit("no GameParams dump available — pass --wg-gameparams/--lesta-gameparams")

    manifest = write_bundle(args.out, realms)
    size_mb = args.out.stat().st_size / 1024 / 1024
    parts = ", ".join(
        f"{name}={info['ships']} ships ({info['gameVersion']})"
        for name, info in manifest["realms"].items()
    )
    print(
        f"[shipdata] wrote {manifest['totalShips']} ships ({parts}) "
        f"-> {args.out} [{size_mb:.1f} MB, slice format {SLICE_FORMAT}]"
    )
    return 0


def _selftest() -> int:
    """Synthetic dumps: shape, merge precedence, determinism."""
    import tempfile

    wg = {
        "PASS110_Balao": {
            "id": 1001,
            "name": "PASS110_Balao",
            "typeinfo": {"type": "Ship", "species": "Submarine"},
            "A_Torpedoes": {"HP_T_1": {"ammoList": ["PTORP_A"]}},
        },
        "PJSB018_Yamato_1944": {
            "id": 1002,
            "name": "PJSB018_Yamato_1944",
            "typeinfo": {"type": "Ship"},
            "A_Artillery": {"HP_AGM_1": {"numBarrels": 3}},
        },
        "PTORP_A": {
            "name": "PTORP_A",
            "typeinfo": {"type": "Projectile", "species": "Torpedo"},
            "alphaDamage": 1000,
        },
    }
    lesta = {
        # Shared id: the Lesta slice must win (lookup order).
        "PASS110_Balao": {
            "id": 1001,
            "name": "PASS110_Balao_LESTA",
            "typeinfo": {"type": "Ship", "species": "Submarine"},
            "A_PingerGun": {"sectorLifetime": 20, "waveDistance": 14000},
        },
        "PJSS520_I2": {
            "id": 1003,
            "name": "PJSS520_I2",
            "typeinfo": {"type": "Ship", "species": "Submarine"},
            "A_PingerGun": {"sectorLifetime": 20, "waveDistance": 13500},
        },
    }
    with tempfile.TemporaryDirectory(prefix="shipdata-selftest-") as tmp:
        tmp_dir = Path(tmp)
        wg_path = tmp_dir / "GameParams.json"
        lesta_path = tmp_dir / "GameParams_lesta.json"
        wg_path.write_text(json.dumps(wg), encoding="utf-8")
        lesta_path.write_text(json.dumps(lesta), encoding="utf-8")
        (tmp_dir / "GameParams_lesta.json.build").write_text("lesta-123\n", encoding="ascii")
        realms = {
            "wg": (load_slices(wg_path), _build_stamp(wg_path, "wg-9"), "GameParams.json"),
            "lesta": (
                load_slices(lesta_path),
                _build_stamp(lesta_path, None),
                "GameParams_lesta.json",
            ),
        }
        out_a = tmp_dir / "a.zip"
        out_b = tmp_dir / "b.zip"
        manifest = write_bundle(out_a, realms)
        write_bundle(out_b, realms)
        assert manifest["sliceFormat"] == SLICE_FORMAT, manifest
        assert manifest["totalShips"] == 3, manifest
        assert manifest["realms"]["lesta"]["build"] == "lesta-123", manifest
        assert out_a.read_bytes() == out_b.read_bytes(), "bundle must be byte-deterministic"
        with zipfile.ZipFile(out_a) as zf:
            names = sorted(zf.namelist())
            assert names == ["1001.json", "1002.json", "1003.json", MANIFEST_ENTRY], names
            shared = json.loads(zf.read("1001.json"))
            assert shared["name"] == "PASS110_Balao_LESTA", "Lesta must win the shared id"
            balao = json.loads(zf.read("1002.json"))
            assert balao["name"] == "PJSB018_Yamato_1944"
            embedded = json.loads(zf.read("1001.json"))
            assert "__torpedoAmmo" not in embedded, "Lesta slice carries no ammo block here"
            yamato = json.loads(zf.read("1002.json"))
            assert yamato.get("A_Artillery"), "WG slice preserved"
            on_disk = json.loads(zf.read(MANIFEST_ENTRY))
            assert on_disk == manifest
    print("[shipdata] selftest OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
