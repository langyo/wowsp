#!/usr/bin/env python3
"""Package content checks shared by the Mod Hub publisher and sync engine.

Crash report gc-20261101232118338-22840: a re-hosted catalog package shipped
glue XML (gui/uss_settings.xml, gui_urls.xml) whose swffile/url entries pointed
at SWF assets (gui/unbound/mods/PostBattleProgressNumbers.swf,
carousel_extended.swf) that existed in NEITHER the package NOR the game
client; the game's Scaleform UI hit "Unknown file format" at boot and hung
(AppHangB1). These pure, offline helpers keep such a self-inconsistent
package from shipping:

- every ".swf" member must carry a real SWF header (FWS raw / CWS zlib /
  ZWS lzma) -- a member named ".swf" whose bytes are anything else is the
  "Unknown file format" crash in the making, so it HARD-fails the release;
- small text members (.xml/.py/.json/.txt/.cfg under 512 KB) are scanned for
  SWF references (<swffile>PATH</swffile> entries, url="...swf" and
  source="...swf" attribute values, both quote styles), and every referenced
  basename must be provided by some member of the same zip (member-basename
  match, case-insensitive);
- XML comments are stripped from a text member BEFORE its SWF references are
  extracted -- the same conservative rule the app-side scanner
  (mod_integrity::strip_xml_comments) applies. Stock game templates document
  example load directives inside XML comments (gui/uss_settings.xml carries a
  commented-out <swffile>../unbound/flash/carousel_extended.swf</swffile>
  example nothing loads), and a documented example is not a reference: it
  must not warn. Only COMPLETE <!-- ... --> spans are removed; an
  unterminated opener is kept verbatim together with the rest of the text, so
  a malformed member never silently loses real references.

Deliberate trade-off: a missing reference is a WARN, never a refusal, here.
A glue file may legitimately point at a stock game asset -- those live in
the client, never in the package -- so package-local absence alone proves
nothing. The authoritative refusal lives in the app-side installer gate,
which resolves references against the actual client index; this scan only
makes the "references something that exists nowhere" case visible before
upload (WARN by default, fatal only under "validate --strict").

No third-party deps, no network, no filesystem mutation: everything reads
bytes and returns data, so both callers (mod_hub_publish.py's validate
stage / release gate and mod_hub_sync.py's asset staging) can embed it
without side effects.

    python scripts/mod_package_check.py   # selftest
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# A real SWF starts with exactly one of these 3-byte signatures: FWS
# (uncompressed), CWS (zlib), ZWS (lzma). Anything else -- including short
# data or lowercase "fws" -- is not an SWF the Scaleform loader will accept.
SWF_MAGICS = (b"FWS", b"CWS", b"ZWS")

# Text members scanned for SWF references: only small ones (bounded memory,
# and glue files are small by construction).
TEXT_SUFFIXES = (".xml", ".py", ".json", ".txt", ".cfg")
TEXT_MEMBER_LIMIT = 512 * 1024

SWFFILE_RE = re.compile(r"<swffile>\s*([^<]+?)\s*</swffile>", re.IGNORECASE)
_URL_ATTR_RE = re.compile(r"""\burl\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE)
_SOURCE_ATTR_RE = re.compile(r"""\bsource\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE)


class PackageContentError(RuntimeError):
    """A package carries .swf member(s) whose bytes fail the SWF magic check."""


@dataclass
class SwfRefFinding:
    """One referenced .swf basename that no member of the same zip provides."""

    package: str
    ref_basename: str
    referencing_members: list[str]

    def as_dict(self) -> dict:
        """The plain {package, ref_basename, referencing_members} shape."""
        return {
            "package": self.package,
            "ref_basename": self.ref_basename,
            "referencing_members": list(self.referencing_members),
        }


@dataclass
class PackageCheckReport:
    """Outcome of scanning one package zip (pure data, JSON-able)."""

    package: str
    members_scanned: int = 0
    swf_members_ok: int = 0
    bad_swf_members: list[str] = field(default_factory=list)
    findings: list[SwfRefFinding] = field(default_factory=list)


def swf_magic_ok(data: bytes) -> bool:
    """First 3 bytes must be EXACTLY FWS, CWS or ZWS (case-sensitive; a
    shorter payload fails the check by construction)."""
    return data[:3] in SWF_MAGICS


def normalize_swf_ref(raw: str) -> str:
    """Lowercase basename of one reference (slash and backslash paths both);
    empty string when it does not name a .swf file."""
    ref = (raw or "").strip().replace("\\", "/")
    ref = posixpath.basename(ref).strip().lower()
    return ref if ref.endswith(".swf") else ""


def strip_xml_comments(text: str) -> str:
    """Remove every COMPLETE XML comment span (``<!-- ... -->``) from text.

    Publisher-side parity with the app scanner's
    ``mod_integrity::strip_xml_comments``: stock game templates document
    example load directives inside XML comments, and a documented example is
    not a load. Conservative by construction:

    - only spans with BOTH the opener and the matching closer are removed;
    - the first closer ends a span (XML has no nested comments, so an opener
      inside a span is plain span text);
    - an UNTERMINATED opener is kept verbatim with the rest of the text -- a
      malformed member must never silently lose real references;
    - deterministic single pass, no third-party dependency.
    """
    if "<!--" not in text:
        return text
    out: list[str] = []
    cursor = 0
    while True:
        open_at = text.find("<!--", cursor)
        if open_at < 0:
            out.append(text[cursor:])
            return "".join(out)
        out.append(text[cursor:open_at])
        body = open_at + 4
        close_at = text.find("-->", body)
        if close_at < 0:
            # Unterminated: keep the opener and the rest of the text.
            out.append(text[open_at:])
            return "".join(out)
        cursor = close_at + 3


def extract_swf_refs(text: str) -> list[str]:
    """Lowercase basenames of every SWF file one text member references.

    Covers the glue shapes seen in the wild: <swffile>PATH</swffile>
    entries, url="....swf" and source="....swf" attribute values (both
    quote styles). Refs that do not name a .swf file are dropped -- they
    cannot trigger the Scaleform loader this gate exists for. Duplicates
    are kept; the zip scan groups them per referencing member anyway.
    """
    refs: list[str] = []
    for m in SWFFILE_RE.finditer(text):
        refs.append(normalize_swf_ref(m.group(1)))
    for attr_re in (_URL_ATTR_RE, _SOURCE_ATTR_RE):
        for m in attr_re.finditer(text):
            raw = m.group(1) if m.group(1) is not None else m.group(2)
            refs.append(normalize_swf_ref(raw))
    return [r for r in refs if r]


def scan_zip(zf: zipfile.ZipFile, package: str = "") -> PackageCheckReport:
    """One pass over an open zip: SWF magic on every .swf member, reference
    extraction on small text members, then member-basename resolution.

    Unreadable .swf members (e.g. encrypted) fail the magic check closed --
    bytes nobody can verify are bytes the Scaleform loader may choke on.
    Unreadable text members only skip the warn-level reference scan.
    Directory entries are neither scanned nor counted as providers (a
    directory never satisfies a file reference).
    """
    rep = PackageCheckReport(package=package)
    infos = [i for i in zf.infolist() if not i.is_dir()]
    rep.members_scanned = len(infos)
    provided = {posixpath.basename(i.filename.replace("\\", "/")).lower()
                for i in infos}
    refs: dict[str, list[str]] = {}
    for info in infos:
        name = info.filename
        lower = name.lower()
        if lower.endswith(".swf"):
            try:
                with zf.open(info) as fh:
                    magic = fh.read(3)
            except Exception as exc:  # noqa: BLE001 - unreadable = unchecked
                rep.bad_swf_members.append(f"{name} (unreadable: {exc})")
                continue
            if swf_magic_ok(magic):
                rep.swf_members_ok += 1
            else:
                rep.bad_swf_members.append(name)
        elif lower.endswith(TEXT_SUFFIXES) and info.file_size < TEXT_MEMBER_LIMIT:
            try:
                with zf.open(info) as fh:
                    text = fh.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001 - reference scan is warn-level
                continue
            # Commented-out example directives are documented, not loaded.
            text = strip_xml_comments(text)
            for ref in extract_swf_refs(text):
                refs.setdefault(ref, []).append(name)
    for ref in sorted(refs):
        if ref not in provided:
            rep.findings.append(SwfRefFinding(
                package=package, ref_basename=ref,
                referencing_members=sorted(set(refs[ref]))))
    return rep


def scan_bytes(data: bytes, package: str = "") -> PackageCheckReport:
    """Scan an in-memory zip (selftests, callers holding the bytes)."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return scan_zip(zf, package)


def scan_path(path, package=None) -> PackageCheckReport:
    """Scan a package zip on disk; the package label defaults to its basename."""
    with zipfile.ZipFile(path) as zf:
        return scan_zip(zf, package or Path(path).name)


def enforce_swf_magic(reports) -> None:
    """Raise one PackageContentError naming EVERY offending member across
    all reports -- the caller (release gate / validate stage) must not
    upload until these are fixed, so it gets the whole list at once."""
    bad = [(r.package, name) for r in reports for name in r.bad_swf_members]
    if bad:
        detail = "; ".join(f"{pkg}: {name}" for pkg, name in bad)
        raise PackageContentError(
            ".swf member(s) fail the FWS/CWS/ZWS magic check "
            "(Scaleform would hit 'Unknown file format' at boot): " + detail)


def selftest() -> None:
    """Offline checks for the pure helpers (no network, no files)."""
    assert swf_magic_ok(b"FWS\x06\x00") and swf_magic_ok(b"CWS\x00")
    assert swf_magic_ok(b"ZWS")
    assert not swf_magic_ok(b"fws\x06")  # exact bytes, case-sensitive
    assert not swf_magic_ok(b"FW") and not swf_magic_ok(b"")
    assert not swf_magic_ok(b"\x89PNG\r\n")

    assert normalize_swf_ref("gui\\Unbound\\Mods\\A.SWF") == "a.swf"
    assert normalize_swf_ref("  B.swf  ") == "b.swf"
    assert normalize_swf_ref("gui/fonts/fontconfig.xml") == ""
    assert normalize_swf_ref("") == ""

    refs = extract_swf_refs(
        "<swffile> gui/unbound/mods/A.SWF </swffile>"
        "<a url='gui\\Unbound\\B.swf' source=\"c.swf\">"
        "<swffile>gui/fonts/fontconfig.xml</swffile>")
    assert refs == ["a.swf", "b.swf", "c.swf"], refs
    # XML comments are documented examples, not loads: complete spans go, an
    # unterminated opener keeps itself and the rest (no silent loss).
    assert strip_xml_comments("plain") == "plain"
    assert strip_xml_comments("a<!-- <swffile>x.swf</swffile> -->b") == "ab"
    assert strip_xml_comments("a<!-- one -->b<!-- two -->c") == "abc"
    assert strip_xml_comments("a --> b <!-- c --> d") == "a --> b  d"
    assert strip_xml_comments("a<!-- b <swffile>keep.swf</swffile>") == (
        "a<!-- b <swffile>keep.swf</swffile>"
    )
    assert extract_swf_refs(
        strip_xml_comments(
            '<!-- <swffile>example.swf</swffile> --><element url="real.swf">'
        )
    ) == ["real.swf"]

    # Publisher-side parity with the app scanner: the stock uss_settings.xml
    # example comment must not warn, while a genuinely missing reference still
    # does.
    stock = """<gui_settings>
    <!-- Template example:
        <swffile>../unbound/flash/carousel_extended.swf</swffile>
    -->
    <element url="gui/unbound/flash/really_missing.swf"/>
</gui_settings>
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("gui/uss_settings.xml", stock)
        zf.writestr("gui/provided.swf", b"CWS\x00")
    report = scan_bytes(buf.getvalue(), "stock.zip")
    assert [f.ref_basename for f in report.findings] == ["really_missing.swf"], (
        report.findings
    )
    assert report.swf_members_ok == 1, report
    print("selftest ok")


if __name__ == "__main__":
    selftest()
