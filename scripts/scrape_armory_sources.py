#!/usr/bin/env python3
"""Regenerate the ship-source table from the Armory's own catalog.

The in-game Armory is an embedded web app whose page embeds the FULL
catalog state (every bundle's currency + ship entitlements) as a JSON
blob — one GET per region returns the complete current offer, with the
game ship ids right in the entitlements. This script:

  1. scrapes the live catalogs (NA / EU / ASIA — direct connection);
  2. scrapes historical snapshots from the Wayback Machine (the same
     pages, archived across years — the union recovers ships that have
     since left the sale rotation; Wayback goes through the local
     proxy, default http://127.0.0.1:7890);
  3. merges everything into `generated` — a shipId → currency-tag map
     written into packages/webui/src/data/ship_sources.json WITHOUT
     touching the hand-curated sections (the coal/steel/event name
     arrays stay exactly as the maintainer left them).

Currency mapping: coal/steel/gold map 1:1; `eventum_*` (per-event
tokens) map to the event tag. Other currencies (paragon_xp,
recruitment_points, credits, real money) are recorded in the raw audit
dump but deliberately produce no tag — the picker's taxonomy has no
slot for them yet.

Usage:
    python scripts/scrape_armory_sources.py             # live + wayback
    python scripts/scrape_armory_sources.py --live-only # skip the archive
    python scripts/scrape_armory_sources.py --dry-run   # report, no write

The fetched pages are cached content-addressed under
scripts/.armory-cache/ (gitignored), so re-runs never re-download a
snapshot already on disk (unbounded retry loops are forbidden; each
fetch carries a hard byte cap).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / "packages/webui/src/data/ship_sources.json"
CACHE = Path(__file__).resolve().parent / ".armory-cache"

LOG = "[scrape-armory]"

# Live catalog regions (the locale path is arbitrary — /en/ everywhere).
LIVE_URLS = {
    "na": "https://armory.worldofwarships.com/en/",
    "eu": "https://armory.worldofwarships.eu/en/",
    "asia": "https://armory.worldofwarships.asia/en/",
}

# The catalog state is locale-independent, but Wayback's captures are
# indexed per locale path — query each and pool the timestamps.
WAYBACK_LOCALES = ["en", "de", "es", "fr", "pl", "pt", "tr", "cs", "ja", "ru", "th", "zh"]
WAYBACK_PAGE = "https://armory.worldofwarships.com/{locale}/"
WAYBACK_FETCH = "http://web.archive.org/web/{ts}id_/{url}"

# Hard caps — a snapshot page is ~2 MB; anything past this is a broken
# capture, not a catalog (large-download discipline: capped retries).
MAX_PAGE_BYTES = 8 * 1024 * 1024
FETCH_TIMEOUT = 90
RETRY_BUDGET = 3
WAYBACK_SLEEP_S = 3

DEFAULT_PROXY = "http://127.0.0.1:7890"

# Tag-mapped currencies; anything outside this set is recorded raw only.
CURRENCY_TAGS = {
    "coal": "coal",
    "steel": "steel",
    "gold": "gold",
}
EVENT_PREFIX = "eventum_"


def fetch(url: str, *, proxy: str | None, cache_key: str | None = None) -> bytes:
    """GET with a hard byte cap, bounded retries, and an optional
    content-addressed disk cache (a cached hit never touches the net)."""
    cache_path = CACHE / f"{cache_key}.html" if cache_key else None
    if cache_path is not None and cache_path.is_file():
        return cache_path.read_bytes()

    last_error: Exception | None = None
    for attempt in range(1, RETRY_BUDGET + 1):
        handler = urllib.request.ProxyHandler(
            {"http": proxy, "https": proxy} if proxy else {}
        )
        opener = urllib.request.build_opener(handler)
        req = urllib.request.Request(
            url, headers={"User-Agent": "wowsp-source-scraper/1 (maintainer tool)"}
        )
        try:
            with opener.open(req, timeout=FETCH_TIMEOUT) as resp:
                data = resp.read(MAX_PAGE_BYTES + 1)
            if len(data) > MAX_PAGE_BYTES:
                raise RuntimeError(f"{url}: response exceeds the {MAX_PAGE_BYTES} byte cap")
            if cache_path is not None:
                CACHE.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(data)
            return data
        except (urllib.error.URLError, OSError, RuntimeError) as e:  # noqa: PERF203
            last_error = e
            print(f"{LOG} fetch attempt {attempt} failed: {e}", file=sys.stderr)
            if attempt < RETRY_BUDGET:
                time.sleep(2 * attempt)
    raise RuntimeError(f"{url}: all {RETRY_BUDGET} attempts failed") from last_error


def parse_state(html: bytes) -> dict:
    """Pull the embedded catalog state out of an Armory page (live or
    archived — both embed the same `const _state = {...}` blob)."""
    text = html.decode("utf-8", errors="replace")
    marker = "const _state = "
    idx = text.find(marker)
    if idx < 0:
        raise ValueError("no embedded _state blob (page shape changed?)")
    obj, _ = json.JSONDecoder().raw_decode(text[idx + len(marker):])
    return obj


def ship_currencies(state: dict) -> dict[str, set[str]]:
    """shipId (str) → the set of RAW currencies it is purchasable for."""
    bundles = (state.get("content") or {}).get("bundles") or {}
    out: dict[str, set[str]] = {}
    for bundle in bundles.values() if isinstance(bundles, dict) else []:
        if not isinstance(bundle, dict):
            continue
        currency = bundle.get("currency")
        if not currency:
            continue
        for ent in bundle.get("entitlements") or []:
            if isinstance(ent, dict) and ent.get("type") == "ship" and ent.get("identifier"):
                out.setdefault(str(ent["identifier"]), set()).add(currency)
    return out


def scrape_live() -> tuple[dict[str, set[str]], list[str]]:
    merged: dict[str, set[str]] = {}
    regions: list[str] = []
    for region, url in LIVE_URLS.items():
        try:
            state = parse_state(fetch(url, proxy=None, cache_key=f"live-{region}"))
        except (RuntimeError, ValueError) as e:
            print(f"{LOG} live region {region} unavailable: {e}", file=sys.stderr)
            continue
        ships = ship_currencies(state)
        regions.append(region)
        print(f"{LOG} live {region}: {len(ships)} ships with prices")
        for ship_id, currencies in ships.items():
            merged.setdefault(ship_id, set()).update(currencies)
    return merged, regions


def scrape_wayback(
    *, proxy: str, per_year: int, max_snapshots: int, since: int
) -> tuple[dict[str, set[str]], int]:
    stamps: set[str] = set()
    for locale in WAYBACK_LOCALES:
        cdx_url = (
            "http://web.archive.org/cdx/search/cdx"
            f"?url=armory.worldofwarships.com/{locale}/"
            f"&output=json&filter=statuscode:200&collapse=timestamp:8"
            f"&from={since}&to=2026&fl=timestamp&limit=40"
        )
        try:
            rows = json.loads(
                fetch(cdx_url, proxy=proxy, cache_key=f"cdx-{locale}").decode()
            )
        except (RuntimeError, ValueError, json.JSONDecodeError) as e:
            print(f"{LOG} cdx {locale} unavailable: {e}", file=sys.stderr)
            continue
        stamps.update(row[0] for row in rows[1:])
    years: dict[str, list[str]] = {}
    for ts in sorted(stamps):
        years.setdefault(ts[:4], []).append(ts)
    picks: list[str] = []
    for year in sorted(years):
        ordered = sorted(years[year])
        step = max(1, len(ordered) // per_year)
        picks.extend(ordered[::step][:per_year])
    picks = sorted(picks)[-max_snapshots:]
    print(f"{LOG} wayback: {len(stamps)} captures, fetching {len(picks)}: {picks}")

    merged: dict[str, set[str]] = {}
    ok = 0
    for i, ts in enumerate(picks):
        url = WAYBACK_FETCH.format(ts=ts, url=WAYBACK_PAGE.format(locale="en"))
        try:
            html = fetch(url, proxy=proxy, cache_key=f"wb-{ts}")
            ships = ship_currencies(parse_state(html))
        except (RuntimeError, ValueError) as e:
            print(f"{LOG} snapshot {ts} unusable: {e}", file=sys.stderr)
            continue
        ok += 1
        print(f"{LOG} snapshot {ts}: {len(ships)} ships")
        for ship_id, currencies in ships.items():
            merged.setdefault(ship_id, set()).update(currencies)
        if i + 1 < len(picks):
            time.sleep(WAYBACK_SLEEP_S)
    return merged, ok


def tag_of(raw: str) -> str | None:
    if raw in CURRENCY_TAGS:
        return CURRENCY_TAGS[raw]
    if raw.startswith(EVENT_PREFIX):
        return "event"
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--live-only", action="store_true", help="skip Wayback history")
    ap.add_argument("--proxy", default=DEFAULT_PROXY, help="proxy for Wayback fetches")
    ap.add_argument("--no-proxy", action="store_true", help="fetch Wayback directly")
    ap.add_argument("--per-year", type=int, default=2, help="snapshots per year")
    ap.add_argument("--max-snapshots", type=int, default=24, help="total snapshot cap")
    ap.add_argument("--since", type=int, default=2019, help="first year to pull")
    ap.add_argument("--dry-run", action="store_true", help="report, do not write")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)

    live, regions = scrape_live()
    merged: dict[str, set[str]] = {k: set(v) for k, v in live.items()}
    history_count = 0
    if not args.live_only:
        historical, history_count = scrape_wayback(
            proxy=None if args.no_proxy else args.proxy,
            per_year=args.per_year,
            max_snapshots=args.max_snapshots,
            since=args.since,
        )
        for ship_id, currencies in historical.items():
            merged.setdefault(ship_id, set()).update(currencies)

    tagged: dict[str, list[str]] = {}
    unmapped: dict[str, list[str]] = {}
    for ship_id, currencies in merged.items():
        tags = sorted({t for c in currencies if (t := tag_of(c))})
        if tags:
            tagged[ship_id] = tags
        unknown = sorted(c for c in currencies if not tag_of(c))
        if unknown:
            unmapped[ship_id] = unknown
    print(
        f"{LOG} merged: {len(merged)} ships; tagged {len(tagged)} "
        f"(regions {regions}, history snapshots {history_count})"
    )
    per_tag = {
        tag: sum(1 for tags in tagged.values() if tag in tags)
        for tag in ("coal", "steel", "gold", "event")
    }
    print(f"{LOG} per tag: {per_tag}; unmapped-currency ships: {len(unmapped)}")

    if args.dry_run:
        return 0

    doc = json.loads(TARGET.read_text(encoding="utf-8"))
    doc["version"] = max(2, int(doc.get("version", 1)) + 1)
    doc["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc["generatedRegions"] = regions
    doc["generatedSnapshots"] = history_count
    doc["generated"] = {k: tagged[k] for k in sorted(tagged, key=int)}
    if unmapped:
        side = TARGET.with_name("ship_sources.raw.json")
        side.write_text(json.dumps(unmapped, indent=1) + "\n", encoding="utf-8")
        print(f"{LOG} raw unmapped currencies → {side.name} (audit only)")
    TARGET.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{LOG} wrote {TARGET.relative_to(REPO)} (v{doc['version']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
