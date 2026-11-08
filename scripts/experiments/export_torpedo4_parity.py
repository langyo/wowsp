#!/usr/bin/env python3
"""Generate the tracked torp4 parity fixture (T4 diagnostic delivery).

Writes JSONL rows consumed by the app/Rust parity test:
  {"decisionRow": <core v2 decision row>, "torp2Extras": [11], "torp3Extras": [6],
   "torp4Extras": [5], "clickContext": {torpLastClickAgeS, torpClicks30s, torpFish30s,
   torpLastClickFish, torpTotalClicks}, "attrs": {torpSpeed, torpDamage, torpDetect,
   torpCount, torpDeep}, "global49": [49], "logitA": raw, "logitB": /T_B,
   "logitC": /T_C, "scenario": "<label>"}

clickContext/attrs are the EXACT inputs used to derive torp4Extras/torp3Extras (so
Rust can recompute both without the sidecar/attribute-table variants), and the
"attrs" block lets the Rust side build ShipAttrs variants (hull-not-in-table /
fields-missing rows carry explicit zeros; normal rows must equal the tracked
ship_attributes.json entry — that also serves as a liveness check).

The derived blocks and the global49 vector are computed with the SAME functions the
trainer uses (train_torpedo_model.derive_torp2_extras / derive_torp3_extras /
derive_torp4_extras), and the expected logits come from the T4 checkpoint's export
wrapper (temperature baked in: logitB/T_B, logitC/T_C; the app applies sigmoid).

Reproducible: --seed only orders the deterministic scenario list; rows are built
from fixed synthetic decision rows covering the boundary cases requested by T4:
no enemies, no torpedo attribute table entry, out-of-range enemy, very close
enemy (ETA clamp = 1), no click, missing attribute fields, plus normal DD/SS/BB.

Usage:
  python scripts/experiments/export_torpedo4_parity.py \
      --checkpoint scripts/experiments/out/torpedo_model/final_torp4/checkpoint.pt \
      --onnx scripts/experiments/out/torpedo_model/final_torp4/fp32.onnx \
      --out packages/app/tauri/src/commands/fixtures/torpedo4_parity.json

When --onnx is given the fixture is ALSO validated against onnxruntime right after
generation (max|dlogit| must stay < 1e-5).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import train_torpedo_model as ttm  # noqa: E402

REPO = HERE.parents[1]
DEFAULT_CHECKPOINT = HERE / "out" / "torpedo_model" / "final_torp4" / "checkpoint.pt"
DEFAULT_FIXTURE = REPO / "packages" / "app" / "tauri" / "src" / "commands" / "fixtures" / "torpedo4_parity.json"
DEFAULT_SHIP_CLASSES = REPO / "packages" / "webui" / "src" / "res" / "data" / "ships_basics.json"
DEFAULT_SHIP_ATTRS = HERE / "ship_attributes.json"


def base_row(ship_id: int, replay: str, t: float, **overrides) -> dict:
    """A complete core-v2 decision row (same schema the export writes)."""
    row = {
        "replayId": replay,
        "replayVersion": "15,9,0,0",
        "mapName": "spaces/20_Atlantic",
        "ownerEntityId": 916676,
        "shipId": ship_id,
        "teamId": 0,
        "t": float(t),
        "ownSpeedKt": 20.0,
        "ownHpFrac": 1.0,
        "ownReloadFrac": 0.5,
        "ownRangeM": 10000.0,
        "zonesOwned0": 1,
        "zonesOwned1": 0,
        "zonesOwned2": 0,
        "zonesOwnedOther": 2,
        "zonesActiveProgress": 1,
        "eventsShells30s": 3,
        "eventsTorps30s": 1,
        "eventsExplosions30s": 0,
        "eventsExplosionsNear30s": 0,
        "enemies": [],
        "friends": [],
        "gameMode": "pvp",
        "featureVersion": 2,
        "ownDamconFrac": 1.0,
        "ownRepairFrac": 1.0,
        "ownOtherConsumableFrac": -1.0,
        "ownEnginePower": 0.5,
        "ownEngineDir": 1.0,
        "ownInSmoke": False,
        "activeSmokeCountFrac": 0.0,
        "activeSmokeAreaFeat": 0.0,
        "visionCapFrac": 1.0,
        "weatherIncomingFrac": 0.0,
        "allyRadarCountFrac": -1.0,
        "allyHydroCountFrac": -1.0,
        "e11EventsKnown": True,
        "labelACanLaunch": True,
        "labelBLaunched": True,
        "ownTorpReloadFrac": 0.5,
        "ownTorpRangeM": 10000.0,
    }
    row.update(overrides)
    return row


def enemy(dist_m, bearing=0.5, observed=True, ship_id=2, **overrides) -> dict:
    e = {
        "entityId": 9,
        "entityType": 2,
        "shipId": ship_id,
        "distM": float(dist_m),
        "bearingRelRad": float(bearing),
        "speedKt": 15.0,
        "hpFrac": 0.8,
        "obsAgeS": 0.2,
        "observedNow": bool(observed),
        "terrainBlocked": None,
        "spotting": None,
        "insideSmoke": False,
        "radarLit": False,
        "isEnemy": True,
        "enginePowerFrac": 0.5,
    }
    e.update(overrides)
    return e


def click_rec(age, clicks30, fish30, last_fish, total):
    return {
        "replayId": "fixture",
        "t": 0.0,
        "shipId": 0,
        "torpLastClickAgeS": float(age),
        "torpClicks30s": int(clicks30),
        "torpFish30s": int(fish30),
        "torpLastClickFish": int(last_fish),
        "torpTotalClicks": int(total),
    }


def pick_hulls(classes: dict, attrs: dict) -> dict:
    """Pick one usable hull per class (present in ships_basics + attribute table)."""
    wanted = {"Destroyer": None, "Cruiser": None, "Battleship": None, "Submarine": None}
    for sid, cls in sorted(classes.items(), key=lambda kv: kv[0]):
        if cls in wanted and wanted[cls] is None and str(sid) in attrs:
            rec = attrs[str(sid)]
            if float(rec.get("torpSpeed", 0.0) or 0.0) > 0.0:
                wanted[cls] = sid
    return wanted


def build_scenarios(hulls: dict) -> list[tuple[str, dict, dict | None, str]]:
    """(scenario label, row, click record|None, attrs variant) — 48 deterministic rows."""
    dd = hulls["Destroyer"]
    cl = hulls["Cruiser"]
    bb = hulls["Battleship"]
    ss = hulls["Submarine"]
    missing_hull = 123456789  # not in ships_basics -> class "unknown", no attributes
    rows: list[tuple[str, dict, dict | None, str]] = []

    def add(label, hull, click, variant="base", **over):
        rows.append((label, base_row(hull, "torpedo4-parity.wowsreplay", 100.0 + len(rows) * 4.0, **over), click, variant))

    kinds = [(dd, "dd"), (cl, "cl"), (bb, "bb"), (ss, "ss")]
    # 1) normal engagements: one observed in-range enemy, mixture of click contexts.
    for i in range(6):
        hull, tag = kinds[i % 4]
        add(
            "normal_" + tag,
            hull,
            click_rec(5.0 + i * 7.0, i, 2 * i, i, 10 + 5 * i),
            enemies=[enemy(4200.0 + 500.0 * i, bearing=0.2 + 0.1 * i)],
        )
    # 2) no enemies at all (geometry dims stay 0).
    for i in range(6):
        hull, tag = kinds[i % 4]
        add("no_enemies_" + tag, hull, click_rec(-1.0, 0, 0, 0, 0), enemies=[])
    # 3) enemy observed but out of torpedo range.
    for i in range(6):
        hull, tag = kinds[i % 4]
        add(
            "out_of_range_" + tag,
            hull,
            click_rec(30.0, 3, 1, 1, 12),
            ownRangeM=6000.0,
            enemies=[enemy(9000.0 + 400.0 * i)],
        )
    # 4) very close enemy: ETA clamp saturates at 1.0.
    for i in range(6):
        hull, tag = kinds[i % 4]
        add(
            "close_eta_clamp_" + tag,
            hull,
            click_rec(2.0, 6, 4, 3, 30),
            ownRangeM=12000.0,
            enemies=[enemy(120.0 + 10.0 * i)],
        )
    # 5) no click yet (sidecar sentinel age = -1; counts 0).
    for i in range(6):
        hull, tag = kinds[i % 4]
        add(
            "no_click_" + tag,
            hull,
            click_rec(-1.0, 0, 0, 0, 0),
            enemies=[enemy(3000.0, bearing=-0.4 + 0.1 * i)],
        )
    # 6) hull absent from the attribute table -> torp3 dims all 0.
    for i in range(6):
        add(
            "hull_not_in_attrs_" + str(i),
            missing_hull,
            click_rec(12.0, 2, 1, 1, 8),
            variant="missing",
            enemies=[enemy(4500.0, bearing=0.1 * i)],
        )
    # 7) attribute entry present but the five torp fields are missing -> zeros.
    for i in range(6):
        hull, tag = kinds[(i + 1) % 4]
        add(
            "attrs_fields_missing_" + tag,
            hull,
            click_rec(45.0, 4, 0, 0, 20),
            variant="blank",
            enemies=[enemy(7000.0, bearing=0.3 + 0.05 * i)],
        )
    # 8) mixed: stale (not observed now) + friendly slots + launch labels off.
    for i in range(6):
        hull, tag = kinds[i % 4]
        add(
            "stale_and_mixed_" + tag,
            hull,
            click_rec(59.0, 5, 3, 2, 40),
            labelACanLaunch=(i % 2 == 0),
            labelBLaunched=(None if i % 2 == 0 else False),
            enemies=[
                enemy(2600.0, bearing=1.9, observed=False),
                enemy(5200.0, bearing=-0.7, observed=True),
            ],
            friends=[
                {
                    "entityId": 10, "entityType": 2, "shipId": 3760109296,
                    "distM": 900.0, "bearingRelRad": 2.7, "speedKt": 12.0,
                    "hpFrac": 0.6, "obsAgeS": 0.0, "observedNow": True,
                    "terrainBlocked": None, "insideSmoke": False, "radarLit": False,
                    "isEnemy": False, "enginePowerFrac": 0.4,
                }
            ],
        )
    return rows


def click_context_block(click: dict | None) -> dict:
    """The exact click sidecar values used to derive torp4Extras."""
    if not click:
        return {
            "torpLastClickAgeS": -1.0,
            "torpClicks30s": 0,
            "torpFish30s": 0,
            "torpLastClickFish": 0,
            "torpTotalClicks": 0,
        }
    return {
        "torpLastClickAgeS": float(click.get("torpLastClickAgeS", -1.0)),
        "torpClicks30s": int(click.get("torpClicks30s", 0)),
        "torpFish30s": int(click.get("torpFish30s", 0)),
        "torpLastClickFish": int(click.get("torpLastClickFish", 0)),
        "torpTotalClicks": int(click.get("torpTotalClicks", 0)),
    }


def attrs_block(attrs_used: dict, ship_id: int) -> dict:
    """The exact five attribute values used to derive torp3Extras (0 = missing)."""
    rec = attrs_used.get(str(int(ship_id)), {}) if attrs_used else {}
    return {
        key: float(rec.get(key, 0.0) or 0.0)
        for key in ("torpSpeed", "torpDamage", "torpDetect", "torpCount", "torpDeep")
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate the tracked torp4 parity fixture")
    ap.add_argument("--checkpoint", default=str(DEFAULT_CHECKPOINT))
    ap.add_argument("--onnx", default=str(DEFAULT_CHECKPOINT.with_name("fp32.onnx")))
    ap.add_argument("--out", default=str(DEFAULT_FIXTURE))
    ap.add_argument("--rows", type=int, default=48)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--ship-classes", default=str(DEFAULT_SHIP_CLASSES))
    ap.add_argument("--ship-attrs", default=str(DEFAULT_SHIP_ATTRS))
    args = ap.parse_args(argv)

    import torch

    ckpt_path = Path(args.checkpoint)
    if not ckpt_path.is_file():
        raise SystemExit("[t4] checkpoint not found: " + str(ckpt_path))
    blob = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    hidden = int(blob.get("hidden", 192))
    entity_dim = int(blob.get("entity_dim", 15))
    global_dim = int(blob.get("global_dim", 49))
    if global_dim != 49:
        raise SystemExit("[t4] checkpoint global_dim " + str(global_dim) + " != 49 (not a torp4 model)")
    temp_b = float(blob.get("temp_b", 0.7564))
    temp_c = float(blob.get("temp_c", 1.0723))
    model = ttm.build_three_head_model(torch, hidden=hidden, entity_dim=entity_dim, global_dim=global_dim)
    model.load_state_dict(blob["model"])
    model.eval()

    classes = ttm.load_ship_classes(Path(args.ship_classes))[0]
    attrs = ttm.load_ship_attributes(Path(args.ship_attrs))
    hulls = pick_hulls(classes, attrs)
    if any(v is None for v in hulls.values()):
        raise SystemExit("[t4] could not find DD/CL/BB/SS hulls in both tables: " + str(hulls))

    scenarios = build_scenarios(hulls)
    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(scenarios))[: args.rows]
    rows_out = []
    for pos, idx in enumerate(order.tolist()):
        label, row, click, variant = scenarios[idx]
        cls = ttm.class_of(int(row["shipId"]), classes)
        attrs_used = attrs
        if variant == "missing":
            attrs_used = attrs
        elif variant == "blank":
            attrs_used = dict(attrs)
            attrs_used[str(row["shipId"])] = {}
        click_ctx = click_context_block(click)
        attr_vals = attrs_block(attrs_used, int(row["shipId"]))
        t2 = ttm.derive_torp2_extras(row, cls)
        t3 = ttm.derive_torp3_extras(row, cls, {str(int(row["shipId"])): attr_vals}, int(row["shipId"]))
        t4 = ttm.derive_torp4_extras(click_ctx)
        e, m = ttm.tfm.entity_matrix_and_mask(row, ttm.FEATURE_VERSION)
        g = ttm.tfm.global_vector(row, ttm.FEATURE_VERSION)
        global49 = [float(x) for x in g] + list(t2) + list(t3) + list(t4)
        if len(global49) != 49:
            raise SystemExit("[t4] global49 width " + str(len(global49)))
        with torch.no_grad():
            la, lb, lc = model(
                torch.from_numpy(e).float().unsqueeze(0),
                torch.from_numpy(np.asarray(global49, dtype=np.float32)).unsqueeze(0),
                torch.from_numpy(m).float().unsqueeze(0),
            )
        lb, lc = ttm.tempered_logits(lb, lc, temp_b, temp_c)
        rows_out.append(
            {
                "decisionRow": row,
                "torp2Extras": [float(x) for x in t2],
                "torp3Extras": [float(x) for x in t3],
                "torp4Extras": [float(x) for x in t4],
                "clickContext": click_ctx,
                "attrs": attr_vals,
                "global49": global49,
                "logitA": float(la.reshape(-1)[0]),
                "logitB": float(lb.reshape(-1)[0]),
                "logitC": float(lc.reshape(-1)[0]),
                "scenario": label,
            }
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out) + "\n", encoding="utf-8")
    print(f"[t4] fixture -> {out_path} ({len(rows_out)} rows, {out_path.stat().st_size:,} bytes)")
    print(f"[t4] checkpoint {ckpt_path.name}: T_B={temp_b} T_C={temp_c} hidden={hidden} global_dim={global_dim}")

    # Self-check 1: global49 must be exactly decisionRow-derived (same code path).
    for r in rows_out:
        cls = ttm.class_of(int(r["decisionRow"]["shipId"]), classes)
        variant = "blank" if r["scenario"].startswith("attrs_fields_missing") else "base"
        attrs_used = dict(attrs) if variant == "blank" else attrs
        if variant == "blank":
            attrs_used[str(r["decisionRow"]["shipId"])] = {}
        g = ttm.tfm.global_vector(r["decisionRow"], ttm.FEATURE_VERSION)
        g49 = [float(x) for x in g] + list(r["torp2Extras"]) + list(r["torp3Extras"]) + list(r["torp4Extras"])
        if len(g49) != len(r["global49"]) or max(abs(a - b) for a, b in zip(g49, r["global49"])) > 1e-9:
            raise SystemExit("[t4] fixture global49 mismatch for scenario " + r["scenario"])
    print("[t4] self-check: global49 matches decisionRow-derived features (<=1e-9)")
    for r in rows_out:
        cls = ttm.class_of(int(r["decisionRow"]["shipId"]), classes)
        sid = int(r["decisionRow"]["shipId"])
        t3_re = ttm.derive_torp3_extras(r["decisionRow"], cls, {str(sid): r["attrs"]}, sid)
        t4_re = ttm.derive_torp4_extras(r["clickContext"])
        if max(abs(a - b) for a, b in zip(t3_re, r["torp3Extras"])) > 1e-12:
            raise SystemExit("[t4] torp3Extras not reproducible from attrs: " + r["scenario"])
        if max(abs(a - b) for a, b in zip(t4_re, r["torp4Extras"])) > 1e-12:
            raise SystemExit("[t4] torp4Extras not reproducible from clickContext: " + r["scenario"])
        if not r["scenario"].startswith(("hull_not_in_attrs", "attrs_fields_missing")):
            if r["attrs"] != attrs_block(attrs, sid):
                raise SystemExit("[t4] normal-row attrs drifted from tracked table: " + r["scenario"])
    print("[t4] self-check: torp3Extras/attrs + torp4Extras/clickContext reproduce (<=1e-12)")

    # Self-check 2: optional ONNX parity (fixture forward vs ONNX).
    onnx_path = Path(args.onnx)
    if onnx_path.is_file():
        import onnxruntime as ort

        sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        worst = 0.0
        for r in rows_out:
            idx = ttm.tfm.entity_matrix_and_mask(r["decisionRow"], ttm.FEATURE_VERSION)
            e, m = idx
            out = sess.run(
                None,
                {
                    "entity": e.astype(np.float32)[None, :, :],
                    "global_feat": np.asarray(r["global49"], dtype=np.float32)[None, :],
                    "mask": m.astype(np.float32)[None, :],
                },
            )
            diff = max(
                abs(float(np.asarray(out[0]).reshape(-1)[0]) - r["logitA"]),
                abs(float(np.asarray(out[1]).reshape(-1)[0]) - r["logitB"]),
                abs(float(np.asarray(out[2]).reshape(-1)[0]) - r["logitC"]),
            )
            worst = max(worst, diff)
        print(f"[t4] onnx parity over {len(rows_out)} fixture rows: max|dlogit| {worst:.2e}")
        if worst > 1e-5:
            raise SystemExit("[t4] fixture-vs-ONNX parity failed: " + str(worst))
    else:
        print("[t4] --onnx not found, skipping ONNX parity: " + str(onnx_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
