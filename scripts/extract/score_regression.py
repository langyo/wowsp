"""Cross-replay score analysis: identify commonList score fields + solve the
domination accrual rate empirically.

For each replay: dump commonList, mode, duration; decode caps + sinks via our
own dump test (already produced full JSON dumps when WOWSP_DUMP_OUT set by
caller). Here we just aggregate the commonLists of several replays.
"""
from __future__ import annotations

import json
import subprocess
import sys
import os

REPLAYS = [
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260816_111325_PASS208-Salmon_38_Canada.wowsreplay",
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260815_114300_PASS208-Salmon_51_Greece.wowsreplay",
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260815_113002_PASS208-Salmon_22_tierra_del_fuego.wowsreplay",
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260814_182340_PASS208-Salmon_40_Okinawa.wowsreplay",
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260814_183955_PISC510-Napoli_38_Canada.wowsreplay",
    r"D:\SteamLibrary\steamapps\common\World of Warships\replays\20260813_212926_PVSD014-Serrano_01_solomon_islands.wowsreplay",
]

CARGO_ENV = {
    **os.environ,
    "WOWSP_TEST_REPLAY": "",
}

def main():
    for rp in REPLAYS:
        out = rp + ".dump.json"
        env = {**os.environ, "WOWSP_TEST_REPLAY": rp, "WOWSP_DUMP_OUT": out}
        subprocess.run(
            ["cargo", "test", "-p", "wowsp_tauri", "dump_replay_json", "--", "--nocapture"],
            cwd="packages/app/tauri", env=env, capture_output=True,
        )
        try:
            d = json.load(open(out, encoding="utf-8"))
        except Exception as e:
            print(rp, "FAILED", e)
            continue
        br = d.get("battleResults")
        cl = None
        mode = None
        if br:
            cl = json.loads(br).get("commonList")
        # find mode string
        if cl:
            for i, v in enumerate(cl):
                if isinstance(v, str) and ("point" in v or "domination" in v or v in ("epicenter", "standard")):
                    mode = (i, v)
        print("=" * 100)
        print(os.path.basename(rp), "mode:", mode)
        if cl:
            print("commonList:", json.dumps(cl)[:600])
        os.remove(out)

if __name__ == "__main__":
    main()
