"""Regression tests for the GLB writers in bake_model.py.

The shipped model pack needed `repair_glbs.py` (and the loader's runtime
`fixGlbPadding`) because the writers padded the JSON chunk with NUL bytes.
the glTF 2.0 GLB container rule requires SPACES there — strict JSON parsers (three's GLTFLoader,
serde_json) reject trailing NULs. These tests lock the padding contract on
every writer so a regression cannot ship silently again.

Run standalone (they are not part of the visual/e2e suites):

    python -m pytest scripts/model_convert/test_bake_model.py -q
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

import numpy as np

from bake_model import (
    LOD_BBOX_TOL_PCT,
    _lod_structure_scale,
    dedup_lod_primitives,
    extract_by_instance,
    _pad4,
    write_glb,
    write_glb_dual,
    write_glb_multimesh,
)


def chunk_layout(data: bytes) -> tuple[int, bytes, bytes]:
    """Parse a GLB container: (json_len, json_chunk, bin_chunk)."""
    assert data[0:4] == b"glTF", "magic"
    total = struct.unpack_from("<I", data, 8)[0]
    assert total == len(data), f"declared length {total} != file size {len(data)}"
    json_len = struct.unpack_from("<I", data, 12)[0]
    assert data[16:20] == b"JSON"
    json_chunk = data[20 : 20 + json_len]
    offset = 20 + json_len
    bin_chunk = b""
    if offset + 8 <= len(data):
        bin_len = struct.unpack_from("<I", data, offset)[0]
        assert data[offset + 4 : offset + 8] == b"BIN\x00"
        bin_chunk = data[offset + 8 : offset + 8 + bin_len]
        assert len(bin_chunk) == bin_len
    return json_len, json_chunk, bin_chunk


def assert_spec_padding(json_chunk: bytes) -> int:
    """The JSON chunk parses verbatim and never contains a NUL byte.

    Returns the padding byte count, so callers can assert the sample actually
    exercised a padded run."""
    assert b"\x00" not in json_chunk, "JSON chunk contains NUL padding"
    parsed = json.loads(json_chunk)  # strict: trailing NUL would raise here
    bare = len(json.dumps(parsed, separators=(",", ":")).encode("utf-8"))
    assert bare <= len(json_chunk)
    if bare < len(json_chunk):
        assert json_chunk[bare:] == b" " * (len(json_chunk) - bare), \
            "JSON padding must be spaces (glTF 2.0 GLB rule)"
    return len(json_chunk) - bare


def test_pad4_helpers_pad_json_with_spaces_and_binary_with_zeros() -> None:
    assert _pad4(b"abc") == b"abc\x00"
    assert _pad4(b"abc", b" ") == b"abc "
    assert _pad4(b"abcd", b" ") == b"abcd"  # already aligned: no padding
    assert _pad4(b"", b" ") == b""


def test_write_glb_multimesh_json_chunk_is_space_padded(tmp_path: Path) -> None:
    saw_padding = 0
    # Several sizes: a single one may land 4-aligned by chance and pad nothing.
    for extra in range(6):
        verts = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        verts += [0.5 + extra * 0.01] * 3  # vary the JSON's digit content
        out = tmp_path / f"multi_{extra}.glb"
        write_glb_multimesh(out, [("hull", verts, [0, 1, 2])])
        json_len, json_chunk, _ = chunk_layout(out.read_bytes())
        assert json_len > 0
        saw_padding += assert_spec_padding(json_chunk)
    assert saw_padding > 0, "the sample must include at least one padded run"


def test_write_glb_single_mesh_space_padded(tmp_path: Path) -> None:
    out = tmp_path / "single.glb"
    write_glb(out, [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], [0, 1, 2])
    _, json_chunk, _ = chunk_layout(out.read_bytes())
    assert_spec_padding(json_chunk)


def test_write_glb_dual_space_padded(tmp_path: Path) -> None:
    tri = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    out = tmp_path / "dual.glb"
    write_glb_dual(out, tri, [0, 1, 2], tri, [0, 1, 2])
    _, json_chunk, _ = chunk_layout(out.read_bytes())
    assert_spec_padding(json_chunk)


def test_binary_chunks_still_pad_with_zeros(tmp_path: Path) -> None:
    # 3 vertices → 36 bytes of positions (aligned); indices u16 ×3 = 6 bytes
    # → the BIN chunk needs 2 zero bytes of alignment padding.
    out = tmp_path / "binpad.glb"
    write_glb(out, [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], [0, 1, 2])
    _, _, bin_chunk = chunk_layout(out.read_bytes())
    assert len(bin_chunk) % 4 == 0
    assert bin_chunk[-2:] == b"\x00\x00", "BIN alignment padding stays zeros"


def test_accessor_bounds_hold_on_a_fresh_multimesh_bake(tmp_path: Path) -> None:
    """A fresh bake satisfies the strict container rules three's GLTFLoader
    enforces: every accessor fits inside its bufferView, and each index
    buffer's element count is a multiple of 3."""
    verts = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
             0.5, 0.5, 0.5, 1.5, 0.5, 0.5, 0.5, 1.5, 0.5]
    out = tmp_path / "bounds.glb"
    write_glb_multimesh(out, [("hull", verts, [0, 1, 2, 3, 4, 5])])
    _, json_chunk, _ = chunk_layout(out.read_bytes())
    doc = json.loads(json_chunk)
    buffer_len = doc["buffers"][0]["byteLength"]
    sizes = {5126: 4, 5123: 2, 5125: 4}
    for acc in doc["accessors"]:
        view = doc["bufferViews"][acc["bufferView"]]
        ncomp = {"SCALAR": 1, "VEC3": 3}[acc["type"]]
        need = acc["count"] * ncomp * sizes[acc["componentType"]]
        acc_offset = acc.get("byteOffset", 0)  # relative to the view
        assert acc_offset + need <= view["byteLength"], "accessor exceeds its bufferView"
        assert view.get("byteOffset", 0) + view["byteLength"] <= buffer_len, "bufferView exceeds the buffer"
        if acc["type"] == "SCALAR":
            assert acc["count"] % 3 == 0, "index count must be a triangle multiple"


# ── LOD dedup (plane bakes) ────────────────────────────────────────────────
# Plane .geometry files carry every section at three detail levels: separate
# primitives with IDENTICAL bounding boxes and decreasing triangle counts.
# Merging all of them triple-surfaces the model and sheds detached debris in
# the airframe stage. `dedup_lod_primitives` collapses each equal-bbox set to
# its densest member; these tests lock the matching rules and the robust
# structure scale that sizes the window.


def _staged(verts: list[float], tris: list[int], cat: str = "misc", inst: str = "0"):
    return (cat, inst, np.asarray(verts, dtype=np.float64).reshape(-1, 3),
            np.asarray(tris, dtype=np.int64))


_UNIT_BOX_VERTS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]


def test_dedup_collapses_an_lod_set_to_its_densest_member() -> None:
    box = _staged(_UNIT_BOX_VERTS, list(range(36)))          # 12 tris — LOD0
    octa = _staged([0, .5, .5, 1, .5, .5, .5, 0, .5, .5, 1, .5, .5, .5, 0, .5, .5, 1],
                   list(range(24)))                           # 8 tris — LOD1
    tetra = _staged([0, 0, 0, 1, 0, 0, .5, 1, .5, .5, .5, 1], list(range(12)))
    kept, stats = dedup_lod_primitives([octa, tetra, box])
    assert len(kept) == 1 and kept[0] is box, "only the densest primitive of the set survives"
    assert stats["sets"] == 1 and stats["dropped"] == 2 and stats["dropped_tris"] == 8 + 4


def test_dedup_keeps_distinct_overlapping_and_mirrored_parts() -> None:
    fuselage = _staged(_UNIT_BOX_VERTS, list(range(36)))
    # A canopy breaking OUT of the fuselage box's top face: it overlaps but
    # matches no corner pair, so it is a section of its own and stays.
    canopy = _staged([.25, 1, .25, .75, 1, .25, .75, 1.5, .75, .25, 1.5, .75],
                     [0, 1, 2, 0, 2, 3])
    # A mirrored twin at negative x: same SIZE, different POSITION — stays.
    twin = _staged([v + (-3 if i % 3 == 0 else 0) for i, v in enumerate(_UNIT_BOX_VERTS)],
                   list(range(36)))
    kept, stats = dedup_lod_primitives([fuselage, canopy, twin])
    assert len(kept) == 3 and kept[0] is fuselage and kept[1] is canopy and kept[2] is twin
    assert stats["dropped"] == 0


def test_dedup_never_crosses_category_or_instance_buckets() -> None:
    a = _staged(_UNIT_BOX_VERTS, list(range(36)), cat="misc", inst="0")
    b = _staged(_UNIT_BOX_VERTS, list(range(36)), cat="misc", inst="7")
    c = _staged(_UNIT_BOX_VERTS, list(range(36)), cat="aircraft", inst="0")
    kept, stats = dedup_lod_primitives([a, b, c])
    assert len(kept) == 3 and kept[0] is a and kept[1] is b and kept[2] is c
    assert stats["dropped"] == 0


def test_dedup_tolerance_splits_at_the_documented_window() -> None:
    # The unit box's diagonal is the structure scale here (sqrt(3) ≈ 1.73), so
    # the window is ≈ 0.0087 — shifts of 0.001 fall inside, 0.05 falls outside.
    rep = _staged(_UNIT_BOX_VERTS, list(range(36)))
    inside = _staged([v + (0.001 if i % 3 == 0 else 0) for i, v in enumerate(_UNIT_BOX_VERTS)],
                     list(range(24)))
    outside = _staged([v + (0.05 if i % 3 == 0 else 0) for i, v in enumerate(_UNIT_BOX_VERTS)],
                      list(range(24)))
    kept, stats = dedup_lod_primitives([rep, inside])
    assert len(kept) == 1 and kept[0] is rep and stats["dropped"] == 1, "within the window: same LOD set"
    kept, stats = dedup_lod_primitives([rep, outside])
    assert len(kept) == 2 and kept[0] is rep and kept[1] is outside and stats["dropped"] == 0, "past the window: separate section"


def test_dedup_scale_ignores_far_away_strays() -> None:
    # A stray parked at 100 units would inflate the GLOBAL extent ~50x and the
    # old extent-based window with it (absorbing the 0.05-shifted section).
    # The structure scale keys on the second-largest primitive diagonal, so
    # the stray cannot move the window and the section stays its own.
    stray = _staged([100, 100, 100, 150, 100, 100, 150, 150, 100, 100, 150, 150],
                    list(range(12)))
    rep = _staged(_UNIT_BOX_VERTS, list(range(36)))
    near = _staged([v + (0.001 if i % 3 == 0 else 0) for i, v in enumerate(_UNIT_BOX_VERTS)],
                   list(range(24)))
    far = _staged([v + (0.05 if i % 3 == 0 else 0) for i, v in enumerate(_UNIT_BOX_VERTS)],
                  list(range(24)))
    assert _lod_structure_scale(np.asarray([1.0, 5.0, 50.0])) == 5.0
    kept, stats = dedup_lod_primitives([stray, rep, near])
    assert len(kept) == 2 and kept[0] is stray and kept[1] is rep
    assert stats["sets"] == 1 and stats["dropped"] == 1, "the true LOD set still collapses beside the stray"
    kept, stats = dedup_lod_primitives([stray, rep, far])
    assert len(kept) == 3 and stats["dropped"] == 0, "the window did not grow with the stray"


def test_dedup_on_empty_input_and_nonfinite_bounds_is_a_noop() -> None:
    empty = _staged([], [])
    kept, stats = dedup_lod_primitives([])
    assert kept == [] and stats["dropped"] == 0
    nan_prim = _staged([float("nan")] * 12, list(range(12)))
    empty_vt = _staged([], [])
    box = _staged(_UNIT_BOX_VERTS, list(range(36)))
    kept, stats = dedup_lod_primitives([nan_prim, box])
    assert len(kept) == 2 and kept[0] is nan_prim and kept[1] is box, "non-finite bounds never match — both stay"
    assert stats["dropped"] == 0
    # ALL primitives degenerate: no diagonal survives to scale the window —
    # a no-op, never an IndexError.
    kept, stats = dedup_lod_primitives([nan_prim, empty_vt])
    assert kept == [nan_prim, empty_vt] or kept == [empty_vt, nan_prim]
    assert stats == {"sets": 0, "dropped": 0, "dropped_tris": 0}


def _synthetic_lod_gltf() -> dict:
    """One node, one mesh, four primitives: a 3-level LOD set + a wing plate.

    Mirrors a real plane export (J7W3: 18 primitives, sections at 3 detail
    levels in one coordinate frame) in miniature."""
    lods = [
        (_UNIT_BOX_VERTS, list(range(36))),                    # box, 12 tris
        ([0, .5, .5, 1, .5, .5, .5, 0, .5, .5, 1, .5, .5, .5, 0, .5, .5, 1], list(range(24))),
        ([0, 0, 0, 1, 0, 0, .5, 1, .5, .5, .5, 1], list(range(12))),
    ]
    wing_verts = [2, 0, 0, 3, 0, 0, 2, .1, .5, 3, .1, .5]
    wing_idx = [0, 1, 2, 0, 2, 3]
    blob = bytearray()
    views, accessors, prims = [], [], []

    def add(data: bytes, comp: int, typ: str, count: int) -> int:
        pad = (-len(blob)) % 4
        blob.extend(b"\x00" * pad)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": comp,
                          "count": count, "type": typ})
        return len(accessors) - 1

    for verts, idx in lods + [(wing_verts, wing_idx)]:
        pv = add(struct.pack(f"<{len(verts)}f", *verts), 5126, "VEC3", len(verts) // 3)
        pi = add(struct.pack(f"<{len(idx)}I", *idx), 5125, "SCALAR", len(idx))
        prims.append({"attributes": {"POSITION": pv}, "indices": pi, "mode": 4})
    gltf = {
        "json": {
            "accessors": accessors,
            "bufferViews": views,
            "buffers": [{"byteLength": len(blob)}],
            "meshes": [{"primitives": prims}],
            "nodes": [{"mesh": 0}],
            "scene": 0,
            "scenes": [{"nodes": [0]}],
        },
        "binary": bytes(blob),
    }
    return gltf


def test_extract_by_instance_dedup_lods_end_to_end() -> None:
    gltf = _synthetic_lod_gltf()
    merged = extract_by_instance(gltf)
    assert sum(len(idx) // 3 for _, idx in merged["misc"].values()) == 12 + 8 + 4 + 2

    deduped = extract_by_instance(gltf, dedup_lods=True)
    verts, idx = deduped["misc"]["0"]
    # The LOD set collapses to the 12-tri box; the wing plate (a different
    # section — its own bbox) survives beside it.
    assert len(idx) // 3 == 12 + 2
    assert len(verts) // 3 == 8 + 4
