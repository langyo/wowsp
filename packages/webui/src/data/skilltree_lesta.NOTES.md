# skilltree_lesta.json — provenance & caveats

Machine-readable sibling note for the Lesta build-planner skill tree.
Regenerate both together with:
`python scripts/extract/build_planner_data.py --realm lesta`
(offline: reads the WG + Lesta GameParams dumps and the ru/zh mo
caches in the WoWSP-extract cache dir; never downloads).

```json
{
 "realm": "lesta",
 "base": {
  "file": "skilltree.json",
  "generatedFrom": {
   "gameparams": "GameParams.json (WG client dump, WoWSP-extract cache)",
   "layout": "wowsft_skills.json (WoWSFT-Kotlin live layout cache)",
   "names": "wowsinfo_lang.json (IDS_SKILL_* bridge)"
  }
 },
 "override": [
  {
   "cell": {
    "class": "CV",
    "tier": 2,
    "column": 3
   },
   "wgCode": "PlanesConsumablesActiveManeuveringUpgrade",
   "lestaCode": "PlanesConsumablesRegeneratehealthUpgrade",
   "why": "WG removed the Regeneratehealth skill (dead WoWSFT layout cell, substituted on WG per LAYOUT_CELL_OVERRIDES); Lesta still ships it as PCOK052. Names from wowsinfo IDS_SKILL_PLANES_CONSUMABLES_REGENERATEHEALTH_UPGRADE."
  }
 ],
 "knownUnknowns": {
  "wgOnlySkillsKeptAsApproximation": [
   "PlanesConsumablesCallfightersUpgrade",
   "SubmarineConsumablesDuration",
   "SubmarineHoldSectors",
   "SubmarineTorpedoPingDamage",
   "TriggerConsSonarTimeCoeff",
   "TriggerPingerReloadBuff",
   "TriggerPingerSpeedBuff"
  ],
  "wgOnlySkillsNote": "Present in the Lesta tree only because the tree is a WG-tree copy; Lesta's PCOL001 catalog does not carry these codes, so treat those cells as approximate.",
  "lestaOnlySkillsNotPlaced": [
   "AcousticSpecialist",
   "BuoyancySpeed",
   "DepthChargeBomberAlert",
   "ExtraCallFighters",
   "GunMainShotDelay",
   "PingerSpeedBuff",
   "ShootShiftBonus",
   "SmokeScreenSetter",
   "SubmarineDefenseHp",
   "SubmarineSpeedOnBuoyancy",
   "SubmarineTorpedoDamage",
   "SubmarineVulnerabilityDepthBomb",
   "TriggerHydrophoneZone",
   "TriggerTorpedoSpeedReload"
  ],
  "lestaOnlySkillsNote": "In Lesta's PCOL001 catalog but absent from WG's skills.json and unplaced on any grid — no defensible (tier, column) source exists, so they are deliberately not invented into the tree."
 }
}
```
