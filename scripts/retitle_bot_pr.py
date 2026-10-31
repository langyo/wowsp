#!/usr/bin/env python3
"""Normalize bot PR titles so the squash subject complies (AGENTS.md §1).

A squash merge turns the PR title into the master commit subject, so a bot
PR must not dodge the subject rules through the reusable lint's bot-author
exemption. dependabot titles ("Bump x from y to z", "Update x requirement
from ^a to ^b") are rewritten to the compliant "⬆️ <title>." form and
validated with the authoritative linter; any other bot title the rewriter
cannot express fails the run instead of silently landing a non-compliant
squash subject.

Usage:
  python scripts/retitle_bot_pr.py --pr 123        fetch, rewrite, validate
  python scripts/retitle_bot_pr.py --title "..."   offline rewrite+validate
  python scripts/retitle_bot_pr.py --self-test     offline fixtures

Network access goes through the `gh` CLI (api.github.com); no direct HTTP.
Non-bot PRs are a no-op here — the reusable lint owns their validation.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import commit_msg_lint  # noqa: E402  (authoritative subject linter, same dir)

BOT_SUFFIX = "[bot]"
DEPENDABOT_TITLE = re.compile(r"^(Bump|Update)\b")
# "Bump <pkg> from <a> to <b>[ in <dir>]" — the single-package bump form.
BUMP_FORM = re.compile(
    r"^Bump\s+(?P<pkg>\S+)\s+from\s+\S+\s+to\s+(?P<version>\S+?)"
    r"(?P<dir>\s+in\s+\S+?)?\s*\.?\s*$"
)
# "Update <pkg> requirement from <a> to <b>[ in <dir>]" — the lockfile-refresh form.
UPDATE_REQ_FORM = re.compile(
    r"^Update\s+(?P<pkg>.+?)\s+requirement\s+from\s+\S+\s+to\s+(?P<version>\S+?)"
    r"(?P<dir>\s+in\s+\S+?)?\s*\.?\s*$"
)


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def gh(*args: str) -> str:
    gh_bin = shutil.which("gh")
    if gh_bin is None:
        eprint("error: gh CLI not found on PATH — install https://cli.github.com")
        raise SystemExit(2)
    proc = subprocess.run(
        [gh_bin, *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        eprint(f"error: gh {' '.join(args[:2])} failed:\n{proc.stderr.strip()}")
        raise SystemExit(2)
    return proc.stdout


def compliant(title: str) -> bool:
    return not commit_msg_lint.lint(title)


def _dir_suffix(dir_part: str | None) -> str:
    """' in /packages/webui' -> ' in the webui package' (the house style)."""
    if not dir_part:
        return ""
    path = dir_part.strip().removeprefix("in").strip()
    known = re.match(r"^/packages/([A-Za-z0-9_.-]+)$", path)
    if known:
        return f" in the {known.group(1)} package"
    return f" in {path}"


def rewrite(title: str) -> str | None:
    """The compliant "⬆️ Move ..." form for a dependabot title, else None.

    Rule 4 bans filler-phrase starts ("Bump ...", "Update ..."), so the
    rewrite mirrors the house style the four manually-retitled bot PRs used:
    "⬆️ Move <pkg> to <version> in the webui package.". A None return means
    the title is not a dependency bump the rewriter can express — the caller
    must fail rather than guess a type.
    """
    if not DEPENDABOT_TITLE.match(title):
        return None
    bump = BUMP_FORM.match(title)
    if bump:
        candidate = (
            f"⬆️ Move {bump['pkg']} to {bump['version']}"
            f"{_dir_suffix(bump['dir'])}."
        )
    else:
        update_req = UPDATE_REQ_FORM.match(title)
        if update_req:
            candidate = (
                f"⬆️ Move the {update_req['pkg']} requirement to {update_req['version']}"
                f"{_dir_suffix(update_req['dir'])}."
            )
        else:
            # Group bumps ("Bump the npm_and_yarn group across 1 directory
            # with 3 updates") and other shapes: keep the description, swap
            # the banned filler verb for the house verb.
            candidate = "⬆️ Move " + re.sub(r"^(Bump|Update)\s+", "", title).rstrip(".") + "."
    return candidate if compliant(candidate) else None


def process_title(title: str) -> int:
    if compliant(title):
        print(f"already compliant: {title}")
        return 0
    candidate = rewrite(title)
    if candidate is None:
        eprint(
            f"error: bot PR title cannot be normalized automatically:\n"
            f"  {title}\n"
            "Retitle the PR by hand to '<gitmoji> <one-line English.>' "
            "(AGENTS.md §1), then re-run."
        )
        return 1
    print(f"retitled: {title!r}\n     ->    {candidate!r}")
    if not compliant(candidate):
        eprint(f"error: rewritten title still fails the linter: {candidate}")
        return 1
    return 0


def run_for_pr(number: str) -> int:
    payload = json.loads(gh("pr", "view", number, "--json", "author,title"))
    author = payload["author"]["login"]
    title = payload["title"]
    if not author.endswith(BOT_SUFFIX):
        print(f"PR #{number} author {author} is not a bot — nothing to do")
        return 0
    if compliant(title):
        print(f"PR #{number} title is already compliant: {title}")
        return 0
    candidate = rewrite(title)
    if candidate is None:
        eprint(
            f"error: bot PR title cannot be normalized automatically:\n"
            f"  {title}\n"
            "Retitle the PR by hand to '<gitmoji> <one-line English.>' "
            "(AGENTS.md §1), then re-run."
        )
        return 1
    gh("pr", "edit", number, "--title", candidate)
    final = json.loads(gh("pr", "view", number, "--json", "title"))["title"]
    if not compliant(final):
        eprint(f"error: PR #{number} title after edit still fails the linter: {final}")
        return 1
    print(f"retitled PR #{number}: {title!r} -> {final!r}")
    return 0


def self_test() -> int:
    fixtures = [
        # (title, expected rewrite; None = not expressible)
        ("Bump reqwest from 0.13.4 to 0.13.5", "⬆️ Move reqwest to 0.13.5."),
        ("Update malkuth requirement from ^0.1 to ^0.2", "⬆️ Move the malkuth requirement to ^0.2."),
        ("Bump vite from 6.4.3 to 8.2.1 in /packages/webui", "⬆️ Move vite to 8.2.1 in the webui package."),
        ("Bump @vitejs/plugin-vue from 6.0.8 to 6.0.9 in /packages/webui", "⬆️ Move @vitejs/plugin-vue to 6.0.9 in the webui package."),
        ("Bump actions/checkout from 4 to 5", "⬆️ Move actions/checkout to 5."),
        # a pre-titled period must not survive or double up
        ("Bump reqwest from 0.13.4 to 0.13.5.", "⬆️ Move reqwest to 0.13.5."),
        # group-bump shapes fall back to the generic verb swap
        ("Bump the npm_and_yarn group across 1 directory with 3 updates", "⬆️ Move the npm_and_yarn group across 1 directory with 3 updates."),
        # conventional-commit style bot titles are not expressible here
        ("feat: bump something", None),
        ("chore(deps): bump yaml", None),
    ]
    for title, want in fixtures:
        got = rewrite(title)
        if got != want:
            print(f"self-test FAILED: {title!r} -> {got!r} (want {want!r})", file=sys.stderr)
            return 1
    if not compliant("⬆️ Move reqwest to 0.13.5."):
        print("self-test FAILED: the rewritten form must pass the linter", file=sys.stderr)
        return 1
    if compliant("Bump reqwest from 0.13.4 to 0.13.5"):
        print("self-test FAILED: the raw dependabot form must fail the linter", file=sys.stderr)
        return 1
    print(f"self-test: {len(fixtures) + 2} fixtures passed")
    return 0


def main() -> int:
    # Keep the emoji-bearing output intact on Windows consoles (cp936 etc.);
    # mirrors scripts/upstream_drift.py.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pr", metavar="NUMBER", help="normalize PR NUMBER's title in place")
    group.add_argument("--title", metavar="TEXT", help="offline: show the rewrite for TEXT")
    group.add_argument("--self-test", action="store_true", help="offline fixtures, no network")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.title is not None:
        return process_title(args.title)
    return run_for_pr(args.pr)


if __name__ == "__main__":
    sys.exit(main())
