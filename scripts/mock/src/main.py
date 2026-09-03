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
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="WoWSP mock backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def wg_to_short_code(wg: str) -> str:
    """Map a WG API language code to the app's internal locale short-code.

    WG codes like "zh-cn" and "zh-sg" both resolve to "zhs" (Simplified
    Chinese). The compound tag used for cache/file naming is
    ``<short_code>-<realm>`` (e.g. "zhs-asia", "zht-asia", "en-asia").
    """
    _MAP = {
        "zh-cn": "zhs",
        "zh-sg": "zhs",
        "zh-tw": "zht",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
        "ru": "ru",
        "fr": "fr",
        "es": "es",
    }
    return _MAP.get(wg, "en")

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
    # Pretend a Steam install exists so the replay list loads in the browser.
    return [{"kind": "steam", "path": "D:/Games/World_of_Warships", "realm": "asia"}]


@app.post("/api/list_replays_meta")
async def cmd_list_replays_meta(request: Request) -> list[dict]:
    dump = _load_replay_dump()
    if dump is not None:
        meta = dump["meta"]
        return [{
            "path": meta["path"],
            "dateTime": meta.get("dateTime"),
            "matchGroup": meta.get("matchGroup"),
            "mapName": meta.get("mapName"),
            "mapId": meta.get("mapId"),
            "ownShipId": 4183305088,
            "ownShipName": "Yamato",
            "playerCount": len(meta.get("vehicles", [])),
        }]
    return [
        {
            "path": "fixtures/sample.wowsreplay",
            "dateTime": "20260712_214500",
            "matchGroup": "pvp",
            "mapName": "17_NA_fault_line",
            "mapId": 17,
            "ownShipId": 4183305088,
            "ownShipName": "Yamato",
            "playerCount": 6,
        }
    ]


@app.post("/api/set_game_path")
async def cmd_set_game_path(request: Request) -> dict:
    body = await request.json()
    return {"kind": "manual", "path": body.get("path", ""), "realm": "asia"}


@app.post("/api/ribbon_skin_dir")
async def cmd_ribbon_skin_dir(request: Request):
    body = await request.json()
    game = body.get("gamePath", "")
    # Real mods live under <game>/res_mods/<ver>/gui/ribbons — surface them
    # when present so the browser preview matches the desktop shell.
    from pathlib import Path

    root = Path(game) / "res_mods"
    if not root.is_dir():
        return None
    hits = [p for p in root.rglob("gui/ribbons") if p.is_dir()]
    if not hits:
        return None
    hits.sort(key=lambda p: len(p.parts), reverse=True)
    return str(hits[0])




# ── Mod Hub (M10 groundwork): thin re-implementation of the Rust
# classifier rules from commands/mod_hub.rs so the browser preview can drive
# the same UI flow against the mock appdata sandbox.
_MOCK_INSTALLED = [
    {"kind": "voice", "name": "Hoshino", "detail": "Hoshino",
     "relPath": "banks/mods/Hoshino"},
    {"kind": "voice", "name": "OTTO Ver1.0", "detail": "OTTO Ver1.1",
     "relPath": "banks/Mods/OTTO Ver1.0"},
    {"kind": "skin", "name": "Hina_Moskva", "detail": "RSC110_Pr_66_Moskva",
     "relPath": "PnFMods/Hina_Moskva"},
    {"kind": "gui", "name": "ribbons", "detail": None, "relPath": "gui/ribbons"},
    {"kind": "patch", "name": "ime_config.xml", "detail": None,
     "relPath": "ime_config.xml"},
]


@app.post("/api/mod_hub_scan_installed")
async def cmd_mod_hub_scan_installed(request: Request) -> list[dict]:
    return _MOCK_INSTALLED


@app.post("/api/mod_hub_classify_path")
async def cmd_mod_hub_classify_path(request: Request) -> dict:
    body = await request.json()
    src = body.get("sourcePath", "")
    low = src.lower().replace("\\", "/")
    if low.endswith(".zip") or low.endswith(".7z"):
        raise HTTPException(status_code=400, detail=(
            "archive payloads need M10.2 unpack support — extract it to a folder first"))
    if low.endswith("语音包") or "/mika" in low or "voice" in low:
        return {
            "kind": "voice", "name": src.rstrip("/\\").rsplit("/", 1)[-1],
            "detail": None,
            "entries": [{"fromRel": ".", "toRel": "banks/mods/MockVoice"}],
            "warnings": ["bare voice pack wrapped into banks/mods"],
        }
    return {
        "kind": "textures", "name": src.rstrip("/\\").rsplit("/", 1)[-1],
        "detail": None,
        "entries": [
            {"fromRel": "content", "toRel": "content"},
            {"fromRel": "PnFMods", "toRel": "PnFMods"},
        ],
        "warnings": ["mock plan — real classification runs in the desktop shell"],
    }


@app.post("/api/mod_hub_install")
async def cmd_mod_hub_install(request: Request) -> dict:
    body = await request.json()
    plan = body.get("plan", {})
    return {
        "name": plan.get("name", "?"), "binVersion": "12668706",
        "wroteFiles": sum(len(e.get("fromRel", "")) for e in plan.get("entries", [])) or 3,
        "warnings": plan.get("warnings", []),
    }


# ── Mod Hub online catalog (commands/mod_catalog.rs): serves a miniature
# mod-index.json so the browser preview can render the catalog grid.
_MOCK_CATALOG = {
    "sourceVersion": "v.15.7.0 #10 (mock)",
    "gameVersion": "15.7.0",
    "fetchedAt": "2026-09-01T00:00:00Z",
    "mods": [
        {
            "id": "ui-timers-shot-timer", "category": "battle",
            "discussion": 91, "version": "15.7.0.10",
            "game": ">=15.7 <15.8",
            "title": "Shot Timer / 开火后倒计时20s",
            "nameZh": "开火后倒计时20s", "nameEn": "Shot Timer",
            "description": "Counts down the 20s detection window after firing main guns.",
            "authorUrl": "",
            "i18n": {
                "en-US": {"name": "Shot Timer", "description": "Counts down the 20s detection window after firing main guns."},
                "zh-CN": {"name": "开火后倒计时20s", "description": "主炮开火被点亮后按 20 秒倒计时提示灭点。"},
            },
            "packages": [{"url": "https://example.com/a.zip", "sha256": "",
                          "size": 13312, "name": "a.zip"}],
        },
        {
            "id": "port-mods-sessionstats-ollin", "category": "port",
            "discussion": 92, "version": "15.7.0.10",
            "game": ">=15.7 <15.8",
            "title": "Session Stats v2 / 战报统计",
            "nameZh": "战报统计", "nameEn": "Session Stats v2",
            "description": "Per-session battle statistics right in the port.",
            "authorUrl": "",
            "i18n": {
                "en-US": {"name": "Session Stats v2", "description": "Per-session battle statistics right in the port."},
                "zh-CN": {"name": "战报统计v2", "description": "在港口直接查看本时段的战报统计。"},
            },
            "packages": [{"url": "https://example.com/b.zip", "sha256": "",
                          "size": 87040, "name": "b.zip"}],
        },
    ],
}
_MOCK_RECORDS: list[dict] = []


@app.post("/api/mod_catalog_refresh")
async def cmd_mod_catalog_refresh(request: Request) -> dict:
    return _MOCK_CATALOG


@app.post("/api/mod_catalog_install")
async def cmd_mod_catalog_install(request: Request) -> dict:
    body = await request.json()
    mod_id = body.get("modId", "?")
    entry = next((m for m in _MOCK_CATALOG["mods"] if m["id"] == mod_id), None)
    _MOCK_RECORDS[:] = [r for r in _MOCK_RECORDS if r["id"] != mod_id]
    _MOCK_RECORDS.append({
        "id": mod_id, "name": entry["nameEn"] if entry else mod_id,
        "version": entry["version"] if entry else "0", "category": "battle",
        "source": "mod-hub", "discussion": entry["discussion"] if entry else None,
        "binVersion": "12668706", "installedAt": "2026-09-01T00:00:00Z",
        "files": ["res_mods/dummy.xml"], "restoreDir": None,
    })
    return {"name": entry["nameEn"] if entry else mod_id, "binVersion": "12668706",
            "wroteFiles": 4, "warnings": ["mock install — nothing was downloaded"]}


@app.post("/api/mod_catalog_uninstall")
async def cmd_mod_catalog_uninstall(request: Request) -> dict:
    body = await request.json()
    mod_id = body.get("modId", "?")
    _MOCK_RECORDS[:] = [r for r in _MOCK_RECORDS if r["id"] != mod_id]
    return {"id": mod_id, "name": mod_id, "removedFiles": 1, "restoredFiles": 0}


@app.post("/api/mod_hub_records")
async def cmd_mod_hub_records() -> list[dict]:
    return _MOCK_RECORDS


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


@app.post("/api/lookup_player_stats")
async def cmd_lookup_player_stats(request: Request) -> dict:
    body = await request.json()
    name = body.get("name", "Unknown")
    return {
        "accountId": 2024711808,
        "name": name,
        "realm": body.get("realm", "asia"),
        "battles": 1234,
        "winrate": 54.3,
        "hidden": False,
        "clanTag": "MOCK",
        "avgDamage": 45210,
        "avgXp": 1120,
        "kdRatio": 1.62,
        "survivalRate": 41.5,
        "hitRate": 33.1,
        "pr": 1620,
        "shipsPlayed": 87,
        "levelingTier": 12,
        "levelingPoints": 3400,
    }


@app.post("/api/lookup_player_ship_stats")
async def cmd_lookup_player_ship_stats(request: Request) -> list:
    body = await request.json()
    return [
        {"shipId": 4265588720, "name": "Nagato", "battles": 320, "wins": 176,
         "damageCaused": 0, "frags": 0, "survivedBattles": 120,
         "winrate": 55.0, "avgDamage": 68200, "lastBattleTime": 0},
        {"shipId": 4287542992, "name": "Zao", "battles": 210, "wins": 110,
         "damageCaused": 0, "frags": 0, "survivedBattles": 80,
         "winrate": 52.4, "avgDamage": 78500, "lastBattleTime": 0},
        {"shipId": 4078352176, "name": "U-69", "battles": 150, "wins": 68,
         "damageCaused": 0, "frags": 0, "survivedBattles": 55,
         "winrate": 45.3, "avgDamage": 21000, "lastBattleTime": 0},
        {"shipId": 4267685872, "name": "Shinano", "battles": 40, "wins": 18,
         "damageCaused": 0, "frags": 0, "survivedBattles": 10,
         "winrate": 45.0, "avgDamage": 0, "lastBattleTime": 0},
    ]


@app.get("/api/list_replays")
async def cmd_list_replays() -> list[str]:
    return [str(p) for p in sorted(FIXTURES.glob("*.wowsreplay"))] or [
        "fixtures/sample.wowsreplay"
    ]


@app.post("/api/read_replay_header")
async def cmd_read_replay_header(request: Request) -> dict:
    body = await request.json()
    dump = _load_replay_dump()
    if dump is not None:
        return dump["meta"]
    return _sample_meta(body.get("path", "fixtures/sample.wowsreplay"))


_REPLAY_DUMP: dict[str, Any] | None = None


def _load_replay_dump() -> dict[str, Any] | None:
    """Optional real replay dump (header + trajectories) placed at
    `fixtures/replay_dump.json` — produced by the `dump_replay_json` Rust test.
    Lets the holographic map render a real match in the browser."""
    global _REPLAY_DUMP
    if _REPLAY_DUMP is None:
        p = FIXTURES / "replay_dump.json"
        if p.exists():
            _REPLAY_DUMP = json.loads(p.read_text(encoding="utf-8"))
    return _REPLAY_DUMP


@app.post("/api/read_replay_positions")
async def cmd_read_replay_positions(request: Request) -> dict:
    dump = _load_replay_dump()
    if dump is not None:
        return {
            "trajectories": dump.get("trajectories", []),
            "explosions": dump.get("explosions", []),
            "torpedoes": dump.get("torpedoes", []),
            "weaponLocks": dump.get("weaponLocks", []),
            "battleResults": dump.get("battleResults"),
            "version": dump.get("version"),
            "mapName": dump.get("mapName"),
            "camera": dump.get("camera", []),
            "netStats": dump.get("netStats", []),
            "leaves": dump.get("leaves", {}),
            "cameraModes": dump.get("cameraModes", []),
            "diagnostics": dump.get("diagnostics", {}),
            "squadronCreates": dump.get("squadronCreates", []),
            "squadronPlanes": dump.get("squadronPlanes", []),
        }
    return {
        "trajectories": [],
        "explosions": [],
        "torpedoes": [],
        "weaponLocks": [],
        "battleResults": None,
        "version": None,
        "mapName": None,
        "camera": [],
        "netStats": [],
        "leaves": {},
        "cameraModes": [],
        "diagnostics": {},
        "squadronCreates": [],
        "squadronPlanes": [],
    }


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


# --- Encyclopedia (ships page) -------------------------------------------
# The mock builds ShipInfo[] from the bundled tech_tree.json (real ship ids,
# names, tiers, types, nations) so the ships view has realistic content in a
# browser. default_profile is a minimal synthetic block; images fall back to
# the WG CDN URL the real backend would return.

_TECH_TREE_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages" / "webui" / "src" / "data" / "tech_tree.json"
)
_RARITY_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages" / "webui" / "src" / "data" / "ship_rarity.json"
)
_SHIP_MODELS_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages" / "webui" / "src" / "data" / "ship_models.json"
)
_SHIP_NAMES_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages" / "webui" / "src" / "data" / "ship_names.json"
)


def _load_encyclopedia() -> list[dict[str, Any]]:
    import json

    tree = {}
    if _TECH_TREE_PATH.exists():
        tree = json.loads(_TECH_TREE_PATH.read_text(encoding="utf-8"))
    rarity = {}
    if _RARITY_PATH.exists():
        rarity = json.loads(_RARITY_PATH.read_text(encoding="utf-8"))
    ships: list[dict[str, Any]] = []
    seen: set[int] = set()
    for node in tree.values():
        sid_raw = node.get("shipId")
        if sid_raw is None:
            continue
        # Normalize to int: tech_tree.json mixes string/number shipIds and the
        # webui's ShipInfo contract (and its byId Map<number> lookup) requires
        # a JSON number.
        sid = int(sid_raw)
        seen.add(sid)
        ships.append({
            "shipId": sid,
            "name": node.get("name", "").replace("IDS_", ""),
            "tier": node.get("tier", 1),
            "type": node.get("type", "Cruiser"),
            "nation": node.get("nation", "usa"),
            "isPremium": node.get("isPremium", False),
            "isSpecial": node.get("isSpecial", False),
            "description": "",
            "gameVersion": "mock",
            "defaultProfile": {
                "hull": {"health": 30000 + node.get("tier", 1) * 5000},
                "mobility": {"max_speed": 30},
                "concealment": {"detect_distance_by_ship": 12},
            },
            "images": {
                "small": f"https://vignette.wikia.nocookie.net/x/{sid}.png",
                "medium": f"https://vignette.wikia.nocookie.net/x/{sid}.png",
                "large": f"https://vignette.wikia.nocookie.net/x/{sid}.png",
                "contour": "",
            },
        })
    # Merge the offline ship-name DB (GameParams + game gettext catalogs) so
    # premium/special/event ships absent from the tech tree still resolve
    # real names, tiers and classes in replay labels.
    if _SHIP_NAMES_PATH.exists():
        import json as _json
        names_db = _json.loads(_SHIP_NAMES_PATH.read_text(encoding="utf-8"))
        for sid_str, entry in names_db.items():
            try:
                sid = int(sid_str)
            except ValueError:
                continue
            if sid in seen:
                continue
            seen.add(sid)
            name = entry.get("names", {}).get("en") or next(iter(entry.get("names", {}).values()), "")
            hp = entry.get("hp") or 30000
            ships.append({
                "shipId": sid,
                "name": name,
                "tier": entry.get("tier") or 5,
                "type": entry.get("type") or "Cruiser",
                "nation": entry.get("nation") or "usa",
                "isPremium": True,
                "isSpecial": False,
                "description": "",
                "gameVersion": "mock",
                "defaultProfile": {
                    "hull": {"health": hp},
                    "mobility": {"max_speed": 30},
                    "concealment": {"detect_distance_by_ship": 12},
                },
                "images": {"small": "", "medium": "", "large": "", "contour": ""},
            })
    return ships


@app.post("/api/get_game_version")
async def cmd_get_game_version() -> dict:
    return {"gameVersion": "mock-0.0.0", "shipsTotal": 0, "timestamp": 0}


@app.post("/api/get_ship_encyclopedia")
async def cmd_get_ship_encyclopedia(request: Request) -> list[dict[str, Any]]:
    body = await request.json()
    realm = body.get("realm", "asia")
    lang = body.get("language", "en")
    # The frontend sends a WG language code; convert to short-code+realm
    # for internal compound tagging (matching the Rust resolve_encyclopedia_language).
    short = wg_to_short_code(lang)
    compound = f"{short}-{realm}"
    print(f"[mock] get_ship_encyclopedia realm={realm} wg={lang} compound={compound}")
    return _load_encyclopedia()


# AppData sandbox: serves files from fixtures/appdata/<file> (path-traversal
# safe) so browser-side flows (account switcher, stats cache) can be
# exercised against realistic data. Mirrors the Tauri appdata_read.

_APPDATA_SANDBOX = Path(__file__).resolve().parent.parent / "fixtures" / "appdata"


@app.post("/api/appdata_read")
async def cmd_appdata_read(payload: dict) -> str | None:
    file = payload.get("file")
    if not file or isinstance(file, str) is False:
        return None
    target = (_APPDATA_SANDBOX / file).resolve()
    try:
        target.relative_to(_APPDATA_SANDBOX.resolve())
    except ValueError:
        return None
    if not target.is_file():
        return None
    return target.read_text(encoding="utf-8")


# --- Ship GameParams (detail modal armor/ballistics tab) ------------------
# Serves a real trimmed GameParams subtree for Yamato (the canonical example
# ship used for visual verification) and a minimal synthetic object for any
# other ship, so the detail modal's armor viewer is exercisable in a browser.

_FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
_YAMATO_GP = _FIXTURES / "yamato_gameparams.json"


@app.post("/api/get_ship_gameparams")
async def cmd_get_ship_gameparams(payload: dict) -> Any:
    ship_id = payload.get("shipId")
    if _YAMATO_GP.exists():
        try:
            return json.loads(_YAMATO_GP.read_text(encoding="utf-8"))
        except Exception:
            pass
    # Minimal synthetic GameParams for any other ship.
    return {
        "id": int(ship_id) if ship_id else 0,
        "index": "MOCK",
        "name": "Mock",
        "typeinfo": {"nation": "usa", "species": "Cruiser", "type": "Ship"},
        "A_Hull": {
            "armor": {"1": 25.0, "2": 100.0, "3": 305.0, "4": 32.0},
            "health": 40000,
            "armourCit": [-1, -1],
            "armourDeck": [-1, -1],
            "armourExtremities": [-1, -1],
        },
    }


@app.post("/api/appdata_write")
async def cmd_appdata_write(payload: dict) -> None:
    return None


# --- Network proxy config (Settings -> Network) ---------------------------
# In-memory only: the browser mock has no real proxy stack, but the settings
# UI still exercises the same get/set round-trip as the desktop shell.

_MOCK_NETWORK: dict[str, Any] = {"mode": "system", "proxy": None}


@app.post("/api/get_network_config")
async def cmd_get_network_config() -> dict:
    return {**_MOCK_NETWORK, "effectiveProxy": None}


@app.post("/api/set_network_config")
async def cmd_set_network_config(payload: dict) -> None:
    _MOCK_NETWORK["mode"] = payload.get("mode", "system")
    _MOCK_NETWORK["proxy"] = payload.get("proxy")
    return None


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WOWSP_MOCK_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)