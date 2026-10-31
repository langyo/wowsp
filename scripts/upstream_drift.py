#!/usr/bin/env python3
"""Upstream drift review for the in-tree game-assets fork (AGENTS.md §11).

WoWSP carries an in-tree fork of landaire/wows-toolkit's `wowsunpack` /
`wows-core` (packages/tools/game-assets{,-core}) with NO upstream sync:
upstream commits are reference, not authority. The flip side is that
upstream fixes never arrive by themselves — game-version adaptation
(GameParams / entitydef / idx / `.geometry` format changes for a new
client build) must be discovered and ported deliberately.

Usage:
  python scripts/upstream_drift.py                  review report
  python scripts/upstream_drift.py --mark-reviewed  advance the baseline
  python scripts/upstream_drift.py --since 2026-08-04   review a custom window
  python scripts/upstream_drift.py --self-test      offline fixtures

`just upstream-drift` wraps the same script. The baseline lives in
scripts/upstream_drift_state.json: the date (day precision, so the API
filter starts at 00:00:00Z) plus the sha of the newest recorded upstream
commit, for traceability.

All network access goes through the `gh` CLI against api.github.com —
this script performs no direct HTTP. The tool is advisory: every port /
skip decision belongs to the human reviewer.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = REPO_ROOT / "scripts" / "upstream_drift_state.json"

UPSTREAM_REPO = "landaire/wows-toolkit"
# (upstream crate under crates/, local fork package under packages/tools/)
FORK_CRATES = [
    ("wowsunpack", "packages/tools/game-assets"),
    ("wows-core", "packages/tools/game-assets-core"),
]
MAX_PAGES = 4  # pages of 100 commits per crate before the listing is "truncated"

# Title heuristics for the commit class §11 cares about: game-version
# adaptation and data-format work. Not verdicts — every listed commit gets
# a human disposition either way; these only decide the flag.
ADAPT_TITLE_PATTERNS = [
    (re.compile(r"\b1[0-9]\.\d{1,2}\b"), "game version reference (e.g. 15.9)"),
    (re.compile(r"gameparams", re.I), "GameParams"),
    (re.compile(r"entitydef", re.I), "entitydef"),
    (re.compile(r"\bidx\b", re.I), "idx"),
    (re.compile(r"\bpkg\b", re.I), "pkg"),
    (re.compile(r"pickle", re.I), "pickle"),
    (re.compile(r"geometry", re.I), ".geometry format"),
    (re.compile(r"\bvfs\b", re.I), "VFS"),
    (re.compile(r"\bbots?\b", re.I), "bot data"),
    (re.compile(r"\bconstants\b", re.I), "game constants"),
    (re.compile(r"\bentit(?:y|ies)\b", re.I), "entity data"),
    (re.compile(r"new (?:build|client|version)", re.I), "new client build"),
    (re.compile(r"\bunpack", re.I), "unpack"),
]

CARGO_VERSION = re.compile(r'^version\s*=\s*"([^"]+)"', re.M)


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def gh_api(endpoint: str, raw: bool = False) -> str:
    """Run `gh api` (repo-standard egress tool) and return stdout."""
    gh = shutil.which("gh")
    if gh is None:
        eprint(
            "error: gh CLI not found on PATH — install https://cli.github.com "
            "and run `gh auth login` first."
        )
        raise SystemExit(2)
    cmd = [gh, "api", endpoint]
    if raw:
        cmd += ["-H", "Accept: application/vnd.github.raw"]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        eprint(f"error: gh api {endpoint} failed:\n{proc.stderr.strip()}")
        raise SystemExit(2)
    return proc.stdout


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {
        "last_reviewed_date": "2026-08-04",
        "last_reviewed_sha": None,
        "last_reviewed_note": "vendor intake finalized 2026-08-03 (58d8fa19)",
    }


def save_state(state: dict) -> None:
    # Atomic write (temp + replace) so a killed process cannot leave a
    # truncated baseline behind.
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    tmp.replace(STATE_FILE)
    # Verify every write by re-read (repo convention for hand-edited state).
    if json.loads(STATE_FILE.read_text(encoding="utf-8")) != state:
        eprint(f"error: state file re-read mismatch: {STATE_FILE}")
        raise SystemExit(2)


def fetch_commits(since: str, max_pages: int) -> tuple[list[dict], bool]:
    """Commits touching either forked upstream crate, newest first.

    Returns (commits, truncated). Each commit dict carries `crates`: the
    forked crates it touched. The commits API has day-precision `since`
    filtering (inclusive), so the state stores the day AFTER the last
    reviewed commit as the baseline and the filter starts at 00:00:00Z of
    that date.
    """
    per_page = 100
    by_sha: dict[str, dict] = {}
    truncated = False
    for upstream_crate, _ in FORK_CRATES:
        for page in range(1, max_pages + 1):
            endpoint = (
                f"repos/{UPSTREAM_REPO}/commits?path=crates/{upstream_crate}"
                f"&since={since}T00:00:00Z&per_page={per_page}&page={page}"
            )
            payload = gh_api(endpoint)
            try:
                batch = json.loads(payload)
            except json.JSONDecodeError as exc:
                eprint(f"error: gh api returned non-JSON for {endpoint}: {exc}")
                raise SystemExit(2)
            for entry in batch:
                record = by_sha.setdefault(entry["sha"], {**entry, "crates": []})
                record["crates"].append(upstream_crate)
            if len(batch) < per_page:
                break
            if page == max_pages:
                truncated = True
    commits = sorted(
        by_sha.values(),
        key=lambda c: c["commit"]["committer"]["date"],
        reverse=True,
    )
    return commits, truncated


def classify(commit: dict) -> tuple[str, list[str]]:
    title = (commit.get("commit", {}).get("message") or "").splitlines()[0]
    reasons = [label for pattern, label in ADAPT_TITLE_PATTERNS if pattern.search(title)]
    return ("adapt" if reasons else "info"), reasons


def version_drift() -> list[dict]:
    rows = []
    for upstream_crate, local_dir in FORK_CRATES:
        upstream_toml = gh_api(
            f"repos/{UPSTREAM_REPO}/contents/crates/{upstream_crate}/Cargo.toml",
            raw=True,
        )
        local_toml = (REPO_ROOT / local_dir / "Cargo.toml").read_text(encoding="utf-8")
        upstream_version = CARGO_VERSION.search(upstream_toml)
        local_version = CARGO_VERSION.search(local_toml)
        rows.append(
            {
                "crate": upstream_crate,
                "local": local_dir,
                "local_version": local_version.group(1) if local_version else None,
                "upstream_version": upstream_version.group(1) if upstream_version else None,
            }
        )
    return rows


def print_report(
    state: dict, commits: list[dict], truncated: bool, rows: list[dict]
) -> None:
    print("game-assets upstream drift review")
    print(f"  baseline : {state['last_reviewed_date']} (sha {state['last_reviewed_sha']})")
    print(f"  note     : {state.get('last_reviewed_note', '-')}")
    print()
    print("crate version drift:")
    for row in rows:
        marker = "" if row["local_version"] == row["upstream_version"] else "  <- drift"
        print(
            f"  {row['crate']:<12} local {row['local_version']}   "
            f"upstream {row['upstream_version']}{marker}"
        )
    print()
    crates_shown = " + ".join(f"crates/{c}" for c, _ in FORK_CRATES)
    if truncated:
        eprint(
            f"warning: listing truncated at {MAX_PAGES} pages per crate — "
            "raise --max-pages for a complete window."
        )
    print(f"upstream commits since {state['last_reviewed_date']} touching {crates_shown}: {len(commits)}")
    print()
    if not commits:
        print("  (nothing to review — run --mark-reviewed to advance the baseline)")
        return
    adapt_count = 0
    for commit in commits:
        klass, reasons = classify(commit)
        if klass == "adapt":
            adapt_count += 1
        sha = commit["sha"][:12]
        commit_date = commit["commit"]["committer"]["date"][:10]
        title = commit["commit"]["message"].splitlines()[0][:100]
        crates_tag = "+".join(commit["crates"])
        flag = "adapt" if klass == "adapt" else "info "
        print(f"  [{flag}] {commit_date} {sha} [{crates_tag}] {title}")
        if reasons:
            print(f"             reasons: {', '.join(reasons)}")
    print()
    print(f"disposition needed: {adapt_count} flagged / {len(commits)} total")
    print("  Port flagged commits into packages/tools/game-assets{,-core} via a")
    print("  normal PR (or record why they do not apply in the PR description);")
    print("  where the fork already fixed the same problem on its own, verify the")
    print("  implementations agree instead of blindly re-porting. Then close the")
    print("  review in the same PR:")
    print("    python scripts/upstream_drift.py --mark-reviewed")


def mark_reviewed(commits: list[dict], truncated: bool) -> None:
    if truncated:
        eprint(
            "error: refusing to advance the baseline over a truncated commit "
            "listing — raise --max-pages and re-run first."
        )
        raise SystemExit(2)
    if commits:
        newest = commits[0]
        new_state = {
            "last_reviewed_date": newest["commit"]["committer"]["date"][:10],
            "last_reviewed_sha": newest["sha"],
            "last_reviewed_note": "reviewed via upstream_drift.py --mark-reviewed",
        }
    else:
        new_state = {
            "last_reviewed_date": date.today().isoformat(),
            "last_reviewed_sha": None,
            "last_reviewed_note": "reviewed: no upstream commits in window",
        }
    save_state(new_state)
    print(
        f"baseline advanced to {new_state['last_reviewed_date']} "
        f"(sha {new_state['last_reviewed_sha']}) — written to {STATE_FILE.name}"
    )


def self_test() -> int:
    def title_of(message: str) -> dict:
        return {"commit": {"message": message, "committer": {"date": "2026-01-01T00:00:00Z"}}}

    fixtures = [
        # (title, expect_class, expect_at_least_one_reason)
        ("Fix 15.9 ship config abilities and pre 15.9 bots", "adapt", True),
        ("Parse the FLOAT64 rpc type so ship export survives new builds", "adapt", True),
        ("Allow constants data to override indices for bot/player info", "adapt", True),
        # the crate name in a conventional-commit scope must not trip the
        # "unpack" keyword (2026-10-31 live-run false positive)
        ("perf(wowsunpack): hold the VFS index paths in one buffer", "adapt", True),
        ("perf(wowsunpack): release the params vector's in-place-collect slack", "info", False),
        # entity data work is fork-relevant (game-assets rpc/entitydefs.rs)
        ("fix: fix some entity-related packet fields + parse more BigWorld protocol info", "adapt", True),
        ("Correct inspector icon and selected control styling", "info", False),
        ("Configure GPUI beta releases for 1.1.0-beta1", "info", False),
        ("Fix CI lint and test failures", "info", False),
    ]
    for message, want_klass, want_reasons in fixtures:
        klass, reasons = classify(title_of(message))
        if klass != want_klass or bool(reasons) != want_reasons:
            print(f"self-test FAILED: {message!r} -> {klass} {reasons}", file=sys.stderr)
            return 1
    local = CARGO_VERSION.search('name = "wowsunpack"\nversion = "0.46.0"\n')
    if not local or local.group(1) != "0.46.0":
        print("self-test FAILED: Cargo.toml version regex", file=sys.stderr)
        return 1
    print(f"self-test: {len(fixtures) + 1} fixtures passed")
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--since",
        metavar="YYYY-MM-DD",
        help="override the reviewed baseline date for this run (not persisted)",
    )
    parser.add_argument(
        "--mark-reviewed",
        action="store_true",
        help="advance the baseline to the newest listed commit (writes the state file)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--self-test", action="store_true", help="offline fixtures, no network")
    parser.add_argument(
        "--max-pages",
        type=int,
        default=MAX_PAGES,
        help=f"max pages of 100 commits per crate (default {MAX_PAGES})",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    state = load_state()
    baseline = args.since or state["last_reviewed_date"]
    commits, truncated = fetch_commits(baseline, args.max_pages)
    if args.mark_reviewed:
        mark_reviewed(commits, truncated)
        if args.json:
            print(
                json.dumps(
                    {"marked": load_state(), "commits_reviewed": len(commits)},
                    indent=2,
                    ensure_ascii=False,
                )
            )
        return 0

    rows = version_drift()
    if args.json:
        print(
            json.dumps(
                {
                    "baseline": baseline,
                    "truncated": truncated,
                    "versions": rows,
                    "commits": [
                        {
                            "sha": commit["sha"],
                            "date": commit["commit"]["committer"]["date"][:10],
                            "title": commit["commit"]["message"].splitlines()[0],
                            **dict(zip(("class", "reasons"), classify(commit))),
                            "crates": commit["crates"],
                        }
                        for commit in commits
                    ],
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0

    print_report({**state, "last_reviewed_date": baseline}, commits, truncated, rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
