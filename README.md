<p align="center"><img src="./docs/logo.webp" alt="WoWSP" width="128" /></p>

<h1 align="center">WoWSP</h1>

<p align="center"><strong>World of WarShip Panel — replay review &amp; in-game overlay</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/langyo/wowsp/blob/master/LICENSE)
[![GitHub](https://img.shields.io/badge/github-langyo%2Fwowsp-blue.svg)](https://github.com/langyo/wowsp)

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

> [!IMPORTANT]
> **警告：本软件完全免费且开源，仅通过官方 [GitHub Releases](https://github.com/langyo/wowsp/releases) 分发。任何渠道收费出售均与作者无关——请勿付款；如已付费，请尽快申请退款并举报卖家。**
>
> **Warning: this software is completely free and open source, distributed only via the official [GitHub Releases](https://github.com/langyo/wowsp/releases). Anyone charging for it is NOT the author — do not pay; if you already have, request a refund and report the seller as soon as possible.**
>
> **Внимание: это ПО полностью бесплатно и с открытым кодом и распространяется только через официальный [GitHub Releases](https://github.com/langyo/wowsp/releases). Тот, кто его продаёт, — не автор: не платите; если уже заплатили, как можно скорее требуйте возврат средств и пожалуйтесь на продавца.**

WoWSP is a next-generation battle analysis dashboard for **World of Warships**. It runs in two modes:

1. **Standalone review** — auto-detects your game install (official WG launcher, Steam, Lesta, or 360), parses `.wowsreplay` files, and renders every ship on a holographic 3D map so you can replay a match without ever launching the game. Built on three.js with model-conversion scripts so new maps and ships can be added without touching app code.

2. **In-game overlay** — installs as a mod that auto-launches WoWSP when the game starts. A transparent overlay window detects both teams at match start and renders a roster on top of the game, shown only while you hold `Tab`. On each Tab press WoWSP captures the screen, locates the team-list region, and re-anchors the overlay to the correct position.

## Android edition

WoWSP also ships a phone edition — the same review dashboard with phone-native layouts that pulls replays straight from your desktop: the computer shows up automatically on the same Wi-Fi, or from anywhere by entering its six-digit pairing code (relayed through the built-in Cloudflare Worker at `wowsp.langyo.xyz`; source and one-command deploy instructions live in [`packages/pairing-relay`](./packages/pairing-relay/README.md)). The APK bundles the 3D model pack and the offline ship-data pack, so reviews render with no network at all once the replays are on the phone.

Building it from source needs the Android SDK + NDK 26.1 and a JDK 17 (`ANDROID_HOME` / `NDK_HOME` / `JAVA_HOME` can be overridden in the environment — see the android notes in the [`justfile`](./justfile)):

```sh
just fetch-models       # one-time ~1.3 GB model-pack download (cached, skipped when present)
just build android-apk  # arm64 debug APK; --release output is unsigned until a keystore is wired in
```

The default build targets arm64 (`aarch64`); for an emulator use `just build android --apk --target x86_64` instead.

The replay parsing, game-detection, and `tempArenaInfo.json` polling principles are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar); the frontend shell, build infrastructure, and licensing model are adapted from [shittim-chest](https://github.com/celestia-island/shittim-chest).

## Documentation

Architecture, design, and guides live under [`docs/`](./docs) in nine languages (English and 简体中文 are fully translated; the other seven mirror the English technical guides with localized index and hub pages), built with [lagrange](https://github.com/celestia-island/lagrange).

Source: [wowsp](https://github.com/langyo/wowsp).

## Status

🎉 **Ready for the initial release** — all 9 feature milestones (M1–M9) are complete: game detection, replay decoding, holographic 3D review, model converters, mod installer, live roster, Tab-triggered re-anchoring, and WG stat lookups. See [`PLAN.md`](./PLAN.md) for the roadmap history and [`docs/`](./docs) for architecture details.

## Feedback

Testing feedback is collected in our QQ group — feel free to join: **1125770228**. Report bugs, share replays, and follow development there.
