<p align="center"><img src="./docs/logo.webp" alt="WoWSP" width="128" /></p>

<h1 align="center">WoWSP</h1>

<p align="center"><strong>Free, open-source battle panel for World of Warships — replay review, in-game overlay, live battle intel, and full stats, for Windows and Android.</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

**English** ·
[简体中文](./docs/zh-CN/guides/README-wowsp.md) ·
[繁體中文](./docs/zh-TW/guides/README-wowsp.md) ·
[日本語](./docs/ja/guides/README-wowsp.md) ·
[한국어](./docs/ko/guides/README-wowsp.md) ·
[Français](./docs/fr/guides/README-wowsp.md) ·
[Español](./docs/es/guides/README-wowsp.md) ·
[Русский](./docs/ru/guides/README-wowsp.md) ·
[العربية](./docs/ar/guides/README-wowsp.md)

</div>

![WoWSP dashboard](./docs/en/screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP is completely free and open source, distributed only via the official [GitHub Releases](https://github.com/langyo/wowsp/releases). Anyone charging money for it is not the author — do not pay; if you already have, request a refund and report the seller.**

WoWSP is a desktop panel for **World of Warships** on Windows, with an Android companion. It auto-detects your game install — Wargaming Game Center, Steam, Lesta, or 360 — and follows you through the whole loop: reviewing the match afterwards, watching it live, and reading the odds while you play.

## What's inside

- **Replay review** — open any `.wowsreplay` and re-watch the match on a holographic 3D map: every ship's track, shells, torpedoes, and plane squadrons, range rings, cyclone weather, and cap-zone simulation. Free-orbit, original-recorder, and follow-a-ship cameras; map labels that keep themselves readable; and per-player battle results (ribbons, achievements, damage composition) beside the map. Every panel exports a share shot that can mask nicknames, and the library filters by mode, date, and archive state.
- **In-game overlay** — hold `Tab` in battle to layer both teams' roster and stats over the match; it re-anchors on every press. Personal-rating tiers and winrate colors, seal stamps, sunk-row tinting, team summaries, and hold-Tab consumable intel. Stats render either in a transparent window over the detected table or inside the game itself through the bundled first-party plugin, with row matching tuned per client (Wargaming, Lesta, and the CN client).
- **Live battle monitor** — from loading screen to results screen, watch the battle unfold: full rosters with PR tiers and clan tags, tier-weighted team winrate, combat cards, and a live personal battle report tracking your own damage, achievements, and kill attribution.
- **Stats dashboard & playtime** — your own "water meter": personal rating, winrate, and average damage cards with date ranges, ship-distribution charts (tier histogram, class and nation donuts), ranked-season history, and multi-account switching. A dedicated playtime view turns your replay files into a battle-calendar heatmap with a year switcher.
- **Player & clan lookup** — search any player or clan (pinyin-aware), read career cards and clan rosters with share shots, and cross-match Clan Battles rosters across servers.
- **Ship encyclopedia & build planner** — the full tech tree with a Wargaming/Lesta branch switch, specs and armor views, per-ship server trends, 3D model stages for ships and planes, and a build planner that projects captain skills, commanders, signals, and upgrades into final specs with credit/XP cost math.
- **Mod hub** — a curated marketplace of community mods across function, texture, and voice (ship skins, Wwise voice packs with previews), with install presets, one-click safe mode, conflict warnings, stale-mod migration, texture-override analysis, and batch updates.
- **Tactics board** *(in development)* — a tactical plan editor over the bundled battle-map catalog: a 20-minute planning clock, unit tracks, action timelines, and shareable plan sets.
- **Android companion** — pair your phone over Wi-Fi (auto-discovery) or from anywhere via a six-digit pairing code through the built-in relay, pull replays straight from your desktop, and review them on the go.

Under the hood it stays a native citizen: mirror-racing auto-updates (portable installs supported), a tray panel, an onboarding wizard, in-app announcements, and a feedback form with log export; themes, wallpapers, UI opacity, font-size, and DPI controls; nine UI languages; minimal anonymous telemetry you can switch off; and a bundled WebView2 that degrades gracefully when missing.

## Download

Windows 10/11 — grab the latest `WoWSP_<version>_x64-installer-webview2.exe` from [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) (WebView2 is bundled), or use the mirror-aware [download page](https://wowsp.langyo.xyz/download) if GitHub is slow where you are. The Android edition is built from source — see the [building guide](./docs/en/guides/building.md).

Screenshots of every view, in every UI language, are on the [website gallery](https://wowsp.langyo.xyz/#gallery).

## Documentation

Architecture, design notes, and guides live in [`docs/`](./docs) in nine languages (English and 简体中文 fully translated), built with [lagrange](https://github.com/celestia-island/lagrange). WoWSP reports minimal anonymous usage telemetry — exactly what is collected (and never collected) is documented in the [telemetry notice](./docs/en/license/usage-telemetry.md).

## Feedback & credits

Bugs and testing feedback: QQ group **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**, or the feedback form on the [website](https://wowsp.langyo.xyz). Replay parsing and game-detection principles are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar); the frontend shell and build infrastructure are adapted from [shittim-chest](https://github.com/celestia-island/shittim-chest).

## License

WoWSP is licensed under the **Synthetic Source License 1.0** ([full text](./LICENSE)) — Apache-2.0-equivalent grants for a substantially AI-generated codebase, whose only extra obligation is keeping the AI-generation disclosure notice on every copy and derivative. The vendored [wows-toolkit](./packages/tools/wowsunpack-vendor) snapshot keeps its upstream **MIT** license; everything else in this repository — including the standalone [pairing-relay](./packages/pairing-relay) worker — is covered by SySL-1.0.

## Support

WoWSP is and stays free. If it has earned it and you want to help, the author's afdian page is **[afdian.com/a/langyo](https://afdian.com/a/langyo)** — **every donation goes entirely to the AI costs of developing WoWSP** (model calls and code-generation tooling).

To keep the responsibilities clear:

- Donating is completely optional and never required — every feature is free, and the app will never embed features that require a donation.
- A donation is a voluntary gift: it creates no employment, commissioning, or other legal relationship, and carries no claim on specific features, delivery timelines, or refunds.
- The project stays open source under the license above, for everyone — donors and non-donors alike.
- WoWSP is an independent, unofficial project with no direct relationship with Wargaming, Lesta, or 360.
