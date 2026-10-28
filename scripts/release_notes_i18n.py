#!/usr/bin/env python3
"""Internationalized GitHub release notes: scaffold, patch, lint, issue sync.

Every `v*` app release body carries a language-section scaffold. GitHub web
shows en-US expanded and every other locale collapsed inside <details>; the
webui changelog (packages/webui/src/utils/releaseI18n.ts) parses the SAME
grammar and renders exactly one locale. This script is the FORMAT AUTHORITY:
its grammar below is mirrored byte-for-byte by the TS parser, and both sides
carry fixtures (self-test here, releaseI18n.test.ts there) that must stay in
agreement. Notes live ONLY on the GitHub Releases page (AGENTS.md §2/§10) —
translations travel as files OUTSIDE the git tree and land in the release
body through this script, never as tracked repository files.

GRAMMAR (v1) — the body is, line-exactly:

    <!-- wowsp:i18n v1 -->
    <details open>                        # en-US ONLY carries " open"
    <summary>🌐 English (en-US)</summary>
                                          # blank line — required
    <!-- wowsp:lang en-US -->             # machine marker, first content line
                                          # blank line — required
    {en-US content: the categorized release body, verbatim}
                                          # blank line — canonical
    </details>                            # (a tight closer is tolerated)
    <details>                             # every other locale: collapsed
    <summary>🌐 简体中文 (zh-CN)</summary>

    <!-- wowsp:lang zh-CN -->

    {zh-CN content or the canonical 🚧 placeholder}

    </details>
    ... zh-TW, ja-JP, ko-KR, ru-RU, fr-FR, es-ES in canonical order ...

SECTION RULES (lint-enforced; "hard" = CI fails):
  S1       body starts (after at most blank lines) with the v1 header —
           an unscaffolded body is LEGACY: always a warning, never a
           failure (wrapping is the Release workflow's job, §10).
  S2 hard  exactly one section per supported locale (read live from
           packages/webui/src/i18n/index.ts SUPPORTED_LOCALES — never
           duplicated here), in the canonical order above.
  S3 hard  openers are exactly "<details open>" (en-US) / "<details>" (rest);
           each is followed by the exact "<summary>🌐 {label} ({locale})</summary>",
           a blank line, the exact "<!-- wowsp:lang {locale} -->" marker line,
           and a blank line before any content; sections end with a lone
           "</details>" line; nothing but blank lines sits between sections.
  S4 hard  content of EVERY locale (en-US included) never smuggles the
           delimiters: no "<details"/"</details>" (any case/spacing) and
           no reserved "<!-- wowsp:" marker. Tag-like raw HTML is banned
           outright in the SEVEN TRANSLATIONS; in the en-US source it is
           only ever a WARNING (legacy bodies legitimately quote markup,
           e.g. "<html>" inside an error message).
  S5 hard  the SEVEN TRANSLATIONS stick to the renderer subset
           (packages/webui/src/components/settings/ReleaseMarkdown.tsx):
           "#{1,6} " headings, "-" / "*" / "+" bullets, plain paragraphs,
           **bold** and [label](url) inline. Forbidden: fenced code,
           blockquotes, ordered lists, images, tables, hr lines, >=4-space
           indents. en-US is exempt (legacy bodies are wrapped verbatim).
  S6 hard  URL preservation: every URL appearing in the en-US section must
           appear in each translation at least as many times.
  S7 soft  a translation whose content equals the canonical per-locale
           placeholder is PENDING — allowed (never a lint failure), tracked
           in the rolling translation issue. Untranslated == untranslated.

COMMANDS
  wrap    [--tag T] [--apply]   wrap a published body into the scaffold
                                (en-US = verbatim old body, rest = placeholders)
  set     [--tag T] --lang L --file F [--apply]
                                replace locale L's section (validates S4-S7
                                against the live en-US section first)
  show                          per-release, per-locale status table
  lint    [--tag T]             hard-validate scaffolded bodies; legacy
                                (unscaffolded) releases warn until backfilled
  issue-sync                    upsert/close the rolling "pending translations"
                                tracking issue from the lint result
  glossary                      canonical heading translations for translators
  self-test                     hermetic fixture suite over the grammar

Everything gh-backed honors GH_REPO (release.yml sets it); locally the repo
is resolved via `gh repo view`. Requires python 3.10+ and the gh CLI.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import subprocess
import sys
import tempfile
import time
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
    stripped = [line.strip() for line in content.split("\n") if line.strip()]
    return stripped == [PENDING[locale].strip()]


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


def check_section(
    locale: str,
    opener: str,
    content: str,
    locales: Sequence[str],
    en_content: Optional[str],
) -> Tuple[List[str], List[str]]:
    """Per-section rule application: S3 opener shape, S4a everywhere,
    S4b/S5/S6 for the seven translations. Returns (violations, warnings) —
    warnings never fail the lint."""
    violations: List[str] = []
    warnings: List[str] = []
    want_open = "<details open>" if locale == EN else "<details>"
    if opener and opener != want_open:
        violations.append("%s: opener must be exactly %r (S3)" % (locale, want_open))
    violations.extend(check_delimiters(content, locale))
    html = check_raw_html(content, locale)
    if locale == EN:
        warnings.extend(html)
    else:
        violations.extend(html)
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


def set_section(body: str, locale: str, content: str, locales: Sequence[str]) -> str:
    """Swap one locale's content inside an existing scaffold, rebuilding the
    body canonically (byte-stable for untouched sections)."""
    version, _, contents, _, _ = parse_scaffold(body)
    if version is None:
        raise SystemExit("--tag body is not scaffolded — run wrap first")
    updated = dict(contents)
    updated[locale] = content.strip("\n")
    return build_scaffold(updated.get(EN, ""), updated, locales)


# ── gh plumbing ───────────────────────────────────────────────────────────

def gh(*args: str) -> str:
    result = subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        raise SystemExit("gh %s failed:\n%s" % (" ".join(args), result.stderr.strip()))
    return result.stdout


def gh_repo() -> str:
    repo = os.environ.get("GH_REPO", "").strip()
    if repo:
        return repo
    return gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()


def release_id_for(tag: str) -> str:
    out = gh("api", "repos/%s/releases/tags/%s" % (gh_repo(), tag), "--jq", ".id").strip()
    if not out:
        raise SystemExit("no release for tag %s" % tag)
    return out


def release_body_for(tag: str) -> str:
    return gh("api", "repos/%s/releases/tags/%s" % (gh_repo(), tag), "--jq", ".body")


def patch_release_body(tag: str, new_body: str) -> None:
    """PATCH the body, then re-read and verify the write landed (the release
    page has clobber history — never trust a silent 200). GitHub reads can
    briefly lag a write (eventual consistency — observed live on every
    backfill PATCH), so each verify re-reads after a growing settle delay
    and compares modulo leading/trailing blank lines."""
    release_id = release_id_for(tag)
    for attempt, delay in enumerate((1, 3, 6, 12, 20), 1):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            json.dump({"body": new_body}, fh)
            payload = fh.name
        try:
            gh("api", "-X", "PATCH", "repos/%s/releases/%s" % (gh_repo(), release_id),
               "--input", payload, "--silent")
        finally:
            os.unlink(payload)
        time.sleep(delay)
        if release_body_for(tag).strip("\n") == new_body.strip("\n"):
            return
        print("note: body write for %s did not settle (attempt %d)" % (tag, attempt), file=sys.stderr)
    raise SystemExit("release body for %s never settled after 5 attempts — aborting" % tag)


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


# ── commands ──────────────────────────────────────────────────────────────

def lint_release(body: str, locales: Sequence[str]) -> Tuple[str, List[str], List[str]]:
    """Classify one release body: (status, violations, warnings), with
    status ∈ {legacy, ok, pending, violation}.

    Legacy (unscaffolded) bodies are always a WARNING, never a failure:
    wrapping is enforced by the Release workflow's notes-i18n job (it fails
    the release run when it cannot wrap), so PR-time CI stays a pure format
    gate and never blocks on backfill progress."""
    version, openers, contents, order, violations = parse_scaffold(body)
    if version is None:
        return "legacy", [], []
    if version != FORMAT_VERSION:
        violations.append("format version %d != supported v%d" % (version, FORMAT_VERSION))
    if violations:
        return "violation", violations, []
    # S2: exactly the supported locale set, canonically ordered.
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
    pending = [l for l in locales if l != EN and is_pending(contents[l], l)]
    return ("pending" if pending else "ok"), [], warnings


def cmd_wrap(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    tag = resolve_tag(args.tag)
    body = release_body_for(tag)
    version, _, _, _, _ = parse_scaffold(body)
    if version is not None:
        print("%s: already scaffolded (v%d) — nothing to do" % (tag, version))
        return
    unsafe = check_delimiters(body, EN)  # raw HTML in legacy bodies wraps fine (warning only)
    if unsafe:
        print("%s: refusing to wrap — the existing body is not parse-safe:" % tag, file=sys.stderr)
        for v in unsafe:
            print("  %s" % v, file=sys.stderr)
        raise SystemExit(1)
    scaffold = build_scaffold(body.strip("\n"), {}, locales)
    if args.apply:
        patch_release_body(tag, scaffold)
        print("%s: scaffolded (en-US verbatim, %d placeholder sections)" % (tag, len(locales) - 1))
    else:
        print(scaffold, end="")
        print("# dry run — re-run with --apply to write %s" % tag, file=sys.stderr)


def cmd_set(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    if args.lang not in locales:
        raise SystemExit("--lang %s is not a supported locale (%s)" % (args.lang, ", ".join(locales)))
    if args.lang == EN:
        raise SystemExit("en-US is the wrapped original body — set never rewrites it")
    tag = resolve_tag(args.tag)
    body = release_body_for(tag)
    version, _, contents, _, _ = parse_scaffold(body)
    if version is None:
        raise SystemExit("%s: not scaffolded — run wrap first" % tag)
    en_content = contents.get(EN)
    if en_content is None:
        raise SystemExit("%s: scaffold has no en-US section — run wrap first" % tag)
    # utf-8-sig: a BOM from a Windows editor must not ride into the body's
    # first line, where it would silently demote the first heading.
    new_content = Path(args.file).read_text(encoding="utf-8-sig").strip("\n")
    violations, _warnings = check_section(args.lang, "<details>", new_content, locales, en_content)
    if violations:
        print("%s: translation for %s does not pass the format constraints:" % (args.file, args.lang),
              file=sys.stderr)
        for v in violations:
            print("  %s" % v, file=sys.stderr)
        raise SystemExit(1)
    new_body = set_section(body, args.lang, new_content, locales)
    if args.apply:
        patch_release_body(tag, new_body)
        status = "pending placeholder kept" if is_pending(new_content, args.lang) else "translated"
        print("%s: %s section set (%s)" % (tag, args.lang, status))
    else:
        print(new_body, end="")
        print("# dry run — re-run with --apply to write %s" % tag, file=sys.stderr)


def _pending_locales(body: str, locales: Sequence[str]) -> List[str]:
    _, _, contents, _, _ = parse_scaffold(body)
    return [l for l in locales if l != EN and is_pending(contents.get(l, ""), l)]


def cmd_show(_args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    tags = list_app_release_tags()
    print("%-10s %-10s sections" % ("release", "status"))
    for tag in tags:
        body = release_body_for(tag)
        status, _, _ = lint_release(body, locales)
        version, _, contents, _, _ = parse_scaffold(body)
        if version is None:
            detail = "no scaffold"
        else:
            detail = " ".join(
                "%s:%s" % (l, "EN" if l == EN else ("…" if is_pending(contents[l], l) else "✓"))
                for l in locales if l in contents
            )
        print("%-10s %-10s %s" % (tag, status, detail))


def cmd_lint(args: argparse.Namespace) -> None:
    locales = read_supported_locales()
    if args.tag:
        tags = [args.tag]
    else:
        tags = list_app_release_tags()
    hard = 0
    legacy = 0
    pending_count = 0
    for tag in tags:
        body = release_body_for(tag)
        status, violations, warnings = lint_release(body, locales)
        if status == "violation":
            hard += 1
            print("✗ %s" % tag)
            for v in violations:
                print("    %s" % v)
        elif status == "legacy":
            legacy += 1
            print("· %s  legacy body — pending i18n backfill" % tag)
        elif status == "pending":
            pending_count += 1
            print("… %s  scaffolded; pending: %s" % (tag, ", ".join(_pending_locales(body, locales))))
        else:
            print("✓ %s" % tag)
        for w in warnings:
            print("    ⚠ %s" % w)
    print("")
    print("%d release(s): %d violation(s), %d legacy, %d scaffolded" % (len(tags), hard, legacy, len(tags) - hard - legacy))
    if hard:
        raise SystemExit(1)


TRANSLATION_ISSUE_TITLE = "🌐 Release notes: pending translation sections"


def cmd_issue_sync(_args: argparse.Namespace) -> None:
    """Upsert (or close) the single rolling translation-tracking issue from
    the current pending map. The release-time job runs this right after
    wrap; agents re-run it after filling the last pending section."""
    locales = read_supported_locales()
    tags = list_app_release_tags()
    pending_map: Dict[str, List[str]] = {}
    for tag in tags:
        body = release_body_for(tag)
        status, _, _ = lint_release(body, locales)
        if status != "pending":
            continue
        pend = _pending_locales(body, locales)
        if pend:
            pending_map[tag] = pend
    existing = gh(
        "issue", "list", "--state", "open", "--search",
        "in:title %s" % TRANSLATION_ISSUE_TITLE, "--json", "number", "--jq", ".[0].number",
    ).strip()
    if not pending_map:
        if existing and existing != "null":
            gh("issue", "close", existing, "--comment",
               "All release-note sections are translated — closing (issue-sync).")
            print("closed tracking issue #%s" % existing)
        else:
            print("nothing pending, no open tracking issue")
        return
    table = "| Release | Pending locales |\n| --- | --- |\n"
    table += "\n".join("| %s | %s |" % (tag, ", ".join(pend)) for tag, pend in pending_map.items())
    body_text = (
        "Release-note i18n sections still carrying placeholders (AGENTS.md §10).\n\n"
        + table
        + "\n\nFill each with `python scripts/release_notes_i18n.py set --tag <tag> "
        "--lang <locale> --file <md> --apply`, then run "
        "`python scripts/release_notes_i18n.py issue-sync` — the issue closes itself "
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


# ── self-test (hermetic; must stay in agreement with releaseI18n.test.ts) ─

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


def _sample_body(locales: Sequence[str], translations: Optional[Dict[str, str]] = None) -> str:
    return build_scaffold(SAMPLE_EN, translations or {}, locales)


def cmd_self_test(_args: argparse.Namespace) -> None:
    locales = FALLBACK_LOCALES

    def expect_violation(name: str, body: str) -> None:
        status, violations, _ = lint_release(body, locales)
        assert status == "violation", "%s: expected violation, got %s" % (name, status)
        assert violations, "%s: violation without messages" % name

    # A fully placeholder body is 'pending'; a translated one passes hard.
    assert lint_release(_sample_body(locales, {l: PENDING[l] for l in locales if l != EN}),
                        locales)[0] == "pending"
    translated = dict(PENDING)
    translated["zh-CN"] = (
        "## 更新内容\n\n### ✨ 新功能\n\n"
        "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ 为水面舰艇表格新增可选的 K/D 列。\n"
        "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 让校准编辑器舞台收进弹窗主体的高度上限内。\n\n"
        "**完整变更日志**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7"
    )
    # One real translation among placeholders: hard-clean but still 'pending'
    # overall — and a fully translated body is 'ok' (this also proves every
    # GLOSSARY locale has the heading table translators rely on).
    status, violations, _warnings = lint_release(_sample_body(locales, translated), locales)
    assert status == "pending" and not violations, (status, violations)

    def _mini(locale: str) -> str:
        return (
            "## %s\n\n### ✨ %s\n\n" % (GLOSSARY["What's Changed"][locale], GLOSSARY["✨ Features"][locale])
            + "- [#1413](https://github.com/langyo/wowsp/pull/1413) ✨ 测试译文：新增 K/D 列。\n"
            + "- [#1409](https://github.com/langyo/wowsp/pull/1409) 🐛 测试译文：修复舞台高度。\n\n"
            + "**%s**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7" % GLOSSARY["Full Changelog"][locale]
        )

    assert lint_release(
        _sample_body(locales, {l: _mini(l) for l in locales if l != EN}), locales
    )[0] == "ok"

    # S1 — a missing/foreign header means legacy: always a warning, never a
    # failure (wrapping is the Release workflow's job, not PR CI's).
    assert lint_release("plain body", locales)[0] == "legacy"
    # S2 — wrong section set/order.
    expect_violation("order", build_scaffold(SAMPLE_EN, {}, list(reversed(locales))))
    truncated = [l for l in locales if l != "es-ES"]
    expect_violation("missing-locale", build_scaffold(SAMPLE_EN, {}, truncated))
    # S3 — opener/summary/marker deviations.
    expect_violation("opener", _sample_body(locales).replace("<details open>", "<details>", 1))
    expect_violation("summary", _sample_body(locales).replace("(zh-CN)</summary>", "(zh-CN) </summary>", 1))
    expect_violation("marker", _sample_body(locales).replace("<!-- wowsp:lang zh-CN -->", "<!-- wowsp:lang zh-TW -->", 1))
    # S4 — delimiters are hard everywhere; raw HTML is a translation
    # violation but only a WARNING in the en-US source (legacy bodies
    # legitimately quote markup).
    expect_violation("closer", _sample_body(locales).replace("**Full Changelog**", "</details> **Full Changelog**", 1))
    expect_violation("html", _sample_body(locales, {**PENDING, "zh-CN": "<b>加粗</b>"}))
    en_html = lint_release(
        _sample_body(locales).replace(
            "**Full Changelog**: https://github.com/langyo/wowsp/compare/v0.6.6...v0.6.7",
            "quotes the <html> tag verbatim",
        ),
        locales,
    )
    assert en_html[0] == "pending" and not en_html[1] and en_html[2], en_html
    # S5 — subset violations in a translation (en-US legacy shapes stay legal).
    legacy_en = _sample_body(locales, {**PENDING, EN: "* legacy bullet\n\n---\n\n> quote"})
    assert lint_release(legacy_en, locales)[0] == "pending"
    fence = "\x60\x60\x60py\nx=1\n\x60\x60\x60"
    expect_violation("fence", _sample_body(locales, {**PENDING, "zh-CN": fence}))
    expect_violation("ordered", _sample_body(locales, {**PENDING, "zh-CN": "1. 第一条"}))
    expect_violation("blockquote", _sample_body(locales, {**PENDING, "zh-CN": "> 引用"}))
    expect_violation("image", _sample_body(locales, {**PENDING, "zh-CN": "![图](https://x/y.png)"}))
    expect_violation("hr", _sample_body(locales, {**PENDING, "zh-CN": "---"}))
    expect_violation("setext", _sample_body(locales, {**PENDING, "zh-CN": "更新内容\n==="}))
    # S6 — dropped URLs fail.
    expect_violation("urls", _sample_body(locales, {**PENDING, "zh-CN": "## 更新内容\n\n- 一个链接都没有"}))
    # S7 — a near-miss placeholder (edited wording) is content, must satisfy S5.
    expect_violation("near-pending", _sample_body(locales, {**PENDING, "zh-CN": "🚧 还没翻译呢（随意改写的占位句子）"}))

    # Byte-stability: set_section on one locale leaves the rest untouched.
    body = _sample_body(locales)
    rebuilt = set_section(body, "zh-CN", translated["zh-CN"], locales)
    assert parse_scaffold(rebuilt)[2] == parse_scaffold(_sample_body(locales, translated))[2]

    print("self-test: all fixtures pass")


# ── entry ─────────────────────────────────────────────────────────────────

def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(description="Internationalized GitHub release notes toolkit")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("wrap", help="wrap a published body into the i18n scaffold")
    p.add_argument("--tag")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_wrap)

    p = sub.add_parser("set", help="replace one locale's section")
    p.add_argument("--tag")
    p.add_argument("--lang", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("show", help="status table over every app release")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("lint", help="hard-validate scaffolded release bodies")
    p.add_argument("--tag")
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
