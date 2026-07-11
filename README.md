<h1 align="center">WoWSP</h1>

<p align="center"><strong>World of WarShip Panel — replay review &amp; in-game overlay</strong></p>

<div align="center">

[![License](https://img.shields.io/badge/license-SySL--1.0-blue.svg)](https://github.com/celestia-island/wowsp/blob/master/LICENSE)
[![GitHub](https://img.shields.io/badge/github-celestia--island%2Fwowsp-blue.svg)](https://github.com/celestia-island/wowsp)

</div>

<div align="center">

**English** ·
[简体中文](./docs/zhs/guides/README-wowsp.md) ·
[繁體中文](./docs/zht/guides/README-wowsp.md) ·
[日本語](./docs/ja/guides/README-wowsp.md) ·
[한국어](./docs/ko/guides/README-wowsp.md) ·
[Français](./docs/fr/guides/README-wowsp.md) ·
[Español](./docs/es/guides/README-wowsp.md) ·
[Русский](./docs/ru/guides/README-wowsp.md) ·
[العربية](./docs/ar/guides/README-wowsp.md)

</div>

WoWSP is a next-generation battle analysis dashboard for **World of Warships**. It runs in two modes:

1. **Standalone review** — auto-detects your game install (official WG launcher, Steam, Lesta, or 360), parses `.wowsreplay` files, and renders every ship on a holographic 3D map so you can replay a match without ever launching the game. Built on three.js with model-conversion scripts so new maps and ships can be added without touching app code.

2. **In-game overlay** — installs as a mod that auto-launches WoWSP when the game starts. A transparent overlay window detects both teams at match start and renders a roster on top of the game, shown only while you hold `Tab`. On each Tab press WoWSP captures the screen, locates the team-list region, and re-anchors the overlay to the correct position.

The replay parsing, game-detection, and `tempArenaInfo.json` polling principles are adapted from [ApeRadar (海猴雷达)](https://github.com/zylalx1/ApeRadar); the frontend shell, build infrastructure, and licensing model are adapted from [shittim-chest](https://github.com/celestia-island/shittim-chest).

## Documentation

Architecture, design, and guides live under [`docs/`](./docs) (English + 简体中文), built with [lagrange](https://github.com/celestia-island/lagrange).

Source: [wowsp](https://github.com/celestia-island/wowsp).

## Status

🚧 **Active scaffold** — this repository is on the `dev` branch with the build infrastructure, documentation framework, and feature skeletons in place. The functional implementations (real detection, replay packet decoding, three.js rendering, overlay capture) land incrementally on `dev`. See [`PLAN.md`](./PLAN.md) for the roadmap.
