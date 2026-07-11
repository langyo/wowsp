"""WoWSP overlay-mode launcher (BigWorld Python mod payload).

Dropped into `<game>/bin/<version>/res_mods/WoWSP.py` and imported by the
PnFMods loader at game startup. Its job is to launch the WoWSP desktop shell so
the transparent overlay window is ready by the time a battle loads.

STATUS: skeleton. The BigWorld mod runtime exposes a specific module/import
contract (PnFMods.main + a per-mod entry symbol) that needs to be confirmed
against a running game before this body is correct. The intended behavior:

    import subprocess, sys, os
    # Locate the WoWSP executable next to the game (bundled by the installer)
    # or on PATH, and launch it detached so the game keeps running.
    wowsp = os.environ.get("WOWSP_EXE") or "WoWSP.exe"
    subprocess.Popen([wowsp], creationflags=subprocess.DETACHED_PROCESS)

The exact hook point (onGameLoad vs onLogin) and how to detect the game exiting
(so WoWSP can quit too) are TODO(M6-bigworld).
"""
