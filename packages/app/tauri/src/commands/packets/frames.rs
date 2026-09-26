use super::*;
/// Walk `[u32 size][u32 type][f32 time][payload]` frames, collecting Position
/// samples (grouped by entity id) and EntityCreate metadata. Stops cleanly if a
/// frame header is truncated or declares an absurd size (trailing padding).
///
/// `legacy` selects the pre-12.6.0 packet-id layout (see [`remap_legacy_packet_id`]);
/// `profile` carries the per-version method ids and entity-type indices.
pub(super) fn walk_frames(
    inflated: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
    legacy: bool,
    profile: &LayoutProfile,
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
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            // 0x2b needs no arm: the legacy remap already maps it onto
            // PACKET_PLAYER_POSITION, and modern clients never emit it.
            PACKET_PLAYER_POSITION | PACKET_POSITION_AUX => {
                if let Some(sample) = parse_player_position(payload, time) {
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            PACKET_ENTITY_CREATE => {
                if let Some(created) = parse_entity_create(payload, time, profile.zone_entity_type)
                {
                    let eid = created.entity_id;
                    let mut kind = created.clone_into_kind();
                    kind.ship_id = scan_state_for_ship_id(&payload[38..], ship_id_candidates);
                    // Entities destroyed and re-created mid-match (leaving and
                    // re-entering the observed area) keep their FIRST creation
                    // time so the frontend doesn't hide them until re-creation.
                    kinds.entry(eid).or_insert(kind);
                }
            },
            PACKET_CELL_PLAYER_CREATE => {
                if let Some(created) = parse_cell_player_create(payload, time) {
                    let eid = created.entity_id;
                    let mut kind = created.clone_into_kind();
                    kind.entity_type = ENTITY_TYPE_AVATAR;
                    kinds.entry(eid).or_insert(kind);
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
    DecodedReplay {
        positions,
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
    }
}
