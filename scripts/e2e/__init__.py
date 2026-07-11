"""Shared constants + fixture paths for WoWSP e2e tests.

Adapted from shittim-chest's `scripts/e2e/shared.py`.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MOCK_DIR = ROOT / "scripts" / "mock"
MOCK_FIXTURES_DIR = MOCK_DIR / "fixtures"
DEFAULT_HOST = "127.0.0.1"
STARTUP_TIMEOUT = 60
REQUEST_TIMEOUT = 10
RECV_TIMEOUT = 15
COLLECT_TIMEOUT = 5


class Method:
    """WoWSP command names — mirror of packages/webui/src/rpc.ts."""

    get_os_preferences = "get_os_preferences"
    detect_game_install = "detect_game_install"
    set_game_path = "set_game_path"
    read_replay_header = "read_replay_header"
    list_replays = "list_replays"
    read_temp_arena_info = "read_temp_arena_info"
    start_arena_watcher = "start_arena_watcher"
    stop_arena_watcher = "stop_arena_watcher"
    capture_game_window = "capture_game_window"
    set_overlay_visible = "set_overlay_visible"
