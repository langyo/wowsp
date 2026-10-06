<h1 align="center">WoWSP</h1>

<p align="center"><strong>Free, open-source battle panel for World of Warships — replay review, in-game roster overlay, and stats lookup, for Windows.</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![Release](https://img.shields.io/github/v/release/langyo/wowsp)](https://github.com/langyo/wowsp/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/langyo/wowsp/total)](https://github.com/langyo/wowsp/releases)

</div>

<div align="center">

**English** ·
[简体中文](../../zh-CN/guides/README-wowsp.md) ·
[繁體中文](../../zh-TW/guides/README-wowsp.md) ·
[日本語](../../ja/guides/README-wowsp.md) ·
[한국어](../../ko/guides/README-wowsp.md) ·
[Français](../../fr/guides/README-wowsp.md) ·
[Español](../../es/guides/README-wowsp.md) ·
[Русский](../../ru/guides/README-wowsp.md) ·
[العربية](../../ar/guides/README-wowsp.md)

</div>

![WoWSP dashboard](../screenshots/dashboard.webp)

> [!IMPORTANT]
> **WoWSP is completely free and open source, distributed only via the official [GitHub Releases](https://github.com/langyo/wowsp/releases). Anyone charging money for it is not the author — do not pay; if you already have, request a refund and report the seller.**

WoWSP is a desktop panel for **World of Warships** on Windows. It auto-detects your game install (Wargaming launcher, Steam, Lesta, or 360) and works in two modes:

- **Standalone review** — open any `.wowsreplay` and re-watch the match on a holographic 3D map: every ship's track, shells, torpedoes, and planes, plus per-player battle results, without ever launching the game.
- **In-game overlay** — while the game runs, hold `Tab` to see both teams' roster and stats layered on top of the match; the overlay re-anchors itself on every press.

Around those two it also gives you:

- Player and clan stats lookup with water-meter career cards.
- A ship encyclopedia with the full tech tree, specs, and armor viewer.
- A mod hub and resource center for popular community mods.
- An Android companion that pulls replays straight from your desktop over Wi-Fi, or from anywhere via a six-digit pairing code.

## Download

Windows 10/11 — grab the latest `WoWSP_<version>_x64-setup-webview2.exe` from [GitHub Releases](https://github.com/langyo/wowsp/releases/latest) (WebView2 is bundled), or use the mirror-aware [download page](https://wowsp.langyo.xyz/download) if GitHub is slow where you are. The Android edition is built from source — see the [building guide](building.md).

Screenshots of every view, in every UI language, are on the [website gallery](https://wowsp.langyo.xyz/#gallery).

## Documentation

Architecture, design notes, and guides live in [`docs/`](../../) in nine languages (English and 简体中文 fully translated), built with [lagrange](https://github.com/celestia-island/lagrange). WoWSP reports minimal anonymous usage telemetry — exactly what is collected (and never collected) is documented in the [telemetry notice](../license/usage-telemetry.md).

## Feedback & credits

Bugs and testing feedback: QQ group **[1125770228](https://qm.qq.com/cgi-bin/qm/qr?k=b6kMIecv3d390ecZVWNQNWMFfLRVgcQ9&jump_from=webapi&authKey=NhNLVnIcIlmfnnDUCjpsra4C/zfciS1sYNjm5SV7x2RPhdP1CzOM91ObP9y9MMQV)**, or the feedback form on the [website](https://wowsp.langyo.xyz). Replay parsing and game-detection principles are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar); the frontend shell and build infrastructure are adapted from [shittim-chest](https://github.com/celestia-island/shittim-chest).

## License

WoWSP is licensed under the **Synthetic Source License 1.0** ([full text](https://github.com/langyo/wowsp/blob/master/LICENSE)) — Apache-2.0-equivalent grants for a substantially AI-generated codebase, whose only extra obligation is keeping the AI-generation disclosure notice on every copy and derivative. The vendored [wows-toolkit](https://github.com/langyo/wowsp/tree/master/packages/tools/wowsunpack-vendor) snapshot and the standalone [pairing-relay](https://github.com/langyo/wowsp/tree/master/packages/pairing-relay) worker keep their upstream **MIT** licenses.
