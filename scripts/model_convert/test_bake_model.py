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

from bake_model import _pad4, write_glb, write_glb_dual, write_glb_multimesh


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
