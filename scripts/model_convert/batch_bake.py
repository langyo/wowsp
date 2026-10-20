#!/usr/bin/env python3
"""Batch-bake ALL ships in the current game version to low-poly holographic GLBs.

Ship list comes from the extract cache's GameParams.json; export runs
through the Rust model-exporter in ONE --batch process (GameParams parse
paid once), then every ship bakes to low-poly.

The conversion takes ~10s per ship (1196 ships ≈ 3h). The script is idempotent
and checkpoints progress, so it can be interrupted and resumed.

Usage:
    python scripts/model_convert/batch_bake.py              # bake all missing
    python scripts/model_convert/batch_bake.py --force       # re-bake all
    python scripts/model_convert/batch_bake.py --limit 10    # bake only 10 (testing)

    just bake-all-ships
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]  # scripts/model_convert/ → scripts/ → repo root
TOOLS_DIR = REPO_ROOT / "target" / "model-tools"
SHIPS_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"
TEMP_DIR = REPO_ROOT / "target" / "model-tmp"

# The Rust ship-export front end (packages/tools/model-exporter) built by
# `just build model-exporter` straight into the cargo target dir.
EXPORTER_BIN = REPO_ROOT / "target" / "release" / "model-exporter.exe"
GAMEPARAMS_JSON = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract" / "GameParams.json"
BAKE_SCRIPT = SCRIPT_DIR / "bake_model.py"
WOWSUNPACK_BIN = REPO_ROOT / "target" / "release" / "game-assets.exe"  # cargo workspace build

def find_game_path() -> str | None:
    sys.path.insert(0, str(SCRIPT_DIR))
    from _common import find_game_path as _fgp
    return _fgp()


def ensure_tools():
    """Ensure the Rust model-exporter binary exists (cargo release build)."""
    if EXPORTER_BIN.is_file():
        return
    print("[batch_bake] model-exporter missing — building (just build model-exporter) ...")
    rc = subprocess.run(
        ["cargo", "build", "--release", "-p", "model-exporter"],
        cwd=str(REPO_ROOT),
    ).returncode
    if rc != 0 or not EXPORTER_BIN.is_file():
        raise FileNotFoundError(
            f"{EXPORTER_BIN} unavailable — run `just build model-exporter` and retry")


def get_ship_names(game: str) -> list[str]:
    """All GameParams ship keys, from the extract cache's GameParams.json
    (`just extract` produces it; the old wows-list-ships binary is gone
    with the C++ exporter it came from)."""
    if not GAMEPARAMS_JSON.is_file():
        print(f"error: {GAMEPARAMS_JSON} missing — run `just extract` first.",
              file=sys.stderr)
        sys.exit(1)
    dump = json.loads(GAMEPARAMS_JSON.read_text(encoding="utf-8"))
    names = [
        key
        for key, entry in dump.items()
        if isinstance(entry, dict)
        and isinstance(entry.get("typeinfo"), dict)
        and entry["typeinfo"].get("type") == "Ship"
    ]
    print(f"[batch_bake] found {len(names)} ships in GameParams")
    return names


def derive_filename(gp_name: str) -> str:
    """Use the GameParams index prefix as the GLB filename.
    e.g. PASB017_Montana_1945 → PASB017.glb"""
    return gp_name.split("_")[0] + ".glb"
    return "_".join(readable) + ".glb"


def glb_mesh_stats(path: Path) -> tuple[int, int]:
    """Read a baked GLB's triangle + vertex counts from JSON accessor metadata
    only (no binary decode). Every baked GLB from `bake_model.write_glb` has a
    single mesh primitive with POSITION + indices accessors.

    Returns (n_tris, n_verts); (-1, -1) if unreadable. Used by `--resume` to
    spot stale bakes two ways:
      - low triangle count  → old every-Nth-triangle shard algorithm
      - verts ≫ tris×3       → a bake that skipped vertex welding/dedup
                               (bloated ~1.5MB file for a ~75KB model)
    """
    try:
        data = path.read_bytes()
        magic, version, length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67 or length > len(data):
            return -1, -1
        offset = 12
        json_body = None
        while offset < length:
            chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
            offset += 8
            if chunk_type == 0x4E4F534A:  # "JSON"
                json_body = data[offset : offset + chunk_len]
                break
            offset += chunk_len
        if not json_body:
            return -1, -1
        g = json.loads(json_body.rstrip(b"\x00").decode("utf-8"))
        n_tris_total = 0
        n_verts_total = 0
        for mesh in g.get("meshes", []):
            for prim in mesh.get("primitives", []):
                pos_acc = prim.get("attributes", {}).get("POSITION")
                if pos_acc is not None:
                    n_verts_total += g["accessors"][pos_acc].get("count", 0)
                if "indices" in prim:
                    n_tris_total += g["accessors"][prim["indices"]].get("count", 0) // 3
        return (n_tris_total, n_verts_total) if n_tris_total > 0 else (-1, -1)
    except Exception:
        return -1, -1


def count_glb_triangles(path: Path) -> int:
    """Back-compat shim: triangle count only (see glb_mesh_stats)."""
    return glb_mesh_stats(path)[0]


def looks_current(path: Path, min_tris: int) -> bool:
    """Resume-mode freshness check. A baked GLB is "current" (skip re-baking)
    iff ALL of:
      - it uses the multi-mesh format (≥3 named meshes), NOT the legacy
        dual-mesh hull/turret format
      - triangle count ≥ a floor (rules out old shard-algorithm bakes)
      - vertices ≤ triangles × 3 + slack (rules out unwelded bakes)
    """
    n_tris, n_verts = glb_mesh_stats(path)
    if n_tris < 0 or n_verts < 0:
        return False
    # Detect old dual-mesh format: exactly 2 nodes named "hull" and "turret".
    # These must be re-baked into the new multi-category format.
    if _is_old_dual_mesh(path):
        return False
    floor = min(min_tris, 2000)
    if n_tris < floor:
        return False
    return n_verts <= n_tris * 3 + 64


def _is_old_dual_mesh(path: Path) -> bool:
    """Return True if *path* is a legacy dual-mesh GLB (hull + turret only)."""
    try:
        data = path.read_bytes()
        _, _, length = struct.unpack_from("<III", data, 0)
        if length > len(data):
            return False
        offset = 12
        json_body = None
        while offset < length:
            chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
            offset += 8
            if chunk_type == 0x4E4F534A:
                json_body = data[offset : offset + chunk_len]
                break
            offset += chunk_len
        if not json_body:
            return False
        g = json.loads(json_body.rstrip(b"\x00").decode("utf-8"))
        nodes = g.get("nodes", [])
        if len(nodes) != 2:
            return False
        names = {n.get("name", "") for n in nodes}
        return names == {"hull", "turret"}
    except Exception:
        return False


def raw_path_for(gp_name: str) -> Path:
    """Unique temp raw-GLB path per ship (collision-safe across runs)."""
    import hashlib
    tag = hashlib.md5(gp_name.encode()).hexdigest()[:8]
    return TEMP_DIR / f"raw_{tag}.glb"


def bake_one(game: str, gp_name: str, output_dir: Path, force: bool,
             resume_min_tris: int = 0, model_dir_name: str | None = None) -> bool:
    """Convert + bake a single ship. Returns True on success (including skip).

    `force`           — always re-bake even if output exists.
    `resume_min_tris` — when >0 (resume mode), skip an existing GLB only if it
                         looks current (enough triangles AND welded vertices).
                         This makes the run safely resumable: re-invoking it
                         only touches files still needing work.
    `model_dir_name`  — internal model directory name (e.g. 'USB001_Yukon_1941')
                         for armor GLB export via game-assets.
    """
    filename = derive_filename(gp_name)
    out_glb = output_dir / filename

    if out_glb.exists():
        if force:
            pass  # re-bake regardless
        elif resume_min_tris > 0:
            if looks_current(out_glb, resume_min_tris):
                # Visual model is current — still check armor.
                return _bake_armor_if_stale(game, gp_name, output_dir, force, model_dir_name)
        else:
            return _bake_armor_if_stale(game, gp_name, output_dir, force, model_dir_name)

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    raw_glb = raw_path_for(gp_name)

    # Step 1: single-ship export (the batch driver uses --batch instead,
    # paying the GameParams warm-up once for the whole fleet).
    try:
        rc = subprocess.call(
            [str(EXPORTER_BIN), "-W", game, "-s", gp_name,
             "-o", str(raw_glb), "-L", "2"],
            timeout=180,
        )
        if rc != 0 or not raw_glb.exists():
            raw_glb.unlink(missing_ok=True)
            print(f"     ↳ exporter rc={rc} (missing game geometry?)")
            return False
    except subprocess.TimeoutExpired:
        raw_glb.unlink(missing_ok=True)
        print(f"     ↳ exporter timed out")
        return False
    except Exception:
        raw_glb.unlink(missing_ok=True)
        print(f"     ↳ exporter crashed")
        return False

    return bake_from_raw(gp_name, raw_glb, output_dir, model_dir_name,
                         game=game, force=force)


def bake_from_raw(gp_name: str, raw_glb: Path, output_dir: Path,
                  model_dir_name: str | None, game: str | None = None,
                  force: bool = False) -> bool:
    """Bake an exported raw GLB into the pack format + refresh armor.

    Steps 2+3 of the bake; separate from the export so the batch driver
    can run one exporter process for the whole fleet and then bake per
    ship."""
    out_glb = output_dir / derive_filename(gp_name)

    # Step 2: bake visual model to low-poly.
    try:
        rc = subprocess.call(
            [sys.executable, str(BAKE_SCRIPT),
             str(raw_glb), "-o", str(out_glb), "--triangles", "15000"],
            timeout=30,
        )
        if rc != 0 or not out_glb.exists():
            raw_glb.unlink(missing_ok=True)
            return False
    except subprocess.TimeoutExpired:
        raw_glb.unlink(missing_ok=True)
        return False
    except Exception:
        raw_glb.unlink(missing_ok=True)
        return False
    finally:
        raw_glb.unlink(missing_ok=True)

    # Step 3: export armor mesh GLB (from game .geometry file).
    if game:
        return _bake_armor_if_stale(game, gp_name, output_dir, force, model_dir_name)
    return True


def _bake_armor_if_stale(game: str, gp_name: str, output_dir: Path, force: bool,
                          model_dir_name: str | None) -> bool:
    prefix = gp_name.split("_")[0]
    armor_glb = output_dir / f"{prefix}_armor.glb"
    if WOWSUNPACK_BIN.exists() and model_dir_name:
        armor_stale = force or not armor_glb.exists()
        if not armor_stale:
            at, _ = glb_mesh_stats(armor_glb)
            armor_stale = at < 500
        if armor_stale:
            try:
                rc = subprocess.call(
                    [str(WOWSUNPACK_BIN), "--game-dir", game,
                     "export-armor-glb", "-o", str(armor_glb), model_dir_name],
                    timeout=60,
                )
                if rc != 0:
                    armor_glb.unlink(missing_ok=True)
            except (subprocess.TimeoutExpired, Exception):
                armor_glb.unlink(missing_ok=True)
    return True


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Batch-bake all WoWS ships to holographic GLBs")
    parser.add_argument("--force", action="store_true",
                        help="re-bake every ship even if an up-to-date GLB exists")
    parser.add_argument("--resume", action="store_true", default=True,
                        help="only re-bake ships whose existing GLB looks stale "
                             "(triangle count below --resume-min-tris). Default on; "
                             "makes the run safely interruptible + resumable. "
                             "Use --no-resume to skip ships that merely exist.")
    parser.add_argument("--no-resume", dest="resume", action="store_false",
                        help="disable resume checks — skip any ship whose GLB file exists")
    parser.add_argument("--resume-min-tris", type=int, default=3000,
                        help="triangle threshold for --resume: existing GLBs with fewer "
                             "triangles are treated as stale and re-baked (default: 3000, "
                             "which separates the old ~2000-tri shard bakes from the "
                             "current ~6000-tri vertex-clustering bakes)")
    parser.add_argument("--limit", type=int, default=0,
                        help="max ships to bake this run (0=all). Combined with --resume "
                             "this gives safe batched processing: each invocation works off "
                             "N stale models and exits, so no single run must finish the lot.")
    parser.add_argument("--game-dir", default=None, help="game install path (default: auto-detect)")
    args = parser.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    ensure_tools()
    SHIPS_OUT.mkdir(parents=True, exist_ok=True)
    ship_names = get_ship_names(game)

    # Filter: only bake ships that don't have a GLB yet (unless --force).
    # Also skip PX*-prefixed ships (event/consumable/Boss units that have no
    # playable 3D hull model — the exporter returns exit 1 for these).
    PLAYABLE_PREFIXES = ("PA", "PB", "PC", "PD", "PE", "PF", "PG", "PH", "PI",
                         "PJ", "PK", "PL", "PM", "PN", "PO", "PP", "PQ", "PR",
                         "PS", "PT", "PU", "PV", "PW", "PZ")  # all playable nations

    # Decide whether an existing GLB is "current" (skip) or "stale" (re-bake):
    #   --force              → never current
    #   --resume (default)   → current iff its triangle count ≥ resume_min_tris
    #   --no-resume          → current iff the file exists
    resume_min_tris = args.resume_min_tris if args.resume else 0

    # Pre-load model-name mapping for armor staleness checks.
    model_name_by_prefix: dict[str, str] = {}
    _models_json = REPO_ROOT / "packages" / "webui" / "src" / "data" / "ship_models.json"
    if _models_json.exists():
        _data = json.loads(_models_json.read_text(encoding="utf-8"))
        for _entry in _data.values():
            if isinstance(_entry, dict):
                _idx = _entry.get("index", "")
                _hm = _entry.get("hullModel", "") or ""
                _parts = _hm.replace("\\", "/").split("/")
                if _idx and len(_parts) >= 2:
                    model_name_by_prefix[_idx] = _parts[-2]

    def needs_baking(gp_name: str) -> bool:
        if args.force:
            return True
        out_glb = SHIPS_OUT / derive_filename(gp_name)
        if not out_glb.exists():
            return True
        if resume_min_tris > 0:
            if not looks_current(out_glb, resume_min_tris):
                return True
        # Check armour GLB staleness too.
        prefix = gp_name.split("_")[0]
        armor_glb = SHIPS_OUT / f"{prefix}_armor.glb"
        if WOWSUNPACK_BIN.exists() and model_name_by_prefix.get(prefix):
            if not armor_glb.exists():
                return True
            at, _ = glb_mesh_stats(armor_glb)
            if at < 500:  # old non-normalized armour
                return True
        return False

    todo = []
    skipped = 0
    stale = 0
    for name in ship_names:
        if not any(name.startswith(p) for p in PLAYABLE_PREFIXES):
            skipped += 1
            continue
        if needs_baking(name):
            todo.append(name)
        else:
            stale += 1  # exists + (current | plain-skip): not baked this run
    if args.limit > 0:
        todo = todo[: args.limit]

    mode = "force" if args.force else ("resume" if args.resume else "skip-existing")
    print(f"[batch_bake] mode={mode}  {len(todo)} to bake, {stale} up-to-date, "
          f"{skipped} non-playable skipped (of {len(ship_names)} total)")
    if not todo:
        print("[batch_bake] nothing to do. Use --force to re-bake everything.")
        return 0

    start = time.time()

    # Phase 1 — one exporter process for the whole fleet: the GameParams
    # parse + VFS mount are paid once, then every ship costs just its
    # geometry read. (A per-ship process would add ~20s × N.)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    manifest = TEMP_DIR / "export_batch.txt"
    manifest.write_text(
        "\n".join(f"{n} {raw_path_for(n)}" for n in todo) + "\n", encoding="utf-8")
    print(f"[batch_bake] exporting {len(todo)} ships via model-exporter --batch ...", flush=True)
    try:
        subprocess.call([str(EXPORTER_BIN), "-W", game,
                         "--batch", str(manifest), "-L", "2"])
    except Exception as e:
        print(f"[batch_bake] exporter batch crashed: {e}", file=sys.stderr)
    results_path = Path(str(manifest) + ".results.txt")
    exported: set[str] = set()
    if results_path.is_file():
        for line in results_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("OK "):
                exported.add(line[3:].split("\t", 1)[0].strip())
    print(f"[batch_bake] export phase: {len(exported)}/{len(todo)} raw GLBs "
          f"in {(time.time()-start)/60:.1f}min", flush=True)

    # Phase 2 — bake each exported raw into the pack format (+ armor).
    ok = 0
    fail = 0
    for i, gp_name in enumerate(todo):
        raw = raw_path_for(gp_name)
        if gp_name in exported and raw.is_file():
            success = bake_from_raw(
                gp_name, raw, SHIPS_OUT,
                model_name_by_prefix.get(gp_name.split("_")[0]),
                game=game, force=args.force)
        else:
            success = False
        if success:
            ok += 1
        else:
            fail += 1
        elapsed = time.time() - start
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (len(todo) - i - 1) / rate if rate > 0 else 0
        status = "✓" if success else "✗"
        eta_min = eta / 60
        print(f"  [{i+1}/{len(todo)}] {status} {gp_name} ({ok} ok, {fail} fail, ETA {eta_min:.0f}min)", flush=True)

    print(f"\n[batch_bake] done: {ok} baked, {fail} failed in {(time.time()-start)/60:.1f}min")
    print(f"[batch_bake] models in {SHIPS_OUT}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
