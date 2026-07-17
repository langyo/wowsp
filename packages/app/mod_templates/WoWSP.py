"""WoWSP overlay-mode launcher (BigWorld Python mod payload).

Dropped into `<game>/bin/<version>/res_mods/WoWSP.py` and imported by the
PnFMods loader at game startup. Its job is to launch the WoWSP desktop shell
so the transparent overlay window is ready by the time a battle loads.
"""

import BigWorld
import os
import subprocess
import sys


_WOWSP: subprocess.Popen | None = None


def _launch():
    global _WOWSP
    if _WOWSP is not None:
        return
    path = os.environ.get("WOWSP_EXE", "WoWSP.exe")
    try:
        _WOWSP = subprocess.Popen([path], close_fds=True,
                                  creationflags=subprocess.DETACHED_PROCESS)
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)


def _on_shutdown():
    global _WOWSP
    if _WOWSP is not None:
        try:
            _WOWSP.terminate()
            _WOWSP.wait(timeout=5)
        except Exception:
            try:
                _WOWSP.kill()
                _WOWSP.wait(timeout=5)
            except Exception:
                pass
        _WOWSP = None


BigWorld.callback(0.1, _launch)
BigWorld.onGameDisconnect += _on_shutdown
