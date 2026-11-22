# Core Concepts

> **Audience**: Developers who want a conceptual understanding of WoWSP's design.

## Two modes, one binary

WoWSP is one Tauri desktop app. The same executable runs in standalone review
mode (open a replay, watch the holographic map) or in overlay mode (transparent
window over the running game). The main shell is the Vue app; the overlay
window loads a separate pre-rendered page (`overlay.html`) instead of a Vue
view.

## Data sources

| Source | Mode | What it gives WoWSP |
|---|---|---|
| `.wowsreplay` file | Review | Match descriptor (roster, map, match type) + packet stream (positions over time) |
| `tempArenaInfo.json` | Overlay | Live roster the moment a battle loads |
| `<game>/profile/clientrunner.log` | Both | Realm detection (`Selected realm:` line) |
| Windows registry + Steam manifest | Both | Game install path |
| Wargaming Public / Vortex API | Both (optional) | Per-player stats (winrate, clan, etc.) |
| WoWSP 캐시 메시 노드 | 둘 다(선택) | 같은 전적을 캐시(공식 또는 자체 호스팅)에서 제공 |

전적 조회는 사다리를 오른다: 먼저 설정된 캐시 서버(설정 ▸ 연결 ▸ 캐시 서버, 공식 노드 + 자동 발견이 검증한 커뮤니티 노드), 그다음에 기존의 프록시 → 직접 연결 체인. 캐시된 응답에는 `x-wowsp-cache: hit|miss|peer-hit` 출처 표시가 붙고, 업스트림 상태 레지스트리는 여전히 직접 경로 결과만 기록하므로 캐시 히트가 업스트림의 상태 행을 결코 부풀리지 않는다.

## Model conversion

The holographic map renders map geometry and ship hulls as GLB consumed by
three.js. The game's native asset formats are converted by Python scripts under
`scripts/model_convert/`:

- `convert_map.py` — map space data → GLB
- `convert_ship.py` — ship hull → GLB

Both pull their source assets straight from the (auto-detected or
`--game-dir`-overridden) game install and write the GLB into
`packages/webui/src/res/models/`. Adding a new map or ship is a data-only
operation: run `just convert-map --name <space_id>` (or
`just convert-ship --name <ship>`), and the frontend picks it up. No Rust or
TS changes required.

## Overlay interaction model

The overlay is invisible except while `Tab` is held. On each Tab press:

1. WoWSP captures the game window (Win32 `BitBlt`).
2. A lightweight detector locates the central team-list region.
3. The rendered roster is re-anchored to sit on top of that region.
4. On Tab release, the overlay hides again.

This keeps CPU cost near zero outside Tab presses, and re-anchors every time so
resolution / window-size changes never desync the overlay.

## Provenance

The replay-parsing, game-detection, and `tempArenaInfo.json` polling principles
are adapted from ApeRadar. The frontend shell and build infrastructure are
adapted from shittim-chest. See `LICENSE` for the SySL-1.0 terms.
