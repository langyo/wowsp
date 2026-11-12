"""E30: extract each airframe's squadron GROUPING from GameParams.

User insight: the in-game HUD draws one segmented health bar per flight
GROUP, so the grouping must be recorded. It is: every Aircraft entity
carries `formations.aerialAttack` — the slot table the client lays the
squadron out in — and its slots are strictly three-plane groups (892 / 894
airframes), the third component naming the group's lateral order.

Emits `groupSize` (planes per group) per airframe into
`packages/webui/src/data/plane_groups.json`, keyed by the same paramsId the
replay stream uses (via plane_types.json's index -> id mapping).
"""
import json, io, os, sys

GP = os.environ.get('WOWSP_GAMEPARAMS', r'C:\Users\langy\AppData\Local\WoWSP-extract\GameParams.json')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TYPES = os.path.join(REPO, 'packages', 'webui', 'src', 'data', 'plane_types.json')
OUT = os.path.join(REPO, 'packages', 'webui', 'src', 'data', 'plane_groups.json')

def group_size(ent):
    """Planes per flight group for one airframe, or None when the table
    does not encode groups.

    `aerialAttack` is the client's squadron slot table. When it is the
    uniform template the third component is the GROUP INDEX in lateral
    order (0 centre, then +1/-1, +2/-2 ...), so every group holds the same
    number of planes — that is the value the in-game HUD segments its
    health bar by.

    Some airframes (PAAB952 TBM3, PAAD910 BTD_1) instead carry a
    flight-shaped table whose third component is a fractional per-plane
    lateral OFFSET, not a group id. Two such entities tie on every count
    and an earlier 'mode' fallback silently answered 1 — which renders
    one-plane groups, the exact bug this extractor exists to fix. So:
    only integral, uniform group ids count; anything else returns None
    and the runtime falls back to its positional inference.
    """
    v = (ent.get('formations') or {}).get('aerialAttack')
    if not isinstance(v, list) or len(v) < 2 or not isinstance(v[1], list):
        return None
    counts = {}
    for slot in v[1]:
        if not isinstance(slot, list) or len(slot) < 3:
            continue
        raw = slot[2]
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None
        # A factional component means these slots are laid out per plane
        # (flight/attack shaped), not per group — not group ids at all.
        if abs(val - round(val)) > 1e-6:
            return None
        g = int(round(val))
        counts[g] = counts.get(g, 0) + 1
    if not counts:
        return None
    # Groups must be uniform; a ragged split is not a group table.
    if len(set(counts.values())) != 1:
        return None
    return counts[next(iter(counts))]

def main():
    with io.open(GP, encoding='utf-8') as f:
        gp = json.load(f)
    root = gp.get('root') or gp
    with io.open(TYPES, encoding='utf-8') as f:
        types = json.load(f)
    # plane_types.json: paramsId -> { index, ... }; index is the entity NAME.
    out = {}
    missing = 0
    for params_id, row in types.items():
        name = row.get('name')
        ent = root.get(name) if isinstance(name, str) else None
        if not isinstance(ent, dict):
            missing += 1
            continue
        size = group_size(ent)
        if size:
            out[params_id] = size
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write('\n')
    from collections import Counter
    print('rows:', len(out), 'missing source entity:', missing)
    print('groupSize distribution:', dict(Counter(out.values())))

if __name__ == '__main__':
    main()