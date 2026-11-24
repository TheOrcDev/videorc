//! Plan 260 S1.8b: the committed scene from the backend once it holds the
//! host seat: the renderer's `room-scene-publisher.ts` in Rust (plan 249
//! S12, S14). The content is what the Studio committed
//! (`cloud.room.scene.commit`, `room_content`); the scene adapter moves to
//! `videorc-app-core` in Phase 2/3.
//!
//! Each program page (`EG_`) whose fresh receipt draws scenes gets its
//! lane's scene as a byte stream on `videorc.presentation.scene.v1`,
//! addressed to it alone, again after 10 s; a background picture goes first,
//! once per page session, on `videorc.presentation.background-asset.v1`.
//! The status (each page's rendered revision, and what it drew for the
//! background) goes on `cloud.room.presentation`'s scene entry, which the
//! Studio's commit waits on (5 s). Guests keep their own call view.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::prelude::{LocalParticipant, Room};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::cloud_talk::{
    CLOUD_ROOM_PRESENTATION_EVENT, CloudRoomPresentationEvent, CloudRoomSceneCommitParams,
    PresentationOrientation, PresentationOutput, RoomBackgroundStatus, RoomBackgroundWanted,
    RoomPresentationObservation, RoomPresentationState, RoomPresentationStatus,
};
use crate::room_capability::{CapabilityReceipts, capability_current};
use crate::room_graphics::GraphicsSignal;
use crate::state::AppState;

pub(crate) const SCENE_TOPIC: &str = "videorc.presentation.scene.v1";
pub(crate) const BACKGROUND_ASSET_TOPIC: &str = "videorc.presentation.background-asset.v1";
const SCENE_MAX_BYTES: usize = 16 * 1024;
const SCENE_LEASE_MS: i64 = 30_000;
const SCENE_MOTION_MAX_MS: i64 = 2_000;
const RESEND_MS: i64 = 10_000;
const BACKGROUND_ASSET_MAX_BYTES: usize = 2 * 1024 * 1024;
const BACKGROUND_ASSET_HEADER_MAX: usize = 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(8);
const ASSET_TIMEOUT: Duration = Duration::from_secs(15);

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The renderer's `fnv` (FNV-1a over UTF-16 code units, as `charCodeAt`).
fn fnv(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// `backgroundKey`: the key of a lane's background as a page reports it
/// drawn. The page keys the JSON it received, which is this serialization.
pub(crate) fn background_key(scene: Option<&Value>) -> String {
    match scene
        .and_then(|scene| scene.get("background"))
        .filter(|b| !b.is_null())
    {
        Some(background) => fnv(&background.to_string()),
        None => "none".to_string(),
    }
}

/// `encodeBackgroundAsset`: a 4-byte big-endian header length, the JSON
/// header, the picture.
pub(crate) fn encode_background_asset(header: &Value, image: &[u8]) -> anyhow::Result<Vec<u8>> {
    let head = serde_json::to_vec(header)?;
    if head.len() > BACKGROUND_ASSET_HEADER_MAX {
        anyhow::bail!("Background header too large");
    }
    if image.len() > BACKGROUND_ASSET_MAX_BYTES {
        anyhow::bail!("Background asset too large");
    }
    let mut out = Vec::with_capacity(4 + head.len() + image.len());
    out.extend_from_slice(&(head.len() as u32).to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(image);
    Ok(out)
}

/// Whether a committed transition is one the pages accept.
pub(crate) fn transition_valid(content: &Value) -> bool {
    let transition = &content["transition"];
    let duration = transition["durationMs"].as_i64().unwrap_or(-1);
    let kind = transition["kind"].as_str();
    (0..=SCENE_MOTION_MAX_MS).contains(&duration)
        && match kind {
            Some("cut") => duration == 0,
            Some("motion") => true,
            _ => false,
        }
}

struct Sent {
    key: String,
    revision: u64,
    at: i64,
    generation: u64,
}

#[derive(Default)]
struct SceneState {
    committed: Option<CloudRoomSceneCommitParams>,
    generation: u64,
    apply_at: i64,
    revision: u64,
    sent: HashMap<String, Sent>,
    /// Picture hashes each page holds, by its session.
    assets_sent: HashMap<String, (String, HashSet<String>)>,
    error: Option<String>,
    last_status: Option<RoomPresentationStatus>,
}

struct ScenePeer {
    identity: String,
    sid: String,
    output: String,
    orientation: String,
    applied: Option<(String, u64)>,
    background: Option<Option<Value>>,
}

fn scene_peers(
    receipts: &CapabilityReceipts,
    visible: &HashMap<String, String>,
    now: i64,
) -> Vec<ScenePeer> {
    receipts
        .consumers(visible, now)
        .into_iter()
        .filter(|(identity, _)| identity.starts_with("EG_"))
        .filter_map(|(identity, sid)| {
            let receipt = receipts.get(&identity)?;
            if !capability_current(Some(receipt), &sid, now) {
                return None;
            }
            let scene = receipt.capability.scene.as_ref()?;
            Some(ScenePeer {
                identity,
                sid,
                output: scene.output.clone(),
                orientation: scene.orientation.clone(),
                applied: scene
                    .applied
                    .as_ref()
                    .map(|a| (a.publisher_sid.clone(), a.revision)),
                background: scene.background.as_ref().map(|background| {
                    background
                        .drawn
                        .as_ref()
                        .and_then(|drawn| serde_json::to_value(drawn).ok())
                }),
            })
        })
        .collect()
}

impl SceneState {
    fn content(&self) -> Option<&Value> {
        self.committed.as_ref().and_then(|c| c.content.as_ref())
    }

    fn wanted(&self, orientation: &str) -> Option<Value> {
        self.content()
            .and_then(|content| content.get(orientation))
            .filter(|scene| !scene.is_null())
            .cloned()
    }

    fn commit(&mut self, committed: Option<CloudRoomSceneCommitParams>) {
        self.error = committed
            .as_ref()
            .and_then(|c| c.content.as_ref())
            .filter(|content| !transition_valid(content))
            .map(|_| "Invalid scene transition.".to_string());
        self.committed = committed;
        self.generation += 1;
        self.apply_at = now_ms();
        self.sent.clear();
    }

    fn status(&mut self, peers: &[ScenePeer], local_sid: &str) -> Option<RoomPresentationStatus> {
        let mut observed = BTreeMap::new();
        for peer in peers {
            let sent = self.sent.get(&peer.identity);
            if let (Some(sent), Some((sid, revision))) = (sent, peer.applied.as_ref())
                && sent.generation == self.generation
                && sid == local_sid
                && *revision == sent.revision
            {
                observed.insert(
                    peer.identity.clone(),
                    RoomPresentationObservation {
                        revision: *revision,
                        output: if peer.output == "recording" {
                            PresentationOutput::Recording
                        } else {
                            PresentationOutput::Stream
                        },
                        orientation: if peer.orientation == "v" {
                            PresentationOrientation::V
                        } else {
                            PresentationOrientation::H
                        },
                    },
                );
            }
        }
        let wanted = RoomBackgroundWanted {
            h: background_key(self.wanted("h").as_ref()),
            v: background_key(self.wanted("v").as_ref()),
        };
        let background = (wanted.h != "none" || wanted.v != "none").then(|| {
            let mut drawn = BTreeMap::new();
            let mut unsupported = 0;
            for peer in peers {
                match &peer.background {
                    None => unsupported += 1,
                    Some(Some(page)) => {
                        drawn.insert(peer.identity.clone(), page.clone());
                    }
                    Some(None) => {}
                }
            }
            RoomBackgroundStatus {
                wanted,
                drawn,
                unsupported,
            }
        });
        let enabled = self.content().is_some();
        let committed = self.generation > 0;
        let confirmed = observed.len() == peers.len();
        let state = if self.error.is_some() {
            RoomPresentationState::Failed
        } else if !committed {
            RoomPresentationState::Off
        } else if peers.is_empty() {
            if enabled {
                RoomPresentationState::Preview
            } else {
                RoomPresentationState::Off
            }
        } else if confirmed {
            if enabled {
                RoomPresentationState::Applied
            } else {
                RoomPresentationState::Off
            }
        } else {
            RoomPresentationState::Waiting
        };
        let reason = self.error.clone().or_else(|| match state {
            RoomPresentationState::Preview => {
                Some("Accepted; no program output is running yet.".to_string())
            }
            RoomPresentationState::Waiting => {
                Some("Scene sent; waiting for each output to draw it.".to_string())
            }
            _ => None,
        });
        let status = RoomPresentationStatus {
            enabled,
            state,
            reason,
            revision: self.generation,
            observed,
            guests: None,
            background,
        };
        if self.last_status.as_ref() == Some(&status) {
            return None;
        }
        self.last_status = Some(status.clone());
        Some(status)
    }

    fn forget(&mut self, identity: &str) {
        self.sent.remove(identity);
        self.assets_sent.remove(identity);
    }
}

fn lock(receipts: &StdMutex<CapabilityReceipts>) -> std::sync::MutexGuard<'_, CapabilityReceipts> {
    receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One connection's scene publisher. Ends when `signals` closes.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut signals: mpsc::UnboundedReceiver<GraphicsSignal>,
) {
    let mut scene = SceneState::default();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            signal = signals.recv() => match signal {
                Some(GraphicsSignal::Heard(_)) => {}
                Some(GraphicsSignal::Left(identity)) => scene.forget(&identity),
                None => return,
            },
            _ = tick.tick() => {}
            _ = crate::room_content::CHANGED.notified() => {}
        }
        let committed = crate::room_content::scene();
        if committed != scene.committed {
            scene.commit(committed);
        }
        if let Err(error) = send_due(&state, &room, &show_id, &receipts, &mut scene).await {
            scene.error = Some(format!(
                "Scene delivery failed; the program is unconfirmed. ({error:#})"
            ));
        }
    }
}

async fn send_due(
    state: &AppState,
    room: &Room,
    show_id: &str,
    receipts: &StdMutex<CapabilityReceipts>,
    scene: &mut SceneState,
) -> anyhow::Result<()> {
    let local = room.local_participant();
    let local_sid = local.sid().as_str().to_string();
    let room_name = room.name();
    let now = now_ms();
    let visible: HashMap<String, String> = room
        .remote_participants()
        .values()
        .map(|p| {
            (
                p.identity().as_str().to_string(),
                p.sid().as_str().to_string(),
            )
        })
        .collect();
    let peers = {
        let receipts = lock(receipts);
        scene_peers(&receipts, &visible, now)
    };
    if let Some(status) = scene.status(&peers, &local_sid) {
        state.emit_event(
            CLOUD_ROOM_PRESENTATION_EVENT,
            CloudRoomPresentationEvent {
                show_id: show_id.to_string(),
                graphics: None,
                avatar: None,
                scene: Some(status),
            },
        );
    }
    if scene.generation == 0 || scene.error.is_some() {
        return Ok(());
    }
    let transition = scene
        .content()
        .map(|content| content["transition"].clone())
        .unwrap_or_else(|| json!({ "kind": "cut", "durationMs": 0 }));
    for peer in &peers {
        let wanted = scene.wanted(&peer.orientation);
        let key = json!([
            peer.sid,
            local_sid,
            peer.output,
            peer.orientation,
            wanted,
            transition
        ])
        .to_string();
        if scene.sent.get(&peer.identity).is_some_and(|old| {
            old.key == key && old.generation == scene.generation && now - old.at < RESEND_MS
        }) {
            continue;
        }
        if let Some(background) = wanted.as_ref().and_then(|w| w.get("background"))
            && background["kind"] == "picture"
        {
            send_asset(&local, &room_name, &local_sid, peer, background, scene).await?;
        }
        scene.revision += 1;
        let duration = if transition["kind"] == "cut" {
            0
        } else {
            transition["durationMs"].as_i64().unwrap_or(0)
        };
        let snapshot = json!({
            "version": 1,
            "show": room_name,
            "publisherSid": local_sid,
            "revision": scene.revision,
            "output": peer.output,
            "orientation": peer.orientation,
            "expiresAt": now + SCENE_LEASE_MS - 1000,
            "scene": wanted,
            "transition": {
                "kind": transition["kind"],
                "durationMs": duration,
                "applyAt": if scene.apply_at > 0 { scene.apply_at } else { now },
            },
        });
        let bytes = serde_json::to_vec(&snapshot)?;
        if bytes.len() > SCENE_MAX_BYTES {
            anyhow::bail!("Scene snapshot too large");
        }
        let empty = snapshot["scene"].is_null();
        tokio::time::timeout(
            UPLOAD_TIMEOUT,
            upload(
                &local,
                SCENE_TOPIC,
                "application/json",
                &peer.identity,
                &bytes,
                Some(empty),
            ),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Scene upload timed out"))??;
        scene.sent.insert(
            peer.identity.clone(),
            Sent {
                key,
                revision: scene.revision,
                at: now_ms(),
                generation: scene.generation,
            },
        );
        scene.error = None;
    }
    Ok(())
}

/// A background picture, once per page session.
async fn send_asset(
    local: &LocalParticipant,
    room_name: &str,
    local_sid: &str,
    peer: &ScenePeer,
    background: &Value,
    scene: &mut SceneState,
) -> anyhow::Result<()> {
    let hash = background["hash"].as_str().unwrap_or_default().to_string();
    let Some(asset) = scene
        .committed
        .as_ref()
        .and_then(|c| c.assets.iter().find(|asset| asset.hash == hash))
        .cloned()
    else {
        anyhow::bail!("The background picture is not ready.");
    };
    let held = scene
        .assets_sent
        .entry(peer.identity.clone())
        .or_insert_with(|| (peer.sid.clone(), HashSet::new()));
    if held.0 != peer.sid {
        *held = (peer.sid.clone(), HashSet::new());
    }
    if held.1.contains(&hash) {
        return Ok(());
    }
    let image = base64::engine::general_purpose::STANDARD.decode(asset.base64.as_bytes())?;
    let header = json!({
        "version": 1,
        "show": room_name,
        "publisherSid": local_sid,
        "hash": asset.hash,
        "mime": asset.mime,
        "width": asset.width,
        "height": asset.height,
        "size": image.len(),
    });
    let message = encode_background_asset(&header, &image)?;
    tokio::time::timeout(
        ASSET_TIMEOUT,
        upload(
            local,
            BACKGROUND_ASSET_TOPIC,
            "application/octet-stream",
            &peer.identity,
            &message,
            None,
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Background upload timed out"))??;
    if let Some(held) = scene.assets_sent.get_mut(&peer.identity)
        && held.0 == peer.sid
    {
        held.1.insert(hash);
    }
    Ok(())
}

async fn upload(
    local: &LocalParticipant,
    topic: &str,
    mime: &str,
    identity: &str,
    bytes: &[u8],
    empty: Option<bool>,
) -> anyhow::Result<()> {
    let mut options = StreamByteOptions::new_with_topic(topic);
    options.mime_type = Some(mime.to_string());
    options.total_length = Some(bytes.len() as u64);
    options.destination_identities = vec![identity.to_string().into()];
    if let Some(empty) = empty {
        options.attributes = HashMap::from([("empty".to_string(), empty.to_string())]);
    }
    let writer = local
        .stream_bytes(options)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    for chunk in bytes.chunks(16 * 1024) {
        writer
            .write(chunk)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    writer
        .close()
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_background_key_is_the_renderers_fnv() {
        // FNV-1a of "{}" over UTF-16 units, as the renderer computes it.
        assert_eq!(fnv(""), "811c9dc5");
        assert_eq!(fnv("a"), "e40c292c");
        assert_eq!(background_key(None), "none");
        assert_eq!(background_key(Some(&json!({ "background": null }))), "none");
        let key = background_key(Some(
            &json!({ "background": { "kind": "picture", "hash": "x" } }),
        ));
        assert_eq!(key.len(), 8);
    }

    #[test]
    fn a_background_asset_is_length_header_then_picture() {
        let message = encode_background_asset(&json!({ "v": 1 }), b"PIX").unwrap();
        let head_len = u32::from_be_bytes(message[..4].try_into().unwrap()) as usize;
        assert_eq!(&message[4..4 + head_len], br#"{"v":1}"#);
        assert_eq!(&message[4 + head_len..], b"PIX");
        assert!(encode_background_asset(&json!({ "pad": "x".repeat(2000) }), b"").is_err());
    }

    #[test]
    fn only_a_valid_transition_is_committed() {
        assert!(transition_valid(
            &json!({ "transition": { "kind": "cut", "durationMs": 0 } })
        ));
        assert!(transition_valid(
            &json!({ "transition": { "kind": "motion", "durationMs": 320 } })
        ));
        assert!(!transition_valid(
            &json!({ "transition": { "kind": "cut", "durationMs": 10 } })
        ));
        assert!(!transition_valid(
            &json!({ "transition": { "kind": "motion", "durationMs": 2001 } })
        ));
        assert!(!transition_valid(
            &json!({ "transition": { "kind": "fade", "durationMs": 0 } })
        ));
    }
}
