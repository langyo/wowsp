#!/usr/bin/env python
"""Compute BigWorld exposed client-method indices from extracted entity defs.

E10 research script: given a directory holding `entity_defs/` (with
`alias.xml`, `<Entity>.def` and `interfaces/*.def`) plus `entities.xml`,
replicates the engine's exposed-method index computation that
`packages/tools/wowsunpack-vendor/crates/wowsunpack/src/rpc/entitydefs.rs`
implements (itself the fixed version of replay_unpack's algorithm):

  1. resolve type aliases from `alias.xml` (sequential — an alias may
     reference earlier aliases);
  2. collect client methods: for each interface in `<Implements>` (in
     declaration order) its grandparents (one level, declaration order)
     then the interface itself, then the entity's own methods;
  3. drop duplicate method names keeping the FIRST occurrence (the engine
     rejects a method already defined by an earlier-processed list);
  4. stable-sort by wire size; the exposed index (the wire method id in
     EntityMethod 0x08 packets) is the 0-based position in that list.

Wire size rules (ArgType::sort_size in typedefs.rs):
  UINT8/INT8 1, UINT16/INT16 2, UINT32/INT32/FLOAT/FLOAT32 4,
  UINT64/INT64/FLOAT64/VECTOR2 8, VECTOR3 12, STRING/UNICODE_STRING/BLOB
  variable, ARRAY (unsized) variable, FIXED_DICT with AllowNone variable,
  USER_TYPE variable (regardless of inner), MAILBOX/PYTHON variable (blob),
  alias -> inner, FIXED_DICT -> sum of property sizes, sized ARRAY/TUPLE ->
  count * element size. Method size = sum of arg sizes (variable saturates
  at 0xffff) + VariableLengthHeaderSize (default 1).

Usage:
    python exposed_index.py <defs_root> [EntityName ...]

    <defs_root>  directory containing entity_defs/ and entities.xml
                 (e.g. scripts/experiments/out/defs/scripts)
    EntityName   entities to dump (default: Avatar Vehicle)

Output: one line per method `id\\tname\\tsize`, plus a JSON line prefix
`#TABLE <Entity> <json dict name->id>` for machine consumption.
"""

import json
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
    "FLOAT": 4,  # def "FLOAT" is FLOAT32
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
# Variable-size structural keywords (sized composites resolve recursively).
VARIABLE = {"STRING", "UNICODE_STRING", "BLOB", "USER_TYPE", "MAILBOX", "PYTHON"}


def _child(elem, tag):
    """First direct child element with the given tag (roxmltree child_by_name)."""
    for child in elem:
        if child.tag == tag:
            return child
    return None


def _keyword(elem):
    """The type keyword: the element's leading text, trimmed (parse_type reads
    arg.first_child().text().trim() — i.e. the text node inside the tag)."""
    text = elem.text
    if text is None:
        raise ValueError(f"element <{elem.tag}> has no leading type keyword")
    kw = text.strip()
    if not kw:
        raise ValueError(f"element <{elem.tag}> has empty type keyword")
    return kw


def sort_size_of(elem, aliases, depth=0):
    """sort_size of the type described by `elem` (whose keyword is its text)."""
    if depth > 64:
        raise ValueError("alias recursion too deep")
    kw = _keyword(elem)
    if kw in PRIMITIVES and kw not in VARIABLE:
        return PRIMITIVES[kw]
    if kw in VARIABLE:
        # USER_TYPE is variable for ordering even when its inner streams a
        # fixed number of bytes (typedefs.rs UserType arm); MAILBOX/PYTHON
        # stream as opaque blobs; STRING/BLOB are self-evidently variable.
        return INF
    if kw == "ARRAY":
        of = _child(elem, "of")
        if of is None:
            raise ValueError("ARRAY without <of>")
        inner = sort_size_of(of, aliases, depth + 1)
        size_node = _child(elem, "size")
        if size_node is None:
            return INF
        if inner == INF:
            return INF
        return inner * int(size_node.text.strip())
    if kw == "TUPLE":
        of = _child(elem, "of")
        size_node = _child(elem, "size")
        if of is None or size_node is None:
            raise ValueError("TUPLE without <of>/<size>")
        inner = sort_size_of(of, aliases, depth + 1)
        if inner == INF:
            return INF
        return inner * int(size_node.text.strip())
    if kw == "FIXED_DICT":
        if _child(elem, "AllowNone") is not None:
            return INF
        props = _child(elem, "Properties")
        if props is None:
            return 0
        total = 0
        for prop in props:
            type_node = _child(prop, "Type")
            if type_node is None:
                raise ValueError(f"FIXED_DICT property <{prop.tag}> without <Type>")
            inner = sort_size_of(type_node, aliases, depth + 1)
            if inner == INF:
                return INF
            total += inner
        return total
    if kw in aliases:
        return aliases[kw]
    raise ValueError(f"unrecognized type {kw!r} in <{elem.tag}>")


def parse_aliases(path):
    """Sequential alias resolution mirroring parse_aliases (parse_type against
    the partially built map, then insert)."""
    root = ET.parse(path).getroot()
    aliases = {}
    for elem in root:
        aliases[elem.tag] = sort_size_of(elem, aliases)
    return aliases


def _variable_length_header_size(method):
    """VariableLengthHeaderSize with the engine's fallback: the node's first
    child may be text ("2") or an element (e.g. <WarnLevel>none</WarnLevel>);
    anything unparseable resolves to 1 (parse_type's unwrap_or(1))."""
    node = _child(method, "VariableLengthHeaderSize")
    if node is None:
        return 1
    text = node.text if node.text and node.text.strip() else None
    if text is None:
        for child in node:
            text = child.text
            break
    try:
        return int(text.strip())
    except (ValueError, AttributeError):
        return 1


def parse_def_methods(path, aliases):
    """(client_methods [(name, size)], implements [names]) in declaration order."""
    root = ET.parse(path).getroot()
    implements = []
    impl = _child(root, "Implements")
    if impl is not None:
        for iface in impl:
            implements.append(iface.text.strip())
    methods = []
    cm = _child(root, "ClientMethods")
    if cm is not None:
        for method in cm:
            size = 0
            for child in method:
                if child.tag == "Arg":
                    size += sort_size_of(child, aliases)
                elif child.tag == "Args":
                    for arg in child:
                        size += sort_size_of(arg, aliases)
            vlh = _variable_length_header_size(method)
            total = INF + vlh if size >= INF else size + vlh
            methods.append((method.tag, total))
    return methods, implements


def exposed_index(defs_root, entity):
    """The 0-based exposed index map {name: id} for one entity."""
    ed = defs_root / "entity_defs"
    aliases = parse_aliases(ed / "alias.xml")
    methods, implements = parse_def_methods(ed / f"{entity}.def", aliases)

    # Interfaces: per direct interface its grandparents (one level) then the
    # interface itself; concatenated across interfaces in Implements order.
    inherited = []
    for iface in implements:
        iface_methods, grandparents = parse_def_methods(
            ed / "interfaces" / f"{iface}.def", aliases
        )
        for gp in grandparents:
            gp_methods, _ = parse_def_methods(ed / "interfaces" / f"{gp}.def", aliases)
            inherited.extend(gp_methods)
        inherited.extend(iface_methods)

    combined = inherited + methods
    seen = set()
    deduped = []
    for name, size in combined:
        if name in seen:  # engine keeps the first ("Method already defined")
            continue
        seen.add(name)
        deduped.append((name, size))
    deduped.sort(key=lambda m: m[1])  # stable, matching sort_by_key
    return {name: idx for idx, (name, _) in enumerate(deduped)}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    defs_root = Path(sys.argv[1])
    entities = sys.argv[2:] or ["Avatar", "Vehicle"]
    for entity in entities:
        table = exposed_index(defs_root, entity)
        print(f"#TABLE {entity} {json.dumps(table, sort_keys=True)}")
        for name, idx in sorted(table.items(), key=lambda kv: kv[1]):
            print(f"{idx}\t{name}")
        print(f"# {entity}: {len(table)} client methods", file=sys.stderr)


if __name__ == "__main__":
    main()
