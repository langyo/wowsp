#!/usr/bin/env python
"""E28 probe: do AIRDROPPED torpedoes ride the avatar receive_torpedoes
   stream (the TorpedoLaunch source the follow view would need for drop
   animations)? Decodes method 108 packs on avatar entities and joins each
   pack owner to its entity kind from EntityCreate.

   Observed (6 CV replays, 14.5.0.0): ZERO method-108 calls on any avatar —
   airdropped ordnance does NOT ride this stream. The airdrop projectiles are
   transient entities spawned via EntityCreate/property updates; wiring drop
   animations needs an entity-trajectory decoder first (queued). Ship-launched
   torpedoes keep using the stream (corpus tests exercise it).

   Usage: python airdrop_probe.py [replays-dir]  (pycryptodome)."""
import struct, zlib, glob, os, sys
from collections import Counter, defaultdict
from Cryptodome.Cipher import Blowfish