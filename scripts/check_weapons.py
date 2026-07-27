"""
Simulate buildWeapons logic against all ships in GameParams to verify
weapon data is correctly extracted. Reports ships missing main guns.
"""
import json

GAMEPARAMS = r"C:\Users\langy\AppData\Local\WoWSP-extract\GameParams.json"

data = json.load(open(GAMEPARAMS, "r", encoding="utf-8"))

def hp_slots(obj):
    if not isinstance(obj, dict):
        return []
    return [(k, v) for k, v in obj.items() if k.startswith("HP_") and isinstance(v, dict)]

def gun_ids(block):
    ids = set()
    if not isinstance(block, dict):
        return ids
    for k, v in hp_slots(block):
        n = v.get("name") or v.get("id") or ""
        if n:
            ids.add(str(n))
    return ids

def build_weapons(gp):
    """Mirrors the frontend buildWeapons function."""
    out = []
    if not isinstance(gp, dict):
        return out

    art = gp.get("A_Artillery")
    atba = gp.get("A_ATBA")
    aa = gp.get("A_AirDefense")
    torp = gp.get("A_AirArmament") or (gp.get("Hull") or {}).get("torpedoes")

    # Main guns
    if isinstance(art, dict):
        groups = {}
        for k, m in hp_slots(art):
            barrels = int(m.get("numBarrels", 0) or 0) or 1
            cal = round((float(m.get("barrelDiameter", 0) or 0)) * 1000)
            key = f"{barrels}_{cal}"
            if key in groups:
                groups[key]["count"] += 1
            else:
                groups[key] = {"barrels": barrels, "cal": cal, "count": 1}
        for g in groups.values():
            out.append(f"Main: {g['count']}x{g['barrels']} {g['cal']}mm")

    # Secondary
    if isinstance(atba, dict):
        groups = {}
        for k, m in hp_slots(atba):
            barrels = int(m.get("numBarrels", 0) or 0) or 1
            cal = round((float(m.get("barrelDiameter", 0) or 0)) * 1000)
            key = f"{barrels}_{cal}"
            if key in groups:
                groups[key]["count"] += 1
            else:
                groups[key] = {"barrels": barrels, "cal": cal, "count": 1}
        for g in groups.values():
            out.append(f"Secondary: {g['count']}x{g['barrels']} {g['cal']}mm")

    # Torpedoes
    if isinstance(torp, dict):
        slots = hp_slots(torp)
        if slots:
            counts = {}
            for k, t in slots:
                n = int(t.get("numBarrels", t.get("count", 1)) or 0) or 1
                counts[n] = counts.get(n, 0) + 1
            for tubes, count in counts.items():
                out.append(f"Torpedo: {count}x{tubes}")

    # AA
    if isinstance(aa, dict):
        tiers = {"long": 0, "mid": 0, "short": 0}
        for k, a in hp_slots(aa):
            dist = float(a.get("maxDistance", 0) or 0)
            if dist > 5:
                tiers["long"] += 1
            elif dist > 2.5:
                tiers["mid"] += 1
            else:
                tiers["short"] += 1
        for tier, count in tiers.items():
            if count > 0:
                out.append(f"AA({tier}): {count}")

    return out


# Test all ships
ships = [(k, v) for k, v in data.items() if isinstance(v, dict) and v.get("typeinfo", {}).get("type") == "Ship"]
print(f"Total ships: {len(ships)}")

no_guns = []
aa_only = []
for name, entry in ships:
    weapons = build_weapons(entry)
    has_main = any(w.startswith("Main:") for w in weapons)
    has_secondary = any(w.startswith("Secondary:") for w in weapons)
    has_torp = any(w.startswith("Torpedo:") for w in weapons)
    has_aa = any(w.startswith("AA") for w in weapons)

    if not has_main and not has_secondary and not has_torp:
        if has_aa:
            aa_only.append(name)
        else:
            no_guns.append(name)

print(f"Ships with main guns (from A_Artillery): {sum(1 for k, v in ships if 'A_Artillery' in v and hp_slots(v['A_Artillery']))}")
print(f"Ships with secondaries (from A_ATBA): {sum(1 for k, v in ships if 'A_ATBA' in v and hp_slots(v['A_ATBA']))}")
print(f"Ships with ONLY AA (no guns/torps): {len(aa_only)}")
print(f"Ships with NOTHING: {len(no_guns)}")

if aa_only:
    print(f"\nAA-only ships (first 10): {aa_only[:10]}")

# Now simulate the Rust fallback: for ships in aa_only, find sibling entries with same prefix that DO have A_Artillery
print("\n=== Simulating Rust prefix fallback ===")
fixed = 0
for name in aa_only:
    prefix = "".join(c for c in name if c.isupper())[:4]  # e.g. PASB
    for key, entry in data.items():
        if key.startswith(prefix) and isinstance(entry, dict) and "A_Artillery" in entry:
            if hp_slots(entry["A_Artillery"]):
                weapons = build_weapons(entry)
                has_main = any(w.startswith("Main:") for w in weapons)
                if has_main:
                    fixed += 1
                    break

print(f"AA-only ships fixable by prefix fallback: {fixed}")
print(f"Still unfixable: {len(aa_only) - fixed}")
