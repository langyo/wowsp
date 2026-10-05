"""WoWSP mock backend — FastAPI.

Mirrors the Tauri command surface (see `packages/webui/src/rpc.ts`) over HTTP
under `/api/<cmd>`, so the frontend can develop in a browser (`just dev mock`)
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
    {"id": 1, "name": "Player1", "relation": "0", "shipId": "4276041424", "shipName": "Yamato"},
    {"id": 2, "name": "Player2", "relation": "0", "shipId": "4277090288", "shipName": "Montana"},
    {"id": 3, "name": "Player3", "relation": "0", "shipId": "4281219056", "shipName": "Gearing"},
    {"id": 4, "name": "Enemy1", "relation": "2", "shipId": "4276041424", "shipName": "Yamato"},
    {"id": 5, "name": "Enemy2", "relation": "2", "shipId": "4277090288", "shipName": "Montana"},
    {"id": 6, "name": "Enemy3", "relation": "2", "shipId": "4281219056", "shipName": "Gearing"},
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
            # Real Yamato index from webui's ship_names.json, so ship-id-driven
            # UI (roster panels, the list card's own-ship tag) resolves.
            "ownShipId": 4276041424,
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
            "ownShipId": 4276041424,
            "ownShipName": "Yamato",
            "playerCount": 6,
        }
    ]


@app.post("/api/set_game_path")
async def cmd_set_game_path(request: Request) -> dict:
    body = await request.json()
    return {"kind": "manual", "path": body.get("path", ""), "realm": "asia"}


@app.post("/api/pick_game_folder")
async def cmd_pick_game_folder() -> dict | None:
    # No native dialog in the browser mock — behave like a cancelled pick so
    # the setup modal's browse action is a no-op there.
    return None


@app.post("/api/pick_replay_files")
async def cmd_pick_replay_files() -> list[str]:
    # No native dialog in the browser mock — behave like a cancelled pick so
    # the external-replay button is a no-op there.
    return []


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
     "relPath": "banks/mods/Hoshino", "paths": ["banks/mods/Hoshino"],
     "disabled": False, "version": None},
    {"kind": "skin", "name": "Hina_Moskva", "detail": "RSC110_Pr_66_Moskva",
     "relPath": "PnFMods/Hina_Moskva", "paths": ["PnFMods/Hina_Moskva"],
     "disabled": False, "version": None,
     "textureAnalysis": {"categories": ["skin"], "nations": ["ussr"],
                          "species": [], "spaceNames": ["spaces/PJSC001_Moskva"],
                          "ships": ["Moskva"], "fileCount": 12,
                          "fileKinds": [{"ext": ".dds", "count": 12}],
                          "truncated": False}},
    # A second pack covering the SAME ship: the material list's component
    # row (Moskva) aggregates both.
    {"kind": "skin", "name": "Alt_Camo_Moskva", "detail": "RSC110_Pr_66_Moskva",
     "relPath": "PnFMods/Alt_Camo_Moskva", "paths": ["PnFMods/Alt_Camo_Moskva"],
     "disabled": False, "version": None,
     "textureAnalysis": {"categories": ["skin"], "nations": ["ussr"],
                          "species": [], "spaceNames": ["spaces/PJSC001_Moskva"],
                          "ships": ["Moskva"], "fileCount": 8,
                          "fileKinds": [{"ext": ".dds", "count": 8}],
                          "truncated": False}},
    # An Aslain-anchored row: same name as the mock's foreign aslain unit,
    # so the installed list shows the provenance badge.
    {"kind": "gui", "name": "Shot Timer", "detail": None,
     "relPath": "PnFMods/ShotTimer", "paths": ["PnFMods/ShotTimer"],
     "disabled": False, "version": "15.7.0"},
    {"kind": "script", "name": "SmokeMarker", "detail": None,
     "relPath": "PnFMods/SmokeMarkerPy", "paths": ["PnFMods/SmokeMarkerPy"],
     "disabled": False, "version": "1.4.0"},
    {"kind": "gui", "name": "!battleframe", "detail": None,
     "relPath": "gui/unbound2/!battleframe",
     "paths": ["gui/unbound2/!battleframe"],
     "disabled": False, "version": "1.0"},
    {"kind": "patch", "name": "ime_config.xml", "detail": None,
     "relPath": "ime_config.xml", "paths": ["ime_config.xml"],
     "disabled": False, "version": None},
]


# 1x1 red PNG for the asset-preview mock.
_MOCK_PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4"
             "z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==")


@app.post("/api/mod_tags")
async def cmd_mod_tags(request: Request) -> dict:
    return {
        "schema": 1,
        "tags": [
            {"id": "licensed", "kind": "feature",
             "i18n": {"en-US": "Licensed", "zh-CN": "已授权"}},
            {"id": "ai-generated", "kind": "feature",
             "i18n": {"en-US": "AI-generated", "zh-CN": "AI 合成"}},
            {"id": "ip-blue-archive", "kind": "ip",
             "i18n": {"en-US": "Blue Archive", "zh-CN": "蔚蓝档案"}},
            {"id": "ip-azur-lane", "kind": "ip",
             "i18n": {"en-US": "Azur Lane", "zh-CN": "碧蓝航线"}},
        ],
    }


@app.post("/api/mod_hub_list_assets")
async def cmd_mod_hub_list_assets(request: Request) -> list[dict]:
    return [
        {"rel": "spaces/PJSC001_Moskva/textures_a.png", "size": 2048,
         "kind": "image", "ext": "png", "playable": True},
        {"rel": "spaces/PJSC001_Moskva/textures_b.dds", "size": 13981016,
         "kind": "image", "ext": "dds", "playable": True},
        {"rel": "banks/mods/Hoshino/voice_line_01.ogg", "size": 51200,
         "kind": "audio", "ext": "ogg", "playable": True},
        # .wem is playable now — the read command transcodes (Wwise Vorbis
        # → Ogg, PCM wem → WAV) and returns a playable payload.
        {"rel": "banks/mods/Hoshino/voice_line_02.wem", "size": 66560,
         "kind": "audio", "ext": "wem", "playable": True},
    ]


def _silent_wav(seconds: float = 2.0) -> str:
    """Mono 8kHz 8-bit silent WAV, long enough that the playback
    controller card (progress bar, pause/stop) is exercisable against
    the mock — a one-frame clip ends before the card can be touched."""
    data = b"\x80" * int(8000 * seconds)  # 8-bit silence is the midpoint
    header = (
        b"RIFF" + (36 + len(data)).to_bytes(4, "little") + b"WAVE"
        b"fmt " + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
        + (8000).to_bytes(4, "little") + (8000).to_bytes(4, "little")
        + (1).to_bytes(2, "little") + (8).to_bytes(2, "little")
        + b"data" + len(data).to_bytes(4, "little")
    )
    return base64.b64encode(header + data).decode("ascii")


_MOCK_WAV = _silent_wav()


@app.post("/api/mod_hub_read_asset")
async def cmd_mod_hub_read_asset(request: Request) -> dict:
    body = await request.json()
    rel = str(body.get("relPath", ""))
    if rel.rsplit(".", 1)[-1].lower() in ("wem", "ogg", "mp3", "wav"):
        return {"dataUrl": "data:audio/wav;base64," + _MOCK_WAV}
    return {"dataUrl": "data:image/png;base64," + _MOCK_PNG}


@app.post("/api/mod_hub_foreign_units")
async def cmd_mod_hub_foreign_units(request: Request) -> list[dict]:
    # Sample: an Aslain row that pairs with the mock catalog's shot-timer
    # entry (drives the "another non-WoWSP copy" note on its detail pane),
    # plus two ModStation units (one paired, one not) for the side strip.
    return [
        {"installer": "aslain", "key": "shot-timer", "name": "Shot Timer",
         "version": "15.7.0", "identity": "ui-timers-shot-timer"},
        {"installer": "aslain", "key": "hina-moskva", "name": "Hina_Moskva",
         "version": "15.7.0", "identity": "port-mods-sessionstats-ollin"},
        {"installer": "modstation", "key": "sessionstats", "name": "SessionStats",
         "version": None, "identity": "port-mods-sessionstats-ollin"},
        {"installer": "modstation", "key": "custom-crosshair", "name": "CustomCrosshair",
         "version": None, "identity": None},
    ]


@app.post("/api/mod_hub_scan_installed")
async def cmd_mod_hub_scan_installed(request: Request) -> list[dict]:
    return _MOCK_INSTALLED


@app.post("/api/mod_hub_set_unit_enabled")
async def cmd_mod_hub_set_unit_enabled(request: Request) -> dict:
    body = await request.json()
    rel = body.get("relPath", "")
    for mod in _MOCK_INSTALLED:
        if mod["relPath"] == rel:
            mod["disabled"] = not body.get("enabled", True)
            return {"relPath": rel, "disabled": mod["disabled"],
                    "renamedFiles": 3}
    raise HTTPException(status_code=404, detail=f"no installed plugin at {rel}")


@app.post("/api/mod_hub_uninstall_unit")
async def cmd_mod_hub_uninstall_unit(request: Request) -> dict:
    body = await request.json()
    rel = body.get("relPath", "")
    for i, mod in enumerate(_MOCK_INSTALLED):
        if mod["relPath"] == rel:
            _MOCK_INSTALLED.pop(i)
            return {"id": rel, "name": mod["name"],
                    "removedFiles": 4, "restoredFiles": 0}
    raise HTTPException(status_code=404, detail=f"no installed plugin at {rel}")


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
            "presets": [
                {"id": "default", "nameZh": "标准", "nameEn": "Standard",
                 "packages": [{"url": "https://example.com/a.zip", "sha256": "",
                               "size": 13312, "name": "a.zip"}]},
                {"id": "compact", "nameZh": "紧凑", "nameEn": "Compact",
                 "packages": [{"url": "https://example.com/a-compact.zip", "sha256": "",
                               "size": 8192, "name": "a-compact.zip"}]},
            ],
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
        {
            # Real community packs (discussions #799-#802): the ribbon skin
            # and the Blue Archive AI voices, tags and all.
            "id": "skin.ribbon.azur-lane", "category": "skin",
            "tags": ["licensed", "ip-azur-lane"],
            "discussion": 799, "version": "3.0",
            "game": ">=13.0",
            "title": "Azur Lane Ribbons",
            "nameZh": "碧蓝航线主题勋带", "nameEn": "Azur Lane Ribbons",
            "description": "Azur Lane-themed combat ribbon icons (SineLine, licensed).",
            "authorUrl": "",
            "i18n": {
                "en-US": {"name": "Azur Lane Ribbons", "description": "Azur Lane-themed combat ribbon icons."},
                "zh-CN": {"name": "碧蓝航线主题勋带", "description": "碧蓝航线风格战斗勋带图标。"},
            },
            "packages": [{"url": "https://example.com/ribbon.zip", "sha256": "",
                          "size": 362496, "name": "skin.ribbon.azur-lane.zip"}],
        },
        {
            "id": "voice.ba.hoshino", "category": "voice",
            "tags": ["ai-generated", "ip-blue-archive"],
            "discussion": 800, "version": "1",
            "game": ">=12.1",
            "title": "Hoshino Crew Voice (AI)",
            "nameZh": "星野舰员语音（AI 合成）", "nameEn": "Hoshino Crew Voice (AI)",
            "description": "Blue Archive Hoshino crew voice, AI-synthesized.",
            "authorUrl": "",
            "i18n": {
                "en-US": {"name": "Hoshino Crew Voice (AI)", "description": "Blue Archive Hoshino voice, AI-synthesized."},
                "zh-CN": {"name": "星野舰员语音（AI 合成）", "description": "蔚蓝档案星野语音，AI 合成。"},
            },
            "packages": [{"url": "https://example.com/hoshino.zip", "sha256": "",
                          "size": 3450880, "name": "voice.ba.hoshino.zip"}],
        },
        {
            # Withdrawn sample (closed discussion thread): exercises the
            # delisting path — hidden from list/search, deep-link notice.
            "id": "battle-marker-traffic", "category": "battle",
            "discussion": 93, "version": "15.7.0.10",
            "game": ">=15.7 <15.8", "delisted": True,
            "title": "Ship Movement Indicator / 运动状态指示器",
            "nameZh": "运动状态指示器（红绿灯）", "nameEn": "Ship Movement Indicator",
            "description": "Superseded by SMI v4.",
            "authorUrl": "",
            "i18n": {
                "en-US": {"name": "Ship Movement Indicator", "description": "Superseded by SMI v4."},
                "zh-CN": {"name": "运动状态指示器（红绿灯）", "description": "已被红绿灯 v4 取代。"},
            },
            "packages": [{"url": "https://example.com/c.zip", "sha256": "",
                          "size": 1024, "name": "c.zip"}],
        },
    ],
}
_MOCK_RECORDS: list[dict] = [
    # Stale on purpose: catalog says version "1", the record says "0.9" —
    # the client-version selector's update marker + 一键更新 ride on this.
    {
        "id": "voice.ba.hoshino", "name": "Hoshino Crew Voice (AI)",
        "version": "0.9", "category": "voice", "source": "mod-hub",
        "discussion": 800, "preset": None, "binVersion": "13187581",
        "installedAt": "2026-01-01T00:00:00Z", "files": [],
        "restoreDir": None, "gameRoot": "",
    },
]


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


# Probe plugin always "installed but outdated" against the mock: the
# sidebar marker's second freshness source.
@app.post("/api/ingame_plugin_status")
async def cmd_ingame_plugin_status(request: Request) -> dict:
    return {"installed": True, "outdated": True, "resMods": "bin/13187581/res_mods",
            "discussion": 640}


@app.post("/api/ingame_plugin_install")
async def cmd_ingame_plugin_install(request: Request) -> str:
    return "bin/13187581/res_mods/PnFMods/WoWSPProbe/Main.py"


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
        "soloWr": 52.1,
        "div2Wr": 55.8,
        "div3Wr": 57.3,
    }


@app.post("/api/lookup_players_stats_batch")
async def cmd_lookup_players_stats_batch(request: Request) -> list:
    """Roster fast path: one entry per input name, in order. null = not found.
    Mixes in a hidden profile so the UI's red "hidden stats" path is exercised
    in mock/dev runs."""
    body = await request.json()
    names: list[str] = body.get("names", [])
    out: list[dict | None] = []
    for i, name in enumerate(names):
        if name.startswith(":"):
            out.append(None)
        elif i % 4 == 3:
            out.append({
                "accountId": 2024711808 + i,
                "name": name,
                "realm": body.get("realm", "asia"),
                "battles": None,
                "winrate": None,
                "hidden": True,
                "clanTag": None,
            })
        else:
            out.append({
                "accountId": 2024711808 + i,
                "name": name,
                "realm": body.get("realm", "asia"),
                "battles": 900 + 111 * i,
                "winrate": 48.0 + (i % 7) * 1.7,
                "hidden": False,
                "clanTag": "MOCK",
                "avgDamage": 42000 + 900 * i,
                "avgXp": 1100,
                "kdRatio": 1.4,
                "survivalRate": 38.0,
                "hitRate": 31.0,
                "pr": 1400 + 40 * i,
                "shipsPlayed": 60,
                "levelingTier": 11,
                "levelingPoints": 3100,
            })
    return out


@app.post("/api/lookup_player_ship_stats")
async def cmd_lookup_player_ship_stats(request: Request) -> list:
    body = await request.json()
    _ = body.get("accountId")
    return [
        {"shipId": 4265588720, "name": "Nagato", "battles": 320, "wins": 176,
         "damageCaused": 21_824_000, "frags": 412, "survivedBattles": 120,
         "winrate": 55.0, "avgDamage": 68200, "lastBattleTime": 0,
         "pr": 1750, "avgXp": 1650,
         "modes": {
             "solo": {"battles": 200, "wins": 106, "damageCaused": 13_600_000,
                      "frags": 254, "survivedBattles": 76, "winrate": 53.0,
                      "avgDamage": 68000},
             "div2": {"battles": 80, "wins": 46, "damageCaused": 5_500_000,
                      "frags": 104, "survivedBattles": 28, "winrate": 57.5,
                      "avgDamage": 68750},
             "div3": {"battles": 40, "wins": 24, "damageCaused": 2_724_000,
                      "frags": 54, "survivedBattles": 16, "winrate": 60.0,
                      "avgDamage": 68100},
             "coop": {"battles": 12, "wins": 10, "damageCaused": 500_000,
                      "frags": 18, "survivedBattles": 8, "winrate": 83.3,
                      "avgDamage": 41666},
             "ranked": None}},
        {"shipId": 4287542992, "name": "Zao", "battles": 210, "wins": 110,
         "damageCaused": 16_485_000, "frags": 301, "survivedBattles": 80,
         "winrate": 52.4, "avgDamage": 78500, "lastBattleTime": 0,
         "pr": 1510, "avgXp": 1780, "modes": None},
        {"shipId": 4078352176, "name": "U-69", "battles": 150, "wins": 68,
         "damageCaused": 3_150_000, "frags": 142, "survivedBattles": 55,
         "winrate": 45.3, "avgDamage": 21000, "lastBattleTime": 0,
         "pr": 940, "avgXp": 1120, "modes": None},
        {"shipId": 4267685872, "name": "Shinano", "battles": 40, "wins": 18,
         "damageCaused": 0, "frags": 0, "survivedBattles": 10,
         "winrate": 45.0, "avgDamage": 0, "lastBattleTime": 0,
         "pr": 920, "avgXp": None, "modes": None},
    ]


@app.post("/api/get_ship_server_stats")
async def cmd_get_ship_server_stats(request: Request) -> dict | None:
    """Mirror of the Rust command's happy path: a few well-known mock ships
    have server samples (Nagato / Zao / U-69), anything else has none."""
    body = await request.json()
    ship_id = body.get("shipId")
    samples = {
        4265588720: (63_100, 0.94, 50.02),
        4287542992: (89_400, 0.86, 49.55),
        4078352176: (24_800, 0.71, 49.90),
    }
    sample = samples.get(ship_id)
    if sample is None:
        return None
    return {"shipId": ship_id, "avgDamage": sample[0], "avgFrags": sample[1],
            "winrate": sample[2], "generatedAt": 1_700_000_000, "fromCache": False}


@app.post("/api/get_upgrade_prices")
async def cmd_get_upgrade_prices(request: Request) -> dict:
    """Modernization prices (credits) as GameParams would serve them. The
    planner's cost panel falls back to unknown-price rows for anything
    missing here."""
    return {
        "PCM027": {"name": "PCM027_ConcealmentMeasures_Mod_I", "cost": 1_450_000,
                   "group": "Modernization", "index": "PCM027"},
        "PCM020": {"name": "PCM020_DamageControlSystem_Mod_I", "cost": 1_250_000,
                   "group": "Modernization", "index": "PCM020"},
        "PCY013": {"name": "PCY013_MainGun_Mod", "cost": 3_000_000,
                   "group": "Modernization", "index": "PCY013"},
    }


# A full ranked history (newest first, mirrors RankedSeasonStats): season
# ids follow the backend convention (1000 + season number), a few seasons
# are missing (unplayed ones drop server-side), and the best ranks cover
# all three league metals so the season-timeline modal shows its tints.
_RANKED_FIXTURE: list[dict] = [
    {"seasonId": 1030, "battles": 53, "wins": 33, "bestRank": 5, "bestRankDisplay": "Gold 5"},
    {"seasonId": 1029, "battles": 108, "wins": 54, "bestRank": 5, "bestRankDisplay": "Silver 5"},
    {"seasonId": 1028, "battles": 53, "wins": 31, "bestRank": 10, "bestRankDisplay": "Silver 10"},
    {"seasonId": 1025, "battles": 6, "wins": 5, "bestRank": 6, "bestRankDisplay": "Bronze 6"},
    {"seasonId": 1024, "battles": 104, "wins": 53, "bestRank": 7, "bestRankDisplay": "Silver 7"},
    {"seasonId": 1023, "battles": 278, "wins": 136, "bestRank": 1, "bestRankDisplay": "Silver 1"},
    {"seasonId": 1022, "battles": 218, "wins": 113, "bestRank": 2, "bestRankDisplay": "Silver 2"},
    {"seasonId": 1021, "battles": 26, "wins": 12, "bestRank": 4, "bestRankDisplay": "Bronze 4"},
    {"seasonId": 1020, "battles": 12, "wins": 6, "bestRank": 6, "bestRankDisplay": "Bronze 6"},
    {"seasonId": 1019, "battles": 7, "wins": 4, "bestRank": 7, "bestRankDisplay": "Bronze 7"},
    {"seasonId": 1017, "battles": 12, "wins": 7, "bestRank": 6, "bestRankDisplay": "Bronze 6"},
    {"seasonId": 1016, "battles": 4, "wins": 0, "bestRank": 10, "bestRankDisplay": "Bronze 10"},
    {"seasonId": 1015, "battles": 178, "wins": 107, "bestRank": 3, "bestRankDisplay": "Silver 3"},
    {"seasonId": 1013, "battles": 117, "wins": 64, "bestRank": 1, "bestRankDisplay": "Bronze 1"},
]


@app.post("/api/get_ranked_stats")
async def cmd_get_ranked_stats(request: Request) -> list[dict]:
    """A fake full ranked history (mirrors RankedSeasonStats) so the stats
    card's ranked split and the season-timeline modal have data in a
    browser. The seasonCount arg is accepted but ignored."""
    body = await request.json()
    _ = body.get("accountId")
    out = []
    for f in _RANKED_FIXTURE:
        losses = f["battles"] - f["wins"]
        out.append({
            "seasonId": f["seasonId"],
            "seasonName": f"Season {f['seasonId'] - 1000}",
            "battles": f["battles"],
            "wins": f["wins"],
            "losses": losses,
            "damageDealt": f["battles"] * 61_000 + f["seasonId"] * 137,
            "frags": round(f["battles"] * 0.87),
            "maxDamage": 142_000 + (f["seasonId"] % 9) * 9_500,
            "maxXp": 2_100 + (f["seasonId"] % 7) * 160,
            "survivedBattles": round(f["battles"] * 0.34),
            "planesKilled": round(f["battles"] * 1.6),
            "currentRank": f["bestRank"],
            "bestRank": f["bestRank"],
            "bestRankDisplay": f["bestRankDisplay"],
        })
    return out


@app.post("/api/read_ship_stats_history")
async def cmd_read_ship_stats_history(request: Request) -> list:
    """Stateless mock: no recorded history, so range views always take the
    labeled career fallback under the mock backend."""
    return []


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
            "shellLaunches": dump.get("shellLaunches", []),
            "explosions": dump.get("explosions", []),
            "torpedoes": dump.get("torpedoes", []),
            "torpedoSteers": dump.get("torpedoSteers", []),
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
            "minimapSquadronAdds": dump.get("minimapSquadronAdds", []),
            "minimapSquadronMoves": dump.get("minimapSquadronMoves", []),
            "minimapSquadronRemoves": dump.get("minimapSquadronRemoves", []),
            "wards": dump.get("wards", []),
            "wardRemoves": dump.get("wardRemoves", []),
            "shotKills": dump.get("shotKills", []),
            "damageStats": dump.get("damageStats", []),
            "chatMessages": dump.get("chatMessages", []),
            "achievements": dump.get("achievements", []),
            "weatherTransitions": dump.get("weatherTransitions", []),
            "weatherNotifications": dump.get("weatherNotifications", []),
        }
    return {
        "trajectories": [],
        "shellLaunches": [],
        "explosions": [],
        "torpedoes": [],
        "torpedoSteers": [],
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
        "minimapSquadronAdds": [],
        "minimapSquadronMoves": [],
        "minimapSquadronRemoves": [],
        "wards": [],
        "wardRemoves": [],
        "shotKills": [],
        "damageStats": [],
        "chatMessages": [],
        "achievements": [],
    }


@app.post("/api/read_temp_arena_info")
async def cmd_read_temp_arena_info() -> dict | None:
    return {
        "matchGroup": "pvp",
        "dateTime": "12.07.2026 21:45:00",
        # Same map the replay fixture names — exercises the map-name tag's
        # preview/jump affordances in mock dev and the e2e harness.
        "mapName": "17_NA_fault_line",
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
    return {"imageBase64": base64.b64encode(png).decode(), "rosterRect": None, "anchor": None}


@app.post("/api/set_overlay_visible")
async def cmd_set_overlay_visible() -> None:
    return None


@app.post("/api/create_overlay_window")
async def cmd_create_overlay_window(request: Request) -> None:
    body = await request.json()
    _ = body.get("realm")  # unused — the mock has no window to create
    return None


@app.post("/api/destroy_overlay_window")
async def cmd_destroy_overlay_window() -> None:
    return None


@app.post("/api/start_overlay_tab_watch")
async def cmd_start_overlay_tab_watch() -> None:
    # The mock runs in a browser — there is no global Tab watcher; the
    # overlay window can be toggled via set_overlay_visible instead.
    return None


@app.post("/api/stop_overlay_tab_watch")
async def cmd_stop_overlay_tab_watch() -> None:
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

_MOCK_NETWORK: dict[str, Any] = {
    "mode": "system",
    "proxy": None,
    "resourceCdn": None,
    "githubMirror": None,
}


@app.post("/api/get_network_config")
async def cmd_get_network_config() -> dict:
    return {**_MOCK_NETWORK, "effectiveProxy": None}


@app.post("/api/set_network_config")
async def cmd_set_network_config(payload: dict) -> dict:
    _MOCK_NETWORK["mode"] = payload.get("mode", "system")
    _MOCK_NETWORK["proxy"] = payload.get("proxy")
    _MOCK_NETWORK["resourceCdn"] = payload.get("resourceCdn")
    _MOCK_NETWORK["githubMirror"] = payload.get("githubMirror")
    # The shell returns the SANITIZED config it persisted; the settings UI
    # adopts that response, so the mock must return one too.
    return {**_MOCK_NETWORK, "effectiveProxy": None}


# --- Settings files the shell persists as TOML (in-memory mirrors) ----------

_MOCK_OVERLAY_CONFIG = {"table": "detect", "roster": "ocr"}
_MOCK_GAME_CONFIG = {"activePath": None}


@app.post("/api/get_overlay_config")
async def cmd_get_overlay_config() -> dict:
    return {**_MOCK_OVERLAY_CONFIG}


@app.post("/api/set_overlay_config")
async def cmd_set_overlay_config(payload: dict) -> dict:
    _MOCK_OVERLAY_CONFIG["table"] = payload.get("table", "detect")
    _MOCK_OVERLAY_CONFIG["roster"] = payload.get("roster", "ocr")
    return {**_MOCK_OVERLAY_CONFIG}


@app.post("/api/get_game_config")
async def cmd_get_game_config() -> dict:
    return {**_MOCK_GAME_CONFIG}


@app.post("/api/set_game_config")
async def cmd_set_game_config(payload: dict) -> dict:
    _MOCK_GAME_CONFIG["activePath"] = payload.get("activePath")
    return {**_MOCK_GAME_CONFIG}


# --- Resource pack / caches (Settings -> Updates) --------------------------
# Static canned state: the browser mock has no pack downloads, but the panel
# renders and its buttons round-trip like the desktop shell.

_MOCK_RES: dict[str, Any] = {
    "present": True,
    "treeSha256": "a1b2c3d4e5f6" + "0" * 58,
    "version": "2026-09-11T09:16:54Z",
    "legacyStamp": False,
    "sizeBytes": 1_237_709_382,
    "downloading": False,
}


@app.post("/api/get_res_status")
async def cmd_get_res_status() -> dict:
    return dict(_MOCK_RES)


@app.post("/api/check_res_update")
async def cmd_check_res_update() -> dict:
    return {
        "latestTreeSha256": _MOCK_RES["treeSha256"],
        "latestVersion": _MOCK_RES["version"],
        "updateAvailable": False,
        "deltaSteps": None,
    }


@app.post("/api/res_download")
async def cmd_res_download() -> None:
    # No real download in the mock; flip the flag briefly so the UI path runs.
    _MOCK_RES["present"] = True
    return None


@app.post("/api/res_cancel")
async def cmd_res_cancel() -> None:
    return None


@app.post("/api/clear_res")
async def cmd_clear_res() -> None:
    _MOCK_RES["present"] = False
    _MOCK_RES["treeSha256"] = None
    _MOCK_RES["version"] = None
    _MOCK_RES["sizeBytes"] = 0
    return None


@app.post("/api/ensure_res_pack")
async def cmd_ensure_res_pack() -> str:
    return "C:/Users/mock/AppData/Local/WoWSP"


@app.post("/api/res_cache_root")
async def cmd_res_cache_root() -> str | None:
    # The real command probes `models/` under the cache dir; the mock ties
    # the root to the same presence flag the updates panel shows.
    if _MOCK_RES["present"]:
        return "C:/Users/mock/AppData/Local/WoWSP"
    return None


_MOCK_AUX_CACHES: dict[str, int] = {
    "image-cache": 84_000_000,
    "gameparams": 12_000_000,
    "encyclopedia": 6_500_000,
    "community": 2_100_000,
}


@app.post("/api/aux_cache_overview")
async def cmd_aux_cache_overview() -> list[dict]:
    return [
        {"scope": scope, "sizeBytes": size}
        for scope, size in _MOCK_AUX_CACHES.items()
    ]


@app.post("/api/clear_aux_cache")
async def cmd_clear_aux_cache(payload: dict) -> None:
    scope = payload.get("scope")
    if scope in _MOCK_AUX_CACHES:
        _MOCK_AUX_CACHES[scope] = 0
    return None


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WOWSP_MOCK_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)