use super::build::decode_vehicle_build;
use super::*;
/// Hostile-stream budget: how many distinct entities the frame walk may
/// track. Real battles carry O(10²) entities; a synthetic EntityCreate
/// flood inside the 256 MiB decompress budget used to drive both the
/// group-by merge's O(n²) scan and GB-scale empty-trajectory memory. The
/// cap leaves three orders of magnitude of headroom; once hit, further
/// NEW entities are skipped (existing ones keep decoding) — audit
/// M-8-class input hardening.
pub(super) const MAX_TRACKED_ENTITIES: usize = 100_000;
/// Walk `[u32 size][u32 type][f32 time][payload]` frames, collecting Position
/// samples (grouped by entity id) and EntityCreate metadata. Stops cleanly if a
/// frame header is truncated or declares an absurd size (trailing padding).
///
/// `legacy` selects the pre-12.6.0 packet-id layout (see [`remap_legacy_packet_id`]);
/// `profile` carries the per-version method ids and entity-type indices;
/// `version_key` selects the arena-state FixedDict field layout.
pub(super) fn walk_frames(
    inflated: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
    legacy: bool,
    profile: &LayoutProfile,
    version_key: Option<(u32, u32, u32)>,
) -> DecodedReplay {
    let mut positions: BTreeMap<i32, Vec<PositionSample>> = BTreeMap::new();
    let mut kinds: BTreeMap<i32, EntityKind> = BTreeMap::new();
    let mut destroys: BTreeMap<i32, f32> = BTreeMap::new();
    let mut properties: BTreeMap<i32, Vec<PropertyChange>> = BTreeMap::new();
    let mut methods: Vec<RawMethodCall> = Vec::new();
    let mut method_histogram: Vec<(f32, i32, i32, u32)> = Vec::new();
    let mut method_arg_samples: std::collections::BTreeMap<(i32, i32), Vec<Vec<u8>>> =
        std::collections::BTreeMap::new();
    let mut nested: Vec<RawNestedProperty> = Vec::new();
    let mut weapon_locks: Vec<wowsp_tauri_shared::WeaponLockEvent> = Vec::new();
    let mut battle_results: Option<String> = None;
    let mut version: Option<String> = None;
    let mut map_name: Option<String> = None;
    let mut camera: Vec<wowsp_tauri_shared::CameraSample> = Vec::new();
    let mut net_stats: Vec<wowsp_tauri_shared::NetStatsSample> = Vec::new();
    let mut leaves: BTreeMap<i32, f32> = BTreeMap::new();
    let mut camera_modes: Vec<wowsp_tauri_shared::HpSample> = Vec::new();
    let mut diagnostics = wowsp_tauri_shared::DiagnosticCounts::default();
    let mut squadron_creates: Vec<wowsp_tauri_shared::SquadronCreate> = Vec::new();
    let mut squadron_planes: Vec<wowsp_tauri_shared::SquadronPlane> = Vec::new();
    let mut minimap_squadron_adds: Vec<wowsp_tauri_shared::MinimapSquadronAdd> = Vec::new();
    let mut minimap_squadron_moves: Vec<wowsp_tauri_shared::MinimapSquadronMove> = Vec::new();
    let mut minimap_squadron_removes: Vec<wowsp_tauri_shared::MinimapSquadronRemove> = Vec::new();
    let mut wards: Vec<wowsp_tauri_shared::WardEvent> = Vec::new();
    let mut ward_removes: Vec<wowsp_tauri_shared::WardRemoveEvent> = Vec::new();
    let mut shot_kills: Vec<wowsp_tauri_shared::ShotKillEvent> = Vec::new();
    let mut damage_stats: Vec<wowsp_tauri_shared::DamageStatSample> = Vec::new();
    let mut chat_messages: Vec<wowsp_tauri_shared::ChatEvent> = Vec::new();
    let mut achievements: Vec<wowsp_tauri_shared::AchievementEvent> = Vec::new();
    let mut recorder_avatar: Option<i32> = None;
    let mut position_a_counts: BTreeMap<i32, usize> = BTreeMap::new();
    // E2/E8/E11 experiment surfaces (PR #448): recorder control input, smoke
    // lifecycles, minimap vision, consumable uses.
    let mut cruise: Vec<wowsp_tauri_shared::CruiseSample> = Vec::new();
    let mut vision_events: Vec<wowsp_tauri_shared::VisionEvent> = Vec::new();
    let mut consumable_uses: Vec<wowsp_tauri_shared::ConsumableUseEvent> = Vec::new();
    // SmokeScreen entities keyed by id while their lifecycle is assembled;
    // converted to the sorted event list after the walk (the dissipation end
    // only becomes known when the leave/destroy packet arrives later).
    let mut smokes: BTreeMap<i32, wowsp_tauri_shared::SmokeScreenEvent> = BTreeMap::new();
    // The recorder's own vehicle: set once the avatar's 0x2c stream links to
    // the vehicle it occupies.
    let mut recorder_vehicle: Option<i32> = None;
    // Per-vehicle build payloads decoded out of the EntityCreate state stream
    // (both teams — the IPC exit filters to allies; see `packets::build`).
    let mut vehicle_builds: Vec<VehicleBuildRaw> = Vec::new();
    let mut cur = 0usize;
    while cur + 12 <= inflated.len() {
        let Some(size) = read_bytes(inflated, cur)
            .map(u32::from_le_bytes)
            .map(|v| v as usize)
        else {
            break;
        };
        let Some(ptype) = read_bytes(inflated, cur + 4).map(u32::from_le_bytes) else {
            break;
        };
        let Some(time) = read_bytes(inflated, cur + 8).map(f32::from_le_bytes) else {
            break;
        };
        let payload_end = cur + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        let payload = &inflated[cur + 12..payload_end];
        let logical_type = if legacy {
            remap_legacy_packet_id(ptype)
        } else {
            ptype
        };
        match logical_type {
            PACKET_POSITION => {
                if let Some(sample) = parse_position(payload, time) {
                    *position_a_counts.entry(sample.entity_id).or_default() += 1;
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            // 0x2b needs no arm: the legacy remap already maps it onto
            // PACKET_PLAYER_POSITION, and modern clients never emit it.
            PACKET_PLAYER_POSITION | PACKET_POSITION_AUX => {
                if let Some(sample) = parse_player_position(payload, time) {
                    // The avatar's own 0x2c stream occasionally links to the
                    // vehicle it occupies (linked != 0) — the only
                    // deterministic recorder-vehicle join in the stream.
                    // Only 0x2c is trusted for it: the 0x2a aux stream also
                    // carries the avatar (spectate/aircraft following) and
                    // its links were not verified.
                    if ptype == PACKET_PLAYER_POSITION
                        && recorder_vehicle.is_none()
                        && Some(sample.entity_id) == recorder_avatar
                        && sample.vehicle_id != 0
                    {
                        recorder_vehicle = Some(sample.vehicle_id);
                    }
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            // Lesta 26.10 renumbered this stream onto 0x2e (see the constant):
            // the same 32-byte PlayerPosition layout, carrying the recorder's
            // own ship, its avatar and the squadron transforms. WG containers
            // never reach the arm — the id sits in their undefined tail gap.
            PACKET_PLAYER_POSITION_LESTA if profile.lesta => {
                if let Some(sample) = parse_player_position(payload, time) {
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            PACKET_ENTITY_CREATE => {
                if let Some(created) = parse_entity_create(payload, time, profile.zone_entity_type)
                {
                    let eid = created.entity_id;
                    let entity_type = created.entity_type;
                    let (x, y, z) = (created.x, created.y, created.z);
                    let mut kind = created.clone_into_kind();
                    kind.ship_id = scan_state_for_ship_id(&payload[38..], ship_id_candidates);
                    if kind.entity_type == 2 {
                        kind.max_health = scan_state_for_max_health(&payload[38..]);
                        // The vehicle's own team slot — the one side signal
                        // that also covers ships the arena broadcast never
                        // lists (scripted operation waves spawn mid-battle).
                        // Needs a pinned property table exposing `teamId`;
                        // other versions stay None (existing joins apply).
                        if let Some(version_key) = version_key {
                            kind.team_id =
                                build::scan_state_for_team_id(&payload[38..], version_key);
                        }
                        // Build decode (pinned to the 15.9.x era): the trailing
                        // create state carries the vehicle's shipConfig and the
                        // captain's crew modifiers. A state the walk cannot
                        // trust is skipped and counted — it never fails the
                        // whole replay.
                        if profile.builds {
                            // Destroy-and-recreate (respawn / re-enter) repeats
                            // the SAME create state: keep the first build per
                            // entity, mirroring the kinds map's first-creation
                            // rule above.
                            if !vehicle_builds.iter().any(|build| build.entity_id == eid) {
                                let version_key = version_key.unwrap_or((0, 0, 0));
                                if let Some(build) =
                                    decode_vehicle_build(eid, &payload[38..], version_key)
                                {
                                    // The decoded shipParamsId is the entity's
                                    // GameParams id whether or not the ship sits
                                    // in the roster: scripted operation waves
                                    // carry no roster row, and their labels and
                                    // models join on this id. The roster-scan
                                    // candidate match above still wins when it
                                    // fired (same id, authoritative source).
                                    if kind.ship_id.is_none() {
                                        kind.ship_id = Some(i64::from(build.ship_params_id));
                                    }
                                    vehicle_builds.push(build);
                                    diagnostics.builds_decoded += 1;
                                } else {
                                    diagnostics.builds_skipped += 1;
                                }
                            }
                        } else if version_key.is_some() && !kinds.contains_key(&eid) {
                            // Other client versions have no pinned build layout:
                            // count the entity as skipped (once) so the
                            // diagnostics distinguish "no build support for this
                            // version" from "the stream carried nothing".
                            diagnostics.builds_skipped += 1;
                        }
                    }
                    // Smoke screens: walk the create state for the radius /
                    // height properties (experiment E8). Only the event list
                    // consumes them — the kind stays a plain entity so the
                    // frontend's smoke rendering is untouched.
                    if entity_type == ENTITY_TYPE_SMOKE_SCREEN {
                        let (radius, height) = parse_smoke_state(&payload[38..]);
                        smokes
                            .entry(eid)
                            .or_insert(wowsp_tauri_shared::SmokeScreenEvent {
                                time,
                                entity_id: eid,
                                x,
                                y,
                                z,
                                radius,
                                height,
                                end_time: None,
                            });
                    }
                    // Entities destroyed and re-created mid-match (leaving and
                    // re-entering the observed area) keep their FIRST creation
                    // time so the frontend doesn't hide them until re-creation.
                    if kinds.contains_key(&eid) || kinds.len() < MAX_TRACKED_ENTITIES {
                        kinds.entry(eid).or_insert(kind);
                    }
                }
            },
            PACKET_CELL_PLAYER_CREATE => {
                if let Some(created) = parse_cell_player_create(payload, time) {
                    let eid = created.entity_id;
                    let mut kind = created.clone_into_kind();
                    kind.entity_type = ENTITY_TYPE_AVATAR;
                    if kinds.contains_key(&eid) || kinds.len() < MAX_TRACKED_ENTITIES {
                        kinds.entry(eid).or_insert(kind);
                    }
                    // The recorder's own avatar — the arena state's
                    // `avatarId` back-reference keys the is_self marking.
                    recorder_avatar = Some(eid);
                }
            },
            PACKET_ENTITY_DESTROY => {
                if let Some(eid) = parse_entity_destroy(payload) {
                    destroys.insert(eid, time);
                }
            },
            PACKET_ENTITY_PROPERTY => {
                for change in parse_property(payload, time) {
                    properties.entry(change.entity_id).or_default().push(change);
                }
            },
            PACKET_ENTITY_METHOD => {
                if let Some(call) = parse_entity_method(payload, time) {
                    method_histogram.push((
                        call.time,
                        call.entity_id,
                        call.method_id,
                        call.args.len() as u32,
                    ));
                    let entry = method_arg_samples
                        .entry((call.entity_id, call.method_id))
                        .or_default();
                    if entry.len() < 6 {
                        entry.push(call.args[..call.args.len().min(24)].to_vec());
                    }
                    methods.push(call);
                }
            },
            PACKET_NESTED_PROPERTY => {
                if let Some(n) = parse_nested_property(payload, time) {
                    nested.push(n);
                }
            },
            PACKET_SET_WEAPON_LOCK => {
                if let Some(lock) = parse_weapon_lock(payload, time) {
                    weapon_locks.push(lock);
                }
            },
            PACKET_BATTLE_RESULTS => {
                if battle_results.is_none() {
                    battle_results = parse_battle_results(payload);
                }
            },
            PACKET_VERSION => {
                if version.is_none() {
                    version = parse_version(payload);
                }
            },
            PACKET_CAMERA => {
                if let Some(s) = parse_camera(payload, time) {
                    camera.push(s);
                }
            },
            // Lesta 26.10 moved the camera stream onto 0x26 (see the
            // constant): the WG camera layout in the first 32 bytes, so the
            // existing parser reads it whole; the family gate keeps a WG
            // container's BasePlayerCreateStub traffic (that family's 0x26)
            // out of the camera timeline. Placement above the stub arm
            // commits every Lesta 0x26 packet here — including sub-56-byte
            // payloads the parser rejects — so the diagnostics'
            // create_stubs count no longer covers Lesta 0x26 traffic
            // (nothing consumes that counter).
            PACKET_CAMERA_LESTA if profile.lesta => {
                if let Some(s) = parse_camera(payload, time) {
                    camera.push(s);
                }
            },
            PACKET_NET_STATS => {
                if let Some(s) = parse_net_stats(payload, time) {
                    net_stats.push(s);
                }
            },
            PACKET_MAP => {
                if map_name.is_none() {
                    map_name = parse_map_name(payload);
                }
            },
            PACKET_ENTITY_LEAVE => {
                if let Some(eid) = parse_entity_destroy(payload) {
                    leaves.insert(eid, time);
                }
            },
            PACKET_ENTITY_ENTER => {
                diagnostics.entity_enters += 1;
            },
            PACKET_SERVER_TICK => {
                diagnostics.server_ticks += 1;
            },
            PACKET_SERVER_TIMESTAMP => {
                diagnostics.server_timestamps += 1;
            },
            PACKET_INIT_FLAG => {
                diagnostics.init_flags += 1;
            },
            PACKET_INIT_MARKER => {
                diagnostics.init_markers += 1;
            },
            PACKET_BASE_PLAYER_CREATE => {
                diagnostics.base_player_creates += 1;
            },
            PACKET_BASE_PLAYER_CREATE_STUB => {
                diagnostics.create_stubs += 1;
            },
            PACKET_ENTITY_CONTROL => {
                diagnostics.entity_controls += 1;
            },
            PACKET_CAMERA_MODE => {
                if let Some(mode) = parse_camera_mode(payload, time) {
                    camera_modes.push(mode);
                    diagnostics.camera_modes += 1;
                }
            },
            PACKET_CAMERA_FREELOOK => {
                diagnostics.camera_freelooks += 1;
            },
            PACKET_SUB_CONTROLLER => {
                diagnostics.sub_controllers += 1;
            },
            PACKET_CRUISE_STATE => {
                diagnostics.cruise_states += 1;
                if let Some(sample) = parse_cruise_state(payload, time) {
                    cruise.push(sample);
                }
            },
            PACKET_SHOT_TRACKING => {
                diagnostics.shot_trackings += 1;
            },
            PACKET_GUN_MARKER => {
                diagnostics.gun_markers += 1;
            },
            _ => {},
        }
        cur = payload_end;
    }
    // Capture-zone progress: nested-property payloads on InteractiveZone
    // entities (type index is version-dependent) carry the live capture
    // fraction as a trailing f32 (0..1). Keep only those, keyed by entity.
    let mut cap_progress: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> = BTreeMap::new();
    for n in &nested {
        if kinds.get(&n.entity_id).map(|k| k.entity_type) != Some(profile.zone_entity_type) {
            continue;
        }
        if n.payload.len() >= 4 {
            let Some(f) = read_bytes(&n.payload, n.payload.len() - 4).map(f32::from_le_bytes)
            else {
                continue;
            };
            if f.is_finite() && (0.0..=1.5).contains(&f) {
                cap_progress
                    .entry(n.entity_id)
                    .or_default()
                    .push(wowsp_tauri_shared::HpSample {
                        time: n.time,
                        value: (f * 1000.0).round() as u32,
                    });
            }
        }
    }
    for samples in cap_progress.values_mut() {
        samples.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    // Global weather: the same nested-property stream also carries the
    // BattleLogic entity's `state.weather.globalWeather` — cyclone/storm
    // transitions and approach warnings. The weather-id shape gate inside
    // parse_weather_nested rejects every other nested payload (squadron
    // positions, capture progress), so no entity-type filter is needed.
    let mut weather_transitions: Vec<wowsp_tauri_shared::WeatherTransition> = Vec::new();
    let mut weather_notifications: Vec<wowsp_tauri_shared::WeatherNotification> = Vec::new();
    for n in &nested {
        match parse_weather_nested(&n.payload) {
            Some(WeatherSignal::Transition {
                from_param,
                to_param,
                start_time,
                end_time,
            }) => weather_transitions.push(wowsp_tauri_shared::WeatherTransition {
                time: n.time,
                start_time,
                end_time,
                from_param,
                to_param,
            }),
            Some(WeatherSignal::Notification { param, at_time }) => {
                weather_notifications.push(wowsp_tauri_shared::WeatherNotification {
                    time: n.time,
                    at_time,
                    param,
                });
            },
            None => {},
        }
    }
    weather_transitions.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    weather_notifications.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Resolve method calls into events once the entity types are known: the
    // method ids live in per-entity-type exposed-index tables (version-drifting,
    // see `method_tables`), and only the avatar entity (type 1) carries the
    // battle-effect broadcast methods.
    let mut shell_launches: Vec<wowsp_tauri_shared::ShellLaunchEvent> = Vec::new();
    let mut explosions: Vec<wowsp_tauri_shared::ExplosionEvent> = Vec::new();
    let mut torpedoes: Vec<wowsp_tauri_shared::TorpedoLaunch> = Vec::new();
    let mut torpedo_steers: Vec<wowsp_tauri_shared::TorpedoSteer> = Vec::new();
    for call in &methods {
        let entity_type = kinds.get(&call.entity_id).map(|k| k.entity_type);
        let Some(m) = profile.methods else {
            break;
        };
        if entity_type != Some(ENTITY_TYPE_AVATAR) {
            // Vehicle-side method streams (E11): consumable uses fire on
            // type-2 entities against the Vehicle exposed-id table.
            if entity_type == Some(ENTITY_TYPE_VEHICLE)
                && profile
                    .e11
                    .is_some_and(|e| e.vehicle_on_consumable_used == call.method_id)
            {
                if let Some(event) = decode_consumable_used(call.time, call.entity_id, &call.args) {
                    consumable_uses.push(event);
                }
            }
            continue;
        }
        if call.method_id == m.avatar_receive_artillery_shots {
            shell_launches.extend(decode_artillery_shots(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_torpedoes {
            torpedoes.extend(decode_torpedo_salvos(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_explosions {
            explosions.extend(decode_explosions(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_torpedo_direction {
            torpedo_steers.extend(decode_torpedo_directions(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_add_squadron {
            if let Some(s) = decode_squadron_add(call.time, &call.args) {
                squadron_creates.push(s);
            }
        } else if call.method_id == m.avatar_receive_update_squadron {
            squadron_planes.extend(decode_squadron_update(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_add_minimap_squadron {
            if let Some(s) = decode_minimap_squadron_add(call.time, &call.args) {
                minimap_squadron_adds.push(s);
            }
        } else if call.method_id == m.avatar_receive_update_minimap_squadron {
            if let Some(s) = decode_minimap_squadron_move(call.time, &call.args) {
                minimap_squadron_moves.push(s);
            }
        } else if call.method_id == m.avatar_receive_remove_minimap_squadron
            && args_is_plane_id(&call.args)
        {
            let Some(plane_id) = read_bytes(&call.args, 0).map(u64::from_le_bytes) else {
                continue;
            };
            minimap_squadron_removes.push(wowsp_tauri_shared::MinimapSquadronRemove {
                time: call.time,
                plane_id,
            });
        } else if call.method_id == m.avatar_receive_ward_added {
            if let Some(w) = decode_ward_added(call.time, &call.args, profile.ward_has_type) {
                wards.push(w);
            }
        } else if call.method_id == m.avatar_receive_ward_removed && args_is_plane_id(&call.args) {
            let Some(plane_id) = read_bytes(&call.args, 0).map(u64::from_le_bytes) else {
                continue;
            };
            ward_removes.push(wowsp_tauri_shared::WardRemoveEvent {
                time: call.time,
                plane_id,
            });
        } else if call.method_id == m.avatar_receive_shot_kills {
            shot_kills.extend(decode_shot_kills(
                call.time,
                &call.args,
                profile.shotkill_has_ballistics,
            ));
        } else if m.avatar_receive_damage_stat == Some(call.method_id) {
            damage_stats.extend(decode_damage_stat(call.time, &call.args));
        } else if call.method_id == m.avatar_on_chat_message {
            if let Some(c) = decode_chat_message(call.time, &call.args) {
                chat_messages.push(c);
            }
        } else if call.method_id == m.avatar_on_achievement_earned {
            if let Some(a) = decode_achievement(call.time, &call.args) {
                achievements.push(a);
            }
        } else if profile
            .e11
            .is_some_and(|e| e.avatar_update_minimap_vision_info == call.method_id)
        {
            vision_events.extend(decode_minimap_vision(call.time, &call.args));
        }
    }
    // The arena's initial player/bot state: one onArenaStateReceived call on
    // the recorder's avatar right at match start, carrying the authoritative
    // ship-entity → team/player mapping. Decoded once the walk is done (the
    // call may sit before the CellPlayerCreate frame that names the avatar).
    // The call must sit on an AVATAR entity — the raw method id can collide
    // with another entity type's exposed method; the payload shape gate
    // (3 wire blobs, pickle pair lists, ≥2 entries) is the second defense.
    let mut arena_players: Vec<wowsp_tauri_shared::ArenaPlayer> = Vec::new();
    if profile.arena_state_method.is_some() {
        // Lesta broadcasts onArenaStateReceived on EVERY avatar, each
        // carrying its own view — and the client whose view contains its
        // own calling avatar is the recorder. Picking "the first call that
        // decodes" raced entity-kind completeness (live calibration
        // 2026-10-08: a 10%-prefix cut picked the recorder's 9-player
        // state, the 25% cut picked a bot's 6-player enemy list, dropping
        // is_self mid-battle). Prefer the self-identifying call; the
        // CellPlayerCreate avatar stays the fallback marker for WG.
        let mut fallback: Option<Vec<wowsp_tauri_shared::ArenaPlayer>> = None;
        for call in &methods {
            if Some(call.method_id) != profile.arena_state_method {
                continue;
            }
            if !kinds
                .get(&call.entity_id)
                .is_some_and(|k| k.entity_type == ENTITY_TYPE_AVATAR)
            {
                continue;
            }
            if let Some(mut players) = decode_arena_state(&call.args, version_key) {
                let self_here = players.iter().any(|p| p.avatar_id == Some(call.entity_id));
                for p in &mut players {
                    p.is_self = self_here && p.avatar_id == Some(call.entity_id);
                }
                if self_here {
                    arena_players = players;
                    break;
                }
                if fallback.is_none() {
                    if let Some(avatar) = recorder_avatar {
                        for p in &mut players {
                            p.is_self = p.avatar_id == Some(avatar);
                        }
                    }
                    fallback = Some(players);
                }
            }
        }
        if arena_players.is_empty()
            && let Some(players) = fallback
        {
            arena_players = players;
        }
    }
    for samples in positions.values_mut() {
        samples.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    for changes in properties.values_mut() {
        changes.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    cruise.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Finish the smoke lifecycles: the observed dissipation end. A destroy is
    // authoritative; otherwise the entity's leave time (the last one recorded
    // — the map is overwritten per packet) is the despawn the server sent when
    // the final puff faded.
    let mut smoke_screens: Vec<wowsp_tauri_shared::SmokeScreenEvent> =
        smokes.into_values().collect();
    for s in &mut smoke_screens {
        s.end_time = destroys
            .get(&s.entity_id)
            .copied()
            .or_else(|| leaves.get(&s.entity_id).copied());
    }
    smoke_screens.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Engine-state projection (experiment E11): enginePower (idx 9, UINT8) and
    // engineDir (idx 10, INT8) ALL_CLIENTS properties on Vehicle entities.
    // The raw property stream is already collected; this filters it to the
    // pinned indices on type-2 entities only. The indices were pinned against
    // the 15.8.0 Vehicle.def (E8) — other versions' property sorts are
    // unverified, so the projection rides the E11 version gate.
    let mut engine_states: Vec<wowsp_tauri_shared::EngineStateSample> = Vec::new();
    if profile.e11.is_some() {
        for (eid, changes) in &properties {
            if kinds.get(eid).map(|k| k.entity_type) != Some(ENTITY_TYPE_VEHICLE) {
                continue;
            }
            for c in changes {
                if c.size != 1 {
                    continue;
                }
                let sample = match c.property_index {
                    9 => wowsp_tauri_shared::EngineStateSample {
                        time: c.time,
                        entity_id: *eid,
                        power: Some(c.value as u8),
                        dir: None,
                    },
                    10 => wowsp_tauri_shared::EngineStateSample {
                        time: c.time,
                        entity_id: *eid,
                        power: None,
                        dir: Some(c.value as u8 as i8),
                    },
                    _ => continue,
                };
                engine_states.push(sample);
            }
        }
        engine_states.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    // The recorder's own ship entity: the local player's vehicle never
    // emits Position (0x0a) packets (its transform rides the self stream —
    // 0x2c on WG and Lesta ≤26.9, 0x2e from Lesta 26.10 on), while EVERY
    // other ship streams 0x0a continuously. Exactly one type-2 entity has
    // no 0x0a samples — that is the recorder's ship, a client-invariant
    // anchor no roster or arena state can contradict (live-verified on a
    // Lesta 26.10 capture: the self ship carried zero 0x0a samples while
    // its teammate mirrored its ship config, which had been breaking the
    // config-id join).
    let recorder_ship = recorder_ship_of(&kinds, &position_a_counts, &positions);
    DecodedReplay {
        recorder_ship,
        positions,
        // The version-resolved InteractiveZone index rides with the decode
        // (review M-4) — consumers filter zones through it, never through
        // a re-hardcoded constant.
        zone_entity_type: profile.zone_entity_type,
        kinds,
        destroys,
        properties,
        shell_launches,
        explosions,
        torpedoes,
        torpedo_steers,
        cap_progress,
        weapon_locks,
        battle_results,
        method_histogram,
        method_arg_samples,
        version,
        map_name,
        camera,
        net_stats,
        leaves,
        camera_modes,
        diagnostics,
        squadron_creates,
        squadron_planes,
        minimap_squadron_adds,
        minimap_squadron_moves,
        minimap_squadron_removes,
        wards,
        ward_removes,
        shot_kills,
        damage_stats,
        chat_messages,
        achievements,
        arena_players,
        weather_transitions,
        weather_notifications,
        cruise,
        smoke_screens,
        recorder_vehicle,
        vision_events,
        consumable_uses,
        engine_states,
        vehicle_builds,
    }
}

/// The recorder's own ship entity, as an extracted production rule (the
/// inline closure's contract, now testable): the unique type-2 entity that
/// has streamed NO Position (0x0a) samples but IS present in the position
/// map (its transform rides the 0x2c self stream, or 0x2e on Lesta 26.10+)
/// — the "present via the self stream" half excludes created-but-never-
/// sampled ships, so a torn prefix cannot mis-anchor on an enemy that
/// simply has not streamed yet. Anything other than exactly one candidate
/// yields None (the config-id join's fallback).
pub(super) fn recorder_ship_of(
    kinds: &BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    position_a_counts: &BTreeMap<i32, usize>,
    positions: &BTreeMap<i32, Vec<wowsp_tauri_shared::PositionSample>>,
) -> Option<i32> {
    let candidates: Vec<i32> = kinds
        .iter()
        .filter(|(eid, k)| {
            k.entity_type == 2
                && !position_a_counts.contains_key(eid)
                && positions.contains_key(eid)
        })
        .map(|(eid, _)| *eid)
        .collect();
    (candidates.len() == 1).then(|| candidates[0])
}
