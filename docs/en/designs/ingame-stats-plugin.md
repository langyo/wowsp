# In-Game Stats Plugin — precision telemetry design

> **Status**: experiment concluded (2026-09-28); ready for implementation.
> Companion doc for the overlay: the display layer stays the transparent
> window; this plugin is the in-game data source that keeps the overlay's
> alive/sunk states exact on every setup, including exclusive fullscreen.
> The TAB row ORDER stayed a per-client calibrated inference until the
> probe could read the game's own order in-engine — it can now (see the
> endgame below); the ordering rule that follows remains the fallback
> and the CN story.
>
> **Update (2026-10-01)**: a second view mode landed — 游戏内展示 renders
> the stats INSIDE the game through this plugin's unbound view
> (`gui/unbound2/mods/WoWSPProbe.unbound`, the game-scanned battle-view folder),
> replacing this doc's "renders nothing" stance for the new `table =
> "ingame"` mode only. The overlay mode (`"detect"`) keeps the original
> data-source design below; the bridge (`commands/ingame_bridge.rs`)
> answers `request.json` only while the ingame mode is active, so the two
> displays never run at once.

## Background & goals

The live-battle overlay today infers the TAB team table's geometry by
capturing the screen (`overlay/capture.rs`, `overlay_detect.rs`) and polls
`GetAsyncKeyState(VK_TAB)` at 30 ms. This works, but:

- screen capture is the most fragile layer (DRM/capture exclusions, HDR,
  multi-DPI, windowed-vs-fullscreen quirks);
- key polling cannot tell "Tab held" from "Tab typed in battle chat";
- row order is inferred from a static roster plus sink heuristics.

An in-game mod running on Wargaming's official **Mods API** (the PnFMods
channel, no injection, no memory writes) can observe the battle state from
inside the client and hand it to WoWSP through a file bridge. The mod
renders **nothing** — the transparent overlay remains the display — so the
approach carries none of the per-game-version UI maintenance that killed
earlier "render in game" ideas.

Goal: make "mod telemetry > screen-capture inference > static order" the
priority chain for the overlay's data, keyed by a new roster mode
`"plugin"` in `overlay_config.toml`.

## What the experiment proved

Verified on Steam-ASIA 15.8.0 (build 13187581) and 360-CN 15.8.1 (build
13243917), several battles each, probe artifact at
`packages/ingame-plugin/src/Main.py` (reports itself as `0.1.0`
forever; iteration lives in git history only):

| Capability | Mechanism | Latency / notes |
| --- | --- | --- |
| Mod loads, both realms | `res_mods/<bin>/PnFModsLoader.py` (0-byte marker) + `PnFMods/<Mod>/Main.py`, `API_VERSION = 'API_v1.0'` | coexists with Aslain's mods |
| Injected API modules | `events, ui, utils, battle, callbacks, dataHub, constants` are loader-injected globals; `import` of them fails (allowlist), never shadow them | builtins are whitelisted too: no `globals()`/`eval` |
| Roster + identity | `battle.getPlayersInfo()` → name / accountDBID / shipParamsId / isBot / realm / isAlive | records are `SafeClass`: subscripts work, dict protocol does not; iterate early-loading defensively (container is briefly non-dict). The record's own `isAlive` is now the AUTHORITATIVE alive source — its flips were validated name by name against a real Tab capture's dead rows (battle-long journal, 2026-10-07) |
| Sink attribution | the roster record's `isAlive` flips, polled at 1 s; the avatar-entity walk supplies hp and is a fallback only | the record tracks the client's table name by name (battle-long journals, 2026-10-07). The latch is gated on the record: a single doubting read of the old walk-fed one-way latch could pin a player dead for the whole battle (one episode observed: the local player was reported sunk while alive — the journal of that battle is gone, so the exact trigger stays inferred) |
| Live health & spotting | `dataHub.getEntityCollections('avatar')` → `entity[CC.health]` (`.value/.max/.isAlive`), `entity[CC.relation]` | enemy HP stays 0/0 until spotted — same fog-of-war as the game's own table; a 0→value jump is itself a spotting event |
| TAB screen state | SFM events `input.tabModeIn` / `input.tabModeOut` | fires ≤3 ms after the key; does **not** fire for Tab-in-chat — fixes the false-positive class outright |
| Roster churn | `events.onPlayersListUpdated` | 14 events in one battle |
| Battle lifecycle | `sfm.battleLoadingStarted`, `request.showBattle`, `onBattleStart`, `up.exitBattle`, `window.hide(Battle)` | finer-grained than tempArenaInfo file appearance/removal |

**Not available** (and not needed for the API the overlay consumes):
per-player score/XP components do not exist on avatar entities, and the
unbound-side `$datahub.getCollection().getChildByPath('team.ally.sortedAlive')`
path has no Python-side equivalent: the injected `dataHub` has no
`getCollection`, and the injected `battle` SafeClass does not forward
the battleGate-internal helper of the same name (live 15.9.0 probe).

**Ordering rule — UNSTABLE, per-client knowledge; ground truth must come
from inside the game.** The TAB table's row order is whatever each
client's HUD renders, and the vendors have genuinely diverged (the early
"arena vehicle order with sunk players re-appended" model was only ever
the WG-family approximation — the tie groups it could not resolve are
what #604's dot chips papered over). Calibrate per realm against REAL Tab
captures, expect it to move with any client update, and treat script
decompilation as corroborating evidence only — never as proof. The
2026-10-09 matrix, decompiled from this machine's installs (wowsdeob,
`ShipSystem.add` / `AvatarSystem.__sortKeyAlive`):

- **WG family** (eu/na/asia share one build): alive flag, class rank
  (CV < BB < CA < DD < SS < aux), tier descending, `NATION.SORT_ORDER`
  rank, localized ship short name, `[TAG]nickname` — one concatenated
  string. Live 15.8.0 verified 6/6 on a Tab capture (2026-09-27), and the
  NEXT build (13357625, downloaded 2026-10-06) decompiles to the SAME
  nation-rank-first formula — WG has not moved.
- **360-CN**: its own Python (builds 13243917 AND the current 13357822)
  still computes the WG nation-rank key, yet the client RENDERS the
  localized-ship-name order (2026-10-07 capture, 9/9 pinyin) — the
  divergence lives in the HUD/view layer. Script decompilation therefore
  can NEVER settle this client; only rendered captures count.
- **Lesta** (ru): renders its OWN sort-key order — SETTLED by the
  2026-10-10 live battle (the probe's bridged keys reproduced the table
  row for row, 6/6 allies). The 2026-10-09 "ship-name order, like CN"
  reading was a misread: Lesta's own nation table ranks russia FIRST and
  the key's name segment is an internal code ("2970PRSC103"), so
  Bogatyr leading two St. Louis rows was the nation rank, not a name
  collation — and the un-openable `.pyc` container stopped mattering
  (the keys ARE the order). Equal keys keep the roster's own order
  there (not the '+ name' tie the WG decompile appends).

The app encodes this as per-realm gates over the offline sort key
(utils/realms's `realmUsesShipNameOrder`; utils/shipClass carries the
key itself and the CN static layout) and
refuses to present the inference as game-truth: without a covering
sort-key map, a plugin-CONNECTED battle still reads its row order as
inferred in the /live panel's head (warning pill + tooltip,
`features/replay/telemetryGrade.ts`).

**The endgame SHIPPED (2026-10-09, same day)** — via the ship components,
not the sorted collection: the injected ModAPI dataHub exports only
`getSingleEntity` / `getEntityCollections` over its `SYNCED` whitelist
(decompiled `ModsShell/API_v_1_0/dataHub.py` — exactly two exports), and
`'ship'` IS whitelisted. The probe therefore walks the avatars' `ship`
slot to each player's Ship component, whose `sortKey` is the client's OWN
Tab key (`str(SORT_ORDER.index(subtype)) + str(100 - level) +
str(NATION.SORT_ORDER.index(nation)) + shortName` — `ShipSystem.add`,
build 13357625) and carries it in telemetry (`sortKeys`, name → key).
The /live panel sorts the roster by the client's own comparison and
grades the pill EXACT when the map covers the live roster — the WG
family by key + '[TAG]nickname' (the exact concatenation
`__sortKeyAlive` compares), Lesta by the keys ALONE with equal keys
keeping the roster's own order (live 2026-10-10: two same-key Turenne
rows, a human and a ':bot:', rendered in record order against the plain
compare's ':'-first tie). A ship-name-order client (CN) never renders
the key order its own scripts compute, so there the override stands
down and the pill cannot grade exact. Offline conformance for this
path landed 2026-10-10 (`scripts/check_ingame_plugin.py`'s ship passes):
planted ship entities pin the WG shape (the exact key table in telemetry
AND the panel fold sorting its alive block by the keys, stable — the
fixture's equal-key pair keeps the walk order), the Lesta shape
(UiComponents raising — the path duck-types the components and needs no
constants), partial coverage (an unpaired avatar keeps that side's walk
order — game-true and walk-order rows never interleave — while the
still-covered side sorts), and the encoder quirk (the key table survives
the hand-rolled serializer). The former open item CLOSED the same day,
live: a real Lesta co-op battle served the 'ship' collection in full
(11/11 keys including bots) and settled the model above —
`realmUsesShipNameOrder` is CN-only now (the ru offline fallback is the
WG-family key: right on class/tier, knowingly wrong on the
russia-first rank, the bridged keys being the game-truth), and a
partial-coverage battle keeps the calibrated fallback — game-true and
inferred rows never interleave.

**Ordering-raw-material bridge (2026-10-12)** — with the endgame
shipped, two spots still admitted only offline approximation: Lesta's
equal-key tie resolution (the "roster's own order" is known only to the
client, and the app's Lesta roster synthesis used to sort by (name, id),
destroying it) and the CN ship-name segment (the offline DB's localized
names are only an approximation: app-language drift, and new ships the
DB does not carry yet fall to a sentinel). The probe henceforth carries
both raw materials out in telemetry: `rosterOrder` (the iteration order
of the getPlayersInfo record mapping itself — py2 dict order is
deterministic for a given key set, and the 2026-10-10 capture already
proved that realm's client renders equal keys in record order) and
`shipNames` (the shipName field the records carry themselves — the raw
localized ship-name string the client renders; a build whose records
lack the field outputs an empty table, and the consumer side falls back
to the DB name automatically, behavior unchanged from before).
roster_raw.json carries an `order` array in the same frame; the Rust
synthesis (probe_roster) emits vehicles preserving that order (a missing
field or an entry not named in it falls back to (name, id)) and squeezes
shipName into each row's ship_name. Both webui sides (the /live panel
and the overlay) pre-sort by rosterOrder as the tie base order (names
missing from it land stably last), and the CN arrangement swaps the DB
name segment for the client ship name once a whole side is covered
(mixing the two sources would misorder, hence the whole-side gate). The
grading discipline: the CN pill did not grade exact while the sort
function was our pinyin collator over DB-name inputs — released
2026-10-18 (see the re-calibration below): with client-truth ship
names covering a whole side, the comparator's inputs are the strings
the client itself renders and the arrangement grades EXACT (partial
name coverage keeps the inferred grade).

**AI-verdict bridge (2026-10-22)** — the aim card's bot filtering now
has the game's own authoritative signal: telemetry gains `bots` (the
records' `isBot` rows plus the scripted-name styles ':'/'IDS_'/'#',
cached per battle — a transient empty getPlayersInfo does not blank
the list; the fail-safe body omits the field, and an absent field means
"this probe build predates the bridge", never "no bots"). The event
PvEvP modes field some bots under NORMAL nicknames no name-style rule
can catch — only the record's own isBot flag judges those. The aim
card's verdict passes a two-layer gate (`aimDisplayName`: AI-name
styles + the bots list) and a judged-AI target renders NO card at all,
bare-headed name included; a mixed enemy team keeps the window up and
shows the humans only. The whole-battle suppression lives on the Rust
side under its own flag (`arena_info::last_enemy_all_ai`): an enemy
side that reads entirely AI (co-op, the asymmetric fills, scripted
operation waves, an all-bot event side under normal nicknames — caught
by the WG arena convention that bot rows carry negative ids — or a
custom room deliberately set vs bots; decided off the roster, not the
matchGroup string) keeps the card's window down for the battle's whole
duration. That flag is deliberately SEPARATE
from `LAST_BATTLE_PVE`: the PvE flag also keys the anchor calibration's
battle class, and an asymmetric battle fields a two-team Tab table
whose anchor belongs in the PvP slot.

**Side-membership bridge + frame-roster fallback (2026-10-22).** The
records-dead build class (`getPlayersInfo` empty all battle — the
2026-10-18/19 field reports; the 2026-10-22 support bundle's WGC
client, also build 13357625, played four days of battles whose
telemetry only ever showed the battle-end quit-clear) runs the probe's
walk-sourced session since the roster-grace fallback, but the companion
still could not seat its battle: probe_arena's roster synthesis reads
`roster_raw.json`, which only the records projection writes — on that
class the file stays empty all battle, so a records-dead AND file-less
client (that build class never writes `tempArenaInfo.json` either, see
the 2026-10-20 report) never registered a battle, the Tab watcher's
`battle_known` stayed false, and the overlay never showed no matter how
healthily the telemetry streamed. Telemetry henceforth bridges the
walk's side membership (`sides`: the ally/enemy name lists the strip
fold renders, bots included; EMPTY lists when the walk stands down, a
missing field = a probe build predating the bridge), and probe_arena's
synthesis falls back to the frame's lists when `roster_raw` is
unusable — rows keyed on names alone (no ids, no ship ids), relation 0
off the frame's `self.name`. Alongside, the overlay window's realm
chain gains the bound account's realm as its last link: a walk-sourced
identity is empty AND an install scan that names no realm (the
bundle's realm=None WGC shape) used to dead-end the chain at null,
baking a realm-less URL into the window and disabling every stats
lookup for the whole session.

**Exact-order sources (2026-10-18 static + replay probe).** The TAB order
is the client's rendered `AvatarSystem` sequence. Decompiled
`mcb5884c1/m9be68bb6.pyc` (`__createCollections`) builds the dh
splitting/sorting collections `byTeams`, `byTeamsSortedAlive`
(`sortedAlive`), `sortedLeftTeam` and `realPlayers` from the avatar
collection; the unbound UI reads them as
`$datahub.getCollection(CC.avatar).getChildByPath('team.<side>.sortedAlive')`.
That collection is the only exact in-client order — no sort-key
reconstruction can recover the CN HUD order or a vendor's tie rule.

The Mods API cannot reach it on the current WG build. The decompiled
`ModsShell/API_v_1_0/battleGate` carries an internal
`getCollection(componentId)` helper returning the raw dh collection,
but it is a plain module-global assignment, not an exported API: the
injected `battle` SafeClass reported `getCollection`/`getCollections`/
`getAllPlayers` as missing on Steam-ASIA 15.9.0 (build 13357625, replay
probe), while `getPlayersInfo`, `getPlayerInfo`, `getSelfPlayerInfo` and
`getAllShips` resolve. The injected `dataHub` only serves the SYNCED
entity lists (`avatar`, `ship`, …) and flattens them, so the splitting
tree is lost. `prebattleIndex` in the roster records is NOT the row
order: the same replay showed 0 for most players and 1–3 for others (a
pre-battle/division slot, not the HUD sequence). The 15.9 replay probe
also served the `children` collection (33 entities), but their
`Children.list` values are the UI data-hub's own entity ids (197xx),
not the roster's avatar ids (798xxx); that tree is not the team order.
`battleInfo`/`battleState` sampled empty fields. These negative results
are recorded in `order_probe.json`.

Remaining exact-order routes, in preference order:

1. **Unbound view** — read the collection directly (the path above) and
   either render the panel rows in that order or bridge the sequence to
   the companion. The unbound runtime can dispatch external actions
   (`bindcall externalCall 'direct.action'` / `inputMapping.onAction`,
   used by installed mods), but no installed mod writes files; whether
   an external action reaches the Python `events` handler is the next
   experiment.
2. **Flash bridge** — `flashGate` exports `call`,
   `addExternalCallback`/`removeExternalCallback`, and `flash.call`
   resolves in the injected sandbox. If the battle HUD exposes the
   rendered row list through an ActionScript callback, Python could ask
   for it directly; the SWF ABC surface is still uninspected.
3. **Ship sort keys + roster order** (already bridged) — exact only
   when the client's rule matches the reconstructed key; the CN HUD and
   vendor-specific ties remain outside it.
4. **OCR/TAB capture** — the fallback, not a client truth.

The probe now writes `order_probe.json` once per stabilized session
(re-armed if the roster re-stabilizes) with the API surface, the
candidate collection counts, the roster's `prebattleIndex` values, a
bounded sample of the served container components (`children` lists,
`battleInfo`/`battleState` fields) and any
`team.<side>.sortedAlive` order the build exposes. It is diagnostic
only; no ordering consumer reads it.

**In-game panel exact order (2026-10-18)** — the unbound panel now reads
`$datahub.getCollection().getChildByPath('team.<side>.sortedAlive')`
directly and maps each item to its panel row by avatar id (the row
payload carries `avatar_id`, plus the per-side `allyById`/`enemyById`
maps). Every DSL construct used is precedented in views shipped on BOTH
clients: the unguarded collection var (battle_expert), `items.length` +
`evAdded`/`evRemoved`, `items[$index].id`, and the numeric-id payload
dict index via `toString(id)` + `in` + a guarded index (BuildViewer's
exact idiom). An entry whose id pairs with no row renders a BLANK slot —
exact rows keep their TAB lines and never interleave with the fallback
block; a missing collection falls back to the Python order wholesale.
Replay playback neither mounts unbound battle views nor accepts battle
input (proven with a clean build: always-visible panel + scancode Tab
with verified foreground produced zero renders and zero `tabMode`
events), so the visual check needs one real battle.

**CN arrangement re-calibrated (2026-10-18, replay automation)** —
independent photographed captures (the replay loading screen's own team
lists — a ground-truth surface that DOES render in replay) matched the
offline `gameTabRowCompare(shipNameOrder)` prediction exactly: **18/18**
across both teams on one battle, then a full **24/24** on a 12v12, and —
on five volunteer duplicate-ship battles — **5/5 same-team duplicate
pairs** (two Maines, three 芒s, two 沉舰者s, two Kearsarges) all broken
by the client in PLAYER-NAME pinyin order, exactly the comparator's
tie rule (g<m, d<n, l<s, q<s, b<y). Zero mismatches across every
capture so far. On this evidence the owner RELEASED the CN exact grade
the same day: the pill (gated on every row of BOTH sides) and the
overlay's per-side nickname-column drop now grade exact when the
covered rows all carry client-truth localized ship names — the
calibrated arrangement's inputs are then the rendered strings
themselves. The capture side channel below remains
the belt-and-suspenders client-truth channel for both families.

**Overlay nickname column (2026-10-18)** — the transparent overlay
drops a side's extra nickname column when the side's row order is
game-confirmed: WG/Lesta via full sort-key coverage, CN (since the
2026-10-18 release) via full per-side client ship-name coverage.
Partial coverage or a stale stream brings the name cell back.

**Exact-order route matrix (2026-10-18, WG + CN static/live).** The
search is closed on several fronts; what remains is listed with its
status so nobody re-walks the dead ends:

- **Python Mods API** — closed on BOTH clients. CN's decompiled
  `ModsShell/API_v_1_0` matches WG's: `dataHub` exports exactly
  `getEntityCollections`/`getSingleEntity` (SYNCED component lists,
  flattened — the splitting tree is lost), and `battleGate`'s internal
  `getCollection(componentId)` is a plain module-global helper, not an
  exported API (live CN replay probe: `getCollection`/`getCollections`/
  `getAllPlayers` missing on both clients).
- **unbound → Python reverse bridge** — dead on both clients (live):
  `bindcall externalCall 'inputMapping.onAction'`/`'direct.action'`
  with custom action names, direct callback-name externalCalls, and a
  `setUserPref` payload carrier all fail to reach the Python SFM event
  handler or a registered `flash.addExternalCallback` callback. The
  flash callback REGISTERS fine (2-arg form); nothing unbound-side can
  invoke it.
- **unbound collection reads** — WORK (this is the in-game panel's
  exact order above). CN's unbound runtime provably supports them: the
  community battle_expert view shipped on CN uses
  `$datahub.getCollection(CC.xxx).getChildByPath(...)`. Replay
  playback does not mount battle views, so validation needs one real
  battle.
- **Roster-record side fields** — `prebattleIndex` is a division slot
  (0 for most, 1–3 for division members), never the row order; CN
  records carry no top-level `shipName` (the nested `shipInfo` SafeClass
  still needs an item-access probe). Negative results recorded in
  `order_probe.json`.
- **Client memory reading** — out of scope by policy (no injection /
  no memory writes; AGENTS.md §0).
- **OCR of the rendered TAB table** — the retired pixel pipeline; not
  revisited.

**Capture side channel v1 — the encoder is SHIPPED (2026-10-18), decoder
next.** The overlay already screen-captures the game for table geometry;
the unbound view now renders, per side, a tiny barcode strip whose rows
follow the client's OWN sortedAlive order (the same byId pairing the
panel uses), each row encoding that player's rank in the rosterOrder
bridge the telemetry already publishes. Decoding fixed-geometry binary
blocks is OCR-free and attributes every TAB row exactly on EVERY client
(CN included) with only official APIs. The frozen contract (both sides
are written against these exact numbers — a change is a coordinated
spec bump):

- Strip geometry: blocks 6×6 px, hgap 2, vgap 3, 4 px backdrop padding,
  24 px screen-edge margin — ally strip top-LEFT, enemy strip top-RIGHT
  (`left = stageW - 24 - 70`); strip width 70 px. Backdrop
  `0xFF101010`, one-bit `0xFFF2F2F2`, zero-bit `0xFF303030`.
- Row 0 is the header `1,0,1,0,1,0,1,1` (locate + orient); each data
  row is `[1,0] sync + 5 rank bits MSB-first + even-parity bit` (the
  bit over the five: on when their ones count is even). Bits ride the
  panel payload as booleans (`bits`), computed in Python — the DSL only
  renders ternaries. A rankless row (a name the records never carried)
  renders NO word — the decoder must never guess.
- Mode gating: the payload's `panel`/`barcode` flags come from the
  probe's wowsp.toml keys of the same names; the ACTIVE mode's consumer
  declares them when it starts (the in-game bridge → panel=1/barcode=0,
  the overlay watcher → panel=0/barcode=1, once per game session), and
  the probe re-reads the table at every battle start — the two displays
  never share the screen, and the '--' stats tables stay dark in
  overlay mode.
- Row ids: byId keys are the avatar ENTITY ids the walk latches
  (sticky, bots included) — the same id space the collection items
  carry; the roster record's avatarId field is a DIFFERENT id and only
  a fallback.
- Decoder (the Rust side, next PR): scan the LEFT corridor (x 8..120,
  y 8..600, step 2) for the ally strip's header at the 8 px cell pitch,
  and the MIRRORED right corridor (x stageW-120..stageW-8) for the enemy
  strip; per row sample the 8
  cell centers, threshold at luminance 140, validate sync + parity;
  row k of a side's strip ↔ row k of that side's TAB column; rank →
  name via telemetry rosterOrder. Any failure discards the side
  wholesale (the current order inference stays). A synthetic proof
  (500 random permutations + corners, random offsets, noisy scenes,
  0.4 px blur) round-trips this exact contract.

**Encoder hardening (2026-10-09, WG-ASIA 15.9.0 live)**: the client's
own `utils.jsonEncode` proved build-unstable as well — 15.9 RAISED on
plain dict payloads 15.8 accepted, freezing telemetry.json at its
quit-clear while heartbeat/request kept flowing (the probe stayed alive:
key events, records, journal all normal). Every bridge write now routes
through `json_encode_safe` — the client encoder first, a hand-rolled
ASCII-safe serializer as the fallback (harness pass `plain=reject`) —
so one encoder quirk can never silence the telemetry again.

**Telemetry fail-safe (2026-10-18).** The 1 s telemetry writer now names
its failing stage (`telemetry failed@<stage>`) and always emits UTF-8
bytes through `_bridge_write` (py2 text mode would ASCII-encode a
unicode body; a rejected binary open falls back to text mode). If an
auxiliary stage still raises, the writer emits what it actually
collected — the completed alive map (when available) and the client sort
keys — and omits `players` when the roster loop did not finish, so a
failure can neither freeze the file nor falsely assert "everyone
alive".

**CN divergence** (360 build 13243917, captured 2026-10-07): the CN
client's TAB table does NOT move sunk players anywhere — their rows dim
IN PLACE at the battle-start positions (a 5-dead ally block was still
interleaved with alive rows), and the within-(class, tier) row order
follows the LOCALIZED SHIP NAME (pinyin collation), not the decompiled
nation rank (see utils/shipClass). The LIVE surfaces gate both on `realm == "cn"`
(the transparent overlay's mapping + the /live panel's predicted order —
overlay/main.ts's static layout and ship-name order); the replay
viewer and the holographic roster keep the WG rule DELIBERATELY (no CN
capture exists for their contexts) and the plugin's own panel keeps its
arena-rule merge, a cosmetic difference only. As of 2026-10-12, the raw
shipName strings from the probe's records (telemetry `shipNames`)
replace that arrangement's DB name segment whenever a whole side is
covered (see "Ordering-raw-material bridge" above).

## Sandbox constraints (hard-won, keep in the mod's style guide)

- Python is **2.7**; keep syntax conservative (no f-strings; the existing
  probe is intentionally 2/3-compatible).
- `open()` has **no append mode** ('a' returns None instead of raising):
  rewrite files whole from in-memory buffers.
- Missing files log an engine-side error line before raising: seed every
  polled mailbox once at load (see `manual_refresh.flag` seeding).
- Exceptions escaping a callback kill the mod silently: wrap everything,
  dedupe repeated errors before logging.
- `dir()` on the injected modules returns `[]` (SafeClass wrappers): the
  API surface is only the proven-names list above.
- Two loader channels exist: the classic unsigned PnFMods 1.0 path we use,
  and "ModsAPI 2.0" with WG signature validation (ModStation-class signed
  mods). Unsigned community mods coexist fine; signature failures of
  third-party packs are not our concern.

## Architecture

```
┌─ game client (Mods API sandbox, no network) ─────────────┐
│ PnFMods/WoWSPStats/Main.py                               │
│  · roster poll (1 s, stable-confirm) → request.json      │
│  · entity walk → telemetry (hp/relation/alive)           │
│  · SFM events → tabMode marks, lifecycle marks           │
│  · heartbeat.json (phase port/battle, 1–2 s)             │
└──────────────┬────────────────────────────────────────────┘
               │ flat JSON files in the mod's own directory
┌──────────────┴────────────────────────────────────────────┐
│ WoWSP app (Rust, existing processes)                      │
│  · bridge reader/writer (replaces the experiment probe's │
│    companion role; same request/response protocol the    │
│    third-party reference plugin established)             │
│  · ordering engine: arena order + dead-sinking           │
│  · roster mode "plugin" in overlay_config                │
│  · health check: parse profile/python.log for the mod's  │
│    load/self-check lines (api[load] dh=True …)           │
└───────────────────────────────────────────────────────────┘
```

Bridge files (protocol v1, all in the mod directory):

```jsonc
// request.json — written by the mod on a stable roster (and re-written on
// manual refresh). Companion answers with stats rows.
{ "version": 1, "created": 1690000000.0, "session": "1690000000000",
  "manual": false,
  "players": [ { "name": "...", "account_id": 0, "avatar_id": 0,
                 "ship_id": 0 } ] }

// response.json — written by WoWSP; revision must be monotonic per session;
// an empty file (no trailing newline) means "pending".
{ "version": 1, "session": "1690000000000", "revision": 3, "busy": false,
  "rows": [ { "name": "...", "wr": 52.3, "pr": 1450, "state": "ok",
              "bf": { "battles": 8213, "ishidden": false } } ],
  "labels": { "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" } }

// heartbeat.json — rewritten every 1–2 s; stale = mod dead or game closed.
{ "v": "0.1.0", "t": 1690000000000, "phase": "port" | "battle",
  "players": 17, "revision": 3, "rec": 18, "fb": "" | "records" | "walk" }

// `rec` (records seen this tick) and `fb` (the session's fallback source)
// are the degraded-roster diagnostics added after the 2026-10-18/19 field
// reports (Steam 13357625 + CN360 13357822): on those builds the roster
// NEVER stabilizes — `battle.getPlayersInfo()` answers empty or churns all
// battle — so the telemetry session gate stood closed and telemetry.json
// appeared only as the battle-end quit-clear. The probe now synthesizes
// the session after five grace battle ticks: from the last non-empty
// records attempt (`fb: "records"` — the identity bridge survives), else
// from the entity walk (`fb: "walk"` — names/alive/sides only, identity
// empty and the companion's own realm routing takes over). The companion
// logs the marker once per battle as the "degraded but bridged" evidence
// line, distinct from the hard telemetry-absent WARN.

// telemetry journal — whole-file rewrite of a bounded per-battle ring;
// every distinct state plus event marks on one timeline:
{ "t": 1690000000000, "players": { "<avatarId>": { /* projection */ } },
  "states": { "<name>": { "hp": "43150.0/43150.0", "relation": "2",
                          "alive": "True" } } }
{ "t": 1690000001000, "ev": "input.tabModeIn" }
{ "t": 1690000004000, "ev": "playersListUpdated" }

// manual_refresh.flag — WoWSP writes a fresh epoch-seconds stamp to trigger a
// re-query; the mod consumes it within a 10 s window.
```

## Server-synced price catalog (price_catalog.json)

**Why it exists.** The client's module economy is not static: neither
GameParams nor the scripts layer carries it (decoded build 13357625 —
ShipCrossResearchInfo reads a runtime price list, and the price classes
behind getModulePrices are synced client params). Per-item prices
(credits/gold, discounts) and the cross-research fields (module research
XP plus the required-module dependency price info) arrive as dataHub
components synchronized from the server at login:
dhcomponents.ItemPrice (collection itemPrice),
dhcomponents.ShipCrossResearchInfo (shipCrossResearchInfo),
dhcomponents.ShipTechRestrictions (shipTechRestrictions) and
dhcomponents.ShipEconomicAttributes (shipEconomicAttributes). The
companion app cannot derive these offline, so the probe captures them
once per client session. **Capture-only:** nothing in game reads the file
(no telemetry, panel or ordering path touches it); the companion reads it
through the same flat-file bridge as builds.json / order_probe.json.

**File shape.**

```jsonc
// price_catalog.json — one-shot per client session (never per battle);
// written only when at least one entity was captured.
{ "v": 1, "t": 1690000000000, "phase": "load" | "battle",
  "counts": { "shipCrossResearchInfo": 842, "itemPrice": 21713,
              "shipTechRestrictions": 842, "shipEconomicAttributes": 842 },
  "collections": {
    "shipCrossResearchInfo": [
      { "id": "4170000000",            // the ENTITY id (the join key)
        "components": {
          "ShipCrossResearchInfo": {   // component class name (or CLASS_ID)
            "researchPriceShipExp": 12000,
            "researchPriceFreeExp": 300,
            "researchPriceInfo": { "basePrice": 12000, "finalPrice": 9600,
                                   "currency": "credits" },
            "dependenciesResearchPriceInfo": {
              "PRUH604_D7_HULL_TOP_2": { "basePrice": 4000,
                                         "finalPrice": 3800,
                                         "currency": "credits" } },
            "dependenciesResearchPriceVisible": true,
            "isResearchPriceVisible": true,
            "shipsCrossResearchCostXP": 18000
            // ...the full decoded __slots__ list of the class; the
            // authoritative field lists live in Main.py's
            // _PRICE_COMPONENT_FIELDS
          } } }
    ],
    "itemPrice": [
      { "id": "...", "components": { "ItemPrice": {
          "id": 9201, "currencyID": "credits", "currency": "credits",
          "basePrice": 21000, "finalPrice": 18900,
          "discountPercent": 10, "discountId": 0, "type": "...",
          "till": 0, "isPrivate": false } } } ],
    "shipTechRestrictions": [
      { "id": "...", "components": { "ShipTechRestrictions": {
          "id": 9301, "restrictions": [ "...upgrade entry name..." ] } } } ],
    "shipEconomicAttributes": [ ... ]
    // ^ dynamic sync: generic fallback fields (decoded __slots__ is empty)
  },
  "truncated": true }   // omitted unless the 30000-entity cap was hit
```

Every value is JSON-safe by construction: scalars verbatim, nested price
structs/mappings as objects, strings/bytes text-decoded, numbers via the
probe's sandbox-safe number conversion (prices are integers), containers
bounded (256 items, depth 4). Unreadable fields are omitted, never
fabricated; an unrecognized component class is keyed by its class name
(CLASS_ID fallback) and dumped through the generic __dict__/known-slot
fallback, with _class/_class_id diagnostics when nothing else reads.

**Lifecycle.** One load-phase attempt after resolve_api(), then a small
number of scheduler-tick retries (cap 10, ~20 s at the port cadence)
for the login datastore sync. The bridge is done once BOTH
shipCrossResearchInfo and itemPrice
carry data — one WOWSP_PROBE price catalog written line reports the
per-collection counts — or it stands down silently when the whole hub is
withheld (the Lesta sandbox shape: no file, no log line, no soft error).
A count of -1 means the hub refused that collection name. The file is
never re-written after the retry window: the companion may be reading it.
**A first real capture must verify** the actual served collection names,
the entity-id join keys (ship/item ids) and the component shapes (the
decoded __slots__ classes vs SafeClass wrappers); the harness pins the
parsing contract offline with planted collections.

## Crosshair aim panel

The aim panel (2026-10-18) floats the AIMED player's basic stats a
configurable distance under the crosshair, in-game rendered like the Tab
tables and readable while aiming — not while Tab is held (the unbound
root therefore keeps it OUTSIDE the Tab-visible block).

**Detection contract (decompiled, build 13357625).** The client's own
world ship markers iterate the SAME `CC.avatar` collection the probe
walks (`gui/unbound2/pc/battle/markers/base_marker.unbound`:
`WorldShipMarker` is the avatar renderer), and the lock icon on each
marker lights on `targetComponent.flags & LOCKABLE_WEAPONS`
(`markers/ship_marker.unbound` GET_MARKER_ENTITY_COMPONENT 'target';
the mask is frozen in `shared/constants.unbound` as bits
{0,1,2,6,7,8,10,12,13} = `0x35C7` over the WEAPON_* enum). So "who the
local player is aiming at" is authoritative and engine-computed: the
avatar entity whose `target` component carries any lockable bit. The
probe reads it per tick in the same entity walk (`aim_flags_of`):
`entity[UiComponents.target].flags` on the cc path, duck-typed
components-mapping fallback (`.flags` without `.reasons` — CanHit
carries both) when the client withholds the cc attribute. When several
entities are targeted at once (guns on one ship, torpedoes locked on
another) the MAIN-battery bits (0-2 = UNKNOWN/MAIN_AP/MAIN_HE) win, else
the first lockable hit. The mask constants live in Main.py as
`AIM_LOCKABLE`/`AIM_MAIN_BITS`; changing them is a spec bump against the
client, exactly like the barcode geometry.

**Verdict surface.** The latch lands in telemetry (`aim: {name, flags}`
every battle tick, empty name = no target — the replay/live monitor
reads this), in python.log (`aim <name> flags=<n>` on every switch), and
in the panel payload (`aim` block below).

**Panel payload (aim_block, all presentation Python-side).**

```jsonc
{ "aim": { "on": true, "name": "Foe03", "ship": "Shimakaze",
           "offset": 120,
           "vals": [ { "t": "52.5%", "c": 0xFFFFEE66, "label": "Win rate" },
                     { "t": "1234",  "c": 0xFFFFEE66, "label": "PR" } ] } }
```

`offset` is the wowsp.toml `aim_offset` px below the stage center (the
crosshair sits at the center in every gun mode); `aim = 0` hides the
panel; an EXPLICIT empty column list (the user removed every card)
hides it too, while a companion that never sent columns keeps a
name/ship-only panel.

**Column pipeline.** The columns are the SAME drag-card editor the
water table uses (`OverlayColumnsEditor`, a second instance in the
in-game settings section), persisted as `aimColumns` in the stats prefs
(limit 4, scope "global" in v1 — the bridge serves one roster lookup;
per-ship/class scopes would need the webui's per-player ship-list
pipeline, deliberately out of scope). The MAIN window's overlay
lifecycle pushes them to the bridge on start and on every prefs change
(`set_ingame_bridge_aim([{scope, metric, label}])`, label pre-localized
by the webui), and `response.json` grows:

```jsonc
"aimCols": [ { "scope": "global", "metric": "winrate", "label": "Win rate" } ],
"rows": [ { ..., "aim": [ 52.3 ] } ]   // aligned with aimCols; null = no data
```

`aimCols` is omitted entirely until the companion first receives a
column list (old-probe byte compatibility); an explicitly EMPTY list is
still written (the hide gate above).

**Replay caveat.** Replays do not mount the battle HUD views, so the
panel itself is not visually verifiable in a replay — but the Python
walk runs (the order-probe evidence class), which is why the verdict
rides telemetry: replay playback is the sanctioned way to watch aim
switches live (2026-10-18 matrix: the Steam client's own 15.9.0 replays
plus the CN360 volunteer replays at matching builds).

## Product integration

1. **Auto-install on toggle**: enabling the in-game ordering source in
   settings writes the mod via the existing `mod_install.rs` /
   `packages/ingame-plugin` path (`PnFModsLoader.py` marker only if absent; own
   files only; snapshot + rollback; game-closed guard). Disabling
   uninstalls. This is the "special" registration behavior the owner
   specified: the plugin never appears as a manual install step.
2. **Own-repo Discussions registration**: publish a templated resource
   thread on `langyo/wowsp/discussions` and reference it from a
   `mod-index.json` entry (`category`, `discussion`, `versions[].game`
   compatibility) so the Mod Hub can also list/verify it like any other
   mod — first-party provenance, same catalog machinery (mod-hub.md gap
   G8 consent model).
3. **Fallback chain**: telemetry missing/stale (heartbeat older than N s,
   `api[load] dh=False`, game updated and the mod broke) → silently fall
   back to the current inference pipeline. The overlay never depends on
   the mod to function.

## Risks & maintenance

- **WG API drift** is now the only coupling (no unbound, no stock-element
  copies). The Mods API v1.0 surface has been stable across 13.x→15.8;
  the probe's self-check line makes breakage loud and diagnosable.
- **CN client**: verified working; the 360 client runs the same Mods API
  loader (its log scans for `PnFModsLoader.py` natively). Watch CN
  anti-cheat policy changes each major version.
- **Perf**: 1 s polling of `getPlayersInfo` + entity walk is well within
  budget (TeamHP-style mods walk entities per frame); never use
  `callbacks.perTick` for this.
- **Journal growth**: bounded ring per battle; ship segments with the
  replay if useful for post-battle analysis.

## Rust integration map (exact touch points)

| Concern | File (existing unless noted) | Change |
| --- | --- | --- |
| Bridge file watcher | `commands/arena_info.rs` sibling: new `commands/ingame_bridge.rs` | `notify`-watch the mod directory; parse heartbeat/request/journal; expose Tauri events `wowsp://ingame-*` |
| Ordering engine | `packages/webui/src/features/replay/liveTabOrder.ts` + `packages/webui/src/overlay/inferredOrder.ts`, with Lesta roster synthesis in `commands/probe_roster.rs` | arena order + dead-sinking reducer fed by bridge events; emits the final row order the overlay renders |
| Config schema | `commands/overlay_config.rs` + `packages/webui/src/stores/overlayConfig.ts` | `roster` gains `"plugin"` (priority chain `plugin > inferred > ocr > off`) |
| Overlay key gating | `overlay/placement.rs` (`tab_key_down`) | when the bridge is live, drive show/hide from `input.tabModeIn/Out` marks instead of `GetAsyncKeyState` polling |
| Install / uninstall | `commands/mod_install.rs` + `packages/ingame-plugin/` (new subpackage) | template becomes the subpackage's `Main.py`; snapshot + rollback; game-closed guard; legacy probe cleanup |
| Health check | `commands/ingame_bridge.rs` | parse `profile/python.log` for the mod's `probe … loaded` / `api[load] dh=True` self-check lines; expose status for the settings UI |
| Stats rows | existing `wg_api.rs` / `wg_api_cn.rs` | unchanged — the companion writes `response.json` from the same batch lookup the overlay uses today |

## Test plan

- **Sandbox conformance**: every shipped `Main.py` change is validated
  by `scripts/check_ingame_plugin.py` (CI: "In-game probe sandbox
  conformance"): the file is exec'd under a deliberately crippled
  builtins set — only `open`, `len`, `__import__` (plus the py3-only
  `__build_class__`, a harness artifact; py2.7 class creation needs no
  builtin — and the game's py2.7 also resolves `True`/`False` as
  builtin globals, which a py3 harness cannot withhold; the
  client-side census reports them) — with the injected mods stubbed (the engine modules
  ModsShell/dh/BigWorld stay missing on purpose: their diagnostic blocks
  may legally degrade, and the harness pins the bridge artifacts those
  blocks never feed) and a planted `wowsp.toml` asserting the tool-config
  read, a full battle is driven, and
  the bridge artifacts the app consumes (roster_raw.json in both probe
  encodings — bots included — telemetry.json with the self/identity
  block and numeric `t`, heartbeat/request with valid numeric ids) must
  come out correct with ZERO `is not defined` degradations in the probe
  log.
  Background: Lesta's builtin whitelist omits the class/reflection
  machinery (`Exception`, `object` and more each killed the mod at
  import across 2026-10-08), so the core paths are written to need no
  builtin names at all; the harness is the regression net. Since
  2026-10-10 four SHIP passes additionally drive the game-true sort-key
  path with planted ship entities (the WG shape asserting the exact key
  table and the panel fold's stable key sort, the Lesta shape with
  raising UiComponents, a partial-coverage shape whose unpaired side
  keeps the walk order, and the 15.9 encoder quirk the key table must
  survive) — and the live-battle question they could not answer (what
  the real Lesta sandbox serves for the 'ship' collection) was settled
  the same day, 2026-10-10: the full key table, 11/11 including bots.
  Three PRICE passes pin the server-synced economy bridge: the planted
  collections must round-trip the exact entity rows / decoded field
  lists / counts, the deferred shape proves the login-sync retry lands
  the same file on a later tick, and the withheld Lesta shape
  (UiComponents raising + every collection refused) must leave
  price_catalog.json ABSENT with no swallowed-exception text in either
  the probe log or the soft-error latch. Also keep
  `python -m py_compile` green.
- **Port-only smoke test** (no battle): launch the game, sit in port
  ~15 s, exit; assert `injected names=[…]`, `api[load] dh=True`, and a
  fresh heartbeat in `python.log`. This is the cheap protocol that kept
  the experiment honest — keep it as the acceptance test for installs.
- **Battle fixtures**: one co-op per realm; assert journal contains the
  roster snapshot, ≥1 sink-driven `alive` flip, tabMode marks, and that
  `typeDeath` lines in `python.log` match the flips 1:1.
- **Fallback drill**: stop the app (no companion), assert the mod's 180 s
  busy timeout recovers and the next battle still requests; corrupt the
  mod dir, assert the overlay silently falls back to inference.

## Delivery plan

- **M1** — productionize: strip the probe's discovery batteries into a
  debug flag; freeze the bridge protocol; Rust bridge + ordering engine +
  `roster = "plugin"` mode wired into the overlay store.
- **M2** — settings toggle, auto-install/uninstall, python.log health
  check, stale-fallback logic.
- **M3** — Discussions registration, catalog entry, update channel
  (template bumps ride the app release; the mod file itself changes
  rarely).
