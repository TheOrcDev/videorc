//! Plan 260 S1.8b: the room's static graphics (captions, cards, banners,
//! timers, the chat box) from the backend once it holds the host seat: the
//! renderer's `room-graphics-publisher.ts` in Rust (plan 249 S9, S15, S24,
//! PH-05, PERF-06).
//!
//! The content is the backend's own `cloud.graphics.snapshot`, polled each
//! second with its signature (nothing is built while it is unchanged). Each
//! program page (`EG_`) whose fresh receipt draws static graphics gets its
//! lane's snapshot as a byte stream on `videorc.presentation.static.v1`,
//! addressed to it alone: a new view at once, the same view again after the
//! 10 s renewal, and once more after 3 s when the page's receipt shows it
//! dropped it. A picture the page provably holds goes as a reference. With
//! the room's Graphics switch off, only captions and the comment card go
//! (their own controls put them on the stream). What each page applied goes
//! to the Studio on `cloud.room.presentation` and, once per view, to the
//! cloud for the next controller.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::prelude::{LocalParticipant, Room};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::cloud_talk::{
    CLOUD_ROOM_PRESENTATION_EVENT, CloudRoomPresentationEvent, PresentationOrientation,
    PresentationOutput, RoomPresentationObservation, RoomPresentationState, RoomPresentationStatus,
};
use crate::room_assets::{SentAssets, with_references};
use crate::room_capability::{CapabilityReceipts, capability_current};
use crate::state::AppState;

pub(crate) const GRAPHICS_TOPIC: &str = "videorc.presentation.static.v1";
const GRAPHICS_MAX_BYTES: usize = 6 * 1024 * 1024;
const GRAPHICS_LEASE_MS: i64 = 30_000;
/// A lease renewal of a view its page applied.
pub(crate) const GRAPHICS_RENEW_MS: i64 = 10_000;
/// A view its page has not acknowledged goes again, once, after this long...
pub(crate) const GRAPHICS_UNACKED_RESEND_MS: i64 = 3_000;
/// ...when a receipt this long after the send still does not acknowledge it.
pub(crate) const GRAPHICS_ACK_GRACE_MS: i64 = 2_000;
const CHUNK_BYTES: usize = 16 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(8);

/// The room's Graphics switch (`cloud.room.presentation.set`), off when a
/// hold starts, as the renderer's client was.
static GRAPHICS_ENABLED: AtomicBool = AtomicBool::new(false);
static GRAPHICS_SWITCHED: Notify = Notify::const_new();

pub(crate) fn set_enabled(enabled: bool) {
    GRAPHICS_ENABLED.store(enabled, Ordering::Release);
    GRAPHICS_SWITCHED.notify_waiters();
}

pub(crate) fn reset_enabled() {
    GRAPHICS_ENABLED.store(false, Ordering::Release);
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `graphicsLayers`: one lane's layers, the output's own rect in place.
pub(crate) fn graphics_layers(
    content: Option<&Value>,
    output: &str,
    orientation: &str,
    captions: bool,
) -> Vec<Value> {
    let Some(layers) = content
        .and_then(|c| c.get(orientation))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    layers
        .iter()
        .filter(|layer| layer.get(output).and_then(Value::as_bool) == Some(true))
        .filter(|layer| captions || layer.get("kind").and_then(Value::as_str) != Some("caption"))
        .map(|layer| {
            let mut layer = layer.clone();
            let own_rect = layer
                .get("outputRects")
                .and_then(|rects| rects.get(output))
                .cloned();
            if let Some(fields) = layer.as_object_mut() {
                fields.remove("stream");
                fields.remove("recording");
                fields.remove("outputRects");
                if let Some(rect) = own_rect {
                    fields.insert("rect".to_string(), rect);
                }
            }
            layer
        })
        .collect()
}

/// `roomGraphicsContent`: with the switch off, only the layers whose own
/// controls put them on the stream (captions, the comment card).
pub(crate) fn room_graphics_content(content: Option<&Value>, enabled: bool) -> Option<Value> {
    let content = content?;
    if enabled {
        return Some(content.clone());
    }
    let own = |orientation: &str| -> Vec<Value> {
        content
            .get(orientation)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|layer| {
                matches!(
                    layer.get("kind").and_then(Value::as_str),
                    Some("caption" | "highlight")
                )
            })
            .cloned()
            .collect()
    };
    let (h, v) = (own("h"), own("v"));
    (!h.is_empty() || !v.is_empty()).then(|| json!({ "h": h, "v": v, "unsupported": [] }))
}

/// What was sent to one page, as the renderer kept it.
#[derive(Debug, Clone)]
pub(crate) struct Sent {
    pub key: String,
    pub revision: u64,
    pub at: i64,
    pub layers: Value,
    pub output: String,
    pub orientation: String,
    pub publisher_sid: String,
    pub expires_at: i64,
    pub retried: bool,
}

/// `graphicsSendDue`: whether a page is due `key` now, and whether that send
/// repeats a view it never acknowledged.
pub(crate) fn graphics_send_due(
    sent: Option<&Sent>,
    key: &str,
    applied: Option<(&str, u64)>,
    heard_at: Option<i64>,
    now: i64,
) -> (bool, bool) {
    let Some(sent) = sent.filter(|sent| sent.key == key) else {
        return (true, false);
    };
    let age = now - sent.at;
    let acknowledged = applied == Some((sent.publisher_sid.as_str(), sent.revision));
    if acknowledged || sent.retried {
        return (age >= GRAPHICS_RENEW_MS, false);
    }
    let dropped = heard_at.is_some_and(|heard| heard - sent.at >= GRAPHICS_ACK_GRACE_MS);
    (
        age >= GRAPHICS_RENEW_MS || (dropped && age >= GRAPHICS_UNACKED_RESEND_MS),
        true,
    )
}

/// The cloud keeps an accepted view only when what it would bring back
/// changed (the renderer's `keptGraphicsRef`): the untimed banners and
/// whether captions and the chat box were on.
pub(crate) fn kept_key(layers: &Value) -> String {
    let layers = layers.as_array().cloned().unwrap_or_default();
    let banners: Vec<Value> = layers
        .iter()
        .filter(|l| {
            l.get("kind").and_then(Value::as_str) == Some("banner") && l["expiresAt"].is_null()
        })
        .map(|l| {
            let opacity = l.get("opacity").and_then(Value::as_f64).unwrap_or(1.0);
            let fade_to = l
                .get("fade")
                .and_then(|fade| fade.get("to"))
                .and_then(Value::as_f64)
                .unwrap_or(1.0);
            json!([l["id"], l["asset"]["hash"], l["rect"], opacity * fade_to])
        })
        .collect();
    let kinds: Vec<Value> = layers
        .iter()
        .filter(|l| {
            matches!(
                l.get("kind").and_then(Value::as_str),
                Some("chat" | "caption")
            )
        })
        .map(|l| l["kind"].clone())
        .collect();
    json!([banners, kinds]).to_string()
}

/// The publisher's state for one connection (no I/O).
#[derive(Default)]
pub(crate) struct GraphicsState {
    content: Option<Value>,
    signature: Option<String>,
    enabled: bool,
    heard: HashMap<String, i64>,
    sent: HashMap<String, Sent>,
    accepted: HashMap<String, u64>,
    kept: HashMap<String, String>,
    assets: SentAssets,
    revision: u64,
    error: Option<String>,
    last_status: Option<RoomPresentationStatus>,
}

/// A page that may draw graphics: an `EG_` page with a fresh static
/// receipt. `(identity, sid, output, orientation, captions, refs, applied)`.
struct GraphicsPeer {
    identity: String,
    sid: String,
    output: String,
    orientation: String,
    captions: bool,
    refs: bool,
    applied: Option<(String, u64)>,
}

fn graphics_peers(
    receipts: &CapabilityReceipts,
    visible: &HashMap<String, String>,
    now: i64,
) -> Vec<GraphicsPeer> {
    receipts
        .consumers(visible, now)
        .into_iter()
        .filter(|(identity, _)| identity.starts_with("EG_"))
        .filter_map(|(identity, sid)| {
            let receipt = receipts.get(&identity)?;
            if !capability_current(Some(receipt), &sid, now) {
                return None;
            }
            let graphics = receipt.capability.graphics.as_ref()?;
            let static_layer = graphics.static_layer.as_ref()?;
            Some(GraphicsPeer {
                identity,
                sid,
                output: graphics.output.clone(),
                orientation: graphics.orientation.clone(),
                captions: static_layer.captions == Some(1),
                refs: static_layer.refs == Some(1),
                applied: static_layer
                    .applied
                    .as_ref()
                    .map(|a| (a.publisher_sid.clone(), a.revision)),
            })
        })
        .collect()
}

impl GraphicsState {
    /// New content (or the switch flipped): every page gets the new view.
    fn set(&mut self, content: Option<Value>) {
        self.error = content
            .as_ref()
            .and_then(|c| c.get("unsupported"))
            .and_then(Value::as_array)
            .filter(|list| !list.is_empty())
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            });
        self.content = content;
        self.sent.clear();
    }

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
        let lease_end = now + GRAPHICS_LEASE_MS - 1000;
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

    /// The Studio's status and the views newly applied (for the cloud).
    fn report(
        &mut self,
        peers: &[GraphicsPeer],
        local_sid: &str,
        connected: bool,
        now: i64,
    ) -> (Option<RoomPresentationStatus>, Vec<Value>) {
        let mut observed = std::collections::BTreeMap::new();
        let mut accepted = Vec::new();
        let (mut capable, mut wanted) = (0usize, 0usize);
        for peer in peers {
            let lane =
                graphics_layers(self.content.as_ref(), &peer.output, &peer.orientation, true);
            let needs_captions = lane.iter().any(|l| l["kind"] == "caption");
            let visible = lane
                .iter()
                .any(|l| l["expiresAt"].as_i64().is_none_or(|at| at > now));
            if !needs_captions || peer.captions {
                capable += 1;
            }
            // Before the visibility check: an applied empty view must reach
            // the cloud too.
            if let Some(view) = self.note_accepted(peer, local_sid, now) {
                accepted.push(view);
            }
            if !visible {
                continue;
            }
            wanted += 1;
            let sent = self.sent.get(&peer.identity);
            if let (Some((applied_sid, applied_revision)), Some(sent)) =
                (peer.applied.as_ref(), sent)
                && applied_sid == local_sid
                && *applied_revision == sent.revision
            {
                observed.insert(
                    peer.identity.clone(),
                    RoomPresentationObservation {
                        revision: *applied_revision,
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
        let enabled = self.content.is_some();
        let state = if self.error.is_some() {
            RoomPresentationState::Failed
        } else if !enabled {
            RoomPresentationState::Off
        } else if !connected {
            RoomPresentationState::Waiting
        } else if peers.is_empty() {
            RoomPresentationState::Preview
        } else if capable == peers.len() && wanted > 0 && observed.len() == wanted {
            RoomPresentationState::Applied
        } else {
            RoomPresentationState::Waiting
        };
        let reason = self.error.clone().or_else(|| match state {
            _ if !connected && enabled => Some("Waiting for the room connection.".to_string()),
            RoomPresentationState::Preview => {
                Some("Local preview only; no egress is running.".to_string())
            }
            RoomPresentationState::Waiting if capable < peers.len() => {
                Some("Graphics output unconfirmed: reload older program consumers.".to_string())
            }
            RoomPresentationState::Waiting => {
                Some("Graphics sent; waiting for each output to apply it.".to_string())
            }
            _ => None,
        });
        let status = RoomPresentationStatus {
            enabled: self.enabled,
            state,
            reason,
            revision: self.revision,
            observed,
            guests: None,
            background: None,
        };
        if self.last_status.as_ref() == Some(&status) {
            return (None, accepted);
        }
        self.last_status = Some(status.clone());
        (Some(status), accepted)
    }

    /// Plan 249 S24: a view its page applied exactly as sent, once per
    /// output view and only when what the cloud keeps changed.
    fn note_accepted(&mut self, peer: &GraphicsPeer, local_sid: &str, now: i64) -> Option<Value> {
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
        if self.accepted.len() > 64 {
            // Any one: the map only guards against a late older revision.
            if let Some(oldest) = self.accepted.keys().next().cloned() {
                self.accepted.remove(&oldest);
            }
        }
        let kept = kept_key(&sent.layers);
        let lane = format!("{}/{}", sent.output, sent.orientation);
        if self.kept.get(&lane) == Some(&kept) {
            return None;
        }
        self.kept.insert(lane, kept);
        Some(json!({
            "topic": "static",
            "output": sent.output,
            "orientation": sent.orientation,
            "publisherSid": sent.publisher_sid,
            "revision": sent.revision,
            "layers": sent.layers,
        }))
    }

    fn forget(&mut self, identity: &str) {
        self.heard.remove(identity);
        self.sent.remove(identity);
        self.assets.forget(identity);
    }
}

/// What a connection's graphics publisher hears from the room host.
pub(crate) enum GraphicsSignal {
    /// A receipt was taken (by its identity), at this computer's clock.
    Heard(String),
    /// A visible participant left.
    Left(String),
}

/// One connection's graphics publisher. Ends when `signals` closes.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut signals: mpsc::UnboundedReceiver<GraphicsSignal>,
) {
    let mut graphics = GraphicsState::default();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            signal = signals.recv() => match signal {
                Some(GraphicsSignal::Heard(identity)) => {
                    graphics.heard.insert(identity, now_ms());
                }
                Some(GraphicsSignal::Left(identity)) => {
                    lock(&receipts).forget(&identity);
                    graphics.forget(&identity);
                }
                None => return,
            },
            _ = tick.tick() => {}
            _ = GRAPHICS_SWITCHED.notified() => {}
        }
        refresh_content(&state, &show_id, &mut graphics).await;
        if let Err(error) = send_due(&state, &room, &show_id, &receipts, &mut graphics).await {
            graphics.error = Some(format!(
                "Graphics delivery failed; output is unconfirmed. ({error:#})"
            ));
        }
    }
}

fn lock(receipts: &StdMutex<CapabilityReceipts>) -> std::sync::MutexGuard<'_, CapabilityReceipts> {
    receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The backend's own snapshot, only when its signature moved or the switch
/// flipped.
async fn refresh_content(state: &AppState, show_id: &str, graphics: &mut GraphicsState) {
    let enabled = GRAPHICS_ENABLED.load(Ordering::Acquire);
    let switched = enabled != graphics.enabled;
    graphics.enabled = enabled;
    let params = crate::cloud_graphics::SnapshotParams {
        show_id: show_id.to_string(),
        known: if switched {
            None
        } else {
            graphics.signature.clone()
        },
        held: Vec::new(),
    };
    match crate::cloud_graphics::snapshot(state, params).await {
        Ok(answer) => {
            let signature = answer
                .get("signature")
                .and_then(Value::as_str)
                .map(str::to_string);
            let unchanged = !switched && signature.is_some() && signature == graphics.signature;
            graphics.signature = signature;
            if unchanged || answer.get("content").is_none() {
                return;
            }
            let content = answer.get("content").filter(|c| !c.is_null());
            // S1.8c c5: the HTML banners' placements, for the room's sheet.
            crate::room_html::set_placements(
                content
                    .filter(|_| enabled)
                    .and_then(|content| content.get("html"))
                    .cloned(),
            );
            graphics.set(room_graphics_content(content, enabled));
        }
        Err(error) => {
            if graphics.content.is_some() {
                tracing::warn!("The room's graphics could not be read: {error:#}");
                crate::room_html::set_placements(None);
                graphics.set(None);
                graphics.error =
                    Some("Graphics assets unavailable. Nothing was published.".to_string());
            }
        }
    }
}

fn visible_participants(room: &Room) -> HashMap<String, String> {
    room.remote_participants()
        .values()
        .map(|p| {
            (
                p.identity().as_str().to_string(),
                p.sid().as_str().to_string(),
            )
        })
        .collect()
}

async fn send_due(
    state: &AppState,
    room: &Room,
    show_id: &str,
    receipts: &StdMutex<CapabilityReceipts>,
    graphics: &mut GraphicsState,
) -> anyhow::Result<()> {
    let local = room.local_participant();
    let local_sid = local.sid().as_str().to_string();
    let room_name = room.name();
    let now = now_ms();
    let visible = visible_participants(room);
    let peers = {
        let receipts = lock(receipts);
        graphics_peers(&receipts, &visible, now)
    };
    let (status, accepted) = graphics.report(&peers, &local_sid, true, now);
    if let Some(status) = status {
        state.emit_event(
            CLOUD_ROOM_PRESENTATION_EVENT,
            CloudRoomPresentationEvent {
                show_id: show_id.to_string(),
                graphics: Some(status),
                avatar: None,
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
        let layers = graphics_layers(
            graphics.content.as_ref(),
            &peer.output,
            &peer.orientation,
            peer.captions,
        );
        // PH-05: a picture is named by its hash, not its base64.
        let key = json!([
            peer.sid,
            local_sid,
            peer.output,
            peer.orientation,
            layers
                .iter()
                .map(|l| {
                    let mut l = l.clone();
                    l["asset"] = json!([
                        l["asset"]["hash"],
                        l["asset"]["width"],
                        l["asset"]["height"]
                    ]);
                    l
                })
                .collect::<Vec<_>>()
        ])
        .to_string();
        let applied = peer
            .applied
            .as_ref()
            .map(|(sid, revision)| (sid.as_str(), *revision));
        let (due, retry) = graphics_send_due(
            graphics.sent.get(&peer.identity),
            &key,
            applied,
            graphics.heard.get(&peer.identity).copied(),
            now,
        );
        if !due {
            continue;
        }
        let snapshot = graphics.snapshot(
            &room_name,
            &local_sid,
            &peer.output,
            &peer.orientation,
            layers,
            now,
        );
        let held: HashSet<String> = graphics.assets.held(
            &peer.identity,
            peer.refs,
            applied,
            &peer.sid,
            &local_sid,
            now,
        );
        let bytes = serde_json::to_vec(&with_references(&snapshot, &held))?;
        if bytes.len() > GRAPHICS_MAX_BYTES {
            anyhow::bail!("Graphics snapshot too large");
        }
        let empty = snapshot["layers"].as_array().is_none_or(Vec::is_empty);
        tokio::time::timeout(
            UPLOAD_TIMEOUT,
            upload(&local, &peer.identity, &bytes, empty),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Graphics upload timed out"))??;
        graphics
            .assets
            .record(&peer.identity, &peer.sid, &local_sid, &snapshot);
        graphics.sent.insert(
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
                retried: retry,
            },
        );
    }
    Ok(())
}

async fn upload(
    local: &LocalParticipant,
    identity: &str,
    bytes: &[u8],
    empty: bool,
) -> anyhow::Result<()> {
    let mut options = StreamByteOptions::new_with_topic(GRAPHICS_TOPIC);
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
            "h": [
                { "id": "c", "kind": "caption", "stream": true, "recording": false, "rect": { "x": 0, "y": 0, "w": 1, "h": 0.1 }, "expiresAt": null },
                { "id": "b", "kind": "banner", "stream": true, "recording": true, "rect": { "x": 0, "y": 0.5, "w": 0.3, "h": 0.1 },
                  "outputRects": { "recording": { "x": 0.1, "y": 0.5, "w": 0.3, "h": 0.1 } }, "expiresAt": null }
            ],
            "v": [],
            "unsupported": []
        })
    }

    #[test]
    fn a_lane_keeps_its_layers_and_its_own_rect() {
        let stream = graphics_layers(Some(&content()), "stream", "h", true);
        assert_eq!(stream.len(), 2);
        assert!(stream[0].get("stream").is_none() && stream[0].get("outputRects").is_none());
        let recording = graphics_layers(Some(&content()), "recording", "h", true);
        assert_eq!(recording.len(), 1);
        assert_eq!(recording[0]["rect"]["x"], json!(0.1));
        // A page that does not draw captions gets none.
        assert_eq!(
            graphics_layers(Some(&content()), "stream", "h", false).len(),
            1
        );
    }

    #[test]
    fn with_the_switch_off_only_captions_and_cards_go() {
        let off = room_graphics_content(Some(&content()), false).unwrap();
        assert_eq!(off["h"].as_array().unwrap().len(), 1);
        assert_eq!(off["h"][0]["kind"], "caption");
        assert_eq!(
            room_graphics_content(Some(&content()), true).unwrap(),
            content()
        );
        let banners_only = json!({ "h": [{ "kind": "banner" }], "v": [], "unsupported": [] });
        assert!(room_graphics_content(Some(&banners_only), false).is_none());
    }

    fn sent(key: &str, at: i64, retried: bool) -> Sent {
        Sent {
            key: key.to_string(),
            revision: 4,
            at,
            layers: json!([]),
            output: "stream".into(),
            orientation: "h".into(),
            publisher_sid: "PA_me".into(),
            expires_at: at + 29_000,
            retried,
        }
    }

    // The cases of `graphicsSendDue`.
    #[test]
    fn a_view_goes_new_renewed_and_resent_once_when_dropped() {
        assert_eq!(graphics_send_due(None, "k", None, None, 0), (true, false));
        assert_eq!(
            graphics_send_due(Some(&sent("old", 0, false)), "k", None, None, 0),
            (true, false)
        );
        let s = sent("k", 0, false);
        // Acknowledged: only the renewal.
        assert_eq!(
            graphics_send_due(Some(&s), "k", Some(("PA_me", 4)), None, 9_999),
            (false, false)
        );
        assert_eq!(
            graphics_send_due(Some(&s), "k", Some(("PA_me", 4)), None, 10_000),
            (true, false)
        );
        // Unacknowledged, a receipt 2 s later still without it: once more at 3 s.
        assert_eq!(
            graphics_send_due(Some(&s), "k", None, Some(2_000), 2_999),
            (false, true)
        );
        assert_eq!(
            graphics_send_due(Some(&s), "k", None, Some(2_000), 3_000),
            (true, true)
        );
        // A slow relay alone resends nothing before the renewal.
        assert_eq!(
            graphics_send_due(Some(&s), "k", None, Some(1_000), 3_000),
            (false, true)
        );
        // Already retried: only the renewal.
        assert_eq!(
            graphics_send_due(Some(&sent("k", 0, true)), "k", None, Some(2_000), 3_000),
            (false, false)
        );
    }

    #[test]
    fn the_cloud_keeps_a_view_only_when_its_banners_or_switches_changed() {
        let a = json!([{ "kind": "banner", "id": "b", "asset": { "hash": "h" }, "rect": {}, "opacity": 1, "fade": null, "expiresAt": null },
                       { "kind": "highlight", "id": "x" }]);
        let b = json!([{ "kind": "banner", "id": "b", "asset": { "hash": "h" }, "rect": {}, "opacity": 1, "fade": null, "expiresAt": null }]);
        assert_eq!(kept_key(&a), kept_key(&b), "a card alone is not kept");
        let c = json!([{ "kind": "caption", "id": "c" }]);
        assert_ne!(kept_key(&b), kept_key(&c));
    }
}
