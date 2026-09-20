"""Validator for the in-game recommended-skill presets bundle.

``packages/webui/src/data/crew_presets.json`` mirrors the live client's
``ClientCrewSkills.CrewSkillRecomendationPresets`` module (the commander
screen's yellow "recommended build" ribbon): ordered build steps keyed by
exact GameParams ship name, ship-group name or ship class, plus the
ship-group membership table. Resolution at runtime is most-specific-wins
(exact ship → group → class).

Provenance + regeneration: the table lives in the client's Python scripts
(``bin/<build>/res/scripts.zip`` → ``scripts/ClientCrewSkills/
CrewSkillRecomendationPresets.pyc``, CPython 2.7 behind WG's four-layer
obfuscation — see ``wows_pyc``). ``wows_pyc`` decodes the module and its
mini-VM reconstructs ``SHIP_GROUPS`` reliably, but the preset step values
are built through wrapper-injected runtime state that the VM does not
model, so the committed bundle was produced with the full reference
toolchain this package grew out of. This script therefore *validates* the
committed bundle against the current GameParams on every run (unknown
skill codes / malformed group members fail loudly, signalling that a game
update changed the skill set and the bundle needs a re-decode), and
cross-checks the groups table against a live VM decode when the game is
installed.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wows_pyc  # noqa: E402

PRESETS_MODULE = "ClientCrewSkills.CrewSkillRecomendationPresets"

# GameParams ship names ("PBSS508_Alliance") — group members and preset ship
# keys always carry this shape; decoy junk strings from the obfuscated module
# do not.
SHIP_NAME_RE = re.compile(r"^[A-Z]{2,4}[A-Z]\d{3}_\w")

# GameParams ship class -> client ShipTypes species attribute.
SPECIES_ATTRS = {
    "AirCarrier": "AIRCARRIER",
    "Battleship": "BATTLESHIP",
    "Cruiser": "CRUISER",
    "Destroyer": "DESTROYER",
    "Auxiliary": "AUXILIARY",
    "Submarine": "SUBMARINE",
}


def find_scripts_zip(game_root: str) -> pathlib.Path:
    """Newest ``bin/<build>/res/scripts.zip`` under the game install."""
    bin_dir = pathlib.Path(game_root) / "bin"
    builds = sorted(
        (int(p.name), p / "res" / "scripts.zip")
        for p in bin_dir.iterdir()
        if p.name.isdigit() and (p / "res" / "scripts.zip").is_file()
    )
    if not builds:
        raise FileNotFoundError("no bin/<build>/res/scripts.zip under %s" % game_root)
    return builds[-1][1]


class _Provider(object):
    """Plain attribute bag — wows_pyc.get_attr falls through to getattr."""

    def __init__(self, **attrs):
        self.__dict__.update(attrs)


def _skill_type_by_code(txt: str) -> dict[str, int]:
    """skillType id per skill code from the GameParams default Crew table."""
    import build_planner_data as b

    for _name, e in b.entries_of(txt, '"CrewPersonality"',
                                 lambda x: x.get("typeinfo", {}).get("type") == "Crew"):
        skills = e.get("Skills") or {}
        break
    else:
        raise ValueError("no default Crew table in GameParams")
    return {code: int(sk["skillType"]) for code, sk in skills.items() if "skillType" in sk}


def validate(txt: str, data: dict) -> list[str]:
    """Cross-check the committed crew_presets.json against GameParams.

    Returns a list of problems (empty = clean): every recommended skill must
    be a learnable GameParams skill, groups must carry presets and only
    well-formed GameParams ship names, and only the Auxiliary class preset
    may be empty.
    """
    problems = []
    codes = set(_skill_type_by_code(txt))
    for key, steps in data["presets"].items():
        if not steps and key != "Auxiliary":
            problems.append("preset %s is empty" % key)
        for step in steps:
            unknown = sorted(set(step) - codes)
            if unknown:
                problems.append("preset %s references unknown skills %s" % (key, unknown))
    for group, members in data["groups"].items():
        if group not in data["presets"]:
            problems.append("group %s has no preset" % group)
        for member in members:
            if not SHIP_NAME_RE.match(member):
                problems.append("group %s has malformed member %r" % (group, member))
    return problems


def vm_groups(game_root: str, txt: str) -> dict | None:
    """Decode SHIP_GROUPS from the live client via the mini-VM (best-effort
    decoding cross-check for :func:`main`; None when unavailable)."""
    try:
        wows_pyc.APPLY_RENAMES = False
        wows_pyc.open_zip(str(find_scripts_zip(game_root)))
        code = wows_pyc.decode_real(
            wows_pyc.Z.read(wows_pyc.find_pyc(PRESETS_MODULE)))
        names = [wows_pyc._s(n) for n in code["names"]]
        seed_names = {names[arg] for _off, nm, arg in wows_pyc.walk_ops(code)
                      if nm == "IMPORT_NAME"}
        enum_provider = _Provider(**_skill_type_by_code(txt))
        ship_provider = _Provider(**{attr: sp for sp, attr in SPECIES_ATTRS.items()})
        for name in seed_names:
            mod = wows_pyc.Module(name)
            mod.ns.update({"ST": enum_provider, "SkillTypeEnum": enum_provider,
                           "ShipTypes": ship_provider})
            mod.frozen.update(mod.ns)
            wows_pyc.MODULE_CACHE[name] = mod
        wows_pyc.MODULE_CACHE[PRESETS_MODULE] = wows_pyc.StubModule(PRESETS_MODULE)
        mod = wows_pyc.run_module(PRESETS_MODULE, seed)
        tables = [v for k, v in mod.ns.items()
                  if isinstance(v, dict) and k != "__builtins__" and v
                  and all(isinstance(x, (set, frozenset)) for x in v.values())]
        if not tables:
            return None
        table = max(tables, key=len)
        return {
            wows_pyc._s(k): sorted(wows_pyc._s(x) for x in v
                                   if isinstance(x, bytes) and SHIP_NAME_RE.match(wows_pyc._s(x)))
            for k, v in table.items()
        }
    except Exception:
        return None


def main() -> int:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "extract"))
    from _common import find_game_path

    import build_planner_data as b

    if not b.GAMEPARAMS_JSON.exists():
        print("error: %s not found — run `just extract` first" % b.GAMEPARAMS_JSON, file=sys.stderr)
        return 1
    data = json.loads((b.OUT_DATA / "crew_presets.json").read_text(encoding="utf-8"))
    txt = b.GAMEPARAMS_JSON.read_text(encoding="utf-8")
    problems = validate(txt, data)
    for problem in problems:
        print("!! %s" % problem, file=sys.stderr)
    game = find_game_path()
    if game is not None:
        vm = vm_groups(game, txt)
        if vm is None:
            print("[crew-presets] VM groups cross-check unavailable this build",
                  file=sys.stderr)
        elif next(iter(vm.values()), None) != next(iter(data["groups"].values()), None):
            print("[crew-presets] VM groups cross-check MISMATCH — the game build "
                  "changed; re-decode the presets bundle", file=sys.stderr)
        else:
            print("[crew-presets] VM groups cross-check: matches committed table")
    if problems:
        return 1
    print("[crew-presets] crew_presets.json validates against GameParams: "
          "%d presets, %d groups" % (len(data["presets"]), len(data["groups"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
