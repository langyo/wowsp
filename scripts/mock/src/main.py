"""WoWSP mock backend — FastAPI.

Mirrors the Tauri command surface (see `packages/webui/src/rpc.ts`) over HTTP
under `/api/<cmd>`, so the frontend can develop in a browser (`just dev --mock`)
without the game or the Tauri shell. The webui's `WebTransport` calls these
endpoints; see `packages/webui/src/transport/web.ts`.

Run:
    cd scripts/mock && PYTHONPATH=src python -m uvicorn main:app --port 8787
"""
from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="WoWSP mock backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

# A sample roster matching tempArenaInfo.json shape. Enough to render both
# teams in the overlay view during mock development.
_SAMPLE_ROSTER = [
    {"id": 1, "name": "Player1", "relation": "0", "shipId": "4183305088", "shipName": "Yamato"},
    {"id": 2, "name": "Player2", "relation": "0", "shipId": "4273848496", "shipName": "Montana"},
    {"id": 3, "name": "Player3", "relation": "0", "shipId": "4285609360", "shipName": "Gearing"},
    {"id": 4, "name": "Enemy1", "relation": "2", "shipId": "4183305088", "shipName": "Yamato"},
    {"id": 5, "name": "Enemy2", "relation": "2", "shipId": "4273848496", "shipName": "Montana"},
    {"id": 6, "name": "Enemy3", "relation": "2", "shipId": "4285609360", "shipName": "Gearing"},
]


def _sample_meta(path: str) -> dict[str, Any]:
    return {
        "path": path,
        "matchGroup": "pvp",
        "dateTime": "12.07.2026 21:45:00",
        "mapId": "spaces/17_NE_ice_islands",
        "mapName": "Ice Islands",
        "vehicles": _SAMPLE_ROSTER,
        "raw": {"vehicles": _SAMPLE_ROSTER},
    }


# --- Commands mirrored from rpc.ts -------------------------------------------

@app.get("/api/get_os_preferences")
async def cmd_get_os_preferences() -> dict:
    return {"locale": os.environ.get("LANG", "en"), "colorScheme": "dark"}


@app.get("/api/detect_game_install")
async def cmd_detect_game_install() -> list[dict]:
    # Pretend we found nothing — the webui shows the "set path manually" state.
    return []


@app.post("/api/set_game_path")
async def cmd_set_game_path(request: Request) -> dict:
    body = await request.json()
    return {"kind": "manual", "path": body.get("path", ""), "realm": "asia"}


@app.get("/api/is_game_running")
async def cmd_is_game_running() -> bool:
    return False


@app.post("/api/get_game_process")
async def cmd_get_game_process() -> dict:
    # Mock: game not running. The webui renders the "offline" state.
    return {
        "running": False,
        "pid": None,
        "kind": None,
        "realm": None,
        "exePath": None,
        "matchedInstall": None,
    }


@app.get("/api/list_replays")
async def cmd_list_replays() -> list[str]:
    return [str(p) for p in sorted(FIXTURES.glob("*.wowsreplay"))] or [
        "fixtures/sample.wowsreplay"
    ]


@app.post("/api/read_replay_header")
async def cmd_read_replay_header(request: Request) -> dict:
    body = await request.json()
    return _sample_meta(body.get("path", "fixtures/sample.wowsreplay"))


@app.post("/api/read_temp_arena_info")
async def cmd_read_temp_arena_info() -> dict | None:
    return {
        "matchGroup": "pvp",
        "dateTime": "12.07.2026 21:45:00",
        "vehicles": _SAMPLE_ROSTER,
        "raw": {"vehicles": _SAMPLE_ROSTER},
    }


@app.post("/api/start_arena_watcher")
async def cmd_start_arena_watcher() -> None:
    return None


@app.post("/api/stop_arena_watcher")
async def cmd_stop_arena_watcher() -> None:
    return None


@app.post("/api/capture_game_window")
async def cmd_capture_game_window() -> dict:
    # 1x1 transparent PNG, base64 — matches the Rust skeleton.
    png = bytes(
        [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
            0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54,
            0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
            0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82,
        ]
    )
    return {"imageBase64": base64.b64encode(png).decode(), "rosterRect": None}


@app.post("/api/set_overlay_visible")
async def cmd_set_overlay_visible() -> None:
    return None


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WOWSP_MOCK_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)
