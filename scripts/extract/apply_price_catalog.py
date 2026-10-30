#!/usr/bin/env python3
"""Fill the upgrade-chain economy from a captured client price catalog.

The module-level economy (per-module research XP + buy credits, the
"with required modules" research total and the required-module list) is
NOT in GameParams or the scripts layer - it is the server-synced price
catalog the client receives at login. The in-game probe captures that
catalog into price_catalog.json (see packages/ingame-plugin/src/Main.py,
"server-synced price catalog"); this script joins the capture onto the
generated chain bundles:

  packages/webui/src/data/ship_upgrade_chain.json         WG
  packages/webui/src/data/ship_upgrade_chain_lesta.json   Lesta

Fields filled (everything else is left untouched):

  ships.<id>.slots[].steps[].xp           per-module research XP  (itemPrice)
  ships.<id>.slots[].steps[].credits      per-module buy credits   (itemPrice)
  ships.<id>.next.<child>.xpWithModules   ship XP + required-module XP
  ships.<id>.next.<child>.requiredModules required module entry names

Join keys are the client's own:
  - itemPrice entity id <-> GameParams upgrade entry name (step.name)
    (CommonPrices.PriceList.getModulePrices is keyed by the GameParams
    object name; the synced entity carries that name as its id).
  - shipCrossResearchInfo entity id <-> numeric shipId; its
    researchPriceShipExp is the ship's own research XP and
    dependenciesResearchPriceInfo is the required-module price info.
    xpWithModules = researchPriceShipExp + the XP-currency dependency
    prices; the dependency keys become requiredModules.

The capture shape is verified against the first live run with --inspect;
until then join misses are REPORTED (per-collection counts, matched ids,
sample misses, currency values seen) instead of guessed. Nothing is
written unless --apply is passed, and the fill always validates the
xpShip cross-check (the capture's researchPriceShipExp must equal the
chain's existing next.*.xpShip) before touching a record.

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

# Currency buckets. The synced ItemPrice carries the currency as a string
# (field "currency") and/or an enum ("currencyID"); the string form is
# authoritative. Values are matched case/underscore-insensitively.
XP_CURRENCIES = {"xpship", "shipxp", "shipxpexp", "xp", "experience", "shipexperience"}
CREDIT_CURRENCIES = {"credits", "credit", "silver", "silvercredits"}
GOLD_CURRENCIES = {"gold", "doubloons", "doubloon"}


def _norm_currency(value):
    """The normalized currency name, or None when the value is unmappable."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    return text.replace("_", "").replace("-", "").replace(" ", "")


def _currency_bucket(currency):
    """'xp' | 'credits' | 'gold' | None for a currency value."""
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
    """Best-effort integer (the bridge writes ints, but strings survive)."""
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


def _price_value(entity, component):
    """finalPrice (discounted) then basePrice, from a price entity/struct."""
    for holder in (component, entity):
        if not isinstance(holder, dict):
            continue
        for key in ("finalPrice", "basePrice", "value", "amount"):
            got = _int(holder.get(key))
            if got is not None:
                return got
    return None


def _sum_price_info(value):
    """Total of a dependenciesResearchPriceInfo shape (list/dict of structs)."""
    items = []
    if isinstance(value, dict):
        if any(k in value for k in ("basePrice", "finalPrice", "currency")):
            items = [value]
        else:
            items = list(value.values())
    elif isinstance(value, list):
        items = value
    total = None
    for item in items:
        amount = _price_value(item, item if isinstance(item, dict) else {})
        if amount is None:
            continue
        currency = None
        if isinstance(item, dict):
            currency = item.get("currency") or item.get("currencyID")
        bucket = _currency_bucket(currency) if currency is not None else "xp"
        # Only XP amounts belong in the "with required modules" research
        # total; a credits figure here is a buy price, never research XP.
        if bucket not in (None, "xp"):
            continue
        total = (total or 0) + amount
    return total


def _module_keys_from_dependencies(value):
    """The required-module entry names carried by a dependency info shape."""
    keys = []
    if isinstance(value, dict):
        if any(k in value for k in ("basePrice", "finalPrice", "currency")):
            name = value.get("name") or value.get("id")
            if isinstance(name, str):
                keys.append(name)
        else:
            keys.extend(str(k) for k in value.keys())
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                name = item.get("name") or item.get("id")
                if isinstance(name, str):
                    keys.append(name)
    return [k for k in keys if k]


def _entities(capture, collection):
    cols = capture.get("collections")
    if not isinstance(cols, dict):
        return []
    value = cols.get(collection)
    return value if isinstance(value, list) else []


def _component_map(entity):
    """Flatten an entity's component dicts into one field map."""
    out = {}
    comps = entity.get("components")
    if isinstance(comps, dict):
        for comp in comps.values():
            if isinstance(comp, dict):
                out.update(comp)
    return out


def inspect(capture, chain):
    """Shape + join report for a capture against one realm's chain bundle."""
    ships = chain.get("ships") or {}
    step_names = set()
    for record in ships.values():
        for slot in record.get("slots") or []:
            for step in slot.get("steps") or []:
                name = step.get("name")
                if isinstance(name, str):
                    step_names.add(name)
    ship_ids = set(ships.keys())

    price_entities = _entities(capture, "itemPrice")
    research_entities = _entities(capture, "shipCrossResearchInfo")
    price_ids = [str(e.get("id")) for e in price_entities if e.get("id") is not None]
    research_ids = [str(e.get("id")) for e in research_entities if e.get("id") is not None]

    price_hits = [pid for pid in price_ids if pid in step_names]
    research_hits = [rid for rid in research_ids if rid in ship_ids]

    currencies = Counter()
    for entity in price_entities:
        comp = _component_map(entity)
        for key in ("currency", "currencyID"):
            if key in comp:
                currencies[str(comp[key])] += 1
                break

    def _sample_miss(ids, known):
        return [i for i in ids if i not in known][:8]

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
        "price_ids": len(price_ids),
        "price_matched_steps": len(set(price_hits)),
        "price_match_samples": sorted(set(price_hits))[:8],
        "price_miss_samples": _sample_miss(price_ids, step_names),
        "research_ids": len(research_ids),
        "research_matched_ships": len(set(research_hits)),
        "research_match_samples": sorted(set(research_hits))[:8],
        "research_miss_samples": _sample_miss(research_ids, ship_ids),
        "currencies_seen": dict(currencies.most_common(8)),
        "research_field_samples": [
            sorted(_component_map(e).keys())
            for e in research_entities[:3]
        ],
        "price_field_samples": [
            sorted(_component_map(e).keys())
            for e in price_entities[:3]
        ],
        "truncated": capture.get("truncated"),
    }


def _price_lookup(capture):
    """step name -> {xp?, credits?, gold?} from the itemPrice collection."""
    out = {}
    for entity in _entities(capture, "itemPrice"):
        entity_id = entity.get("id")
        if not isinstance(entity_id, str) or not entity_id:
            continue
        comp = _component_map(entity)
        amount = _price_value(comp, {})
        if amount is None:
            continue
        bucket = _currency_bucket(comp.get("currency"))
        if bucket is None:
            continue
        out.setdefault(entity_id, {})[bucket] = amount
    return out


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
        dep_xp = _sum_price_info(deps)
        required = _module_keys_from_dependencies(deps)
        # "With required modules" precedence (first available wins):
        #   1. the client's own derived total (totalCostXP), when exposed;
        #   2. ship XP + the dependencies' cost XP (shipsCrossResearchCostXP);
        #   3. ship XP + the XP-valued dependency prices.
        # No dependency information at all leaves the field null - the
        # "with modules" number must never be fabricated from the bare XP.
        total = _int(comp.get("totalCostXP"))
        if total is None:
            dep_cost = _int(comp.get("shipsCrossResearchCostXP"))
            if dep_cost is not None and dep_cost > 0:
                total = (xp or 0) + dep_cost
            elif dep_xp is not None:
                total = (xp or 0) + dep_xp
        out[str(entity_id)] = {
            "xp": xp,
            "xpWithModules": total,
            "requiredModules": required or None,
        }
    return out


def fill(chain, prices, research):
    """Apply the two lookups in place; return per-field coverage stats."""
    stats = {
        "steps_xp": 0, "steps_credits": 0, "steps_gold": 0,
        "next_xpWithModules": 0, "next_requiredModules": 0,
        "xp_mismatch_skipped": 0,
    }
    ships = chain.get("ships") or {}
    for record in ships.values():
        for slot in record.get("slots") or []:
            for step in slot.get("steps") or []:
                hit = prices.get(step.get("name") or "")
                if not hit:
                    continue
                if "xp" in hit:
                    step["xp"] = hit["xp"]
                    stats["steps_xp"] += 1
                if "credits" in hit:
                    step["credits"] = hit["credits"]
                    stats["steps_credits"] += 1
                if "gold" in hit and step.get("credits") is None:
                    step["gold"] = hit["gold"]
                    stats["steps_gold"] += 1
        nxt = record.get("next") or {}
        for child_id, edge in nxt.items():
            info = research.get(str(child_id))
            if not info:
                continue
            if info.get("xpWithModules") is not None:
                expected = edge.get("xpShip")
                if expected is not None and info.get("xp") is not None and info["xp"] != expected:
                    stats["xp_mismatch_skipped"] += 1
                    continue
                edge["xpWithModules"] = info["xpWithModules"]
                stats["next_xpWithModules"] += 1
            if info.get("requiredModules"):
                edge["requiredModules"] = info["requiredModules"]
                stats["next_requiredModules"] += 1
    return stats


def _write(path, payload):
    path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--realm", choices=("wg", "lesta"), default="wg")
    ap.add_argument("--catalog", help="captured price_catalog.json from the in-game probe")
    ap.add_argument("--chain", help="chain bundle to fill (default: the bundled realm file)")
    ap.add_argument("--inspect", action="store_true", help="print the capture shape + join report only")
    ap.add_argument("--apply", action="store_true", help="write the filled bundle")
    ap.add_argument("--self-test", action="store_true", help="offline proof of the join/fill logic")
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
    """Synthetic capture: proves both joins, the fill and the sanity guard."""
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
                            {"name": "PTSH101_HULL_STOCK", "prev": None, "depth": 0,
                             "isStock": True, "xp": None, "credits": None, "components": {}},
                            {"name": "PTSH102_HULL_TOP", "prev": "PTSH101_HULL_STOCK",
                             "depth": 1, "isStock": False, "xp": None, "credits": None,
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
        "counts": {"itemPrice": 2, "shipCrossResearchInfo": 1},
        "collections": {
            "itemPrice": [
                {"id": "PTSH102_HULL_TOP", "components": {"ItemPrice": {
                    "id": "PTSH102_HULL_TOP", "currency": "shipXP",
                    "basePrice": 2500, "finalPrice": 2000}}},
                {"id": "PTSH102_HULL_TOP", "components": {"ItemPrice": {
                    "id": "PTSH102_HULL_TOP", "currency": "credits",
                    "basePrice": 900000, "finalPrice": 850000}}},
            ],
            "shipCrossResearchInfo": [
                {"id": "222", "components": {"ShipCrossResearchInfo": {
                    "researchPriceShipExp": 5000,
                    "dependenciesResearchPriceInfo": {
                        "PTSH102_HULL_TOP": {"basePrice": 2000, "currency": "shipXP"}},
                }}},
            ],
        },
    }

    report = inspect(capture, chain)
    assert report["price_matched_steps"] == 1, report
    assert report["research_matched_ships"] == 1, report
    prices = _price_lookup(capture)
    research = _research_lookup(capture)
    assert prices["PTSH102_HULL_TOP"] == {"xp": 2000, "credits": 850000}, prices
    assert research["222"]["xp"] == 5000, research
    assert research["222"]["xpWithModules"] == 7000, research
    assert research["222"]["requiredModules"] == ["PTSH102_HULL_TOP"], research
    stats = fill(chain, prices, research)
    assert stats["steps_xp"] == 1 and stats["steps_credits"] == 1, stats
    assert stats["next_xpWithModules"] == 1 and stats["next_requiredModules"] == 1, stats
    record = chain["ships"]["111"]
    top = record["slots"][0]["steps"][1]
    assert top["xp"] == 2000 and top["credits"] == 850000, top
    assert record["next"]["222"]["xpWithModules"] == 7000, record["next"]
    assert record["next"]["222"]["requiredModules"] == ["PTSH102_HULL_TOP"], record["next"]
    assert record["slots"][0]["steps"][0]["xp"] is None
    assert _currency_bucket("someUnknownCurrency") is None
    bad = {
        "ships": {"111": {
            "index": "PTS101", "research": {"xp": 0, "credits": 0, "gold": 0},
            "next": {"222": {"index": "PTS102", "xpShip": 5000,
                             "xpWithModules": None, "requiredModules": None}},
            "slots": [],
        }},
    }
    bad_capture = json.loads(json.dumps(capture))
    bad_capture["collections"]["shipCrossResearchInfo"][0]["components"]["ShipCrossResearchInfo"]["researchPriceShipExp"] = 4000
    bad_stats = fill(bad, _price_lookup(bad_capture), _research_lookup(bad_capture))
    assert bad_stats["next_xpWithModules"] == 0, bad_stats
    print("SELF-TEST PASS: join + fill + sanity guard")
    return 0


if __name__ == "__main__":
    sys.exit(main())
