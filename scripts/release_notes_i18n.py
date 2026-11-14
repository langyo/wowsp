#!/usr/bin/env python3
"""
Internationalized GitHub release notes: English bodies plus a JSON asset.

The release BODY is plain English markdown (the categorized notes GitHub
generates: "## What's Changed", category headings, PR bullets, the Full
Changelog link). The seven translations live OUTSIDE the body, in one
release ASSET per release:

    release-notes-i18n-<tag>.json

    {
      "schema": 1,
      "tag": "v0.6.9",
      "generated_at": "2026-11-08T00:00:00Z",
      "sections": {
        "zh-CN": "## 更新内容\n...",
        ... zh-TW, ja-JP, ko-KR, ru-RU, fr-FR, es-ES ...
      }
    }

The app fetches the asset for the user's locale (Rust
commands/changelog.rs::changelog_i18n through the GitHub mirror ladder; the
webui renders the section through ReleaseMarkdown) and falls back to the
English body with a hint while a section is still the canonical 🚧
placeholder or the asset is unavailable. GitHub web shows the English body
only; the asset is the translation channel. Why: the release body has a hard
125,000-character GitHub limit, and a full seven-locale body-scaffold no
longer fits (v0.6.9: the en-US body alone was 34.6k chars, the seven
translations ~260k).

This script is the FORMAT AUTHORITY for both the asset JSON and the LEGACY
v1 body scaffold (older release bodies still carry it; the TS parser
packages/webui/src/utils/releaseI18n.ts mirrors both and its fixtures stay
in agreement with the self-test command). Translations travel as files
OUTSIDE the git tree, never as tracked repository files (AGENTS.md
section 2 / section 10).

ASSET RULES (lint-enforced; A* hard unless marked):
  A1  asset name is release-notes-i18n-<tag>.json, attached to the same
      release as the tag.
  A2  schema == 1 and tag == the release tag.
  A3  sections keys == every supported locale except en-US (read live from
      packages/webui/src/i18n/index.ts SUPPORTED_LOCALES) - no missing,
      extra or duplicate locale. Content is markdown, not HTML.
  A4  a section never smuggles the body-scaffold delimiters: no
      "<details"/"</details>" (any case/spacing) and no reserved
      "<!-- wowsp:" marker.
  A5  translations stick to the ReleaseMarkdown renderer subset
      (packages/webui/src/components/settings/ReleaseMarkdown.tsx):
      "#{1,6} " headings, "-" / "*" / "+" bullets, plain paragraphs,
      **bold** and [label](url) inline. Forbidden: fenced code,
      blockquotes, ordered lists, images, tables, hr lines, >=4-space
      indents.
  A6  URL preservation: every URL appearing in the English body must
      appear in each translation at least as many times.
  A7  no JS-stringification litter ("[object Object]" and friends) in any
      section - a translation-pipeline bug, the 2026-10-31 v0.6.8
      incident.
  A8  soft: a section whose content equals the canonical per-locale
      placeholder is PENDING - allowed, tracked by the rolling
      translation issue (issue-sync). Untranslated == untranslated.
  A9  soft: a section that leaves at least half of the English PR bullet
      lines byte-identical is flagged as partially untranslated. The
      policy (since the 2026-11-14 v0.6.9/v0.6.10 retrofit) is that PR
      bullet TITLES are translated too; the [#NNNN](url) link, the emoji,
      every URL and the Full Changelog line stay verbatim.

BODY RULES:
  B1  hard: the body is English markdown; it never carries the legacy i18n
      markers/delimiters. Empty bodies fail.
  B2  soft: a LEGACY v1 body scaffold is accepted as a warning (older
      clients understand it; the migration to English bodies happened on
      2026-11-08). pack still extracts its en-US section.

LEGACY v1 BODY GRAMMAR (parsed for old releases / old clients only):
    <!-- wowsp:i18n v1 -->
    <details open>
    <summary>🌐 English (en-US)</summary>
    ...
    <details> ... one collapsed section per locale ...
The v1 S-rules (section order, opener/summary/marker shapes,
raw-HTML/litter split, renderer subset, URL preservation) remain enforced
for legacy bodies exactly as the TS parser expects.

COMMANDS
  pack    [--tag T] [--upload]  build the release's JSON asset from the
                                English body (missing sections become the
                                canonical placeholders; an existing asset's
                                translations are preserved) and optionally
                                upload it with gh
  set     [--tag T] --lang L --file F [--apply]
                                replace locale L's section in the JSON
                                asset (validates A2-A7, warns on A9); creates
                                the asset from the English body when none
                                exists yet
  show    [--tag T]              per-release, per-locale asset status table
  lint    [--tag T] [--assets]  B1/B2 over the bodies (the CI gate), plus
                                A1-A9 over the assets with --assets (A8/A9
                                are soft; they never fail the lint)
  issue-sync                    upsert/close the rolling "pending
                                translations" tracking issue from the assets
  glossary                      canonical heading translations for translators
  self-test                     hermetic fixture suite over both formats

Everything gh-backed honors GH_REPO (release.yml sets it); locally the repo
is resolved from GH_REPO, the checkout's origin remote, or gh repo view (in
that order). Requires python 3.10+ and the gh CLI.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

# Windows consoles default to a legacy codepage (gbk/cp936) that cannot
# encode half the tables this tool prints; the whole pipeline is UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        if _stream.encoding and _stream.encoding.lower() not in ("utf-8", "utf8"):
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
SUPPORTED_LOCALES_SOURCE = REPO_ROOT / "packages" / "webui" / "src" / "i18n" / "index.ts"

FORMAT_VERSION = 1
ASSET_SCHEMA = 1
ASSET_NAME_FORMAT = "release-notes-i18n-%s.json"

# Embedded mirror of SUPPORTED_LOCALES (self-test stays hermetic; every
# release-facing command reads the live file and FAILS on drift — the TS
# source is the single source of truth, this list only seeds fixtures).
FALLBACK_LOCALES = [
    "en-US",
    "zh-CN",
    "zh-TW",
    "ja-JP",
    "ko-KR",
    "ru-RU",
    "fr-FR",
    "es-ES",
]
EN = "en-US"

# <summary> labels — the human language name in itself.
LABELS: Dict[str, str] = {
    "en-US": "English",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    "ja-JP": "日本語",
    "ko-KR": "한국어",
    "ru-RU": "Русский",
    "fr-FR": "Français",
    "es-ES": "Español",
}

# Canonical pending placeholders (S7). One line each, leading 🚧, pointing at
# the English section — the webui treats any 🚧-leading first line as pending
# and falls back to en-US.
PENDING: Dict[str, str] = {
    "zh-CN": "🚧 本版本的更新说明尚未翻译，请展开 English (en-US) 一节阅读英文原文。",
    "zh-TW": "🚧 本版本的更新說明尚未翻譯，請展開 English (en-US) 一節閱讀英文原文。",
    "ja-JP": "🚧 このリリースの更新内容はまだ翻訳されていません。English (en-US) の節を開いて原文をご覧ください。",
    "ko-KR": "🚧 이 릴리스의 변경 로그는 아직 번역되지 않았습니다. English (en-US) 섹션을 펼쳐 원문을 확인해 주세요.",
    "ru-RU": "🚧 Примечания к этой версии ещё не переведены — разверните раздел English (en-US), чтобы прочитать оригинал.",
    "fr-FR": "🚧 Les notes de cette version ne sont pas encore traduites — dépliez la section English (en-US) pour lire l'original.",
    "es-ES": "🚧 Las notas de esta versión aún no están traducidas — despliega la sección English (en-US) para leer el original.",
}

# Canonical heading translations for translators (glossary command). The
# taxonomy itself is owned by celestia-devtools' release-notes generator;
# unknown categories translate the words after the emoji.
GLOSSARY: Dict[str, Dict[str, str]] = {
    "What's Changed": {
        "zh-CN": "更新内容", "zh-TW": "更新內容", "ja-JP": "変更内容",
        "ko-KR": "변경 사항", "ru-RU": "Что изменилось",
        "fr-FR": "Nouveautés de cette version", "es-ES": "Novedades de esta versión",
    },
    "Full Changelog": {
        "zh-CN": "完整变更日志", "zh-TW": "完整變更日誌", "ja-JP": "全変更履歴",
        "ko-KR": "전체 변경 로그", "ru-RU": "Полный список изменений",
        "fr-FR": "Journal des modifications complet", "es-ES": "Registro de cambios completo",
    },
    "Other Changes": {
        "zh-CN": "其他变更", "zh-TW": "其他變更", "ja-JP": "その他の変更",
        "ko-KR": "기타 변경 사항", "ru-RU": "Другие изменения",
        "fr-FR": "Autres changements", "es-ES": "Otros cambios",
    },
    "✨ Features": {
        "zh-CN": "新功能", "zh-TW": "新功能", "ja-JP": "新機能",
        "ko-KR": "새 기능", "ru-RU": "Новые возможности",
        "fr-FR": "Nouveautés", "es-ES": "Novedades",
    },
    "🐛 Fixes": {
        "zh-CN": "问题修复", "zh-TW": "錯誤修復", "ja-JP": "修正",
        "ko-KR": "버그 수정", "ru-RU": "Исправления",
        "fr-FR": "Corrections", "es-ES": "Correcciones",
    },
    "♻️ Refactoring": {
        "zh-CN": "重构", "zh-TW": "重構", "ja-JP": "リファクタリング",
        "ko-KR": "리팩토링", "ru-RU": "Рефакторинг",
        "fr-FR": "Refactorisation", "es-ES": "Refactorización",
    },
    "📝 Documentation": {
        "zh-CN": "文档", "zh-TW": "文件", "ja-JP": "ドキュメント",
        "ko-KR": "문서", "ru-RU": "Документация",
        "fr-FR": "Documentation", "es-ES": "Documentación",
    },
    "✅ Tests": {
        "zh-CN": "测试", "zh-TW": "測試", "ja-JP": "テスト",
        "ko-KR": "테스트", "ru-RU": "Тесты",
        "fr-FR": "Tests", "es-ES": "Pruebas",
    },
    "🔒 Security": {
        "zh-CN": "安全", "zh-TW": "安全性", "ja-JP": "セキュリティ",
        "ko-KR": "보안", "ru-RU": "Безопасность",
        "fr-FR": "Sécurité", "es-ES": "Seguridad",
    },
    "🔥 Removals": {
        "zh-CN": "移除", "zh-TW": "移除", "ja-JP": "削除",
        "ko-KR": "제거", "ru-RU": "Удаления",
        "fr-FR": "Suppressions", "es-ES": "Eliminaciones",
    },
    "🔧 Maintenance": {
        "zh-CN": "维护", "zh-TW": "維護", "ja-JP": "メンテナンス",
        "ko-KR": "유지 보수", "ru-RU": "Обслуживание",
        "fr-FR": "Maintenance", "es-ES": "Mantenimiento",
    },
    "⚡ Performance": {
        "zh-CN": "性能", "zh-TW": "效能", "ja-JP": "パフォーマンス",
        "ko-KR": "성능", "ru-RU": "Производительность",
        "fr-FR": "Performances", "es-ES": "Rendimiento",
    },
    "💄 UI": {
        "zh-CN": "界面", "zh-TW": "介面", "ja-JP": "UI",
        "ko-KR": "UI", "ru-RU": "Интерфейс",
        "fr-FR": "Interface", "es-ES": "Interfaz",
    },
    "🌐 Localization": {
        "zh-CN": "本地化", "zh-TW": "在地化", "ja-JP": "ローカリゼーション",
        "ko-KR": "현지화", "ru-RU": "Локализация",
        "fr-FR": "Traduction", "es-ES": "Traducción",
    },
    "⬆️ Dependencies": {
        "zh-CN": "依赖", "zh-TW": "相依性", "ja-JP": "依存関係",
        "ko-KR": "의존성", "ru-RU": "Зависимости",
        "fr-FR": "Dépendances", "es-ES": "Dependencias",
    },
}

HEADER_RE = re.compile(r"^<!-- wowsp:i18n v([0-9]+) -->$")  # ASCII digits, like the TS mirror
LANG_MARKER_RE = re.compile(r"^<!-- wowsp:lang ([A-Za-z-]+) -->$")
SUMMARY_RE = re.compile(r"^<summary>🌐 (.+) \(([A-Za-z-]+)\)</summary>$")
DETAILS_OPEN_RE = re.compile(r"^<details( open)?>$")
TAG_LIKE_RE = re.compile(r"<[A-Za-z/!][^>\n]{0,200}>")
DETAILS_LIKE_RE = re.compile(r"(?i)</?\s*details")
URL_RE = re.compile(r"""https?://[^\s<>"'\)\]]+""")
URL_TRAILING_RE = re.compile(r"[.,;:!?]+$")

# S8 — JS stringification litter is never content (any `[object X]`).
LITTER_RE = re.compile(r"\[object [A-Za-z]+\]")

# S5 forbidden line shapes (translations only).
BLOCKQUOTE_RE = re.compile(r"^>")
FENCE_RE = re.compile(r"^\x60\x60\x60|^\s*~~~")
ORDERED_LIST_RE = re.compile(r"^\d+[.)]\s")
IMAGE_RE = re.compile(r"!\[")
TABLE_ROW_RE = re.compile(r"^\s*\|")
HR_LINE_RE = re.compile(r"^\s*(-{3,}|={3,}|\*{3,}|_{3,})\s*$")  # includes setext underlines
DEEP_INDENT_RE = re.compile(r"^\s{4,}")
HEADING_RE = re.compile(r"^#{1,6}\s+\S")
BULLET_RE = re.compile(r"^[-*+]\s+\S")


# ── locales ───────────────────────────────────────────────────────────────

def read_supported_locales() -> List[str]:
    """Read SUPPORTED_LOCALES live from the webui i18n source (single source
    of truth — CI scaffold and app parser can never drift)."""
    text = SUPPORTED_LOCALES_SOURCE.read_text(encoding="utf-8")
    m = re.search(r"SUPPORTED_LOCALES\s*=\s*\[([^\]]+)\]", text, re.S)
    if not m:
        raise SystemExit("cannot locate SUPPORTED_LOCALES in " + str(SUPPORTED_LOCALES_SOURCE))
    locales = re.findall(r'"([^"]+)"', m.group(1))
    if not locales or "en-US" not in locales:
        raise SystemExit("SUPPORTED_LOCALES is empty or lacks en-US")
    if len(locales) != len(set(locales)):
        raise SystemExit("duplicate entries in SUPPORTED_LOCALES")
    missing = [l for l in locales if l not in LABELS or (l != EN and l not in PENDING)]
    if missing:
        raise SystemExit(
            "locales missing LABELS/PENDING tables in release_notes_i18n.py: "
            + ", ".join(missing)
            + " — update the script together with the locale list"
        )
    return locales


# ── grammar ───────────────────────────────────────────────────────────────

def normalize_lines(body: str) -> List[str]:
    """Split exactly like the TS parser: CRLF/CR folded to LF, per-line
    trailing spaces PRESERVED (byte parity with releaseI18n.ts)."""
    return body.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def content_text(lines: Sequence[str]) -> str:
    """Section content as stored/parsed: trailing blanks dropped, inner
    blank lines and per-line trailing spaces preserved."""
    end = len(lines)
    while end and not lines[end - 1].strip():
        end -= 1
    return "\n".join(lines[:end])


def parse_scaffold(
    body: str,
) -> Tuple[Optional[int], Dict[str, str], Dict[str, str], List[str], List[str]]:
    """Parse a body under the grammar. Returns (format_version — None when
    the body is not scaffolded at all, {locale: opener}, {locale: content},
    section order, structural violations). A None version means "legacy
    body" — callers treat that as not-scaffolded."""
    lines = normalize_lines(body)
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines):
        return None, {}, {}, [], []
    header = HEADER_RE.match(lines[i])
    if not header:
        return None, {}, {}, [], []
    version = int(header.group(1))
    i += 1

    openers: Dict[str, str] = {}
    contents: Dict[str, str] = {}
    order: List[str] = []
    violations: List[str] = []

    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        opener = lines[i].strip()
        if not DETAILS_OPEN_RE.match(opener):
            violations.append("line %d: expected a <details> opener, found %r" % (i + 1, opener))
            return version, openers, contents, order, violations
        i += 1
        summary = lines[i].strip() if i < len(lines) else ""
        sum_match = SUMMARY_RE.match(summary)
        if not sum_match:
            violations.append("line %d: expected <summary>🌐 name (locale)</summary>, found %r" % (i + 1, summary))
            return version, openers, contents, order, violations
        locale = sum_match.group(2)
        i += 1
        if i < len(lines) and lines[i].strip():
            violations.append("%s: line %d: expected a blank line after the summary" % (locale, i + 1))
        else:
            i += 1
        marker = lines[i].strip() if i < len(lines) else ""
        marker_match = LANG_MARKER_RE.match(marker)
        if not marker_match:
            violations.append("%s: line %d: expected <!-- wowsp:lang %s -->, found %r" % (locale, i + 1, locale, marker))
            return version, openers, contents, order, violations
        if marker_match.group(1) != locale:
            violations.append(
                "line %d: summary says %s but marker says %s" % (i + 1, locale, marker_match.group(1))
            )
            return version, openers, contents, order, violations
        i += 1
        if i < len(lines) and lines[i].strip():
            violations.append("%s: line %d: expected a blank line after the language marker" % (locale, i + 1))
        else:
            i += 1
        content_lines: List[str] = []
        while i < len(lines) and lines[i].strip() != "</details>":
            if DETAILS_OPEN_RE.match(lines[i].strip()):
                violations.append("%s: line %d: nested <details> inside a section" % (locale, i + 1))
                return version, openers, contents, order, violations
            content_lines.append(lines[i])
            i += 1
        if i >= len(lines):
            violations.append("%s: section never closed with </details>" % locale)
            return version, openers, contents, order, violations
        i += 1  # consume the closer
        if locale in contents:
            violations.append("duplicate section for %s" % locale)
        contents[locale] = content_text(content_lines)
        openers[locale] = opener
        order.append(locale)
    return version, openers, contents, order, violations


def is_pending(content: str, locale: str) -> bool:
    """A8: ANY first non-empty line starting with the pending marker counts
    as pending.

    This is deliberately the SAME rule the webui parser applies
    (packages/webui/src/utils/releaseI18n.ts isPending): the app refuses to
    render a section whose first line carries the marker, so the format
    authority must report it as untranslated too - exact-equality here would
    let set/lint/issue-sync bless a section users never see.
    """
    first = next((line.strip() for line in content.split("\n") if line.strip()), "")
    return first.startswith("🚧")


def urls_of(content: str) -> collections.Counter:
    found = (URL_TRAILING_RE.sub("", u) for u in URL_RE.findall(content))
    return collections.Counter(u for u in found if u)


def check_delimiters(content: str, locale: str) -> List[str]:
    """S4a — parser-breaking content, hard for every locale."""
    violations: List[str] = []
    if DETAILS_LIKE_RE.search(content):
        violations.append("%s: content contains a <details>/</details> sequence (S4)" % locale)
    if "<!-- wowsp:" in content:
        violations.append("%s: content contains a reserved <!-- wowsp: marker (S4)" % locale)
    return violations


def _strip_fenced_blocks(content: str) -> str:
    """Blank out fenced code blocks for the B1 delimiter probe: an English
    body may legitimately QUOTE the retired i18n markers inside a fence."""
    out: List[str] = []
    in_fence = False
    for line in content.split("\n"):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append("")
            continue
        out.append("" if in_fence else line)
    return "\n".join(out)


def check_raw_html(content: str, locale: str) -> List[str]:
    """S4b — tag-like raw HTML. Hard for the seven translations; for the
    en-US source only ever surfaced as a WARNING: legacy bodies quote
    markup, GitHub renders the section exactly as it always did, and the
    app renders it as plain text (no v-html anywhere)."""
    for n, line in enumerate(content.split("\n"), 1):
        m = TAG_LIKE_RE.search(line)
        if m:
            return ["%s: line %d: raw HTML %r" % (locale, n, m.group(0))]
    return []


def check_litter(content: str, locale: str) -> List[str]:
    """S8 — JS stringification litter. Hard for the seven translations;
    for the en-US source only ever a WARNING (a legacy body may quote the
    artifact verbatim), same split as S4b."""
    for n, line in enumerate(content.split("\n"), 1):
        m = LITTER_RE.search(line)
        if m:
            return ["%s: line %d: stringification litter %r (S8)" % (locale, n, m.group(0))]
    return []


def check_translation_subset(content: str, locale: str) -> List[str]:
    """S5 — translations stay inside the ReleaseMarkdown renderer subset."""
    violations: List[str] = []
    for n, raw in enumerate(content.split("\n"), 1):
        line = raw.strip()
        if not line:
            continue
        bad: Optional[str] = None
        if FENCE_RE.search(raw):
            bad = "fenced code"
        elif BLOCKQUOTE_RE.match(line):
            bad = "blockquote"
        elif ORDERED_LIST_RE.match(line):
            bad = "ordered list (use a bullet)"
        elif IMAGE_RE.search(line):
            bad = "image"
        elif TABLE_ROW_RE.match(raw):
            bad = "table row"
        elif HR_LINE_RE.match(line):
            bad = "horizontal rule"
        elif DEEP_INDENT_RE.match(raw):
            bad = ">=4-space indent (renders as a code block on GitHub)"
        elif not (HEADING_RE.match(line) or BULLET_RE.match(line)):
            # plain paragraph — always fine
            pass
        if bad:
            violations.append("%s: line %d: %s is outside the renderer subset (S5): %r" % (locale, n, bad, line))
            break
    return violations


def check_urls(en_content: str, content: str, locale: str) -> List[str]:
    """S6 — translations carry every en-US URL at least as often."""
    missing = urls_of(en_content) - urls_of(content)
    if missing:
        total = sum(missing.values())
        detail = ", ".join(sorted(missing.elements())[:4])
        more = "" if total <= 4 else " (+%d more)" % (total - 4)
        return ["%s: dropped URL(s) present in en-US (S6): %s%s" % (locale, detail, more)]
    return []


PR_LINK_BULLET_RE = re.compile(r"^[-*+]\s+\[#\d+\]\(")


def verbatim_bullet_warning(en_content: str, content: str, locale: str) -> List[str]:
    """A9 - soft: partially-untranslated sections. A translation that leaves
    at least half of the English PR bullet lines byte-identical is flagged:
    headings-only translations (the v0.6.9/v0.6.10 regression closed on
    2026-11-14) trip it, fully translated sections never do. Warnings never
    fail the lint."""
    en_lines: List[str] = []
    for line in en_content.split("\n"):
        stripped = line.strip()
        if stripped and PR_LINK_BULLET_RE.match(stripped):
            en_lines.append(stripped)
    if len(en_lines) < 2:
        return []
    translated_lines = {line.strip() for line in content.split("\n")}
    verbatim = sum(1 for line in en_lines if line in translated_lines)
    if verbatim * 2 >= len(en_lines):
        return [
            "%s: %d/%d PR bullet lines are byte-identical to en-US (A9 soft - "
            "translate the bullet titles; the PR link and emoji stay verbatim)"
            % (locale, verbatim, len(en_lines))
        ]
    return []


def check_section(
    locale: str,
    opener: str,
    content: str,
    locales: Sequence[str],
    en_content: Optional[str],
) -> Tuple[List[str], List[str]]:
    """Per-section rule application: S3 opener shape, S4a everywhere,
    S4b/S5/S6/S8 for the seven translations (S8 warns on en-US, like
    S4b). Returns (violations, warnings) — warnings never fail the
    lint."""
    violations: List[str] = []
    warnings: List[str] = []
    want_open = "<details open>" if locale == EN else "<details>"
    if opener and opener != want_open:
        violations.append("%s: opener must be exactly %r (S3)" % (locale, want_open))
    violations.extend(check_delimiters(content, locale))
    html = check_raw_html(content, locale)
    litter = check_litter(content, locale)
    if locale == EN:
        warnings.extend(html)
        warnings.extend(litter)
    else:
        violations.extend(html)
        violations.extend(litter)
    if not content.strip():
        violations.append("%s: empty section content (S7)" % locale)
        return violations, warnings
    if locale == EN:
        return violations, warnings  # S5/S6 never apply to the en-US source
    if is_pending(content, locale):
        return violations, warnings  # pending is allowed (S7)
    violations.extend(check_translation_subset(content, locale))
    if en_content is not None:
        violations.extend(check_urls(en_content, content, locale))
    return violations, warnings


def build_scaffold(en_content: str, translations: Dict[str, str], locales: Sequence[str]) -> str:
    """Render the canonical scaffold. Sections without a translation entry
    carry the canonical placeholder."""
    out: List[str] = ["<!-- wowsp:i18n v%d -->" % FORMAT_VERSION]
    for locale in locales:
        out.append("<details open>" if locale == EN else "<details>")
        out.append("<summary>🌐 %s (%s)</summary>" % (LABELS[locale], locale))
        out.append("")
        out.append("<!-- wowsp:lang %s -->" % locale)
        out.append("")
        if locale == EN:
            content = (en_content or "").strip("\n") or "(No release notes.)"
        else:
            content = (translations.get(locale) or "").strip("\n") or PENDING[locale]
        out.extend(content.split("\n"))
        out.append("")
        out.append("</details>")
    return "\n".join(out) + "\n"


# ── asset document ───────────────────────────────────────────────────────

def translated_locales(locales: Sequence[str]) -> List[str]:
    """Every supported locale except the English body locale."""
    return [l for l in locales if l != EN]


def asset_name(tag: str) -> str:
    return ASSET_NAME_FORMAT % tag


def build_asset_doc(
    tag: str,
    en_content: str,
    translations: Optional[Dict[str, str]] = None,
    existing: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    """Build/refresh one release's asset doc.

    Existing sections win over placeholders (a re-run must not clobber
    filled translations), while explicit translations entries override
    them. Missing sections become the canonical per-locale placeholder.
    """
    locales = read_supported_locales()
    sections: Dict[str, str] = {}
    old_sections = (existing or {}).get("sections") if existing else None
    if isinstance(old_sections, dict):
        for loc in translated_locales(locales):
            value = old_sections.get(loc)
            if isinstance(value, str) and value.strip():
                sections[loc] = value
    for loc in translated_locales(locales):
        supplied = (translations or {}).get(loc)
        if supplied is not None:
            sections[loc] = supplied.strip("\n")
        elif loc not in sections:
            sections[loc] = PENDING[loc]
    if not en_content.strip():
        raise SystemExit("%s: release body is empty - cannot build the i18n asset" % tag)
    return {
        "schema": ASSET_SCHEMA,
        "tag": tag,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sections": sections,
    }


def validate_asset_doc(
    doc: Dict[str, object],
    tag: str,
    locales: Sequence[str],
    en_content: Optional[str],
) -> List[str]:
    """A1-A7 over one asset doc. Pending placeholders are allowed (A8)."""
    violations: List[str] = []
    schema = doc.get("schema")
    if not (isinstance(schema, int) and not isinstance(schema, bool) and schema == ASSET_SCHEMA):
        violations.append("asset schema is %r, want %d (A2)" % (schema, ASSET_SCHEMA))
    if doc.get("tag") != tag:
        violations.append("asset tag is %r, want %r (A2)" % (doc.get("tag"), tag))
    generated = doc.get("generated_at")
    if not isinstance(generated, str) or not generated.strip():
        violations.append("asset generated_at is missing (A2)")
    sections = doc.get("sections")
    if not isinstance(sections, dict):
        return violations + ["asset has no sections object (A3)"]
    want = translated_locales(locales)
    keys = sorted(str(k) for k in sections.keys())
    if keys != sorted(want):
        violations.append("asset locale set is %s, want exactly %s (A3)" % (keys, sorted(want)))
    for loc in want:
        content = sections.get(loc)
        if not isinstance(content, str) or not content.strip():
            violations.append("asset section %s is missing/empty (A3)" % loc)
            continue
        violations.extend(check_section(loc, "", content, locales, en_content)[0])
    return violations

# ── gh plumbing ───────────────────────────────────────────────────────────

# gh's HTTP path occasionally hits a transient TLS/handshake timeout on the
# GitHub edge from some networks; a lint/issue-sync sweep over dozens of
# releases must retry those instead of dying mid-pass.
TRANSIENT_GH_ERRORS = (
    "TLS handshake timeout",
    "error connecting to api.github.com",
    "net/http: TLS",
    "connection reset by peer",
    "unexpected EOF",
    "EOF",
    "i/o timeout",
    "connection refused",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
)


def _gh_is_mutating(args: Sequence[str]) -> bool:
    """Whether a gh invocation writes server state.

    Retrying a write after an ambiguous timeout can duplicate it (a second
    tracking issue, a second close comment) when the first attempt actually
    landed; only read-only calls ride the transient-retry loop."""
    if not args:
        return False
    if args[0] == "api":
        return any(
            arg in ("-X", "--method", "-f", "--field", "-F", "--raw-field", "--input")
            for arg in args
        )
    if args[0] == "release" and len(args) > 1:
        return args[1] in ("upload", "edit", "delete", "delete-asset")
    if args[0] == "issue" and len(args) > 1:
        return args[1] in ("create", "edit", "close", "comment", "delete")
    return False


def gh(*args: str) -> str:
    last: Optional[subprocess.CompletedProcess] = None
    for attempt in range(5):
        last = subprocess.run(
            ["gh", *args], capture_output=True, text=True, encoding="utf-8"
        )
        if last.returncode == 0:
            return last.stdout
        blob = (last.stderr or "") + (last.stdout or "")
        if (
            attempt < 4
            and not _gh_is_mutating(args)
            and any(marker in blob for marker in TRANSIENT_GH_ERRORS)
        ):
            time.sleep(2 ** attempt)
            continue
        break
    raise SystemExit("gh %s failed:\n%s" % (" ".join(args), (last.stderr or "").strip()))


_GH_REPO_CACHE: Optional[str] = None


def _repo_from_git_remote() -> Optional[str]:
    """owner/repo parsed from the checkout this script lives in.

    Preferred over `gh repo view` locally: the latter costs a GraphQL round
    trip (and its own TLS flakiness) even though the answer is right there
    in .git/config. The release workflow sets GH_REPO, so CI never needs
    either path."""
    result = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        return None
    match = re.search(r"github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$", result.stdout.strip())
    if not match:
        return None
    return "%s/%s" % (match.group(1), match.group(2))


def gh_repo() -> str:
    global _GH_REPO_CACHE
    if _GH_REPO_CACHE:
        return _GH_REPO_CACHE
    repo = os.environ.get("GH_REPO", "").strip()
    if not repo:
        repo = _repo_from_git_remote() or ""
    if not repo:
        repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    _GH_REPO_CACHE = repo
    return repo


def release_body_for(tag: str) -> str:
    return gh("api", "repos/%s/releases/tags/%s" % (gh_repo(), tag), "--jq", ".body")


def list_app_release_tags() -> List[str]:
    """Newest-first digit-leading app release tags (the changelog.rs rule:
    strip v/V, must start with an ASCII digit)."""
    out = gh("release", "list", "--limit", "300", "--json", "tagName,isDraft,isPrerelease")
    tags: List[str] = []
    for row in json.loads(out):
        if row.get("isDraft"):
            continue
        tag = row.get("tagName", "")
        bare = tag[1:] if tag[:1] in ("v", "V") else tag
        if bare[:1].isdigit():
            tags.append(tag)
    return tags


def resolve_tag(explicit: Optional[str]) -> str:
    if explicit:
        return explicit
    tags = list_app_release_tags()
    if not tags:
        raise SystemExit("no app releases found")
    return tags[0]


def release_assets_for(tag: str) -> List[dict]:
    """The release's asset list (name/size/browser_download_url dicts)."""
    out = gh("api", "repos/%s/releases/tags/%s" % (gh_repo(), tag), "--jq", ".assets")
    try:
        parsed = json.loads(out or "[]")
    except json.JSONDecodeError:
        raise SystemExit("cannot parse the asset list for %s" % tag)
    return parsed if isinstance(parsed, list) else []


def release_asset(tag: str, name: str) -> Optional[dict]:
    for asset in release_assets_for(tag):
        if asset.get("name") == name:
            return asset
    return None


def _download_asset_bytes(tag: str) -> bytes:
    """Download the release's i18n asset through gh.

    gh owns the same HTTP stack the rest of this script uses; a raw urllib
    read of the release-download redirect can hang on the object-storage
    edge (observed on a 2026-11 local pass)."""
    directory = tempfile.mkdtemp(prefix="rn-dl-")
    name = asset_name(tag)
    try:
        gh(
            "release",
            "download",
            tag,
            "--repo",
            gh_repo(),
            "--pattern",
            name,
            "--dir",
            directory,
            "--clobber",
        )
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            raise SystemExit("%s: gh downloaded no %s asset" % (tag, name))
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def download_asset_doc(tag: str) -> Optional[Dict[str, object]]:
    """Fetch and decode the release's i18n asset; None when it is absent."""
    asset = release_asset(tag, asset_name(tag))
    if not asset:
        return None
    raw = _download_asset_bytes(tag)
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit("%s: i18n asset is not valid UTF-8 JSON: %s" % (tag, exc))
    return decoded if isinstance(decoded, dict) else None


def fetch_asset_docs(
    tags: Sequence[str], workers: int = 6
) -> Dict[str, Tuple[Optional[Dict[str, object]], Optional[str]]]:
    """Fetch many release assets concurrently.

    The sweep commands (show/lint --assets/issue-sync) hit one asset per app
    release; serial gh round trips dominate their runtime, and a single slow
    tag must not stretch the whole pass. Results keep the tags order and are
    (doc, error): a corrupt/unreadable asset is reported for its own tag
    instead of aborting the sweep (one bad historical asset must not red the
    whole release-notes pass)."""
    docs: Dict[str, Tuple[Optional[Dict[str, object]], Optional[str]]] = {}
    if not tags:
        return docs
    with ThreadPoolExecutor(max_workers=min(workers, len(tags))) as pool:
        futures = {tag: pool.submit(download_asset_doc, tag) for tag in tags}
        for tag, future in futures.items():
            try:
                docs[tag] = (future.result(), None)
            except SystemExit as exc:
                docs[tag] = (None, str(exc))
    return docs


def upload_asset_doc(tag: str, doc: Dict[str, object]) -> None:
    """Upload (or replace) the release's i18n asset and verify the write by
    re-downloading it: release-asset writes have no trusted read-back, and a
    silently truncated upload would strand every client on the English body."""
    directory = tempfile.mkdtemp(prefix="rn-asset-")
    path = os.path.join(directory, asset_name(tag))
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        with open(path, "rb") as fh:
            expected = fh.read()
        gh("release", "upload", tag, path, "--repo", gh_repo(), "--clobber")
        last_error: Optional[BaseException] = None
        for delay in (0, 1, 2, 4):
            if delay:
                time.sleep(delay)
            try:
                if _download_asset_bytes(tag) == expected:
                    return
            except SystemExit as exc:  # upload not visible yet / transient
                last_error = exc
        raise SystemExit(
            "%s: uploaded i18n asset did not read back byte-identically (%s)"
            % (tag, last_error or "content mismatch")
        )
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def english_content_for(tag: str) -> Tuple[str, str]:
    """(body mode, English markdown) for one release.

    mode is "english" for the canonical plain body and "legacy-scaffold"
    for the pre-2026-11 v1 scaffold (the en-US section is extracted).
    """
    body = release_body_for(tag)
    version, _, contents, _, _ = parse_scaffold(body)
    if version is None:
        return "english", body
    return "legacy-scaffold", contents.get(EN, "") or ""

# ── commands ──────────────────────────────────────────────────────────────

def lint_release(body: str, locales: Sequence[str]) -> Tuple[str, List[str], List[str]]:
    """Classify one release body: (status, violations, warnings), with
    status in {ok, legacy, violation}.

    The canonical body is plain English markdown (B1). A legacy v1 scaffold
    body is accepted as a soft warning (B2): older clients understand it and
    the app keeps the legacy parser, but new releases never write it.
    """
    version, openers, contents, order, violations = parse_scaffold(body)
    if version is None:
        plain = check_delimiters(_strip_fenced_blocks(body), EN)
        if not body.strip():
            plain.append("empty release body (B1)")
        warnings = check_raw_html(body, EN) + check_litter(body, EN)
        if plain:
            return "violation", plain, warnings
        return "ok", [], warnings
    if version != FORMAT_VERSION:
        violations.append("format version %d != supported v%d" % (version, FORMAT_VERSION))
    if violations:
        return "violation", violations, []
    if order != list(locales):
        violations.append("section order/set is %s, want exactly %s (S2)" % (order, list(locales)))
    warnings: List[str] = []
    for locale in locales:
        if locale not in contents:
            continue  # already reported by the order check
        section_violations, section_warnings = check_section(
            locale, openers.get(locale, ""), contents[locale], locales, contents.get(EN)
        )
        violations.extend(section_violations)
        warnings.extend(section_warnings)
    if violations:
        return "violation", violations, warnings
    return "legacy", [], warnings


def cmd_pack(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    tag = resolve_tag(args.tag)
    mode, en_content = english_content_for(tag)
    if not en_content.strip():
        raise SystemExit("%s: release body has no English content" % tag)
    existing = download_asset_doc(tag)
    doc = build_asset_doc(tag, en_content, None, existing)
    violations = validate_asset_doc(doc, tag, locales, en_content)
    if violations:
        print("%s: rebuilt i18n asset does not pass the asset constraints:" % tag, file=sys.stderr)
        for violation in violations:
            print("  %s" % violation, file=sys.stderr)
        raise SystemExit(1)
    sections = doc["sections"]
    pending = [l for l in translated_locales(locales) if is_pending(sections[l], l)]
    if args.upload:
        upload_asset_doc(tag, doc)
        print("%s: i18n asset uploaded (%s body, %d locale sections, %d pending)"
              % (tag, mode, len(sections), len(pending)))
    else:
        print(json.dumps(doc, ensure_ascii=False, indent=2))
        print("# dry run - re-run with --upload to attach %s" % asset_name(tag), file=sys.stderr)


def cmd_set(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    if args.lang not in locales:
        raise SystemExit("--lang %s is not a supported locale (%s)" % (args.lang, ", ".join(locales)))
    if args.lang == EN:
        raise SystemExit("en-US is the English release body - set never rewrites it")
    tag = resolve_tag(args.tag)
    mode, en_content = english_content_for(tag)
    if not en_content.strip():
        raise SystemExit("%s: release body has no English content" % tag)
    # utf-8-sig: a BOM from a Windows editor must not ride into the section
    new_content = Path(args.file).read_text(encoding="utf-8-sig").strip("\n")
    first_line = next((line.strip() for line in new_content.split("\n") if line.strip()), "")
    if first_line.startswith("🚧") and new_content.strip() != PENDING[args.lang].strip():
        raise SystemExit(
            "%s: content starts with the pending marker but is not the canonical placeholder - "
            "the app treats any marker-leading section as untranslated; drop the marker line and retry"
            % args.lang
        )
    violations, _warnings = check_section(args.lang, "", new_content, locales, en_content)
    if violations:
        print("%s: translation for %s does not pass the format constraints:" % (args.file, args.lang),
              file=sys.stderr)
        for violation in violations:
            print("  %s" % violation, file=sys.stderr)
        raise SystemExit(1)
    existing = download_asset_doc(tag)
    doc = build_asset_doc(tag, en_content, {args.lang: new_content}, existing)
    violations = validate_asset_doc(doc, tag, locales, en_content)
    if violations:
        print("%s: the rebuilt i18n asset does not pass the asset constraints:" % tag, file=sys.stderr)
        for violation in violations:
            print("  %s" % violation, file=sys.stderr)
        raise SystemExit(1)
    for warning in verbatim_bullet_warning(en_content, new_content, args.lang):
        print("⚠ %s  %s" % (tag, warning))
    if args.apply:
        upload_asset_doc(tag, doc)
        status = "pending placeholder kept" if is_pending(new_content, args.lang) else "translated"
        print("%s: %s section written to the i18n asset (%s; %s body)" % (tag, args.lang, status, mode))
    else:
        print(json.dumps(doc, ensure_ascii=False, indent=2))
        print("# dry run - re-run with --apply to write the asset for %s" % tag, file=sys.stderr)


def cmd_show(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    tags = [args.tag] if getattr(args, "tag", None) else list_app_release_tags()
    docs = fetch_asset_docs(tags)
    print("%-10s %-16s %-8s sections" % ("release", "body", "asset"))
    for tag in tags:
        body = release_body_for(tag)
        version, _, contents, _, _ = parse_scaffold(body)
        mode = "english" if version is None else "legacy-scaffold"
        en_for_asset = body if version is None else (contents.get(EN) or "")
        doc, asset_error = docs.get(tag, (None, None))
        if asset_error:
            print("%-10s %-16s %-8s %s" % (tag, mode, "INVALID", asset_error))
            continue
        if doc is None:
            print("%-10s %-16s %-8s (no asset)" % (tag, mode, "missing"))
            continue
        violations = validate_asset_doc(doc, tag, locales, en_for_asset)
        if violations:
            print("%-10s %-16s %-8s %s" % (tag, mode, "INVALID", violations[0]))
            continue
        sections = doc.get("sections") if isinstance(doc.get("sections"), dict) else {}
        detail = " ".join(
            "%s:%s" % (l, "…" if is_pending(str(sections.get(l) or ""), l) else "✓")
            for l in translated_locales(locales)
        )
        print("%-10s %-16s %-8s %s" % (tag, mode, "ok", detail))


def cmd_lint(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    tags = [args.tag] if args.tag else list_app_release_tags()
    hard = legacy = assets_ok = assets_pending = assets_missing = 0
    docs = fetch_asset_docs(tags) if args.assets else {}
    for tag in tags:
        body = release_body_for(tag)
        version, _, contents, _, _ = parse_scaffold(body)
        en_for_asset = body if version is None else (contents.get(EN) or "")
        status, violations, warnings = lint_release(body, locales)
        if status == "violation":
            hard += 1
            print("✗ %s" % tag)
            for violation in violations:
                print("    %s" % violation)
        elif status == "legacy":
            legacy += 1
            print("· %s  legacy v1 scaffold body (B2) - English bodies are canonical" % tag)
        else:
            print("✓ %s" % tag)
        for warning in warnings:
            print("    ⚠ %s" % warning)
        if not args.assets:
            continue
        doc, asset_error = docs.get(tag, (None, None))
        if asset_error:
            hard += 1
            print("    ✗ %s  %s" % (tag, asset_error))
            continue
        if doc is None:
            hard += 1
            assets_missing += 1
            print("    ✗ %s  missing i18n asset %s (A1)" % (tag, asset_name(tag)))
            continue
        asset_violations = validate_asset_doc(doc, tag, locales, en_for_asset)
        if asset_violations:
            hard += 1
            print("    ✗ %s  i18n asset violations:" % tag)
            for violation in asset_violations:
                print("      %s" % violation)
            continue
        sections = doc["sections"]
        pending = [l for l in translated_locales(locales) if is_pending(sections[l], l)]
        if pending:
            assets_pending += 1
            print("    … %s  asset pending: %s" % (tag, ", ".join(pending)))
        else:
            assets_ok += 1
        if en_for_asset.strip():
            for loc in translated_locales(locales):
                if is_pending(sections[loc], loc):
                    continue
                for warning in verbatim_bullet_warning(en_for_asset, sections[loc], loc):
                    print("    ⚠ %s  %s" % (tag, warning))
    print("")
    if args.assets:
        print("%d release(s): %d violation(s), %d legacy body, %d asset(s) ok, %d asset(s) pending, %d asset(s) missing"
              % (len(tags), hard, legacy, assets_ok, assets_pending, assets_missing))
    else:
        print("%d release(s): %d violation(s), %d legacy body, %d English body"
              % (len(tags), hard, legacy, len(tags) - hard - legacy))
    if hard:
        raise SystemExit(1)


TRANSLATION_ISSUE_TITLE = "🌐 Release notes: pending translation sections"


def cmd_issue_sync(_args: argparse.Namespace) -> None:
    """Upsert (or close) the rolling translation-tracking issue from the
    current per-release asset pending state. The release-time job runs this
    right after pack; agents re-run it after filling the last pending
    section."""
    locales = read_supported_locales()
    tags = list_app_release_tags()
    docs = fetch_asset_docs(tags)
    pending_map: Dict[str, List[str]] = {}
    for tag in tags:
        doc, asset_error = docs.get(tag, (None, None))
        if asset_error or doc is None:
            pending_map[tag] = translated_locales(locales)
            continue
        sections = doc.get("sections") if isinstance(doc.get("sections"), dict) else {}
        pend = [
            l for l in translated_locales(locales)
            if not isinstance(sections.get(l), str)
            or not sections[l].strip()
            or is_pending(sections[l], l)
        ]
        if pend:
            pending_map[tag] = pend
    existing = gh(
        "issue", "list", "--state", "open", "--search",
        "in:title %s" % TRANSLATION_ISSUE_TITLE, "--json", "number", "--jq", ".[0].number",
    ).strip()
    if not pending_map:
        if existing and existing != "null":
            gh("issue", "close", existing, "--comment",
               "All release-note sections are translated - closing (issue-sync).")
            print("closed tracking issue #%s" % existing)
        else:
            print("nothing pending, no open tracking issue")
        return
    table = "| Release | Pending locales |\n| --- | --- |\n"
    table += "\n".join("| %s | %s |" % (tag, ", ".join(pend)) for tag, pend in pending_map.items())
    body_text = (
        "Release-note translation sections still carrying the canonical placeholder (AGENTS.md section 10).\n\n"
        + table
        + "\n\nFill each with `python scripts/release_notes_i18n.py set --tag <tag> "
        "--lang <locale> --file <md> --apply` (writes the JSON asset `release-notes-i18n-<tag>.json`), "
        "then run `python scripts/release_notes_i18n.py issue-sync` - the issue closes itself "
        "when nothing is pending."
    )
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
        fh.write(body_text)
        payload = fh.name
    try:
        if existing and existing != "null":
            gh("issue", "edit", existing, "--body-file", payload)
            print("updated tracking issue #%s (%d release(s) pending)" % (existing, len(pending_map)))
        else:
            url = gh("issue", "create", "--title", TRANSLATION_ISSUE_TITLE, "--body-file", payload)
            print("opened tracking issue %s (%d release(s) pending)" % (url.strip(), len(pending_map)))
    finally:
        os.unlink(payload)

def cmd_glossary(_args: argparse.Namespace) -> None:
    locales = [l for l in read_supported_locales() if l != EN]
    print("%-28s%s" % ("source", "".join("%-12s" % l for l in locales)))
    for source, table in GLOSSARY.items():
        print("%-28s%s" % (source, "".join("%-12s" % table.get(l, "—") for l in locales)))


# ── self-test (hermetic; legacy-scaffold fixtures must stay in agreement
#    with packages/webui/src/utils/releaseI18n.test.ts) ─────────────────

SAMPLE_EN = (
    "## What's Changed\n"
    "\n"
    "### ✨ Features\n"
    "\n"
    "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ Add an optional K/D column to the water-table surfaces.\n"
    "\n"
    "### 🐛 Fixes\n"
    "\n"
    "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 Fit calibration editor stage inside the modal body cap.\n"
    "\n"
    "**Full Changelog**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7"
)


def _mini(locale: str) -> str:
    return (
        "## %s\n\n### ✨ %s\n\n" % (GLOSSARY["What's Changed"][locale], GLOSSARY["✨ Features"][locale])
        + "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ 测试译文：新增 K/D 列。\n"
        + "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 测试译文：修复舞台高度。\n\n"
        + "**%s**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7" % GLOSSARY["Full Changelog"][locale]
    )


def _sample_scaffold(locales: Sequence[str], translations: Optional[Dict[str, str]] = None) -> str:
    return build_scaffold(SAMPLE_EN, translations or {}, locales)


def cmd_self_test(_args: argparse.Namespace) -> None:
    locales = FALLBACK_LOCALES
    translated = dict(PENDING)
    translated["zh-CN"] = _mini("zh-CN")

    # ── canonical model: English body + JSON asset ────────────────────
    assert lint_release(SAMPLE_EN, locales)[0] == "ok"
    assert lint_release("", locales)[0] == "violation"
    assert lint_release(SAMPLE_EN + "\n</details>", locales)[0] == "violation"
    assert lint_release(SAMPLE_EN + "\n<!-- wowsp:lang zh-CN -->", locales)[0] == "violation"
    raw = lint_release(SAMPLE_EN + "\nquotes the <html> tag verbatim", locales)
    assert raw[0] == "ok" and raw[2], raw

    doc = build_asset_doc("v0.6.7", SAMPLE_EN)
    assert doc["schema"] == ASSET_SCHEMA
    assert list(doc["sections"].keys()) == translated_locales(locales)
    assert all(is_pending(doc["sections"][l], l) for l in translated_locales(locales))
    assert validate_asset_doc(doc, "v0.6.7", locales, SAMPLE_EN) == []

    filled = build_asset_doc("v0.6.7", SAMPLE_EN, {"zh-CN": translated["zh-CN"]}, doc)
    assert not is_pending(filled["sections"]["zh-CN"], "zh-CN")
    assert validate_asset_doc(filled, "v0.6.7", locales, SAMPLE_EN) == []
    assert build_asset_doc("v0.6.7", SAMPLE_EN, None, filled)["sections"]["zh-CN"] == translated["zh-CN"]

    # A9 soft: headings-only / partially translated sections warn, fully
    # translated ones (and single-bullet bodies) never do.
    assert verbatim_bullet_warning(SAMPLE_EN, SAMPLE_EN, "zh-CN")
    assert verbatim_bullet_warning(SAMPLE_EN, _mini("zh-CN"), "zh-CN") == []
    half = _mini("zh-CN").replace(
        "测试译文：修复舞台高度。", "Fit calibration editor stage inside the modal body cap.")
    assert verbatim_bullet_warning(SAMPLE_EN, half, "zh-CN")
    assert verbatim_bullet_warning(
        "- [#1](https://github.com/langyo/wowsp/pull/1) ✨ Solo bullet.",
        "- [#1](https://github.com/langyo/wowsp/pull/1) ✨ Solo bullet.", "zh-CN") == []

    def expect_asset_violation(name: str, mutate) -> None:
        bad = json.loads(json.dumps(filled))
        mutate(bad)
        assert validate_asset_doc(bad, "v0.6.7", locales, SAMPLE_EN), name

    expect_asset_violation("schema", lambda d: d.__setitem__("schema", 2))
    expect_asset_violation("tag", lambda d: d.__setitem__("tag", "v0.6.8"))
    expect_asset_violation("missing-locale", lambda d: d["sections"].pop("ja-JP"))
    expect_asset_violation("extra-locale", lambda d: d["sections"].__setitem__("xx-XX", "x"))
    expect_asset_violation("delimiter", lambda d: d["sections"].__setitem__("ja-JP", "</details>"))
    expect_asset_violation("dropped-url", lambda d: d["sections"].__setitem__("ja-JP", "## 変更内容\n\n- リンクなし"))
    expect_asset_violation("litter", lambda d: d["sections"].__setitem__("ja-JP", "## [object Object]"))
    expect_asset_violation("empty", lambda d: d["sections"].__setitem__("ko-KR", ""))
    expect_asset_violation("generated_at", lambda d: d.pop("generated_at"))

    # ── legacy v1 scaffold bodies (old releases / old clients) ─────────
    def expect_legacy(name: str, scaffold: str) -> None:
        status, violations, _warnings = lint_release(scaffold, locales)
        assert status == "legacy" and not violations, (name, status, violations)

    expect_legacy("pending", _sample_scaffold(locales, {l: PENDING[l] for l in locales if l != EN}))
    expect_legacy("translated", _sample_scaffold(locales, translated))
    expect_legacy("mini", _sample_scaffold(locales, {l: _mini(l) for l in locales if l != EN}))

    def expect_violation(name: str, body: str) -> None:
        status, violations, _ = lint_release(body, locales)
        assert status == "violation" and violations, (name, status)

    expect_violation("order", build_scaffold(SAMPLE_EN, {}, list(reversed(locales))))
    truncated = [l for l in locales if l != "es-ES"]
    expect_violation("missing-locale", build_scaffold(SAMPLE_EN, {}, truncated))
    expect_violation("opener", _sample_scaffold(locales).replace("<details open>", "<details>", 1))
    expect_violation("summary", _sample_scaffold(locales).replace("(zh-CN)</summary>", "(zh-CN) </summary>", 1))
    expect_violation("marker", _sample_scaffold(locales).replace("<!-- wowsp:lang zh-CN -->", "<!-- wowsp:lang zh-TW -->", 1))
    expect_violation("closer", _sample_scaffold(locales).replace("**Full Changelog**", "</details> **Full Changelog**", 1))
    expect_violation("html", _sample_scaffold(locales, {**PENDING, "zh-CN": "<b>加粗</b>"}))
    en_html = lint_release(
        _sample_scaffold(locales).replace(
            "**Full Changelog**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7",
            "quotes the <html> tag verbatim",
        ),
        locales,
    )
    assert en_html[0] == "legacy" and not en_html[1] and en_html[2], en_html
    legacy_en = _sample_scaffold(locales, {**PENDING, EN: "* legacy bullet\n\n---\n\n> quote"})
    assert lint_release(legacy_en, locales)[0] == "legacy"
    fence = "\x60\x60\x60py\nx=1\n\x60\x60\x60"
    expect_violation("fence", _sample_scaffold(locales, {**PENDING, "zh-CN": fence}))
    expect_violation("ordered", _sample_scaffold(locales, {**PENDING, "zh-CN": "1. 第一条"}))
    expect_violation("blockquote", _sample_scaffold(locales, {**PENDING, "zh-CN": "> 引用"}))
    expect_violation("image", _sample_scaffold(locales, {**PENDING, "zh-CN": "![图](https://x/y.png)"}))
    expect_violation("hr", _sample_scaffold(locales, {**PENDING, "zh-CN": "---"}))
    expect_violation("setext", _sample_scaffold(locales, {**PENDING, "zh-CN": "更新内容\n==="}))
    expect_violation("urls", _sample_scaffold(locales, {**PENDING, "zh-CN": "## 更新内容\n\n- 一个链接都没有"}))
    # Placeholder contract parity with the TS parser: ANY marker-leading
    # first line is pending, even when translated content follows it.
    assert is_pending("🚧 还没翻译呢（随意改写的占位句子）\n\n## 更新内容", "zh-CN")
    assert is_pending(PENDING["zh-CN"], "zh-CN")
    assert not is_pending("## 更新内容\n\n- 🚧 中间行不是占位符", "zh-CN")
    litter = lint_release(_sample_scaffold(locales, {**PENDING, "zh-CN": "## [object Object]"}), locales)
    assert litter[0] == "violation" and any("S8" in v for v in litter[1]), litter
    en_litter = lint_release(
        _sample_scaffold(locales).replace("**Full Changelog**", "[object Object] **Full Changelog**", 1),
        locales,
    )
    assert en_litter[0] == "legacy" and any("S8" in w for w in en_litter[2]), en_litter

    print("self-test: all fixtures pass")

# ── entry ─────────────────────────────────────────────────────────────────

def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Internationalized GitHub release notes toolkit")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pack", help="build/upload one release's i18n JSON asset")
    p.add_argument("--tag")
    p.add_argument("--upload", action="store_true")
    p.set_defaults(fn=cmd_pack)

    p = sub.add_parser("set", help="replace one locale's section in the JSON asset")
    p.add_argument("--tag")
    p.add_argument("--lang", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("show", help="status table over every app release's i18n asset")
    p.add_argument("--tag")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("lint", help="hard-validate release bodies (+ assets with --assets)")
    p.add_argument("--tag")
    p.add_argument("--assets", action="store_true")
    p.set_defaults(fn=cmd_lint)

    p = sub.add_parser("issue-sync", help="upsert/close the pending-translations issue")
    p.set_defaults(fn=cmd_issue_sync)

    p = sub.add_parser("glossary", help="canonical heading translations")
    p.set_defaults(fn=cmd_glossary)

    p = sub.add_parser("self-test", help="run the hermetic grammar fixtures")
    p.set_defaults(fn=cmd_self_test)

    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
