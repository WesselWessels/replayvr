use boxcars::{Attribute, ParserBuilder, Replay};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;

#[derive(Serialize, Clone)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

#[derive(Serialize, Clone)]
struct CarState {
    id: i32,
    name: String,
    team: u8,
    x: f32,
    y: f32,
    z: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    qw: f32,
    boost: u8,
}

#[derive(Serialize, Clone)]
struct PadInfo {
    x: f32,
    y: f32,
    z: f32,
    is_large: bool,
}

#[derive(Serialize)]
struct GoalEvent {
    time: f32,
    player_name: String,
    team: u8,
}

#[derive(Serialize)]
struct Frame {
    time: f32,
    ball: Option<Vec3>,
    cars: Vec<CarState>,
    pad_states: Vec<bool>,  // true = picked up (unavailable), indexed by meta.pads order
}

#[derive(Serialize)]
struct PlayerMeta {
    name: String,
    team: u8,
}

#[derive(Serialize)]
struct ReplayMeta {
    team0_score: i32,
    team1_score: i32,
    duration: f32,
    players: Vec<PlayerMeta>,
    pads: Vec<PadInfo>,
    goals: Vec<GoalEvent>,
}

#[derive(Serialize)]
struct Output {
    meta: ReplayMeta,
    frames: Vec<Frame>,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let path = args.get(1).expect("Usage: rl-parser <replay_file>");

    let data = fs::read(path).expect("Could not read replay file");

    let replay: Replay = ParserBuilder::new(&data)
        .on_error_check_crc()
        .parse()
        .expect("Could not parse replay");

    let props = &replay.properties;

    let team0_score = props
        .iter()
        .find(|(k, _)| k == "Team0Score")
        .and_then(|(_, v)| if let boxcars::HeaderProp::Int(n) = v { Some(*n) } else { None })
        .unwrap_or(0);

    let team1_score = props
        .iter()
        .find(|(k, _)| k == "Team1Score")
        .and_then(|(_, v)| if let boxcars::HeaderProp::Int(n) = v { Some(*n) } else { None })
        .unwrap_or(0);

    let duration = props
        .iter()
        .find(|(k, _)| k == "TotalSecondsPlayed")
        .and_then(|(_, v)| if let boxcars::HeaderProp::Float(f) = v { Some(*f) } else { None })
        .unwrap_or(0.0);

    let players: Vec<PlayerMeta> = props
        .iter()
        .find(|(k, _)| k == "PlayerStats")
        .and_then(|(_, v)| {
            if let boxcars::HeaderProp::Array(rows) = v {
                Some(rows.iter().filter_map(|row| {
                    let name = row.iter().find(|(k, _)| k == "Name")
                        .and_then(|(_, v)| if let boxcars::HeaderProp::Str(s) = v { Some(s.clone()) } else { None })?;
                    let team = row.iter().find(|(k, _)| k == "Team")
                        .and_then(|(_, v)| if let boxcars::HeaderProp::Int(n) = v { Some(*n as u8) } else { None })
                        .unwrap_or(0);
                    Some(PlayerMeta { name, team })
                }).collect())
            } else { None }
        })
        .unwrap_or_default();

    let network = match replay.network_frames {
        Some(ref nf) => nf,
        None => { eprintln!("No network frames"); return; }
    };

    // actor_id → object name
    let mut actor_class: HashMap<i32, String> = HashMap::new();
    let mut ball_pos: Option<Vec3> = None;
    let mut cars: HashMap<i32, CarState> = HashMap::new();
    let mut pri_name: HashMap<i32, String> = HashMap::new();
    let mut pri_team: HashMap<i32, u8> = HashMap::new();
    let mut car_pri: HashMap<i32, i32> = HashMap::new();
    // Boost component tracking: CarComponent_Boost_TA actor_id → car actor_id
    let mut boost_comp_car: HashMap<i32, i32> = HashMap::new();

    // Boost pad tracking.
    // object_id is stable per pad across respawns; actor_id changes each respawn.
    let mut pad_by_object: HashMap<i32, usize> = HashMap::new(); // object_id → pad index
    let mut pad_by_actor: HashMap<i32, usize> = HashMap::new();  // actor_id → pad index (remapped each spawn)
    let mut discovered_pads: Vec<PadInfo> = Vec::new();
    let mut pad_states_current: Vec<bool> = Vec::new();

    // Build stream_id → object name mapping via net_cache
    let mut stream_to_name: HashMap<i32, String> = HashMap::new();
    for cache in &replay.net_cache {
        for prop in &cache.properties {
            if let Some(name) = replay.objects.get(prop.object_ind as usize) {
                stream_to_name.insert(prop.stream_id, name.clone());
            }
        }
    }

    // Set of known player names from header (for matching String attrs on PRI actors)
    let known_names: std::collections::HashSet<&str> = players.iter().map(|p| p.name.as_str()).collect();

    // Build frame index → time lookup for goal conversion
    let frame_times: Vec<f32> = network.frames.iter().map(|f| f.time).collect();
    let t0_net = frame_times.first().copied().unwrap_or(0.0);

    let goals: Vec<GoalEvent> = props
        .iter()
        .find(|(k, _)| k == "Goals")
        .and_then(|(_, v)| if let boxcars::HeaderProp::Array(rows) = v { Some(rows) } else { None })
        .map(|rows| rows.iter().filter_map(|row| {
            let player_name = row.iter().find(|(k, _)| k == "PlayerName")
                .and_then(|(_, v)| if let boxcars::HeaderProp::Str(s) = v { Some(s.clone()) } else { None })?;
            let team = row.iter().find(|(k, _)| k == "PlayerTeam")
                .and_then(|(_, v)| if let boxcars::HeaderProp::Int(n) = v { Some(*n as u8) } else { None })
                .unwrap_or(0);
            let frame_idx = row.iter().find(|(k, _)| k == "frame")
                .and_then(|(_, v)| if let boxcars::HeaderProp::Int(n) = v { Some(*n as usize) } else { None })?;
            let time = frame_times.get(frame_idx).copied()? - t0_net;
            Some(GoalEvent { time, player_name, team })
        }).collect())
        .unwrap_or_default();

    let mut frames: Vec<Frame> = Vec::new();

    for frame in &network.frames {
        // New actors
        for new_actor in &frame.new_actors {
            let id = new_actor.actor_id.0;
            let class_name = replay.objects
                .get(new_actor.object_id.0 as usize)
                .cloned()
                .unwrap_or_default();

            actor_class.insert(id, class_name.clone());

            if class_name.contains("Car_Default") || class_name.contains("Car_Season") || class_name.contains("Car_PostGame") {
                cars.insert(id, CarState {
                    id,
                    name: String::new(),
                    team: 0,
                    x: 0.0, y: 0.0, z: 0.0,
                    qx: 0.0, qy: 0.0, qz: 0.0, qw: 1.0,
                    boost: 0,
                });
            }

            // Boost pad detection
            // Boost pad — positions fixed by map, not in network data.
            // Use object_id (stable per named pad) to deduplicate across respawns.
            if class_name.contains("VehiclePickup_Boost_TA") {
                let obj_id = new_actor.object_id.0;
                let idx = *pad_by_object.entry(obj_id).or_insert_with(|| {
                    let i = discovered_pads.len();
                    discovered_pads.push(PadInfo { x: 0.0, y: 0.0, z: 0.0, is_large: false });
                    pad_states_current.push(false);
                    i
                });
                // Reset to available on every respawn (actor recreation = pad is back)
                pad_states_current[idx] = false;
                pad_by_actor.insert(id, idx);
            }
        }

        // Deleted actors
        for deleted in &frame.deleted_actors {
            cars.remove(&deleted.0);
            // Pad actor deleted = pad was picked up (unavailable until respawn)
            if let Some(&pad_idx) = pad_by_actor.get(&deleted.0) {
                pad_states_current[pad_idx] = true;  // true = picked up
                pad_by_actor.remove(&deleted.0);
            }
        }

        // Updated actors — each UpdatedActor has a single attribute
        for replication in &frame.updated_actors {
            let actor_id = replication.actor_id.0;
            let class = actor_class.get(&actor_id).cloned().unwrap_or_default();

            // Get attribute name via stream_id → net_cache → objects
            let attr_name = stream_to_name
                .get(&replication.stream_id.0)
                .map(|s| s.as_str())
                .unwrap_or("");

            match &replication.attribute {
                Attribute::RigidBody(rb) => {
                    let pos = &rb.location;
                    if class.contains("Ball") {
                        ball_pos = Some(Vec3 { x: pos.x, y: pos.y, z: pos.z });
                    } else if let Some(car) = cars.get_mut(&actor_id) {
                        car.x = pos.x;
                        car.y = pos.y;
                        car.z = pos.z;
                        let q = &rb.rotation;
                        car.qx = q.x;
                        car.qy = q.y;
                        car.qz = q.z;
                        car.qw = q.w;
                    }
                }
                Attribute::Byte(val) => {
                    if attr_name.contains("ReplicatedBoost") {
                        if let Some(car) = cars.get_mut(&actor_id) {
                            car.boost = *val;
                        } else if let Some(&car_id) = boost_comp_car.get(&actor_id) {
                            if let Some(car) = cars.get_mut(&car_id) {
                                car.boost = *val;
                            }
                        }
                    }
                }
                Attribute::Boolean(val) => {
                    // bPickedUp on boost pad actors
                    if let Some(&pad_idx) = pad_by_actor.get(&actor_id) {
                        pad_states_current[pad_idx] = *val;
                    }
                }
                Attribute::String(s) => {
                    let class = actor_class.get(&actor_id).map(|s| s.as_str()).unwrap_or("");
                    if class.contains("PRI") && known_names.contains(s.as_str()) {
                        pri_name.insert(actor_id, s.clone());
                    }
                }
                Attribute::ActiveActor(aa) => {
                    let class = actor_class.get(&actor_id).map(|s| s.as_str()).unwrap_or("");
                    if class.contains("PRI") && aa.active {
                        let target = actor_class.get(&aa.actor.0).map(|s| s.as_str()).unwrap_or("");
                        if target.contains("Team0") {
                            pri_team.insert(actor_id, 0);
                        } else if target.contains("Team1") {
                            pri_team.insert(actor_id, 1);
                        } else if target.contains("PRI") || target.contains("PlayerReplicationInfo") {
                            car_pri.insert(actor_id, aa.actor.0);
                        }
                    } else if aa.active && cars.contains_key(&actor_id) {
                        let target_class = actor_class.get(&aa.actor.0).map(|s| s.as_str()).unwrap_or("");
                        if target_class.contains("PRI") {
                            car_pri.insert(actor_id, aa.actor.0);
                        }
                    }
                    // CarComponent_Boost links to its parent car via an ActiveActor pointing at a car actor
                    if aa.active {
                        let class = actor_class.get(&actor_id).map(|s| s.as_str()).unwrap_or("");
                        if class.contains("CarComponent_Boost") && cars.contains_key(&aa.actor.0) {
                            boost_comp_car.insert(actor_id, aa.actor.0);
                        }
                    }
                }
                Attribute::ReplicatedBoost(rb) => {
                    if let Some(car) = cars.get_mut(&actor_id) {
                        car.boost = rb.boost_amount;
                    } else if let Some(&car_id) = boost_comp_car.get(&actor_id) {
                        if let Some(car) = cars.get_mut(&car_id) {
                            car.boost = rb.boost_amount;
                        }
                    }
                }
                _ => {}
            }
        }

        // Propagate name + team from PRI → car
        for (car_id, pri_id) in &car_pri {
            if let Some(car) = cars.get_mut(car_id) {
                if let Some(name) = pri_name.get(pri_id) {
                    car.name = name.clone();
                }
                if let Some(team) = pri_team.get(pri_id) {
                    car.team = *team;
                }
            }
        }

        frames.push(Frame {
            time: frame.time,
            ball: ball_pos.clone(),
            cars: cars.values().cloned().collect(),
            pad_states: pad_states_current.clone(),
        });
    }

    let output = Output {
        meta: ReplayMeta { team0_score, team1_score, duration, players, pads: discovered_pads, goals },
        frames,
    };

    println!("{}", serde_json::to_string(&output).unwrap());
}
