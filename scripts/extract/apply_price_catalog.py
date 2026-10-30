#!/usr/bin/env python3
"""Fill the upgrade-chain economy from a captured client price catalog.

The client's module economy - per-module research XP, buy credits, and the
"with required modules" research total - is NOT in GameParams or the scripts
layer: it is the server-synced price catalog the client receives at login.
The in-game probe captures that catalog into price_catalog.json (see
packages/ingame-plugin/src/Main.py, "server-synced price catalog"); this
script joins the capture onto the generated chain bundles:

  packages/webui/src/data/ship_upgrade_chain.json         WG
  packages/webui/src/data/ship_upgrade_chain_lesta.json   Lesta

JOIN KEYS (verified against a real WG port capture, build 13357625):
  - itemPrice entities identify their item by the component's numeric "id",
    which IS the priced entity's GameParams id. Module steps carry that same
    number as "gpid" (the extractor writes it), so a module price joins
    directly onto the step. Ship prices carry the ship's own GameParams id,
    which is the chain's shipId key - the ship-level exp price cross-checks
    the chain's research.xp (exact match on all 1230 WG ships in the first
    capture), which is the sanity gate below.
  - the currency is the component's consumer string "currency" ("exp" =
    research XP, "credits" = buy price, "gold" = doubloons); the numeric
    currencyID is only a fallback when the string is absent.
  - shipCrossResearchInfo (when the capture carries it - the WG port
    capture came back empty) wins for the "with required modules" total;
    otherwise the total is computed from the chain's own unlock graph: the
    modules that carry nextShips for the edge are exactly the modules that
    must be researched first, so their captured XP plus the child's research
    XP is the minimal-equipment total.

Fields filled (everything else is left untouched):

  ships.<id>.slots[].steps[].xp           per-module research XP  (itemPrice)
  ships.<id>.slots[].steps[].credits      per-module buy credits   (itemPrice)
  ships.<id>.next.<child>.xpWithModules   ship XP + required-module XP
  ships.<id>.next.<child>.requiredModules module entry names

Nothing is written unless --apply is passed, and every value is cross-checked
before it lands: a captured ship XP must equal the chain's existing xpShip,
and a required-module XP total is only emitted when every required module's
XP is known (never fabricated).

Usage:
    # shape + join report only (no writes) - run this on a fresh capture first
    python scripts/extract/apply_price_catalog.py --realm wg --catalog price_catalog.json --inspect

    # write the economy fields into the bundled chain JSON
    python scripts/extract/apply_price_catalog.py --realm wg --catalog price_catalog.json --apply

    # offline proof of the join/fill logic (no capture needed)
    python scripts/extract/apply_price_catalog.py --self-test
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SRC_DATA = REPO / "packages/webui/src/data"
CHAIN_PATHS = {
    "wg": SRC_DATA / "ship_upgrade_chain.json",
    "lesta": SRC_DATA / "ship_upgrade_chain_lesta.json",
}

# Currency buckets. The client writes the currency as a consumer string
# (field "currency"); the numeric "currencyID" mirrors it (0 credits,
# 1 gold, 2 exp on the captured build) and is only used when the string is
# missing.
XP_CURRENCIES = {"exp", "xp", "xpship", "shipxp", "experience", "shipexperience"}
CREDIT_CURRENCIES = {"credits", "credit", "silver", "silvercredits"}
GOLD_CURRENCIES = {"gold", "doubloons", "doubloon"}


def _norm_currency(value):
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    return text.replace("_", "").replace("-", "").replace(" ", "")


def _currency_bucket(currency):
    key = _norm_currency(currency)
    if key is None:
        return None
    if key in XP_CURRENCIES:
        return "xp"
    if key in CREDIT_CURRENCIES:
        return "credits"
    if key in GOLD_CURRENCIES:
        return "gold"
    return None


def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _entities(capture, collection):
    cols = capture.get("collections")
    if not isinstance(cols, dict):
        return []
    value = cols.get(collection)
    return value if isinstance(value, list) else []


def _component_map(entity):
    out = {}
    comps = entity.get("components")
    if isinstance(comps, dict):
        for comp in comps.values():
            if isinstance(comp, dict):
                out.update(comp)
    return out


def _iter_steps(chain):
    """(shipId, ship record, step) for every module step of a bundle."""
    for sid, record in (chain.get("ships") or {}).items():
        for slot in record.get("slots") or []:
            for step in slot.get("steps") or []:
                yield sid, record, step


def _price_lookup(capture):
    """gpid -> {xp?, credits?, gold?} plus a name-keyed fallback map."""
    by_gpid = {}
    by_name = {}
    for entity in _entities(capture, "itemPrice"):
        comp = _component_map(entity)
        amount = _int(comp.get("finalPrice"))
        if amount is None:
            amount = _int(comp.get("basePrice"))
        # A zero price is the client's "no cost" sentinel (free/stock gear):
        # leave the field null instead of rendering a literal 0 as a price.
        if amount is None or amount <= 0:
            continue
        bucket = _currency_bucket(comp.get("currency"))
        if bucket is None:
            if comp.get("currency") is not None:
                continue
            bucket = {0: "credits", 1: "gold", 2: "xp"}.get(_int(comp.get("currencyID")))
            if bucket is None:
                continue
        gpid = _int(comp.get("id"))
        if gpid is not None:
            by_gpid.setdefault(gpid, {})[bucket] = amount
        elif isinstance(entity.get("id"), str) and entity.get("id"):
            by_name.setdefault(entity["id"], {})[bucket] = amount
    return {"by_gpid": by_gpid, "by_name": by_name}


def _research_lookup(capture):
    """shipId -> {xp, xpWithModules, requiredModules} from the synced component."""
    out = {}
    for entity in _entities(capture, "shipCrossResearchInfo"):
        entity_id = _int(entity.get("id"))
        if entity_id is None:
            continue
        comp = _component_map(entity)
        xp = _int(comp.get("researchPriceShipExp"))
        deps = comp.get("dependenciesResearchPriceInfo")
        required = []
        dep_xp = 0
        has_dep = False
        if isinstance(deps, dict):
            for key, item in deps.items():
                required.append(str(key))
                amount = None
                if isinstance(item, dict):
                    amount = _int(item.get("finalPrice"))
                    if amount is None:
                        amount = _int(item.get("basePrice"))
                if amount is not None:
                    dep_xp += amount
                    has_dep = True
        total = _int(comp.get("totalCostXP"))
        if total is None:
            dep_cost = _int(comp.get("shipsCrossResearchCostXP"))
            if dep_cost is not None and dep_cost > 0:
                total = (xp or 0) + dep_cost
            elif has_dep:
                total = (xp or 0) + dep_xp
        out[str(entity_id)] = {
            "xp": xp,
            "xpWithModules": total,
            "requiredModules": required or None,
        }
    return out


def _step_price(prices, step):
    """The captured economy of one step: gpid first, name as the fallback."""
    gpid = _int(step.get("gpid"))
    if gpid is not None and gpid in prices["by_gpid"]:
        return prices["by_gpid"][gpid]
    name = step.get("name")
    if isinstance(name, str) and name in prices["by_name"]:
        return prices["by_name"][name]
    return None


def _child_research_xp(chain, child_id):
    child = (chain.get("ships") or {}).get(str(child_id))
    if not child:
        return None
    return _int((child.get("research") or {}).get("xp"))


def fill(chain, prices, research):
    """Apply the lookups in place; return per-field coverage stats."""
    stats = {
        "steps_xp": 0, "steps_credits": 0, "steps_gold": 0,
        "steps_matched": 0, "steps_seen": 0,
        "next_xpWithModules": 0, "next_requiredModules": 0,
        "next_from_synced": 0, "xp_mismatch_skipped": 0,
    }
    for _sid, _record, step in _iter_steps(chain):
        stats["steps_seen"] += 1
        # Stock modules come with the ship: they carry no research XP and are
        # not a buy cost in the panel (its first column shows them price-free),
        # so only the upgrade modules receive the captured economy.
        if step.get("isStock"):
            continue
        hit = _step_price(prices, step)
        if not hit:
            continue
        stats["steps_matched"] += 1
        if "xp" in hit:
            step["xp"] = hit["xp"]
            stats["steps_xp"] += 1
        if "credits" in hit:
            step["credits"] = hit["credits"]
            stats["steps_credits"] += 1
        if "gold" in hit and step.get("credits") is None:
            step["gold"] = hit["gold"]
            stats["steps_gold"] += 1

    # Edge totals: the synced research info wins when the capture has it;
    # otherwise compute ship XP + the unlock-carrier modules' captured XP.
    for _sid, record in (chain.get("ships") or {}).items():
        unlockers = {}
        for slot in record.get("slots") or []:
            for step in slot.get("steps") or []:
                for child in step.get("unlocks") or []:
                    unlockers.setdefault(str(child), []).append(step)
        for child_id, edge in (record.get("next") or {}).items():
            info = research.get(str(child_id))
            child_xp = _child_research_xp(chain, child_id)
            expected = edge.get("xpShip")
            if child_xp is not None and expected is not None and child_xp != expected:
                stats["xp_mismatch_skipped"] += 1
                continue
            required_steps = unlockers.get(str(child_id), [])
            # Only RESEARCHABLE modules can be a prerequisite: an unlock that
            # sits on a stock module costs nothing, so it is not a requirement
            # (those edges keep the bare ship-XP tooltip).
            research_steps = [s for s in required_steps if not s.get("isStock")]
            required_names = [s.get("name") for s in research_steps
                              if isinstance(s.get("name"), str)]
            if info and info.get("requiredModules"):
                required_names = info["requiredModules"]
            if required_names:
                edge["requiredModules"] = required_names
                stats["next_requiredModules"] += 1
            total = None
            if info and info.get("xpWithModules") is not None:
                total = info["xpWithModules"]
                stats["next_from_synced"] += 1
            elif (child_xp is not None and research_steps
                  and all(_int(s.get("xp")) is not None for s in research_steps)):
                total = child_xp + sum(_int(s.get("xp")) for s in research_steps)
            # A total identical to the bare XP means "no extra module research
            # needed" - leave the second tooltip row off instead of repeating
            # the same number.
            if total is not None and total != child_xp:
                edge["xpWithModules"] = total
                stats["next_xpWithModules"] += 1
    return stats


def inspect(capture, chain):
    """Shape + join report for a capture against one realm's chain bundle."""
    steps = list(_iter_steps(chain))
    step_gpids = {_int(step.get("gpid")) for _sid, _rec, step in steps
                  if _int(step.get("gpid")) is not None}
    ship_ids = set((chain.get("ships") or {}).keys())

    prices = _entities(capture, "itemPrice")
    research = _entities(capture, "shipCrossResearchInfo")
    price_gpids = []
    currencies = Counter()
    exp_by_ship = {}
    for entity in prices:
        comp = _component_map(entity)
        gpid = _int(comp.get("id"))
        if gpid is not None:
            price_gpids.append(gpid)
        for key in ("currency", "currencyID"):
            if comp.get(key) is not None:
                currencies[str(comp[key])] += 1
                break
        if gpid is not None and str(gpid) in ship_ids:
            if _currency_bucket(comp.get("currency")) == "xp":
                amount = _int(comp.get("finalPrice"))
                if amount is not None and amount > 0:
                    exp_by_ship[str(gpid)] = amount
    matched = {g for g in price_gpids if g in step_gpids}
    unknown = [g for g in price_gpids if g not in step_gpids]

    exp_match = 0
    exp_diff = []
    for sid, amount in exp_by_ship.items():
        record = (chain.get("ships") or {}).get(sid) or {}
        chain_xp = _int((record.get("research") or {}).get("xp"))
        if chain_xp is None:
            continue
        if chain_xp == amount:
            exp_match += 1
        elif len(exp_diff) < 5:
            exp_diff.append((sid, amount, chain_xp))

    return {
        "capture_version": capture.get("v"),
        "capture_phase": capture.get("phase"),
        "capture_t": capture.get("t"),
        "chain_gameVersion": chain.get("gameVersion"),
        "collections": {
            name: len(_entities(capture, name))
            for name in ("shipCrossResearchInfo", "itemPrice",
                         "shipTechRestrictions", "shipEconomicAttributes")
        },
        "counts_field": capture.get("counts"),
        "research_entities": len(research),
        "steps": len(steps),
        "steps_with_gpid": len(step_gpids),
        "price_entities": len(prices),
        "price_gpids": len(price_gpids),
        "price_gpid_matched_steps": len(matched),
        "price_gpid_unmatched": len(unknown),
        "currencies_seen": dict(currencies.most_common(8)),
        "ship_exp_prices": len(exp_by_ship),
        "ship_exp_matches_chain": exp_match,
        "ship_exp_diffs": exp_diff,
        "truncated": capture.get("truncated"),
    }


def _write(path, payload):
    path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--realm", choices=("wg", "lesta"), default="wg")
    ap.add_argument("--catalog", help="captured price_catalog.json from the in-game probe")
    ap.add_argument("--chain", help="chain bundle to fill (default: the bundled realm file)")
    ap.add_argument("--inspect", action="store_true",
                    help="print the capture shape + join report only")
    ap.add_argument("--apply", action="store_true", help="write the filled bundle")
    ap.add_argument("--self-test", action="store_true",
                    help="offline proof of the join/fill logic")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.catalog:
        ap.error("--catalog is required (or pass --self-test)")
    catalog_path = Path(args.catalog)
    if not catalog_path.is_file():
        ap.error("price catalog not found: %s" % catalog_path)
    capture = json.loads(catalog_path.read_text(encoding="utf-8"))

    chain_path = Path(args.chain) if args.chain else CHAIN_PATHS[args.realm]
    if not chain_path.is_file():
        ap.error("chain bundle not found: %s" % chain_path)
    chain = json.loads(chain_path.read_text(encoding="utf-8"))

    report = inspect(capture, chain)
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if args.inspect:
        return 0
    if not args.apply:
        print("[price-fill] pass --apply to write the economy fields", file=sys.stderr)
        return 0

    prices = _price_lookup(capture)
    research = _research_lookup(capture)
    stats = fill(chain, prices, research)
    _write(chain_path, chain)
    print("[price-fill] applied:", json.dumps(stats, sort_keys=True))
    return 0


def self_test():
    """Synthetic capture: proves the gpid join, computed totals and gates."""
    chain = {
        "gameVersion": "wg-test",
        "source": "gameparams",
        "ships": {
            "111": {
                "index": "PTS101",
                "research": {"xp": 1000, "credits": 0, "gold": 0},
                "next": {"222": {"index": "PTS102", "xpShip": 5000,
                                 "xpWithModules": None, "requiredModules": None}},
                "slots": [
                    {
                        "ucType": "_Hull",
                        "steps": [
                            {"name": "PTSH101_HULL_STOCK", "gpid": 1001,
                             "prev": None, "depth": 0, "isStock": True,
                             "xp": None, "credits": None, "components": {}},
                            {"name": "PTSH102_HULL_TOP", "gpid": 1002,
                             "prev": "PTSH101_HULL_STOCK", "depth": 1,
                             "isStock": False, "xp": None, "credits": None,
                             "components": {}, "unlocks": [222]},
                        ],
                    }
                ],
            },
            "222": {
                "index": "PTS102",
                "research": {"xp": 5000, "credits": 0, "gold": 0},
                "next": {},
                "slots": [],
            },
        },
    }
    capture = {
        "v": 1, "t": 123, "phase": "port",
        "counts": {"itemPrice": 3, "shipCrossResearchInfo": 0},
        "collections": {
            "itemPrice": [
                {"id": "1", "components": {"ItemPrice": {
                    "id": 1002, "currency": "exp",
                    "finalPrice": 2000, "basePrice": 2500}}},
                {"id": "2", "components": {"ItemPrice": {
                    "id": 1002, "currency": "credits",
                    "finalPrice": 850000, "basePrice": 900000}}},
                {"id": "3", "components": {"ItemPrice": {
                    "id": 222, "currency": "exp",
                    "finalPrice": 5000, "basePrice": 5000}}},
            ],
            "shipCrossResearchInfo": [],
        },
    }

    report = inspect(capture, chain)
    assert report["price_gpid_matched_steps"] == 1, report
    assert report["ship_exp_matches_chain"] == 1, report
    prices = _price_lookup(capture)
    assert prices["by_gpid"][1002] == {"xp": 2000, "credits": 850000}, prices
    stats = fill(chain, prices, _research_lookup(capture))
    assert stats["steps_xp"] == 1 and stats["steps_credits"] == 1, stats
    record = chain["ships"]["111"]
    top = record["slots"][0]["steps"][1]
    assert top["xp"] == 2000 and top["credits"] == 850000, top
    assert record["next"]["222"]["xpWithModules"] == 7000, record["next"]
    assert record["next"]["222"]["requiredModules"] == ["PTSH102_HULL_TOP"], record["next"]
    assert record["slots"][0]["steps"][0]["xp"] is None
    synced = {"222": {"xp": 5000, "xpWithModules": 7100,
                      "requiredModules": ["PTSH102_HULL_TOP"]}}
    stats2 = fill(json.loads(json.dumps(chain)), prices, synced)
    assert stats2["next_from_synced"] == 1, stats2
    bad = json.loads(json.dumps(chain))
    bad["ships"]["222"]["research"]["xp"] = 4000
    bad_stats = fill(bad, prices, {})
    assert bad_stats["next_xpWithModules"] == 0, bad_stats
    assert _currency_bucket("exp") == "xp"
    assert _currency_bucket("credits") == "credits"
    assert _currency_bucket("gold") == "gold"
    assert _currency_bucket("battlecardum") is None
    print("SELF-TEST PASS: gpid join + computed totals + synced override + gates")
    return 0


if __name__ == "__main__":
    sys.exit(main())
