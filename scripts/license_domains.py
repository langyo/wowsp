"""Vendor domains in the license corpus — shared constants and repair pass.

The wizard license documents are shipped VERBATIM inside the Windows
installer, where antivirus engines scan their strings. The SySL model
disclosure once named the vendors with look-alike domains
(deepseek.ai / zhipu.ai) that are NOT the vendors' official sites: Huorong
flagged the 0.6.8 installer over it (a heuristic hit on the squatted domain
string, not on any network behaviour — the app never contacts those hosts).
The upstream celestia-island/sysl template still carries the same two
domains, and the installer build refreshes its SySL texts from that
repository, so a wowsp-side fix alone could be overwritten by the next
build.

This module is the single source of truth for:
- IMPERSONATION_DOMAINS — look-alike hosts that must never appear in a
  shipped license document, with the official site to use instead;
- OFFICIAL_VENDOR_DOMAINS — the real vendor sites a disclosure link may
  point at (extend this list only after verifying the vendor's own
  documentation);
- sanitize_license_text() — the build-time repair pass applied to EVERY
  staged license document (product-owned copyright notices, docs-owned
  telemetry pages and the upstream-refreshed SySL agreements alike);
- urls_in()/disclosure_hosts() — small extractors shared by the guard.

check_licenses.py guards the tracked corpus (and exercises this module's
logic as a self-test), while build_installers.py applies the repair pass to
fetched SySL agreements.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

#: Look-alike / squatted vendor domains -> the vendor's official website.
#: These may never appear in a shipped license document.
IMPERSONATION_DOMAINS: dict[str, str] = {
    "deepseek.ai": "https://www.deepseek.com",
    "zhipu.ai": "https://www.zhipuai.cn",
}

#: Hosts (without www.) a model-disclosure vendor link may point at.
#: A new primary model vendor belongs here once its official site is
#: verified against the vendor's own documentation.
OFFICIAL_VENDOR_DOMAINS: set[str] = {
    "deepseek.com",
    "zhipuai.cn",
    "z.ai",
}

#: Anything that looks like an absolute web URL (kept deliberately greedy:
#: the corpus is human-written prose, not HTML).
#: Conservative ASCII URL character set: a URL glued to CJK prose
#: ("…zhipuai.cn是官方站") must stop at the first non-URL character instead
#: of swallowing the sentence. Trailing ASCII punctuation may still be part
#: of the match and is stripped by clean_url().
_URL_RE = re.compile(
    r"https?://[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+", re.IGNORECASE
)

#: A model-disclosure line: the SySL template writes "Model — Vendor — URL"
#: (TWO em dashes), e.g. "GLM … — Zhipu AI — https://…" or the markdown
#: bullet form "… — Vendor — [site](https://…)". Requiring two em dashes
#: keeps ordinary prose that merely mentions a link ("Copyright … —
#: https://github.com/…") out of the vendor-link check.
_DISCLOSURE_LINE_RE = re.compile(r"—.*—.*https?://", re.IGNORECASE)

#: Trailing punctuation a prose/markdown URL may pick up (ASCII sentence
#: punctuation, CJK punctuation, markdown emphasis) — stripped before the
#: host is parsed, so "…zhipuai.cn。" or "**…zhipuai.cn**" never fails.
_URL_TAIL = ".,;:!?，。；：、*！？…）】」』》〉”’»›_~"


def clean_url(url: str) -> str:
    """Drop trailing prose/markdown punctuation from an extracted URL."""
    return url.rstrip(_URL_TAIL)


def urls_in(text: str) -> list[str]:
    """Every absolute URL in *text*, in order (tail punctuation stripped)."""
    return [clean_url(url) for url in _URL_RE.findall(text)]


def lookalike_pattern(lookalike: str) -> re.Pattern[str]:
    """The ONE definition of a look-alike host occurrence.

    Boundary = ASCII host characters only (NOT Unicode word boundaries): a
    CJK sentence can sit right next to a bare domain (访问deepseek.ai), and
    Unicode boundaries would both refuse to repair it and miss it in the
    guard. Any leading host labels (www./api./…) are part of the match, so
    the whole host is replaced. A DIFFERENT registrable domain that merely
    contains the string (xdeepseek.ai) is not a look-alike of this vendor
    and is left alone, in the guard and in the repair alike.
    """
    return re.compile(
        r"(?<![a-z0-9-])(?:[a-z0-9-]+\.)*" + re.escape(lookalike) + r"(?![a-z0-9-])",
        re.IGNORECASE,
    )


def is_official_vendor_host(host: str) -> bool:
    """True when *host* is an official vendor site or a subdomain of one"""
    return any(
        host == domain or host.endswith("." + domain)
        for domain in OFFICIAL_VENDOR_DOMAINS
    )


def normalize_host(host: str) -> str:
    """Lower-case a hostname and drop the www. prefix for comparisons."""
    host = host.strip().lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def disclosure_hosts(text: str) -> list[str]:
    """Hosts of the URLs on model-disclosure lines (vendor attributions)."""
    hosts: list[str] = []
    for line in text.splitlines():
        if not _DISCLOSURE_LINE_RE.search(line):
            continue
        for url in urls_in(line):
            try:
                host = urlparse(url).hostname
            except ValueError:
                host = None
            if host:
                normalized = normalize_host(host)
                if normalized and normalized not in hosts:
                    hosts.append(normalized)
    return hosts


def sanitize_license_text(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Rewrite impersonation domains to the vendors' official sites.

    Returns (repaired_text, fixes) where fixes lists
    (lookalike_domain, official_host) pairs that were applied. The repair is
    a factual correction of the disclosure link, never a change to the
    license terms. The match is case-insensitive and HOST-AWARE: a squatted
    host (bare, ``www.``-prefixed or any subdomain of it) is replaced as a
    whole by the official host, so ``www.deepseek.ai`` never becomes
    ``www.www.deepseek.com`` and markdown labels are repaired together with
    their URLs.
    """
    fixes: list[tuple[str, str]] = []
    updated = text
    for lookalike, official in IMPERSONATION_DOMAINS.items():
        # One shared definition of an occurrence (see lookalike_pattern):
        # ASCII host boundaries, any leading host labels, case-insensitive.
        pattern = lookalike_pattern(lookalike)
        official_host = urlparse(official).hostname or official
        updated, count = pattern.subn(official_host, updated)
        if count:
            fixes.append((lookalike, official_host))
    # A repaired link must also satisfy the guard's HTTPS rule: an insecure
    # "http://<official>" (bare, www-prefixed or a subdomain of it) is
    # upgraded so the staged document is guard-clean.
    for official in IMPERSONATION_DOMAINS.values():
        official_host = urlparse(official).hostname or official
        # Upgrade the www-prefixed host AND its bare form (plus subdomains of
        # either): a document may link https://deepseek.com without www.
        upgrade_hosts = {official_host}
        if official_host.startswith("www."):
            upgrade_hosts.add(official_host[4:])
        for host in upgrade_hosts:
            matched: list[str] = []

            def _upgrade(match: re.Match[str]) -> str:
                matched.append(match.group(1))
                return "https://" + match.group(1)

            updated = re.subn(
                # Host boundaries on BOTH sides: deepseek.com.cn /
                # deepseek.community / zhipuai.cn.evil.com are different
                # hosts and must not be reported as an official-link repair.
                # The extra (?!\.[a-z0-9]) lookahead keeps a following dot
                # LABEL out of the match while still allowing sentence-final
                # "http://deepseek.com." (dot + space/end).
                r"(?<![a-z0-9-])http://((?:[a-z0-9-]+\.)*"
                + re.escape(host)
                + r")(?![a-z0-9-])(?!\.[a-z0-9])",
                _upgrade,
                updated,
                flags=re.IGNORECASE,
            )[0]
            for actual in matched:
                fixes.append(("http://" + actual, "https://" + actual))
    return updated, fixes


def license_problems(text: str) -> list[str]:
    """Every guard violation in one license document (empty = clean).

    The guard is intentionally narrow: shipped license documents must use
    HTTPS, must never carry a look-alike vendor domain, and a
    model-disclosure vendor link must point at an official vendor site.

    The look-alike scan uses the SAME host-boundary pattern as the repair
    (not a bare URL-host check): a domain written only in prose or as a
    markdown label (with the URL pointing elsewhere) must fail too, and any
    subdomain of a squatted host fails with it. A different registrable
    domain that merely contains the same characters (xdeepseek.ai) is not a
    look-alike of this vendor.
    """
    problems: list[str] = []
    for url in urls_in(text):
        if url.lower().startswith("http://"):
            problems.append(f"insecure URL (use https): {url}")
    for lookalike, official in IMPERSONATION_DOMAINS.items():
        match = lookalike_pattern(lookalike).search(text)
        if match:
            problems.append(
                f"look-alike vendor domain {lookalike} appears in the text "
                f"as {match.group(0)!r} (official site: {official})"
            )
    for host in disclosure_hosts(text):
        if any(
            host == lookalike or host.endswith("." + lookalike)
            for lookalike in IMPERSONATION_DOMAINS
        ):
            # A look-alike (or a subdomain of one) already reported above. A
            # DIFFERENT registrable domain that merely ends with the same
            # string (notdeepseek.ai, evil-deepseek.ai) is NOT a look-alike:
            # it still has to pass the official-vendor check below.
            continue
        if not is_official_vendor_host(host):
            problems.append(
                f"model-disclosure link points at {host}, which is not a "
                "known official vendor site (verify it, then extend "
                "OFFICIAL_VENDOR_DOMAINS)"
            )
    return problems
