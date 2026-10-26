# skilltree_lesta.json — provenance

**Authoritative** (decoded from the Lesta client itself, build 8867689):

- Source: `CommonCrews/CrewSkills/SkillsSettings.pyc` inside
  `bin/8867689/res/scripts3.zip`, behind the Lesta "finalUnp" script shield.
  The shield is decoded by `scripts/pyc_deob/wows_pyc3.py` (xdis-based
  CPython 3.10 mini-VM): stage-1 payload decode (xor+b64+zlib), loader
  bypass (execute the packed module code directly), and co_consts/co_names
  recovery from the 145-cell symbol/repair table embedded in the payload.
- The recovered table has 5 classes x 4 tiers x 6 columns (24 skills per
  surface class, 24 for SUBMARINE too — Lesta's sub tree is a full 6-column
  grid, unlike WG's 5-column 20-cell sub tree).
- Known divergences vs WG all confirmed from the table itself:
  - CV tier-2 col-3: PlanesConsumablesRegeneratehealthUpgrade (维修专员)
    instead of WG's PlanesConsumablesActiveManeuveringUpgrade.
  - DD: TriggerTorpedoSpeedReload in, GmShellReload out.
  - SS: 12 Lesta-only skills in (AcousticSpecialist, BuoyancySpeed,
    DepthChargeBomberAlert, GunMainShotDelay, PingerSpeedBuff,
    ShootShiftBonus, SmokeScreenSetter, SubmarineDefenseHp,
    SubmarineSpeedOnBuoyancy, SubmarineTorpedoDamage,
    SubmarineVulnerabilityDepthBomb, BuoyancySpeed), 8 WG-only skills out
    (TriggerPingerReloadBuff, DetectionAiming, DetectionAlert,
    SubmarineConsumablesDuration, TriggerPingerSpeedBuff, SubmarineHoldSectors,
    SubmarineTorpedoPingDamage, TriggerConsSonarTimeCoeff).
- Icons for the 14 Lesta-only skills + the regeneratehealth skill extracted
  read-only from the Lesta client pkgs (lesta_planner_icons.py).
- Names for the 14 Lesta-only skills curated from the mo_ru localization
  semantics (the client never shipped en/zh strings for them): see the
  curated table in lesta_skill_grid.py / the generator commit.
- Desc fields are empty for skills the client ships no description for
  (same convention as the WG tree).
