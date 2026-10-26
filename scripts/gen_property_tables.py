#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the replay decoder's exposed-PROPERTY index tables.

Why: an EntityCreate (0x05) state stream carries the entity's client-visible
properties in BigWorld "exposed index" order — the property list sorted by wire
size (stable sort, equal sizes keep the entity-def order). The list is
inheritance-ordered (interfaces' grandparents one level, then the interface,
then the entity's own list) and FILTERED by the property Flags the client
replicates (ALL_CLIENTS / BASE_AND_CLIENT / OTHER_CLIENTS / OWN_CLIENT /
CELL_PUBLIC_AND_OWN; the same five-flag filter as game-assets'
`rpc/entitydefs.rs` `parse_scripts`). The index map drifts whenever the entity
defs change, so the decoder resolves the two payloads it reads
(`shipConfig`, `crewModifiersCompactParams`) BY NAME from a generated table
instead of pinning magic constants.

The generator mirrors `scripts/experiments/exposed_index.py`'s type parser
(alias resolution, ARRAY/TUPLE/FIXED_DICT recursion, VariableLengthHeaderSize
irrelevant here — properties stream no header), reads `entity_defs`, and emits
`packages/app/replay_core/src/packets/property_tables.rs`.

Usage:

    # Emit the committed table from the embedded pins (no game install needed;
    # CI never runs this script):
    python scripts/gen_property_tables.py

    # OR write it straight to the tree:
    python scripts/gen_property_tables.py --out packages/app/replay_core/src/packets/property_tables.rs

    # Regenerate from freshly extracted entity defs (validates the pinned row,
    # then emits the same byte-identical file; also how a NEW version row is
    # produced before it is transcribed into PINNED):
    #   cargo build -p game-assets --release
    #   ./target/release/game-assets.exe -g <game_dir> extract \
    #       -o scripts/experiments/out/defs "/scripts/entity_defs/**" "/scripts/entities*"
    python scripts/gen_property_tables.py --defs scripts/experiments/out/defs/scripts \
        --version 15.9.0

    # Print the freshly parsed table (for adding a future version row to
    # PINNED without hand-transcribing 54 entries):
    python scripts/gen_property_tables.py --defs <defs_root> --version 15.10.0 --dump-pins

The output is committed; `--defs` re-derives the requested version's row from a
fresh extraction and validates it against the embedded pin first (a
disagreement is reported to stderr and exits nonzero, never silently written).
Both modes emit byte-identical files for a pinned version.
"""

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

INF = 0xFFFF

PRIMITIVES = {
    "UINT8": 1,
    "INT8": 1,
    "UINT16": 2,
    "INT16": 2,
    "UINT32": 4,
    "INT32": 4,
    "FLOAT": 4,
    "FLOAT32": 4,
    "UINT64": 8,
    "INT64": 8,
    "FLOAT64": 8,
    "VECTOR2": 8,
    "VECTOR3": 12,
    "STRING": INF,
    "UNICODE_STRING": INF,
    "BLOB": INF,
}
VARIABLE = {"STRING", "UNICODE_STRING", "BLOB", "USER_TYPE", "MAILBOX", "PYTHON"}

# Property flags the client replicates (game-assets parse_scripts' five-flag
# filter; BASE_AND_CLIENT is in it, which entitydefs.rs' "internal" list skips).
KEPT_FLAGS = {
    "ALL_CLIENTS",
    "BASE_AND_CLIENT",
    "OTHER_CLIENTS",
    "OWN_CLIENT",
    "CELL_PUBLIC_AND_OWN",
}

# Entities the decoder needs a table for. The emitted file carries Vehicle only
# (the build payload stream); Avatar is parsed too so the same generator can
# grow a table for it without code changes.
ENTITIES = ("Vehicle",)

# Pinned rows: version -> entity -> (count, [(name, wire_size_or_INF), ...])
# in EXPOSED-INDEX order (already sorted). Generated from the 15.9.0 client
# defs (Steam build 13357625) and validated with --defs; append future versions
# below (keep the list ascending).
PINNED = {
    (15, 9, 0): {
        "Vehicle": (
            54,
            [
                ("hasAirTargetsInRange", 1),
                ("isAntiAirMode", 1),
                ("buoyancyCurrentState", 1),
                ("buoyancyRudderIndex", 1),
                ("isOnForsage", 1),
                ("teamId", 1),
                ("uiEnabled", 1),
                ("isAlive", 1),
                ("speedSignDir", 1),
                ("enginePower", 1),
                ("engineDir", 1),
                ("ignoreMapBorders", 1),
                ("isBot", 1),
                ("isFogHornOn", 1),
                ("blockedControls", 1),
                ("isInvisible", 1),
                ("hasActiveMainSquadron", 1),
                ("isInRageMode", 1),
                ("oilLeakState", 1),
                ("burningFlags", 2),
                ("targetLocalPos", 2),
                ("torpedoLocalPos", 2),
                ("laserTargetLocalPos", 2),
                ("waveLocalPos", 2),
                ("weaponLockFlags", 2),
                ("serverSpeedRaw", 2),
                ("respawnTime", 2),
                ("airDefenseDispRadius", 4),
                ("health", 4),
                ("regenerationHealth", 4),
                ("regeneratedHealth", 4),
                ("maxHealth", 4),
                ("buoyancyCurrentWaterline", 4),
                ("regenCrewHpLimit", 4),
                ("buoyancy", 4),
                ("visibilityFlags", 4),
                ("owner", 4),
                ("selectedWeapon", 4),
                ("maxServerSpeedRaw", 4),
                ("draught", 4),
                ("ruddersAngle", 4),
                ("deepRuddersAngle", 4),
                ("visibilityTime", 8),
                ("airDefenseTargetIds", 65535),
                ("antiAirAuras", 65535),
                ("effects", 65535),
                ("sounds", 65535),
                ("shipConfig", 65535),
                ("crewModifiersCompactParams", 65535),
                ("debugText", 65535),
                ("miscsPresetsStatus", 65535),
                ("triggeredSkillsData", 65535),
                ("deathSettings", 65535),
                ("state", 65535),
            ],
        ),
    },
}


def child(elem, tag):
    for c in elem:
        if c.tag == tag:
            return c
    return None


def keyword(elem):
    text = elem.text
    if text is None or not text.strip():
        raise ValueError("element <%s> has no leading type keyword" % elem.tag)
    return text.strip()


def sort_size(elem, aliases, depth=0):
    if depth > 64:
        raise ValueError("alias recursion too deep")
    kw = keyword(elem)
    if kw in PRIMITIVES and kw not in VARIABLE:
        return PRIMITIVES[kw]
    if kw in VARIABLE:
        return INF
    if kw == "ARRAY":
        of = child(elem, "of")
        if of is None:
            raise ValueError("ARRAY without <of>")
        inner = sort_size(of, aliases, depth + 1)
        size_node = child(elem, "size")
        if size_node is None or inner == INF:
            return INF
        return inner * int(size_node.text.strip())
    if kw == "TUPLE":
        of = child(elem, "of")
        size_node = child(elem, "size")
        if of is None or size_node is None:
            raise ValueError("TUPLE without <of>/<size>")
        inner = sort_size(of, aliases, depth + 1)
        if inner == INF:
            return INF
        return inner * int(size_node.text.strip())
    if kw == "FIXED_DICT":
        if child(elem, "AllowNone") is not None:
            return INF
        props = child(elem, "Properties")
        if props is None:
            return 0
        total = 0
        for prop in props:
            type_node = child(prop, "Type")
            if type_node is None:
                raise ValueError("FIXED_DICT property <%s> without <Type>" % prop.tag)
            inner = sort_size(type_node, aliases, depth + 1)
            if inner == INF:
                return INF
            total += inner
        return total
    if kw in aliases:
        return aliases[kw]
    raise ValueError("unrecognized type %r in <%s>" % (kw, elem.tag))


def parse_aliases(path):
    aliases = {}
    for elem in ET.parse(path).getroot():
        aliases[elem.tag] = sort_size(elem, aliases)
    return aliases


def parse_def_properties(path, aliases):
    """(properties [(name, size)], implements) in declaration order."""
    root = ET.parse(path).getroot()
    implements = []
    impl = child(root, "Implements")
    if impl is not None:
        for iface in impl:
            if iface.text and iface.text.strip():
                implements.append(iface.text.strip())
    props = []
    plist = child(root, "Properties")
    if plist is not None:
        for prop in plist:
            type_node = child(prop, "Type")
            if type_node is None:
                raise ValueError("%s property <%s> without <Type>" % (path, prop.tag))
            flags_node = child(prop, "Flags")
            flags = flags_node.text.strip() if flags_node is not None and flags_node.text else ""
            if flags not in KEPT_FLAGS:
                continue
            props.append((prop.tag, sort_size(type_node, aliases)))
    return props, implements


def exposed_properties(defs_root, entity):
    """(name, wire_size) list in exposed-index order for one entity."""
    ed = Path(defs_root) / "entity_defs"
    aliases = parse_aliases(ed / "alias.xml")
    own, implements = parse_def_properties(ed / (entity + ".def"), aliases)
    inherited = []
    for iface in implements:
        iface_props, grandparents = parse_def_properties(
            ed / "interfaces" / (iface + ".def"), aliases
        )
        for gp in grandparents:
            gp_props, _ = parse_def_properties(ed / "interfaces" / (gp + ".def"), aliases)
            inherited.extend(gp_props)
        inherited.extend(iface_props)
    props = inherited + own
    # Stable sort by wire size; variable-width (INF) entries keep XML order.
    props.sort(key=lambda item: item[1])
    return props


def parse_version(text):
    parts = text.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise SystemExit("--version must be MAJOR.MINOR.PATCH, got %r" % text)
    return tuple(int(p) for p in parts)


def rust_str(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def emit_row(version, entity, count, props, ship_config, crew):
    out = []
    out.append("    (%d, %d, %d)," % version)
    out.append("    %sPropertyTable {" % entity)
    out.append("        count: %d," % count)
    out.append("        properties: &[")
    for name, size in props:
        width = "None" if size == INF else "Some(%d)" % size
        # Struct literals are always multi-line under rustfmt's default
        # struct_lit_width heuristic: emit the formatted shape so the committed
        # file is byte-identical to the generator output.
        out.append("            PropertyEntry {")
        out.append("                name: %s," % rust_str(name))
        out.append("                fixed_width: %s," % width)
        out.append("            },")
    out.append("        ],")
    out.append("        ship_config: %d," % ship_config)
    out.append("        crew_modifiers_compact_params: %d," % crew)
    out.append("    },")
    return out


def emit(rows):
    lines = []
    lines.append("//! AUTO-GENERATED by `scripts/gen_property_tables.py` — do not edit by hand.")
    lines.append("//!")
    lines.append("//! Per-game-version exposed-PROPERTY tables for the entities the replay")
    lines.append("//! decoder walks. An EntityCreate (0x05) state stream carries the entity's")
    lines.append("//! client-visible properties in BigWorld exposed-index order: the property")
    lines.append("//! list inheritance-ordered (interfaces, then the entity's own), filtered by")
    lines.append("//! the replicated Flags, and stably sorted by wire size. The index drifts")
    lines.append("//! whenever the entity defs change, so `build.rs` resolves the payloads it")
    lines.append("//! decodes (`shipConfig`, `crewModifiersCompactParams`) BY NAME from this")
    lines.append("//! table and walks the fixed/variable split off each entry's wire width.")
    lines.append("//!")
    lines.append("//! Source of truth: the client's `entity_defs` XML, extracted from a local")
    lines.append("//! game install with the vendored CLI (offline; CI never runs the generator):")
    lines.append("//!")
    lines.append("//! ```text")
    lines.append("//! cargo build -p game-assets --release")
    lines.append("//! ./target/release/game-assets.exe -g <game_dir> extract \\")
    lines.append('//!     -o scripts/experiments/out/defs "/scripts/entity_defs/**" "/scripts/entities*"')
    lines.append("//! python scripts/gen_property_tables.py            # regenerate this file")
    lines.append("//! python scripts/gen_property_tables.py --defs <defs_root> --version 15.9.0")
    lines.append("//!                                           # offline validation only")
    lines.append("//! ```")
    lines.append("")
    lines.append("/// One client-visible property: its entity-def name and wire width.")
    lines.append("pub struct PropertyEntry {")
    lines.append("    pub name: &'static str,")
    lines.append("    /// Fixed wire width in bytes (1/2/4/8/12); `None` = variable-width")
    lines.append("    /// (BLOB/STRING/ARRAY/USER_TYPE/... — self-describing on the wire).")
    lines.append("    pub fixed_width: Option<u8>,")
    lines.append("}")
    lines.append("")
    lines.append("/// One game version's Vehicle exposed-property map, in exposed-index order.")
    lines.append("pub struct VehiclePropertyTable {")
    lines.append("    /// The number of properties in the EntityCreate state (the u8 after the")
    lines.append("    /// frame's u32 declared length).")
    lines.append("    pub count: u8,")
    lines.append("    /// Exposed-index-ordered property list; the position IS the wire index.")
    lines.append("    pub properties: &'static [PropertyEntry],")
    lines.append("    /// Exposed index of the `shipConfig` USER_TYPE property (u8 length + blob).")
    lines.append("    pub ship_config: u8,")
    lines.append("    /// Exposed index of the `crewModifiersCompactParams` FIXED_DICT property.")
    lines.append("    pub crew_modifiers_compact_params: u8,")
    lines.append("}")
    lines.append("")
    lines.append("/// (major, minor, patch) -> Vehicle property map, ascending. Generated from")
    lines.append("/// the entity defs of each pinned version.")
    lines.append(
        "pub static VEHICLE_PROPERTY_TABLES: &[((u16, u16, u16), VehiclePropertyTable)] = &[("
    )
    for version, entity, count, props, ship_config, crew in rows:
        lines.extend(emit_row(version, entity, count, props, ship_config, crew))
    lines.append(")];")
    lines.append("")
    lines.append("/// Resolve the property table for a parsed client version: the newest pinned")
    lines.append("/// row of the SAME (major, minor) era at or below the requested patch.")
    lines.append("/// `None` = no map pinned for this era (the caller skips build decoding).")
    lines.append("pub fn vehicle_property_table_for_version(")
    lines.append("    version: (u32, u32, u32),")
    lines.append(") -> Option<&'static VehiclePropertyTable> {")
    lines.append("    let (major, minor, patch) = version;")
    lines.append("    let mut best: Option<((u16, u16, u16), &'static VehiclePropertyTable)> = None;")
    lines.append("    for (key, table) in VEHICLE_PROPERTY_TABLES {")
    lines.append("        if u32::from(key.0) != major || u32::from(key.1) != minor {")
    lines.append("            continue;")
    lines.append("        }")
    lines.append("        if u32::from(key.2) > patch {")
    lines.append("            continue;")
    lines.append("        }")
    lines.append("        match best {")
    lines.append("            Some((best_key, _)) if best_key >= *key => {},")
    lines.append("            _ => best = Some((*key, table)),")
    lines.append("        }")
    lines.append("    }")
    lines.append("    best.map(|(_, table)| table)")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def rows_from_pins():
    rows = []
    for version in sorted(PINNED):
        for entity in ENTITIES:
            count, props = PINNED[version][entity]
            names = [name for name, _ in props]
            if "shipConfig" not in names or "crewModifiersCompactParams" not in names:
                raise SystemExit("pinned %s row lacks the decoded payload properties" % (version,))
            rows.append(
                (
                    version,
                    entity,
                    count,
                    props,
                    names.index("shipConfig"),
                    names.index("crewModifiersCompactParams"),
                )
            )
    return rows


def validate(defs_root, version):
    """Recompute the row from defs and compare it with the pin; exit 1 on drift."""
    got = exposed_properties(defs_root, "Vehicle")
    pin = PINNED.get(version)
    if pin is None:
        print("--defs: no pinned %s row to validate against" % (version,), file=sys.stderr)
        return 1
    count, want = pin["Vehicle"]
    problems = []
    if count != len(got):
        problems.append("count pin=%d defs=%d" % (count, len(got)))
    for index in range(max(len(want), len(got))):
        want_item = want[index] if index < len(want) else None
        got_item = got[index] if index < len(got) else None
        if want_item != got_item:
            problems.append("index %d pin=%r defs=%r" % (index, want_item, got_item))
            if len(problems) >= 20:
                break
    if problems:
        for problem in problems:
            print("--defs: Vehicle %s: %s" % (version, problem), file=sys.stderr)
        return 1
    print(
        "--defs: Vehicle %s table recomputes cleanly (%d properties)" % (version, count),
        file=sys.stderr,
    )
    return 0


def dump_pins_row(defs_root, version):
    props = exposed_properties(defs_root, "Vehicle")
    names = [name for name, _ in props]
    print("    (%d, %d, %d): {" % version)
    print('        "Vehicle": (')
    print("            %d," % len(props))
    print("            [")
    for name, size in props:
        print("                (%r, %d)," % (name, size))
    print("            ],")
    print("        ),")
    print("    },")
    print("ship_config=%d crew_modifiers_compact_params=%d"
          % (names.index("shipConfig"), names.index("crewModifiersCompactParams")), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="write the generated Rust file here")
    parser.add_argument("--defs", help="entity_defs root to validate against")
    parser.add_argument("--version", help="MAJOR.MINOR.PATCH version key for --defs/--dump-pins")
    parser.add_argument("--dump-pins", action="store_true", help="print the parsed row as PINNED data")
    args = parser.parse_args()
    if args.dump_pins:
        if not args.defs or not args.version:
            raise SystemExit("--dump-pins requires --defs and --version")
        dump_pins_row(args.defs, parse_version(args.version))
        return 0
    rows = rows_from_pins()
    if args.defs:
        if not args.version:
            raise SystemExit("--defs requires --version")
        version = parse_version(args.version)
        code = validate(args.defs, version) if version in PINNED else 0
        if code:
            return code
        # Generate the row SET from the freshly parsed entity defs: a pinned
        # version whose row just validated emits identically to the committed
        # file; a NEW version can be emitted straight from a fresh extraction
        # before its row is transcribed into PINNED.
        fresh = exposed_properties(args.defs, "Vehicle")
        names = [name for name, _ in fresh]
        fresh_row = (
            version,
            "Vehicle",
            len(fresh),
            fresh,
            names.index("shipConfig"),
            names.index("crewModifiersCompactParams"),
        )
        rows = [row for row in rows if row[0] != version]
        rows.append(fresh_row)
        rows.sort(key=lambda row: row[0])
    text = emit(rows)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
