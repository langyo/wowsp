#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Install / uninstall / inspect the WoWSP in-game bridge probe.

Dev tool: copies packages/ingame-plugin/src/Main.py plus the in-game
panel's unbound view into <game>/bin/<latest>/res_mods/ and makes sure the
0-byte PnFModsLoader.py marker exists (the game's Mods API scans for it).
Never touches files it does not own; everything it writes is recorded in
PnFMods/WoWSPProbe/install_record.json and undone by `uninstall`.

Usage:
  python scripts/install_ingame_probe.py install --game "D:/path/to/game"
  python scripts/install_ingame_probe.py status   --game "D:/path/to/game"
  python scripts/install_ingame_probe.py uninstall --game "D:/path/to/game"
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

MOD_DIR_NAME = 'WoWSPProbe'
PLUGIN_SRC = Path(__file__).resolve().parents[1] / 'packages' / 'ingame-plugin' / 'src'
TEMPLATE = PLUGIN_SRC / 'Main.py'
# The visible half of the in-game display mode: the unbound view, auto
# discovered + mounted by the game from gui/unbound2/mods/ (the folder the
# working battle views live in; a ForgeBlueprints/ manifest was tried first
# and never worked - those XMLs are installer-only metadata).
VIEW = PLUGIN_SRC / 'WoWSPProbe.unbound'
VIEW_DEST = Path('gui') / 'unbound2' / 'mods' / 'WoWSPProbe.unbound'
LEGACY_DESTS = (
    Path('gui') / 'unbound2' / 'PnFMods' / 'WoWSPProbe.unbound',
    Path('ForgeBlueprints') / 'WoWSPProbe.xml',
)
GAME_EXES = ('WorldOfWarships64.exe', 'WorldOfWarships.exe')


def game_running():
    for exe in GAME_EXES:
        try:
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq ' + exe],
                                 capture_output=True, timeout=10).stdout
        except Exception:
            return False
        # tasklist emits the console codepage (GBK on zh-CN), not UTF-8.
        if exe.lower() in out.decode('utf-8', errors='replace').lower():
            return True
    return False


def resolve_bin(root, requested):
    bins = [p for p in (root / 'bin').iterdir() if p.is_dir() and p.name.isdigit()] if (root / 'bin').is_dir() else []
    if not bins:
        fail('no versioned bin/ folders under %s - is this a game root?' % root)
    if requested:
        chosen = root / 'bin' / requested
        if not chosen.is_dir():
            fail('requested bin version %s not found' % requested)
    else:
        chosen = max(bins, key=lambda p: int(p.name))
    return chosen


def res_mods_of(bin_dir):
    rm = bin_dir / 'res_mods'
    rm.mkdir(exist_ok=True)
    return rm


def looks_like_game(root):
    return ((root / 'bin64' / 'WorldOfWarships64.exe').exists()
            or (root / 'WorldOfWarships.exe').exists()
            or any((root / 'bin' / d.name / 'bin64' / 'WorldOfWarships64.exe').exists()
                   for d in (root / 'bin').glob('*') if d.is_dir()))


def fail(message):
    print('ERROR: ' + message)
    sys.exit(1)


def read_record(mod_dir):
    record_file = mod_dir / 'install_record.json'
    if record_file.is_file():
        try:
            return json.loads(record_file.read_text(encoding='utf-8'))
        except Exception:
            return {}
    return {}


def cmd_install(root, requested_bin):
    if game_running():
        fail('the game is running - exit it first (mods load only at startup anyway)')
    if not looks_like_game(root):
        print('WARNING: %s does not look like a game root (no WorldOfWarships64.exe); continuing anyway' % root)
    bin_dir = resolve_bin(root, requested_bin)
    rm = res_mods_of(bin_dir)
    mod_dir = rm / 'PnFMods' / MOD_DIR_NAME
    mod_dir.mkdir(parents=True, exist_ok=True)

    loader = rm / 'PnFModsLoader.py'
    created_loader = False
    if not loader.exists():
        loader.touch()
        created_loader = True

    shutil.copyfile(TEMPLATE, mod_dir / 'Main.py')
    view_dest = rm / VIEW_DEST
    view_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(VIEW, view_dest)
    for rel_dest in LEGACY_DESTS:
        dest = rm / rel_dest
        if dest.is_file():
            dest.unlink()
    record = {'created_loader': created_loader, 'bin': bin_dir.name,
              'installed_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'template': str(TEMPLATE)}
    (mod_dir / 'install_record.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    print('installed probe %s -> %s' % (MOD_DIR_NAME, mod_dir))
    print('  panel view   %s' % view_dest)
    print('  loader marker %s (%s)' % (loader, 'created' if created_loader else 'already present'))
    print('  start the game, then: python %s status --game <root>' % Path(__file__).name)


def cmd_uninstall(root, requested_bin):
    if game_running():
        fail('the game is running - exit it first')
    bin_dir = resolve_bin(root, requested_bin)
    mod_dir = bin_dir / 'res_mods' / 'PnFMods' / MOD_DIR_NAME
    if not mod_dir.is_dir():
        print('probe not installed under %s - nothing to do' % bin_dir)
        return
    record = read_record(mod_dir)
    shutil.rmtree(mod_dir)
    for rel_dest in (VIEW_DEST,) + LEGACY_DESTS:
        dest = bin_dir / 'res_mods' / rel_dest
        if dest.is_file():
            dest.unlink()
            print('removed %s' % dest)
    loader = bin_dir / 'res_mods' / 'PnFModsLoader.py'
    if record.get('created_loader') and loader.is_file() and loader.stat().st_size == 0:
        loader.unlink()
        print('removed loader marker we created')
    print('removed %s' % mod_dir)


def cmd_status(root, requested_bin):
    bin_dir = resolve_bin(root, requested_bin)
    mod_dir = bin_dir / 'res_mods' / 'PnFMods' / MOD_DIR_NAME
    loader = bin_dir / 'res_mods' / 'PnFModsLoader.py'
    print('game root      %s' % root)
    print('bin            %s' % bin_dir.name)
    print('loader marker  %s' % ('present' if loader.exists() else 'MISSING'))
    print('probe dir      %s' % ('present' if mod_dir.is_dir() else 'not installed'))
    if mod_dir.is_dir():
        for f in sorted(mod_dir.iterdir()):
            print('  %-22s %8d bytes' % (f.name, f.stat().st_size))
        hb = mod_dir / 'heartbeat.json'
        if hb.is_file():
            try:
                data = json.loads(hb.read_text(encoding='utf-8'))
                age = time.time() - data.get('t', 0) / 1000.0
                print('  heartbeat: phase=%s players=%s revision=%s, %.0f s ago' %
                      (data.get('phase'), data.get('players'), data.get('revision'), age))
            except Exception as exc:
                print('  heartbeat unreadable: %s' % exc)
        req = mod_dir / 'request.json'
        if req.is_file():
            data = json.loads(req.read_text(encoding='utf-8'))
            print('  last request: %d players at %s' % (len(data.get('players', [])), time.strftime('%H:%M:%S', time.localtime(data.get('created', 0)))))
    log_file = root / 'profile' / 'python.log'
    if log_file.is_file():
        try:
            lines = [l for l in log_file.read_text(encoding='utf-8', errors='replace').splitlines() if 'WOWSP_PROBE' in l]
            print('python.log WOWSP_PROBE lines: %d (last 8):' % len(lines))
            for l in lines[-8:]:
                print('  ' + l)
        except Exception as exc:
            print('python.log unreadable: %s' % exc)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('command', choices=['install', 'uninstall', 'status'])
    ap.add_argument('--game', required=True, help='game root directory')
    ap.add_argument('--bin', help='bin version folder (default: newest)')
    args = ap.parse_args()
    root = Path(args.game).resolve()
    if not root.is_dir():
        fail('game root %s does not exist' % root)
    {'install': cmd_install, 'uninstall': cmd_uninstall, 'status': cmd_status}[args.command](root, args.bin)


if __name__ == '__main__':
    main()
