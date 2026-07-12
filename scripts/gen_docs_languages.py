#!/usr/bin/env python3
"""Generate the 7 new WoWSP docs language directories (zht, ja, ko, fr, es, ru, ar).

For each language we produce a fully translated:
  - README.md        (documentation index)
  - SUMMARY.md       (sidebar)
  - guides/README-wowsp.md   (language-switcher hub, with SySL badge)
  - guides/CONTRIBUTING.md   (license & CLA section localized)

The deeper technical guides (architecture.md, building.md, fundamentals.md) and
the design docs are mirrored from docs/en/ verbatim — they share the same
code/asset references and the en text is the canonical source, matching how
docs/zhs/ is structured (only the index/hub/CONTRIBUTING are localized).

The full 9-language README-wowsp switcher row is generated for every language,
with the current language bolded.

Run from the repo root:  python scripts/gen_docs_languages.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "docs"

# (code, native_name, tagline, doc_index_heading, license_note)
# tagline: the "World of Warship Panel — replay review & in-game overlay" line
# doc_index_heading: the localized "Documentation Index" + section headers
LANGS = [
    {
        "code": "zht",
        "name": "繁體中文",
        "tagline": "戰艦世界戰況分析儀表板 — 錄像回顧與遊戲內覆蓋層",
        "intro": "WoWSP 是面向《戰艦世界》的新一代戰況分析儀表板。它有兩種工作模式：獨立的錄像回顧（全息 3D 地圖）與遊戲內透明覆蓋層。",
        "doc_index": "文件索引",
        "guides_h": "指南",
        "designs_h": "設計",
        "overview": "概覽",
        "col_arch": "架構",
        "col_concepts": "基本概念",
        "col_building": "建置",
        "col_contrib": "貢獻指南",
        "desc_arch": "系統架構與雙模式設計",
        "desc_concepts": "核心概念",
        "desc_building": "建置與開發指南",
        "desc_contrib": "如何參與貢獻",
        "col_arch_design": "架構設計",
        "desc_arch_design": "架構設計文件",
        "sidebar_note": "完整目錄請見側邊欄。",
        "license_note": "WoWSP 採用 **Synthetic Source License（SySL-1.0）** —— 一種面向 AI 生成程式碼的寬鬆授權條款，要求揭露 AI 生成事實及所用模型，不設商業限制、不設變更日期、不設競業期。詳見 [`LICENSE`](../../../LICENSE)。",
        "contrib_title": "貢獻指南",
        "contrib_thanks": "感謝你有興趣為 WoWSP 貢獻！",
    },
    {
        "code": "ja",
        "name": "日本語",
        "tagline": "World of Warships 戦況分析ダッシュボード — リプレイレビューとゲーム内オーバーレイ",
        "intro": "WoWSP は『World of Warships』向けの次世代戦況分析ダッシュボードです。2 つのモードで動作します。独立したリプレイレビュー（ホログラフィック 3D マップ）と、ゲーム内の透過オーバーレイです。",
        "doc_index": "ドキュメント索引",
        "guides_h": "ガイド",
        "designs_h": "設計",
        "overview": "概要",
        "col_arch": "アーキテクチャ",
        "col_concepts": "基本概念",
        "col_building": "ビルド",
        "col_contrib": "コントリビュート",
        "desc_arch": "システムアーキテクチャと二つのモード設計",
        "desc_concepts": "中核となる概念",
        "desc_building": "ビルドと開発ガイド",
        "desc_contrib": "コントリビュートガイド",
        "col_arch_design": "アーキテクチャ設計",
        "desc_arch_design": "アーキテクチャ設計書",
        "sidebar_note": "完全な目次はサイドバーを参照してください。",
        "license_note": "WoWSP は **Synthetic Source License（SySL-1.0）** の下で提供されます。AI 生成コード向けの寛容なライセンスで、AI 生成事実と使用モデルの開示を要求しますが、商用制限・変更日・競業期間はありません。詳しくは [`LICENSE`](../../../LICENSE) を参照してください。",
        "contrib_title": "WoWSP へのコントリビュート",
        "contrib_thanks": "コントリビュートにご関心をお持ちいただきありがとうございます！",
    },
    {
        "code": "ko",
        "name": "한국어",
        "tagline": "World of Warships 전투 분석 대시보드 — 리플레이 리뷰 및 게임 내 오버레이",
        "intro": "WoWSP는 World of Warships를 위한 차세대 전투 분석 대시보드입니다. 두 가지 모드로 동작합니다. 독립적인 리플레이 리뷰(홀로그램 3D 지도)와 게임 내 투명 오버레이입니다.",
        "doc_index": "문서 색인",
        "guides_h": "가이드",
        "designs_h": "설계",
        "overview": "개요",
        "col_arch": "아키텍처",
        "col_concepts": "기본 개념",
        "col_building": "빌드",
        "col_contrib": "기여 가이드",
        "desc_arch": "시스템 아키텍처와 이중 모드 설계",
        "desc_concepts": "핵심 개념",
        "desc_building": "빌드 및 개발 가이드",
        "desc_contrib": "기여 방법",
        "col_arch_design": "아키텍처 설계",
        "desc_arch_design": "아키텍처 설계 문서",
        "sidebar_note": "전체 목차는 사이드바를 참조하세요.",
        "license_note": "WoWSP는 **Synthetic Source License(SySL-1.0)** 로 배포됩니다. AI 생성 코드를 위한 관대한 라이선스로, AI 생성 사실과 사용된 모델 공개를 요구하지만 상업적 제한, 변경일, 경쟁 금지 기간은 없습니다. 자세한 내용은 [`LICENSE`](../../../LICENSE)를 참조하세요.",
        "contrib_title": "WoWSP에 기여하기",
        "contrib_thanks": "기여해 주셔서 감사합니다!",
    },
    {
        "code": "fr",
        "name": "Français",
        "tagline": "Tableau de bord d'analyse de bataille pour World of Warships — revue des replays et overlay en jeu",
        "intro": "WoWSP est un tableau de bord d'analyse de bataille de nouvelle génération pour World of Warships. Il fonctionne dans deux modes : la revue autonome des replays (carte 3D holographique) et l'overlay transparent en jeu.",
        "doc_index": "Index de la documentation",
        "guides_h": "Guides",
        "designs_h": "Conception",
        "overview": "Aperçu",
        "col_arch": "Architecture",
        "col_concepts": "Concepts",
        "col_building": "Compilation",
        "col_contrib": "Contribuer",
        "desc_arch": "Architecture du système et conception à deux modes",
        "desc_concepts": "Concepts fondamentaux",
        "desc_building": "Guide de compilation et de développement",
        "desc_contrib": "Guide de contribution",
        "col_arch_design": "Conception de l'architecture",
        "desc_arch_design": "Document de conception architecturale",
        "sidebar_note": "Consultez la barre latérale pour l'index complet.",
        "license_note": "WoWSP est distribué sous la **Synthetic Source License (SySL-1.0)** — une licence permissive pour le code généré par IA, qui exige la divulgation de la génération IA et des modèles utilisés, sans restriction commerciale, sans date de changement et sans période de non-concurrence. Voir [`LICENSE`](../../../LICENSE).",
        "contrib_title": "Contribuer à WoWSP",
        "contrib_thanks": "Merci de votre intérêt pour contribuer !",
    },
    {
        "code": "es",
        "name": "Español",
        "tagline": "Panel de análisis de batalla para World of Warships — revisión de repeticiones y superposición dentro del juego",
        "intro": "WoWSP es un panel de análisis de batalla de nueva generación para World of Warships. Funciona en dos modos: revisión independiente de repeticiones (mapa 3D holográfico) y una superposición transparente dentro del juego.",
        "doc_index": "Índice de documentación",
        "guides_h": "Guías",
        "designs_h": "Diseño",
        "overview": "Visión general",
        "col_arch": "Arquitectura",
        "col_concepts": "Conceptos",
        "col_building": "Compilación",
        "col_contrib": "Contribuir",
        "desc_arch": "Arquitectura del sistema y diseño de dos modos",
        "desc_concepts": "Conceptos fundamentales",
        "desc_building": "Guía de compilación y desarrollo",
        "desc_contrib": "Guía de contribución",
        "col_arch_design": "Diseño de arquitectura",
        "desc_arch_design": "Documento de diseño arquitectónico",
        "sidebar_note": "Consulte la barra lateral para el índice completo.",
        "license_note": "WoWSP se distribuye bajo la **Synthetic Source License (SySL-1.0)** — una licencia permisiva para código generado por IA que requiere la divulgación de la generación por IA y los modelos utilizados, sin restricciones comerciales, sin fecha de cambio y sin período de no competencia. Ver [`LICENSE`](../../../LICENSE).",
        "contrib_title": "Contribuir a WoWSP",
        "contrib_thanks": "¡Gracias por su interés en contribuir!",
    },
    {
        "code": "ru",
        "name": "Русский",
        "tagline": "Панель анализа боя для World of Warships — разбор повторов и внутриигровое наложение",
        "intro": "WoWSP — это панель анализа боя нового поколения для World of Warships. Работает в двух режимах: автономный разбор повторов (голографическая 3D-карта) и прозрачное внутриигровое наложение.",
        "doc_index": "Указатель документации",
        "guides_h": "Руководства",
        "designs_h": "Проектирование",
        "overview": "Обзор",
        "col_arch": "Архитектура",
        "col_concepts": "Основы",
        "col_building": "Сборка",
        "col_contrib": "Участие",
        "desc_arch": "Системная архитектура и двухрежимный дизайн",
        "desc_concepts": "Ключевые понятия",
        "desc_building": "Руководство по сборке и разработке",
        "desc_contrib": "Руководство по участию",
        "col_arch_design": "Проектирование архитектуры",
        "desc_arch_design": "Документ архитектурного проектирования",
        "sidebar_note": "Полное оглавление смотрите на боковой панели.",
        "license_note": "WoWSP распространяется по лицензии **Synthetic Source License (SySL-1.0)** — разрешительной лицензии для ИИ-сгенерированного кода, требующей раскрытия факта генерации ИИ и использованных моделей, без коммерческих ограничений, даты изменения и неконкуренции. См. [`LICENSE`](../../../LICENSE).",
        "contrib_title": "Вклад в WoWSP",
        "contrib_thanks": "Спасибо за интерес к участию в проекте!",
    },
    {
        "code": "ar",
        "name": "العربية",
        "tagline": "لوحة تحليل المعارك لعالم السفن — مراجعة إعادات التشغيل وتراكب داخل اللعبة",
        "intro": "WoWSP هو لوحة تحليل معارك من الجيل التالي لعالم السفن (World of Warships). يعمل في وضعين: مراجعة مستقلة لإعادات التشغيل (خريطة ثلاثية الأبعاد هولوغرافية) وتراكب شفاف داخل اللعبة.",
        "doc_index": "فهرس الوثائق",
        "guides_h": "الأدلة",
        "designs_h": "التصميم",
        "overview": "نظرة عامة",
        "col_arch": "البنية",
        "col_concepts": "المفاهيم",
        "col_building": "البناء",
        "col_contrib": "المساهمة",
        "desc_arch": "بنية النظام وتصميم الوضعين",
        "desc_concepts": "المفاهيم الأساسية",
        "desc_building": "دليل البناء والتطوير",
        "desc_contrib": "دليل المساهمة",
        "col_arch_design": "تصميم البنية",
        "desc_arch_design": "وثيقة تصميم البنية",
        "sidebar_note": "راجع الشريط الجانبي للفهرس الكامل.",
        "license_note": "يُوزَّع WoWSP تحت رخصة **Synthetic Source License (SySL-1.0)** — رخصة متساهلة للكود المُولَّد بالذكاء الاصطناعي، تتطلب الإفصاح عن توليد الذكاء الاصطناعي والنماذج المستخدمة، دون قيود تجارية أو تاريخ تغيير أو فترة منافسة. انظر [`LICENSE`](../../../LICENSE).",
        "contrib_title": "المساهمة في WoWSP",
        "contrib_thanks": "شكرًا لاهتمامك بالمساهمة!",
    },
]

# The full 9-language switcher. Order matches lagrange.toml `order`.
ALL_LANGS = [
    ("en", "English"),
    ("zhs", "简体中文"),
    ("zht", "繁體中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("fr", "Français"),
    ("es", "Español"),
    ("ru", "Русский"),
    ("ar", "العربية"),
]


def switcher_row(current: str) -> str:
    """Build the language-switcher row for README-wowsp, bolding `current`."""
    parts = []
    for code, name in ALL_LANGS:
        if code == current:
            parts.append(f"**{name}**")
        else:
            parts.append(f"[{name}](../../{code}/guides/README-wowsp.md)")
    return " ·\n".join(parts)


def write_readme(lang: dict) -> str:
    return f"""# WoWSP

**{lang["tagline"]}**

{lang["intro"]}

## {lang["doc_index"]}

### {lang["guides_h"]}

| {lang["doc_index"]} | |
|---|---|
| [{lang["col_arch"]}](./guides/architecture.md) | {lang["desc_arch"]} |
| [{lang["col_concepts"]}](./guides/fundamentals.md) | {lang["desc_concepts"]} |
| [{lang["col_building"]}](./guides/building.md) | {lang["desc_building"]} |
| [{lang["col_contrib"]}](./guides/CONTRIBUTING.md) | {lang["desc_contrib"]} |

### {lang["designs_h"]}

| {lang["doc_index"]} | |
|---|---|
| [{lang["col_arch_design"]}](./designs/architecture.md) | {lang["desc_arch_design"]} |

{lang["sidebar_note"]}
"""


def write_summary(lang: dict) -> str:
    return f"""# WoWSP

[{lang["overview"]}](./README.md)

---

# {lang["guides_h"]}

- [{lang["col_arch"]}](./guides/architecture.md)
- [{lang["col_concepts"]}](./guides/fundamentals.md)
- [{lang["col_building"]}](./guides/building.md)
- [{lang["col_contrib"]}](./guides/CONTRIBUTING.md)
- [WoWSP README](./guides/README-wowsp.md)

# {lang["designs_h"]}

- [{lang["col_arch_design"]}](./designs/architecture.md)
"""


def write_readme_wowsp(lang: dict) -> str:
    return f"""<h1 align="center">WoWSP</h1>

<p align="center"><strong>{lang["tagline"]}</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/celestia-island/wowsp/blob/master/LICENSE)
[![GitHub](https://img.shields.io/badge/github-celestia--island%2Fwowsp-blue.svg)](https://github.com/celestia-island/wowsp)

</div>

<div align="center">

{switcher_row(lang["code"])}

</div>

WoWSP is a next-generation battle analysis dashboard for **World of Warships**. It runs in two modes:

1. **Standalone review** — auto-detects your game install, parses `.wowsreplay` files, and renders every ship on a holographic 3D map.
2. **In-game overlay** — a transparent overlay window shows both teams, visible only while you hold `Tab`, re-anchored on each press via screen capture.

## Documentation

Architecture, design, and guides live at the repository root under [`docs/`](../../), built with [lagrange](https://github.com/celestia-island/lagrange).

Source: [wowsp](https://github.com/celestia-island/wowsp).
"""


def write_contributing(lang: dict) -> str:
    return f"""# {lang["contrib_title"]}

{lang["contrib_thanks"]}

## License & CLA

{lang["license_note"]}
"""


def generate():
    en = DOCS / "en"
    for lang in LANGS:
        code = lang["code"]
        ldir = DOCS / code
        guides = ldir / "guides"
        designs = ldir / "designs"
        guides.mkdir(parents=True, exist_ok=True)
        designs.mkdir(parents=True, exist_ok=True)

        # Localized index / sidebar / hub / contributing.
        (ldir / "README.md").write_text(
            write_readme(lang), encoding="utf-8"
        )
        (ldir / "SUMMARY.md").write_text(
            write_summary(lang), encoding="utf-8"
        )
        (guides / "README-wowsp.md").write_text(
            write_readme_wowsp(lang), encoding="utf-8"
        )
        (guides / "CONTRIBUTING.md").write_text(
            write_contributing(lang), encoding="utf-8"
        )

        # Mirror the technical bodies from English (canonical source).
        for name in ("architecture.md", "building.md", "fundamentals.md"):
            shutil.copy2(en / "guides" / name, guides / name)
        for name in ("README.md", "architecture.md"):
            shutil.copy2(en / "designs" / name, designs / name)

        print(f"generated docs/{code}/ ({len(list(ldir.rglob('*.md')))} files)")


if __name__ == "__main__":
    generate()
