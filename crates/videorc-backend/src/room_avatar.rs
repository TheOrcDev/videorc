//! Plan 260 S1.8b: the worn avatar and its bubble from the backend once it
//! holds the host seat: the renderer's `room-avatar-publisher.ts` in Rust
//! (plan 249 S4, S5, S6, S24, PERF-06). The content is what the Studio built
//! and handed over (`cloud.room.avatar.set`, `room_content`); the builder
//! moves to `videorc-app-core` in Phase 2/3.
//!
//! Each program page (`EG_`) whose fresh receipt draws graphics gets its
//! lane's layers (the atlas variant when it advertises `animation: 1`) as a
//! byte stream on `videorc.presentation.avatar.v1`, addressed to it alone,
//! again after 10 s; a picture it provably holds goes as a reference. A
//! guest page (`g_`) gets the stream's landscape layers only while the host
//! shows them to guests, and a clear when that stops. What each page applied
//! goes to the Studio on `cloud.room.presentation` and, once per view, to
//! the cloud.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::prelude::{LocalParticipant, Room};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::cloud_talk::{
    CloudRoomPresentationEvent, PresentationOrientation, PresentationOutput,
    RoomPresentationGuests, RoomPresentationObservation, RoomPresentationState,
    RoomPresentationStatus,
};
use crate::room_assets::{SentAssets, with_references};
use crate::room_capability::{CapabilityReceipts, capability_current};
use crate::room_graphics::GraphicsSignal;
use crate::state::AppState;

pub(crate) const AVATAR_TOPIC: &str = "videorc.presentation.avatar.v1";
/// Plan 249 S5: the avatar's motion, from the renderer's motion model for
/// now (`cloud.room.avatar.motion`); it moves to app-core with the builders.
pub(crate) const AVATAR_MOTION_TOPIC: &str = "videorc.presentation.avatar-motion.v1";
const AVATAR_MOTION_MAX_BYTES: usize = 16 * 1024;

/// The connection's sender and the pages that animate now (egress pages
/// whose receipt advertises animation, for an output the content shows,
/// with an atlas variant to draw), kept by the avatar publisher.
type MotionSlot = Option<(LocalParticipant, String, Vec<String>)>;
static MOTION: StdMutex<MotionSlot> = StdMutex::new(None);

fn motion_slot() -> std::sync::MutexGuard<'static, MotionSlot> {
    MOTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `cloud.room.avatar.motion`: one message of the renderer's motion model,
/// sent to the pages that animate. Answers who they are (the renderer's
/// model sends a keyframe to a page it has not served yet).
pub(crate) async fn send_motion(message: &Value) -> anyhow::Result<Vec<String>> {
    let Some((local, room_name, targets)) = motion_slot().clone() else {
        return Ok(Vec::new());
    };
    if targets.is_empty() {
        return Ok(targets);
    }
    // The renderer's model runs without the room: the host's session and the
    // room are this connection's.
    let mut message = message.clone();
    if let Some(fields) = message.as_object_mut() {
        fields.insert("publisherSid".to_string(), json!(local.sid().as_str()));
        fields.insert("show".to_string(), json!(room_name));
    }
    let payload = serde_json::to_vec(&message)?;
    if payload.len() > AVATAR_MOTION_MAX_BYTES {
        anyhow::bail!("The avatar's motion message is over 16 KiB.");
    }
    local
        .publish_data(livekit::prelude::DataPacket {
            payload,
            topic: Some(AVATAR_MOTION_TOPIC.to_string()),
            reliable: true,
            destination_identities: targets
                .iter()
                .map(|identity| identity.clone().into())
                .collect(),
        })
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    Ok(targets)
}

/// `motionTargets`.
fn motion_targets(content: Option<&Value>, peers: &[AvatarPeer]) -> Vec<String> {
    let Some(content) = content.filter(|c| c.get("animated").is_some_and(Value::is_object)) else {
        return Vec::new();
    };
    peers
        .iter()
        .filter(|peer| peer.role == Role::Egress && peer.animation)
        .filter(|peer| content.get(&peer.output).and_then(Value::as_bool) == Some(true))
        .map(|peer| peer.identity.clone())
        .collect()
}
const AVATAR_MAX_BYTES: usize = 512 * 1024;
const AVATAR_LEASE_MS: i64 = 30_000;
/// The same view goes again after this long (the lease renewal).
const AVATAR_RENEW_MS: i64 = 10_000;
const CHUNK_BYTES: usize = 16 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(8);

/// The room's Avatar switch (`cloud.room.presentation.set`), off when a hold
/// starts, as the renderer's client was.
static AVATAR_ENABLED: AtomicBool = AtomicBool::new(false);
static AVATAR_SWITCHED: Notify = Notify::const_new();

pub(crate) fn set_enabled(enabled: bool) {
    AVATAR_ENABLED.store(enabled, Ordering::Release);
    AVATAR_SWITCHED.notify_waiters();
}

pub(crate) fn reset_enabled() {
    AVATAR_ENABLED.store(false, Ordering::Release);
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Egress,
    Guest,
}

fn consumer_role(identity: &str) -> Option<Role> {
    if identity.starts_with("EG_") {
        Some(Role::Egress)
    } else if identity.starts_with("g_") {
        Some(Role::Guest)
    } else {
        None
    }
}

/// The layers one page gets: a guest the stream's landscape layers while
/// shown to guests; an egress its lane (the atlas variant for an animating
/// page) when the content shows that output.
pub(crate) fn avatar_layers(
    content: Option<&Value>,
    guests: bool,
    guest: bool,
    output: &str,
    orientation: &str,
    animation: bool,
) -> Vec<Value> {
    let Some(content) = content else {
        return Vec::new();
    };
    let shows = |output: &str| content.get(output).and_then(Value::as_bool) == Some(true);
    let lane = |set: &Value, orientation: &str| -> Vec<Value> {
        set.get(orientation)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    if guest {
        return if guests && shows("stream") {
            lane(content, "h")
        } else {
            Vec::new()
        };
    }
    if !shows(output) {
        return Vec::new();
    }
    let variant = content
        .get("animated")
        .filter(|animated| animation && animated.is_object())
        .unwrap_or(content);
    lane(variant, orientation)
}

#[derive(Debug, Clone)]
struct Sent {
    key: String,
    revision: u64,
    at: i64,
    layers: Value,
    output: String,
    orientation: String,
    publisher_sid: String,
    expires_at: i64,
}

#[derive(Default)]
struct AvatarState {
    content: Option<Value>,
    guests: bool,
    sent: HashMap<String, Sent>,
    accepted: HashMap<String, u64>,
    kept: HashMap<String, String>,
    guest_shown: HashSet<String>,
    assets: SentAssets,
    revision: u64,
    error: Option<String>,
    last_status: Option<RoomPresentationStatus>,
}

struct AvatarPeer {
    identity: String,
    sid: String,
    role: Role,
    output: String,
    orientation: String,
    animation: bool,
    refs: bool,
    applied: Option<(String, u64)>,
}

fn avatar_peers(
    receipts: &CapabilityReceipts,
    visible: &HashMap<String, String>,
    now: i64,
) -> Vec<AvatarPeer> {
    receipts
        .consumers(visible, now)
        .into_iter()
        .filter_map(|(identity, sid)| {
            let role = consumer_role(&identity)?;
            let receipt = receipts.get(&identity)?;
            if !capability_current(Some(receipt), &sid, now) {
                return None;
            }
            let graphics = receipt.capability.graphics.as_ref()?;
            Some(AvatarPeer {
                identity,
                sid,
                role,
                output: graphics.output.clone(),
                orientation: graphics.orientation.clone(),
                animation: graphics.animation == Some(1),
                refs: graphics.refs == Some(1),
                applied: graphics
                    .applied
                    .as_ref()
                    .map(|a| (a.publisher_sid.clone(), a.revision)),
            })
        })
        .collect()
}

/// The cloud keeps an accepted avatar view only when its pictures or places
/// changed (the renderer's `keptAvatarRef`).
fn kept_key(layers: &Value) -> String {
    let kept: Vec<Value> = layers
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| json!([l["asset"]["hash"], l["rect"]]))
        .collect();
    Value::Array(kept).to_string()
}

impl AvatarState {
    fn snapshot(
        &mut self,
        room_name: &str,
        local_sid: &str,
        output: &str,
        orientation: &str,
        layers: Vec<Value>,
        now: i64,
    ) -> Value {
        self.revision += 1;
        let lease_end = now + AVATAR_LEASE_MS - 1000;
        let layers: Vec<Value> = layers
            .into_iter()
            .filter(|l| l["expiresAt"].as_i64().is_none_or(|at| at > now))
            .map(|mut l| {
                if let Some(at) = l["expiresAt"].as_i64() {
                    l["expiresAt"] = json!(at.min(lease_end));
                }
                l
            })
            .collect();
        json!({
            "version": 1,
            "show": room_name,
            "publisherSid": local_sid,
            "revision": self.revision,
            "output": output,
            "orientation": orientation,
            "expiresAt": lease_end,
            "layers": layers,
        })
    }

    fn note_accepted(&mut self, peer: &AvatarPeer, local_sid: &str, now: i64) -> Option<Value> {
        let (applied_sid, applied_revision) = peer.applied.as_ref()?;
        if applied_sid != local_sid {
            return None;
        }
        let sent = self.sent.get(&peer.identity)?;
        if sent.revision != *applied_revision
            || sent.publisher_sid != local_sid
            || sent.output != peer.output
            || sent.orientation != peer.orientation
            || sent.expires_at <= now
        {
            return None;
        }
        let view = format!(
            "{}/{}/{}",
            sent.output, sent.orientation, sent.publisher_sid
        );
        if self.accepted.get(&view).copied().unwrap_or(0) >= sent.revision {
            return None;
        }
        self.accepted.insert(view, sent.revision);
        if self.accepted.len() > 64
            && let Some(any) = self.accepted.keys().next().cloned()
        {
            self.accepted.remove(&any);
        }
        let kept = kept_key(&sent.layers);
        let lane = format!("{}/{}", sent.output, sent.orientation);
        if self.kept.get(&lane) == Some(&kept) {
            return None;
        }
        self.kept.insert(lane, kept);
        Some(json!({
            "topic": "avatar",
            "output": sent.output,
            "orientation": sent.orientation,
            "publisherSid": sent.publisher_sid,
            "revision": sent.revision,
            "layers": sent.layers,
        }))
    }

    fn report(
        &mut self,
        peers: &[AvatarPeer],
        local_sid: &str,
        now: i64,
    ) -> (Option<RoomPresentationStatus>, Vec<Value>) {
        let mut observed = std::collections::BTreeMap::new();
        let mut accepted = Vec::new();
        let (mut capable, mut wanted, mut egress) = (0usize, 0usize, 0usize);
        let mut guests = RoomPresentationGuests {
            enabled: self.guests,
            capable: 0,
            applied: 0,
        };
        for peer in peers {
            let acknowledged = |state: &AvatarState| {
                peer.applied.as_ref().is_some_and(|(sid, revision)| {
                    sid == local_sid
                        && state
                            .sent
                            .get(&peer.identity)
                            .is_some_and(|sent| sent.revision == *revision)
                })
            };
            if peer.role == Role::Guest {
                guests.capable += 1;
                if self.guest_shown.contains(&peer.identity) && acknowledged(self) {
                    guests.applied += 1;
                }
                continue;
            }
            egress += 1;
            capable += 1;
            let visible = self.content.as_ref().is_some_and(|content| {
                content.get(&peer.output).and_then(Value::as_bool) == Some(true)
                    && content[&peer.orientation]
                        .as_array()
                        .is_some_and(|layers| layers.iter().any(|l| l["kind"] == "avatar"))
            });
            if let Some(view) = self.note_accepted(peer, local_sid, now) {
                accepted.push(view);
            }
            if !visible {
                continue;
            }
            wanted += 1;
            if acknowledged(self)
                && let Some((_, revision)) = peer.applied.as_ref()
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
        let shows = self.content.as_ref().is_some_and(|content| {
            content.get("stream").and_then(Value::as_bool) == Some(true)
                || content.get("recording").and_then(Value::as_bool) == Some(true)
        });
        let state = if self.error.is_some() {
            RoomPresentationState::Failed
        } else if !shows {
            RoomPresentationState::Off
        } else if egress == 0 {
            RoomPresentationState::Preview
        } else if capable == egress && wanted > 0 && observed.len() == wanted {
            RoomPresentationState::Applied
        } else {
            RoomPresentationState::Waiting
        };
        let reason = self.error.clone().or_else(|| match state {
            RoomPresentationState::Preview => {
                Some("Local preview only; no egress is running.".to_string())
            }
            RoomPresentationState::Waiting => {
                Some("Avatar sent; waiting for each output to apply it.".to_string())
            }
            _ => None,
        });
        let status = RoomPresentationStatus {
            enabled: self.content.is_some(),
            state,
            reason,
            revision: self.revision,
            observed,
            guests: Some(guests),
            background: None,
        };
        if self.last_status.as_ref() == Some(&status) {
            return (None, accepted);
        }
        self.last_status = Some(status.clone());
        (Some(status), accepted)
    }

    fn forget(&mut self, identity: &str) {
        self.sent.remove(identity);
        self.guest_shown.remove(identity);
        self.assets.forget(identity);
    }
}

/// The connection ended: no motion goes out on it any more.
struct ClearMotion;

impl Drop for ClearMotion {
    fn drop(&mut self) {
        *motion_slot() = None;
    }
}

fn lock(receipts: &StdMutex<CapabilityReceipts>) -> std::sync::MutexGuard<'_, CapabilityReceipts> {
    receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The content as the switch and the Studio's hand-off say now.
fn current_content() -> (Option<Value>, bool) {
    let held = crate::room_content::avatar();
    let guests = held.as_ref().and_then(|held| held.guests).unwrap_or(false);
    let content = held
        .and_then(|held| held.content)
        .filter(|_| AVATAR_ENABLED.load(Ordering::Acquire));
    (content, guests)
}

/// One connection's avatar publisher. Ends when `signals` closes.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut signals: mpsc::UnboundedReceiver<GraphicsSignal>,
) {
    let mut avatar = AvatarState::default();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    *motion_slot() = Some((room.local_participant(), room.name(), Vec::new()));
    let _clear = ClearMotion;
    loop {
        tokio::select! {
            signal = signals.recv() => match signal {
                Some(GraphicsSignal::Heard(_)) => {}
                Some(GraphicsSignal::Left(identity)) => avatar.forget(&identity),
                None => return,
            },
            _ = tick.tick() => {}
            _ = AVATAR_SWITCHED.notified() => {}
            _ = crate::room_content::CHANGED.notified() => {}
        }
        let (content, guests) = current_content();
        if content != avatar.content || guests != avatar.guests {
            avatar.content = content;
            avatar.guests = guests;
            avatar.sent.clear();
            avatar.error = None;
        }
        if let Err(error) = send_due(&state, &room, &show_id, &receipts, &mut avatar).await {
            avatar.error = Some(format!(
                "Avatar delivery failed; output is unconfirmed. ({error:#})"
            ));
        }
    }
}

async fn send_due(
    state: &AppState,
    room: &Room,
    show_id: &str,
    receipts: &StdMutex<CapabilityReceipts>,
    avatar: &mut AvatarState,
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
        avatar_peers(&receipts, &visible, now)
    };
    if let Some((_, _, targets)) = motion_slot().as_mut() {
        *targets = motion_targets(avatar.content.as_ref(), &peers);
    }
    let (status, accepted) = avatar.report(&peers, &local_sid, now);
    if let Some(status) = status {
        crate::room_presentation::publish(
            state,
            CloudRoomPresentationEvent {
                show_id: show_id.to_string(),
                graphics: None,
                avatar: Some(status),
                scene: None,
                media: None,
            },
        );
    }
    for mut view in accepted {
        view["showId"] = json!(show_id);
        crate::spawn_keep_cloud_presentation(state, show_id.to_string(), view);
    }
    for peer in &peers {
        let guest = peer.role == Role::Guest;
        let layers = avatar_layers(
            avatar.content.as_ref(),
            avatar.guests,
            guest,
            &peer.output,
            &peer.orientation,
            peer.animation,
        );
        // A guest that never saw layers needs no clear.
        if guest && layers.is_empty() && !avatar.guest_shown.contains(&peer.identity) {
            continue;
        }
        let key = json!([peer.sid, local_sid, peer.output, peer.orientation, layers]).to_string();
        if avatar
            .sent
            .get(&peer.identity)
            .is_some_and(|old| old.key == key && now - old.at < AVATAR_RENEW_MS)
        {
            continue;
        }
        let snapshot = avatar.snapshot(
            &room_name,
            &local_sid,
            &peer.output,
            &peer.orientation,
            layers,
            now,
        );
        let applied = peer
            .applied
            .as_ref()
            .map(|(sid, revision)| (sid.as_str(), *revision));
        let held = avatar.assets.held(
            &peer.identity,
            peer.refs,
            applied,
            &peer.sid,
            &local_sid,
            now,
        );
        let bytes = serde_json::to_vec(&with_references(&snapshot, &held))?;
        if bytes.len() > AVATAR_MAX_BYTES {
            anyhow::bail!("Avatar snapshot too large");
        }
        let empty = snapshot["layers"].as_array().is_none_or(Vec::is_empty);
        tokio::time::timeout(
            UPLOAD_TIMEOUT,
            upload(&local, &peer.identity, &bytes, empty),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Avatar upload timed out"))??;
        avatar
            .assets
            .record(&peer.identity, &peer.sid, &local_sid, &snapshot);
        avatar.sent.insert(
            peer.identity.clone(),
            Sent {
                key,
                revision: snapshot["revision"].as_u64().unwrap_or(0),
                at: now_ms(),
                layers: snapshot["layers"].clone(),
                output: peer.output.clone(),
                orientation: peer.orientation.clone(),
                publisher_sid: local_sid.clone(),
                expires_at: snapshot["expiresAt"].as_i64().unwrap_or(0),
            },
        );
        if guest {
            if empty {
                avatar.guest_shown.remove(&peer.identity);
            } else {
                avatar.guest_shown.insert(peer.identity.clone());
            }
        }
        avatar.error = None;
    }
    Ok(())
}

async fn upload(
    local: &LocalParticipant,
    identity: &str,
    bytes: &[u8],
    empty: bool,
) -> anyhow::Result<()> {
    let mut options = StreamByteOptions::new_with_topic(AVATAR_TOPIC);
    options.mime_type = Some("application/json".to_string());
    options.total_length = Some(bytes.len() as u64);
    options.destination_identities = vec![identity.to_string().into()];
    options.attributes = HashMap::from([("empty".to_string(), empty.to_string())]);
    let writer = local
        .stream_bytes(options)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    for chunk in bytes.chunks(CHUNK_BYTES) {
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

    fn content() -> Value {
        json!({
            "h": [{ "kind": "avatar", "rect": {}, "asset": { "hash": "s" }, "expiresAt": null }],
            "v": [{ "kind": "avatar", "rect": {}, "asset": { "hash": "sv" }, "expiresAt": null }],
            "stream": true,
            "recording": false,
            "animated": {
                "h": [{ "kind": "avatar", "rect": {}, "asset": { "hash": "atlas" }, "expiresAt": null }],
                "v": []
            }
        })
    }

    #[test]
    fn each_page_gets_its_lane_and_the_atlas_only_when_it_animates() {
        let c = content();
        assert_eq!(
            avatar_layers(Some(&c), false, false, "stream", "h", false)[0]["asset"]["hash"],
            "s"
        );
        assert_eq!(
            avatar_layers(Some(&c), false, false, "stream", "h", true)[0]["asset"]["hash"],
            "atlas"
        );
        // The recording lane is off in this content.
        assert!(avatar_layers(Some(&c), false, false, "recording", "h", false).is_empty());
        assert!(avatar_layers(None, true, false, "stream", "h", false).is_empty());
    }

    #[test]
    fn guests_see_the_stream_landscape_still_layers_only_while_shown() {
        let c = content();
        assert!(avatar_layers(Some(&c), false, true, "stream", "h", true).is_empty());
        let shown = avatar_layers(Some(&c), true, true, "stream", "h", true);
        assert_eq!(
            shown[0]["asset"]["hash"], "s",
            "a guest draws the still set"
        );
        assert_eq!(consumer_role("g_ada").map(|r| r == Role::Guest), Some(true));
        assert!(consumer_role("host:show").is_none());
    }

    #[test]
    fn the_cloud_keeps_a_view_only_when_its_pictures_or_places_changed() {
        let a = json!([{ "asset": { "hash": "x" }, "rect": { "x": 0.1 } }]);
        let b = json!([{ "asset": { "hash": "x" }, "rect": { "x": 0.2 } }]);
        assert_ne!(kept_key(&a), kept_key(&b));
        assert_eq!(kept_key(&a), kept_key(&a.clone()));
    }
}
