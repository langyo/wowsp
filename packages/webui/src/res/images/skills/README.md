# Skill icons

Real in-game commander-skill icons, one per skill code (snake_case of the
GameParams Crew skill code), converted to webp by
`scripts/extract/build_planner_data.py`.

Two sources:

- The WoWs-ShipBuilder asset pack (square 60x60 art) — the historical source
  for most icons; that repo has since gone dark, so its fetch relies on the
  WoWSP-extract cache.
- The live client itself: `/gui/crew_commander/skills/<stem>.png` inside
  gui_0001.pkg holds real 60x60 square art (not the old unusable silhouette
  strips). Slice by (size, crc32) against wows_meta.json — the 13 Trigger
  family icons (隐蔽加速 / 怒火满腔 / 近距离作战 / 无畏斗士 / …) were produced
  this way and are one-off artifacts the script's ShipBuilder loop cannot
  recreate.

Regenerate the code list via
`python scripts/extract/build_planner_data.py --only skilltree` (needs the
`just extract` GameParams cache).
