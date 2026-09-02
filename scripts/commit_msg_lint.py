#!/usr/bin/env python3
"""Commit-message linter enforcing the gitmoji convention (AGENTS.md §1).

Faithful port of celestia-devtools `commit_msg.py` (the org CI linter) so
this repository carries its own authoritative implementation; the whitelist
and rules below are kept in sync with the upstream source.

Rules (applied to the subject line — first line of the commit message):

1.  Must start with a gitmoji from gitmoji.dev (plus the org additions
    🔗 🔄 📜 🛡️).
2.  Must NOT use Conventional Commits prefixes (``feat:``, ``fix:``, etc.) —
    the emoji **is** the type marker.
3.  First letter after the emoji must be uppercase (``[A-Z]``).
4.  Must NOT start with a bare version number or filler phrase (``v1.2.3``,
    ``bump version``, ``update to``, etc.).
5.  Must end with a period (``.``).
6.  Must be English-only (no CJK characters or wide punctuation).
7.  Must NOT use a colon-prefix subject (``Topic phrase: details``) — even
    with a capitalized leading phrase like ``Fix compliance: ...``; write
    one plain sentence instead.

Exemptions (checked before rules):
-  ``Revert ...`` (git revert).

Merge subjects (``Merge branch ...`` / ``Merge pull request ...``) are
**rejected**: this repository uses squash merges only, so a merge-commit
subject is a violation, not an exemption.

The ``lint()`` function returns a list of violation strings; an empty list
means the message passes all rules.
"""

from __future__ import annotations

import argparse
import re
import sys
from typing import List

# ── gitmoji.dev canonical emoji set ───────────────────────────────────────────
# Sourced from https://gitmoji.dev.  Each entry is the raw emoji character
# (including variation selectors and ZWJ sequences where applicable).  The
# lookup is `subject.startswith(emoji)`, so multi-codepoint emoji work
# correctly without decoding.
GITMOJI_WHITELIST: frozenset[str] = frozenset([
    "\U0001f3a8",        # 🎨 :art:
    "\u26a1\ufe0f",      # ⚡️ :zap:
    "\u26a1",            # ⚡ :zap (without variation selector)
    "\U0001f525",        # 🔥 :fire:
    "\U0001f41b",        # 🐛 :bug:
    "\U0001f691",        # 🚑 :ambulance:
    "\u2728",            # ✨ :sparkles:
    "\U0001f4dd",        # 📝 :memo:
    "\U0001f680",        # 🚀 :rocket:
    "\U0001f484",        # 💄 :lipstick:
    "\U0001f389",        # 🎉 :tada:
    "\u2705",            # ✅ :white_check_mark:
    "\U0001f512",        # 🔒 :lock:
    "\U0001f516",        # 🔖 :bookmark:
    "\U0001f517",        # 🔗 :link (org: symlink/copilot)
    "\U0001f6a8",        # 🚨 :rotating_light:
    "\U0001f6a7",        # 🚧 :construction:
    "\U0001f49a",        # 💚 :green_heart:
    "\u2b07\ufe0f",      # ⬇️ :arrow_down:
    "\u2b06\ufe0f",      # ⬆️ :arrow_up:
    "\U0001f4cc",        # 📌 :pushpin:
    "\U0001f477",        # 👷 :construction_worker:
    "\U0001f4c8",        # 📈 :chart_with_upwards_trend:
    "\u267b\ufe0f",      # ♻️ :recycle:
    "\u2795",            # ➕ :heavy_plus_sign:
    "\u2796",            # ➖ :heavy_minus_sign:
    "\U0001f527",        # 🔧 :wrench:
    "\U0001f528",        # 🔨 :hammer:
    "\U0001f310",        # 🌐 :globe_with_meridians:
    "\u270f\ufe0f",      # ✏️ :pencil2:
    "\U0001f4a9",        # 💩 :poop:
    "\u23ea",            # ⏪ :rewind:
    "\U0001f500",        # 🔀 :twisted_rightwards_arrows:
    "\U0001f504",        # 🔄 :counterclockwise_arrows_button (org: sync/refresh)
    "\U0001f4e6",        # 📦 :package:
    "\U0001f47d",        # 👽 :alien:
    "\U0001f69a",        # 🚚 :truck:
    "\U0001f4c4",        # 📄 :page_facing_up:
    "\U0001f4a5",        # 💥 :boom:
    "\U0001f371",        # 🍱 :bento:
    "\u267f\ufe0f",      # ♿️ :wheelchair:
    "\U0001f4a1",        # 💡 :bulb:
    "\U0001f37b",        # 🍻 :beers:
    "\U0001f4ac",        # 💬 :speech_balloon:
    "\U0001f5c3\ufe0f",  # 🗃️ :card_file_box:
    "\U0001f50a",        # 🔊 :loud_sound:
    "\U0001f507",        # 🔇 :mute:
    "\U0001f465",        # 👥 :busts_in_silhouette:
    "\U0001f6b8",        # 🚸 :children_crossing:
    "\U0001f3d7\ufe0f",  # 🏗️ :building_construction:
    "\U0001f4f1",        # 📱 :iphone:
    "\U0001f921",        # 🤡 :clown_face:
    "\U0001f95a",        # 🥚 :egg:
    "\U0001f648",        # 🙈 :see_no_evil:
    "\U0001f4f8",        # 📸 :camera_flash:
    "\u2697\ufe0f",      # ⚗️ :alembic:
    "\U0001f50d",        # 🔍 :mag:
    "\U0001f3f7\ufe0f",  # 🏷️ :label:
    "\U0001f331",        # 🌱 :seedling:
    "\U0001f6a9",        # 🚩 :triangular_flag_on_post:
    "\U0001f945",        # 🥅 :goal_net:
    "\U0001f4ab",        # 💫 :dizzy:
    "\U0001f5d1\ufe0f",  # 🗑️ :wastebasket:
    "\U0001f6c2",        # 🛂 :passport_control:
    "\U0001fa79",        # 🩹 :adhesive_bandage:
    "\U0001f9d0",        # 🧐 :monocle_face:
    "\u26b0\ufe0f",      # ⚰️ :coffin:
    "\U0001f9ea",        # 🧪 :test_tube:
    "\U0001f454",        # 👔 :necktie:
    "\U0001fa7a",        # 🩺 :stethoscope:
    "\U0001f9f1",        # 🧱 :bricks:
    "\U0001f9d1\u200d\U0001f4bb",  # 🧑‍💻 :technologist:
    "\U0001f4b8",        # 💸 :money_with_wings:
    "\U0001f9f5",        # 🧵 :thread:
    "\U0001f9ba",        # 🦺 :safety_vest:
    "\U0001f4dc",        # 📜 :scroll (org: license)
    "\U0001f6e1\ufe0f",  # 🛡️ :shield (org)
])

# ── Regexes (compiled once) ──────────────────────────────────────────────────

# Conventional Commits prefix: feat, fix, chore, docs, style, refactor, perf,
# test, build, ci, revert, net, init — with optional scope parens.
_CONVENTIONAL_PREFIX_RE = re.compile(
    r"^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert|net|init)"
    r"(?:\([^)]*\))?\s*[:!]",
)

# Colon-prefix subject ("Topic phrase: details"). Forbidden even when the
# leading phrase is capitalized, e.g. "Fix compliance: ..." or
# "Audit round 23: ...". The character immediately before the colon must be a
# letter/digit so code tokens like "Support :is()" or timestamps such as
# "09:34Z" are not false positives.
_COLON_PREFIX_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9 ._/-]{0,60}[A-Za-z0-9._/-]:\s",
)

# Leading bare version number or filler phrases (after gitmoji and space).
_VERSION_OR_FILLER_START_RE = re.compile(
    r"^(?:v?\d+\.\d+(?:\.\d+)*|bump\s|update\sto\b|upgrade\sto\b|downgrade\s)",
    re.IGNORECASE,
)

# CJK and full-width characters (Chinese, Japanese, Korean, etc.).
_CJK_RE = re.compile(r"[\u2e80-\u2eff\u3000-\u303f\u31c0-\u31ef\u3200-\u32ff"
                     r"\u3300-\u33ff\u3400-\u4dbf\u4e00-\u9fff"
                     r"\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]")

# First English letter position (used for capital-letter check).
_FIRST_ALPHA_RE = re.compile(r"[A-Za-z]")

# Trailing period on the subject line.
_ENDS_WITH_PERIOD_RE = re.compile(r"\.\s*$")

# ── Helpers ──────────────────────────────────────────────────────────────────

def _first_line(text: str) -> str:
    """Return the subject line (up to first newline, stripped)."""
    return text.split("\n", 1)[0].rstrip()


def _has_any_gitmoji_prefix(subject: str) -> bool:
    """Check whether *subject* starts with any emoji in the whitelist."""
    for emoji in GITMOJI_WHITELIST:
        if subject.startswith(emoji):
            return True
    return False


def _trim_gitmoji(subject: str) -> str:
    """Strip the leading gitmoji and any whitespace from the subject."""
    for emoji in GITMOJI_WHITELIST:
        if subject.startswith(emoji):
            return subject[len(emoji):].lstrip()
    return subject


# ── Public API ───────────────────────────────────────────────────────────────

def lint(subject: str, *, allow_cjk: bool = False) -> List[str]:
    """Validate a single commit-message subject line.

    Returns a list of violation descriptions.  An empty list means the message
    passes all rules.  The check is designed to be safe to call from hooks and
    CI — it never raises.
    """
    violations: List[str] = []

    # Treat empty or whitespace-only subjects as a hard violation.
    if not subject or not subject.strip():
        violations.append("commit message is empty")
        return violations

    # Exemption: git-revert commits (git revert produces "Revert ...").
    if subject.startswith("Revert "):
        return []

    # Merge subjects are banned: this repository uses squash merges only.
    if subject.startswith("Merge "):
        violations.append(
            "merge-commit subjects are forbidden; use squash merge"
        )
        return violations

    # Rule 1 — gitmoji prefix.
    if not _has_any_gitmoji_prefix(subject):
        violations.append(
            "must start with a gitmoji (https://gitmoji.dev); "
            "e.g. '🐛 Fix the parser crash.'"
        )
        return violations  # remaining rules depend on correct prefix

    # Text after the gitmoji.
    tail = _trim_gitmoji(subject)

    # Rule 2 — no Conventional Commits prefix.
    if _CONVENTIONAL_PREFIX_RE.match(tail):
        violations.append(
            "must NOT use a Conventional Commits prefix (feat:/fix:/chore:/etc.); "
            "the emoji is the type marker"
        )

    # Rule 7 — no colon-prefix subject.
    if _COLON_PREFIX_RE.match(tail):
        violations.append(
            "must NOT use a colon-prefix subject (e.g. 'Fix compliance: ...', "
            "'Audit round 23: ...'); write one plain sentence instead"
        )

    # Rule 3 — first letter after emoji must be uppercase.
    alpha = _FIRST_ALPHA_RE.search(tail)
    if alpha is not None:
        if not alpha.group()[0].isupper():
            violations.append(
                "first letter after the emoji must be uppercase; "
                f"found lowercase '{alpha.group()}'"
            )
    elif not allow_cjk:
        violations.append("summary must contain at least one English letter")

    # Rule 4 — no version-number / filler start.
    if _VERSION_OR_FILLER_START_RE.match(tail):
        violations.append(
            "must NOT start with a bare version number or filler phrase "
            "(e.g. '0.3', 'Bump version', 'Update to'); "
            "describe the change instead"
        )

    # Rule 5 — trailing period.
    # 🔄 sync/refresh messages often carry timestamp metadata in parens, so
    # the period requirement is relaxed for them.
    if allow_cjk:
        pass  # CJK summaries may end in Chinese punctuation or none
    elif subject.startswith("\U0001f504"):
        pass  # 🔄 — exempt from period rule
    else:
        # Strip GitHub squash merge PR reference " (#123)" before checking.
        pr_stripped = re.sub(r'\s*\(#\d+\)\s*$', '', subject)
        if not _ENDS_WITH_PERIOD_RE.search(pr_stripped):
            violations.append("must end with a period (.)")

    # Rule 6 — English-only (no CJK).
    cjk = _CJK_RE.search(subject)
    if cjk is not None and not allow_cjk:
        violations.append(
            f"must be English-only; found CJK character "
            f"'{cjk.group()}' at position {cjk.start()}"
        )

    return violations


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    """CLI entry point (mirrors the upstream celestia-devtools subcommand)."""
    parser = argparse.ArgumentParser(
        prog="commit_msg_lint",
        description="Validate commit messages against the gitmoji convention.",
    )
    sub = parser.add_subparsers(dest="subcmd")

    # check <file>
    p_check = sub.add_parser("check", help="validate a commit message")
    p_check.add_argument(
        "file", nargs="?", default=None,
        help="path to the commit message file (as passed by git to the hook; $1)",
    )
    p_check.add_argument(
        "--subject", default=None,
        help="validate a literal subject string instead of a file",
    )
    p_check.add_argument(
        "--stdin-subjects", action="store_true",
        help="read subjects from stdin (one per line) for batch CI validation",
    )
    p_check.add_argument(
        "--allow-cjk", action="store_true",
        help="allow CJK in commit subjects (kept for parity with upstream)",
    )

    args = parser.parse_args()

    if not args.subcmd:
        parser.print_help()
        return 2

    subjects: List[str] = []

    if args.subject is not None:
        subjects.append(args.subject)
    elif args.stdin_subjects:
        raw = sys.stdin.read()
        subjects = [line.strip() for line in raw.splitlines() if line.strip()]
    elif args.file is not None:
        try:
            raw = open(args.file, encoding="utf-8").read()
        except OSError as exc:
            print(f"error: cannot read {args.file}: {exc}", file=sys.stderr)
            return 2
        subjects.append(_first_line(raw))
    else:
        print("error: either FILE, --subject, or --stdin-subjects required",
              file=sys.stderr)
        return 2

    errors: List[str] = []
    for subject in subjects:
        violations = lint(subject, allow_cjk=args.allow_cjk)
        if violations:
            errors.append(subject)
            for v in violations:
                errors.append(f"  - {v}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(
            "\nCommit message format:  <gitmoji> <Capitalized English summary.>\n"
            "Examples:\n"
            "  ✅ 🐛 Fix the parser crash.\n"
            "  ✅ ✨ Add distributed tracing support.\n"
            "  ❌ fix: broken thing\n"
            "  ❌ 🐛 修复解析器\n",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
