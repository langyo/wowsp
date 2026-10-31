#!/usr/bin/env python3
"""Guard the license corpus against look-alike vendor domains.

Why this exists: the wizard license documents are shipped verbatim inside
the Windows installer, and antivirus heuristics scan their strings. The SySL
model disclosure once linked the vendors through squatted look-alike
domains (deepseek.ai / zhipu.ai); Huorong flagged the 0.6.8 installer for
the deepseek.ai string even though the app never contacts that host. The
upstream SySL template can reintroduce it on every installer build, so both
the tracked corpus and the build-time refresh are guarded (see
license_domains.py, which this script also self-tests).

Checks, over every shipped license text (LICENSE itself, the vendored
installer license/copyright texts, and the telemetry notices staged from
the docs pages):
- every URL is HTTPS;
- no look-alike vendor domain appears anywhere;
- every model-disclosure vendor link points at an official vendor site.

Run it directly (`python scripts/check_licenses.py`) or with
`--self-test` to exercise the detection/repair logic on fixtures.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from license_domains import (  # noqa: E402  (path setup must run first)
    IMPERSONATION_DOMAINS,
    OFFICIAL_VENDOR_DOMAINS,
    license_problems,
    sanitize_license_text,
)

LICENSE_CORPUS = (
    [REPO / "LICENSE"]
    + sorted((REPO / "packages" / "installer" / "licenses").glob("*.txt"))
    # The installer also bundles the telemetry notices staged from the docs
    # pages (shun.toml.template's third [[licenses]] entry).
    + sorted((REPO / "docs").glob("*/license/usage-telemetry.md"))
)


def check_corpus() -> int:
    failures = 0
    for path in LICENSE_CORPUS:
        if not path.is_file():
            print(f"[check-licenses] missing license document: {path}")
            failures += 1
            continue
        text = path.read_text(encoding="utf-8")
        problems = license_problems(text)
        if not problems:
            continue
        failures += len(problems)
        rel = path.relative_to(REPO)
        for problem in problems:
            print(f"[check-licenses] {rel}: {problem}")
    if failures:
        print(
            "[check-licenses] "
            f"{failures} problem(s). A shipped license document carries a "
            "look-alike or unverified vendor domain: use the vendor's official "
            "site (see scripts/license_domains.py) and make sure the installer "
            "is not flagged by antivirus heuristics again."
        )
    return failures


def self_test() -> int:
    """Exercise the repair/detection logic on fixtures (no repository I/O)."""
    failures = 0

    def expect(condition: bool, label: str) -> None:
        nonlocal failures
        if not condition:
            failures += 1
            print(f"[check-licenses] self-test FAILED: {label}")

    # The repair pass rewrites both the disclosure URL and its markdown label.
    nl = chr(10)
    sample = nl.join(
        [
            "Primary AI Models Used:",
            "  GLM 5 — Zhipu AI — https://zhipu.ai",
            "  DeepSeek V4 Flash — DeepSeek — [deepseek.ai](https://deepseek.ai)",
        ]
    )
    repaired, fixes = sanitize_license_text(sample)
    expect(len(fixes) == 2, "both look-alike domains are reported as fixed")
    expect("deepseek.ai" not in repaired, "deepseek.ai removed by the repair")
    expect("zhipu.ai" not in repaired, "zhipu.ai removed by the repair")
    expect("https://www.deepseek.com" in repaired, "deepseek repaired to official")
    expect("https://www.zhipuai.cn" in repaired, "zhipu repaired to official")
    expect(not license_problems(repaired), "repaired text passes the guard")

    # The guard catches each violation class on its own.
    expect(
        any("look-alike" in p for p in license_problems("see https://deepseek.ai")),
        "look-alike domain detected",
    )
    expect(
        any("insecure URL" in p for p in license_problems("see http://www.deepseek.com")),
        "plain-http URL detected",
    )
    expect(
        any(
            "official vendor site" in p
            for p in license_problems("GLM — Zhipu AI — https://example.com")
        ),
        "unverified disclosure vendor detected",
    )
    expect(
        not license_problems("GLM — Zhipu AI — https://www.zhipuai.cn"),
        "official disclosure vendor accepted",
    )
    # The literal scan must catch forms a URL-host check would miss: a
    # subdomain, a bare prose mention, an upper-case spelling, and a markdown
    # label whose URL points elsewhere. Antivirus heuristics match the bare
    # string, so all of these must fail.
    for probe in (
        "api.deepseek.ai",
        "DEEPSEEK.AI",
        "see deepseek.ai for details",
        "[deepseek.ai](https://www.deepseek.com)",
    ):
        expect(
            any("look-alike" in p for p in license_problems(probe)),
            f"literal look-alike detected in {probe!r}",
        )
    # The repair is host-aware and case-insensitive: a prefixed/subdomain
    # squatted host is replaced as a whole (never www.www.), any case.
    repaired2, fixes2 = sanitize_license_text(
        "https://www.deepseek.ai/x https://api.deepseek.ai DEEPSEEK.AI"
    )
    expect(len(fixes2) == 1, "one look-alike domain reported by the repair")
    expect("deepseek.ai" not in repaired2.lower(), "all case variants repaired")
    expect("www.www." not in repaired2, "repair never doubles the www prefix")
    expect(repaired2.count("https://www.deepseek.com") == 2, "URLs repaired")
    expect("www.deepseek.com" in repaired2, "bare label repaired")
    expect(not license_problems(repaired2), "repaired probes pass the guard")
    # Unicode word boundaries would refuse to repair a bare domain glued to a
    # CJK sentence while the guard still flags it; the ASCII lookaround
    # boundary must repair it. An insecure http:// link is upgraded to https
    # so the staged document passes the guard.
    repaired3, fixes3 = sanitize_license_text(
        "访问deepseek.ai的官网 http://deepseek.ai/v1 https://xdeepseek.ai"
    )
    domain_fixes = [pair for pair in fixes3 if pair[0] in IMPERSONATION_DOMAINS]
    expect(
        len(domain_fixes) == 1,
        "one look-alike domain repaired in CJK/http probes",
    )
    expect(
        "访问www.deepseek.com的官网" in repaired3,
        "CJK-adjacent domain repaired",
    )
    # The poisoned forms are gone; the unrelated registrable domain and the
    # upgraded URL are what is left.
    expect(
        "访问deepseek.ai" not in repaired3 and "http://deepseek.ai" not in repaired3,
        "every look-alike occurrence repaired",
    )
    expect("https://www.deepseek.com/v1" in repaired3, "http link upgraded to https")
    expect(
        "xdeepseek.ai" in repaired3,
        "a different registrable domain is left alone (xdeepseek.ai)",
    )
    expect(not license_problems(repaired3), "CJK/http repaired probes are guard-clean")
    # False-positive fixtures: an official subdomain and a URL trailing prose
    # punctuation are fine, and a single em-dash line is not a vendor link.
    expect(
        not license_problems("GLM — Zhipu AI — https://platform.deepseek.com/x"),
        "official vendor subdomain accepted",
    )
    # A different registrable domain that merely ENDS with the look-alike
    # string is not a look-alike of this vendor: the look-alike skip may only
    # exempt the exact host or its dot-boundary subdomains, so such a
    # disclosure link still has to be rejected as a non-official vendor site
    # (the round-3 BLOCKER: an endswith() without the dot exempted it).
    for probe in ("notdeepseek.ai", "evil-deepseek.ai", "xdeepseek.ai"):
        problems = license_problems(f"GLM — Zhipu AI — https://{probe}")
        expect(
            any("official vendor site" in p for p in problems),
            f"non-official disclosure host rejected: {probe}",
        )
    expect(
        not license_problems("https://xdeepseek.ai"),
        "a non-disclosure mention of a different registrable domain passes",
    )
    upgraded_bare, _ = sanitize_license_text("http://deepseek.com/api")
    expect(
        "https://deepseek.com/api" in upgraded_bare,
        "a bare-http official link is upgraded to https",
    )
    expect(
        not license_problems("GLM — Zhipu AI — https://www.zhipuai.cn。"),
        "CJK trailing punctuation stripped before the host check",
    )
    for wrapped in (
        "GLM — Zhipu AI — （https://www.zhipuai.cn）",
        "GLM — Zhipu AI — 「https://www.zhipuai.cn」",
        "GLM — Zhipu AI — “https://www.zhipuai.cn”",
        "GLM — Zhipu AI — «https://www.zhipuai.cn»",
        "GLM — Zhipu AI — _https://www.zhipuai.cn_",
        "GLM — Zhipu AI — ~~https://www.zhipuai.cn~~",
        # A URL glued to CJK prose stops at the sentence start (ASCII URL
        # character set) instead of swallowing the sentence into the host.
        "GLM — Zhipu AI — https://www.zhipuai.cn是官方站",
    ):
        expect(
            not license_problems(wrapped),
            f"wrapped official link accepted: {wrapped[-6:]}",
        )
    # Upper-case schemes are still disclosure lines (IGNORECASE) and are
    # rejected for non-official hosts.
    expect(
        any(
            "official vendor site" in p
            for p in license_problems("GLM — Zhipu AI — HTTPS://evil.example")
        ),
        "upper-case scheme disclosure line checked",
    )
    # The https upgrade has host boundaries: a different domain that merely
    # starts with the official name is not rewritten or reported as a repair.
    untouched, scheme_fixes = sanitize_license_text(
        "http://deepseek.com.cn http://zhipuai.cn.evil.com"
    )
    expect(
        "http://deepseek.com.cn" in untouched
        and "http://zhipuai.cn.evil.com" in untouched,
        "different hosts are not mistaken for official links",
    )
    expect(scheme_fixes == [], "no bogus repair reported for different hosts")
    expect(
        not license_problems("Copyright — https://github.com/celestia-island/sysl"),
        "a single-dash prose link is not treated as a vendor disclosure",
    )
    # The canonical constants must stay consistent (official hosts are real
    # vendor domains, not look-alikes).
    expect(
        all(domain not in OFFICIAL_VENDOR_DOMAINS for domain in IMPERSONATION_DOMAINS),
        "look-alike domains are not allowlisted as official",
    )
    failures += _staging_self_test()
    if failures:
        print(f"[check-licenses] self-test: {failures} failure(s)")
    else:
        print("[check-licenses] self-test: OK")
    return failures


def _staging_self_test() -> int:
    """Exercise the INSTALLER build's repair pass without building one.

    The guard above only proves the committed corpus is clean; installers
    also stage documents refreshed from upstream (celestia-island/sysl still
    carries the look-alike domains) and copy product/docs-owned files. This
    simulation drives build_installers.stage_text and fetch_sysl_agreements
    against temp fixtures with a squatted domain and asserts nothing bad
    reaches the staging directory.
    """
    import tempfile

    failures = 0

    def expect(condition: bool, label: str) -> None:
        nonlocal failures
        if not condition:
            failures += 1
            print(f"[check-licenses] staging self-test FAILED: {label}")

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import build_installers

        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            # A product-owned document with a squatted domain is repaired.
            src = tmp / "copyright-xx.txt"
            src.write_text(
                "[deepseek.ai](https://deepseek.ai) / https://www.zhipu.ai",
                encoding="utf-8",
                newline="",
            )
            dst = tmp / "staged-xx.txt"
            build_installers.stage_text(src, dst, "copyright-xx.txt")
            staged = dst.read_text(encoding="utf-8")
            expect(
                all(d not in staged.lower() for d in IMPERSONATION_DOMAINS),
                "stage_text repairs product-owned documents",
            )
            expect("www.www." not in staged, "stage_text never doubles the www prefix")

            # Every SySL locale (upstream-refreshed path, simulated offline as
            # the vendored fallback) is repaired before it is staged.
            fake_installer = tmp / "installer"
            fake_licenses = fake_installer / "licenses"
            fake_licenses.mkdir(parents=True)
            real = REPO / "packages" / "installer" / "licenses"
            locales = ["en"] + list(build_installers.SYSL_I18N_DIRS)
            for locale in locales:
                (fake_licenses / f"{locale}.txt").write_text(
                    (real / f"{locale}.txt").read_text(encoding="utf-8")
                    + chr(10)
                    + "https://deepseek.ai",
                    encoding="utf-8",
                    newline="",
                )
            stage = tmp / "stage"
            stage.mkdir()
            old_installer = build_installers.INSTALLER
            old_urlopen = build_installers.urllib.request.urlopen

            def offline(*_args, **_kwargs):
                raise OSError("offline staging self-test")

            build_installers.INSTALLER = fake_installer
            build_installers.urllib.request.urlopen = offline
            try:
                build_installers.fetch_sysl_agreements(stage)
            finally:
                build_installers.INSTALLER = old_installer
                build_installers.urllib.request.urlopen = old_urlopen
            staged_sysl = list((stage / "licenses").glob("*.txt"))
            expect(
                len(staged_sysl) == len(locales),
                "every SySL locale staged by the simulated build",
            )
            dirty = [
                path.name
                for path in staged_sysl
                if any(
                    domain in path.read_text(encoding="utf-8").lower()
                    for domain in IMPERSONATION_DOMAINS
                )
            ]
            expect(not dirty, "fetched/vendored SySL texts sanitized: " + repr(dirty))
    except Exception as exc:  # pragma: no cover - reported as a failure
        failures += 1
        print(f"[check-licenses] staging self-test FAILED: {exc!r}")
    return failures


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return 1 if self_test() else 0
    failures = check_corpus()
    if failures:
        return 1
    print(f"[check-licenses] OK ({len(LICENSE_CORPUS)} license documents)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
