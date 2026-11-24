//! Plan 260 S1.8c c4c: who may subscribe to the host's tracks in the
//! backend's room, and the program audio routing topic, as the renderer
//! room's aux publisher does both (plan 249 S3, S7, S8;
//! `room-aux-publisher.ts`).
//!
//! Subscriptions are closed by default (`allowAll` off). Every visible
//! participant and each hidden egress page with a current capability receipt
//! may take the host's tracks; an HTML layer sheet goes to egress pages only;
//! the auxiliary track only to a consumer whose media v2 receipt is current;
//! and during a stream-screen takeover an egress page that cannot route
//! audio (no current receipt, or no `audioRouting: 1`) loses the host's
//! speech (the legacy whole-program silence). LiveKit's Rust SDK scopes a
//! permission by identity where the browser SDK scoped it by session id; the
//! plan is recomputed whenever a participant comes or goes.
//!
//! Routing: the Studio's program audio settings (speech and auxiliary gain
//! and mute, `cloud.room.routing.set`) go to every routing-capable program
//! page on `videorc.audio-routing.v1`, reliably, when they change and once a
//! second for the page's 3 s lease.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use livekit::id::{ParticipantIdentity, TrackSid};
use livekit::participant::ParticipantTrackPermission;
use livekit::prelude::{DataPacket, Room, TrackKind};
use serde_json::json;
use tokio::sync::{Notify, broadcast, mpsc, oneshot};

use crate::cloud_talk::ProgramAudioSettings;
use crate::room_capability::{CapabilityReceipts, capability_current};
use crate::state::AppState;

pub(crate) const AUDIO_ROUTING_TOPIC: &str = "videorc.audio-routing.v1";
/// `room-media-v2.ts`'s auxiliary track.
pub(crate) const AUX_TRACK_NAME: &str = "videorc:v2:host-aux:stereo";
/// `cloud-html-layer.ts`'s role: a sheet track's name starts with it.
const HTML_LAYER_ROLE: &str = "videorc:html-layer:v1";
const RECORDER_IDENTITY_PREFIX: &str = "EG_";
const ACTIVE_SCREEN_EVENT: &str = "screens.active.changed";
const ROUTING_RENEW: Duration = Duration::from_secs(1);
const ROUTING_MIN_GAP: Duration = Duration::from_millis(250);

static ROUTING: StdMutex<Option<ProgramAudioSettings>> = StdMutex::new(None);
static ROUTING_CHANGED: Notify = Notify::const_new();

fn routing() -> ProgramAudioSettings {
    ROUTING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_default()
}

/// `cloud.room.routing.set`.
pub(crate) fn set_routing(settings: ProgramAudioSettings) {
    *ROUTING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(settings);
    ROUTING_CHANGED.notify_waiters();
}

/// A hold ended: the defaults again.
pub(crate) fn clear() {
    *ROUTING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// One consumer the host may serve, as its receipt describes it.
#[derive(Debug, Clone)]
pub(crate) struct Consumer {
    pub(crate) identity: String,
    /// Its media v2 receipt is this session's and fresh.
    pub(crate) current: bool,
    /// The receipt says `audioRouting: 1`.
    pub(crate) routing: bool,
}

/// One of the host's published tracks.
#[derive(Debug, Clone)]
pub(crate) struct HostTrack {
    pub(crate) sid: String,
    pub(crate) name: String,
    pub(crate) audio: bool,
}

fn is_egress(identity: &str) -> bool {
    identity.starts_with(RECORDER_IDENTITY_PREFIX)
}

fn is_sheet(name: &str) -> bool {
    name.strip_prefix(HTML_LAYER_ROLE)
        .is_some_and(|rest| rest.starts_with(':'))
}

/// Which of the host's tracks each consumer may take, by identity.
pub(crate) fn subscription_plan(
    consumers: &[Consumer],
    tracks: &[HostTrack],
    takeover: bool,
) -> BTreeMap<String, BTreeSet<String>> {
    consumers
        .iter()
        .map(|consumer| {
            let egress = is_egress(&consumer.identity);
            let legacy_silenced = egress && takeover && !(consumer.current && consumer.routing);
            let allowed = tracks
                .iter()
                .filter(|track| {
                    if track.name == AUX_TRACK_NAME {
                        !legacy_silenced && consumer.current
                    } else if is_sheet(&track.name) {
                        egress
                    } else {
                        !(legacy_silenced && track.audio)
                    }
                })
                .map(|track| track.sid.clone())
                .collect();
            (consumer.identity.clone(), allowed)
        })
        .collect()
}

/// The program pages that negotiated routing and are current now.
pub(crate) fn routing_targets(consumers: &[Consumer]) -> Vec<String> {
    consumers
        .iter()
        .filter(|consumer| is_egress(&consumer.identity) && consumer.current && consumer.routing)
        .map(|consumer| consumer.identity.clone())
        .collect()
}

/// The routing packet (`AudioRoutingPacket`: exactly nine fields).
pub(crate) fn routing_packet(
    show: &str,
    publisher_sid: &str,
    sequence: u64,
    sent_at: i64,
    settings: &ProgramAudioSettings,
) -> serde_json::Value {
    json!({
        "v": 1,
        "show": show,
        "publisherSid": publisher_sid,
        "sequence": sequence,
        "sentAt": sent_at,
        "speechGain": settings.speech_gain,
        "auxiliaryGain": settings.auxiliary_gain,
        "speechMuted": settings.speech_muted,
        "auxiliaryMuted": settings.auxiliary_muted,
    })
}

fn consumers(room: &Room, receipts: &StdMutex<CapabilityReceipts>, now: i64) -> Vec<Consumer> {
    let visible: HashMap<String, String> = room
        .remote_participants()
        .values()
        .map(|participant| {
            (
                participant.identity().as_str().to_string(),
                participant.sid().as_str().to_string(),
            )
        })
        .collect();
    let receipts = receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    receipts
        .consumers(&visible, now)
        .into_iter()
        .map(|(identity, sid)| {
            let receipt = receipts.get(&identity);
            Consumer {
                current: capability_current(receipt, &sid, now),
                routing: receipt.is_some_and(|receipt| receipt.capability.audio_routing == Some(1)),
                identity,
            }
        })
        .collect()
}

/// One connection's subscriptions and routing. `changed` says a receipt, a
/// participant or a local track changed; it ends when `done` fires or a
/// sender drops.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut changed: mpsc::UnboundedReceiver<()>,
    mut done: oneshot::Receiver<()>,
) {
    let mut events = state.events.subscribe();
    let mut takeover = state
        .database
        .active_stream_screen()
        .ok()
        .flatten()
        .is_some();
    let mut planned: Option<BTreeMap<String, BTreeSet<String>>> = None;
    let mut sequence = 0u64;
    let mut sent: Option<(Instant, ProgramAudioSettings)> = None;
    // The first tick is at once: subscriptions close before anyone joins.
    let mut pulse = tokio::time::interval(ROUTING_RENEW);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            signal = changed.recv() => {
                if signal.is_none() {
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(event) if event.event == ACTIVE_SCREEN_EVENT => {
                    takeover = !event.payload.is_null();
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = pulse.tick() => {}
            _ = ROUTING_CHANGED.notified() => {}
        }
        let now = chrono::Utc::now().timestamp_millis();
        let consumers = consumers(&room, &receipts, now);
        let local = room.local_participant();
        let publications = local.track_publications();
        let tracks: Vec<HostTrack> = publications
            .values()
            .map(|publication| HostTrack {
                sid: publication.sid().as_str().to_string(),
                name: publication.name(),
                audio: publication.kind() == TrackKind::Audio,
            })
            .collect();
        let plan = subscription_plan(&consumers, &tracks, takeover);
        if planned.as_ref() != Some(&plan) {
            let sids: HashMap<String, TrackSid> = publications
                .keys()
                .map(|sid| (sid.as_str().to_string(), sid.clone()))
                .collect();
            let permissions = plan
                .iter()
                .map(|(identity, allowed)| ParticipantTrackPermission {
                    participant_identity: ParticipantIdentity::from(identity.as_str()),
                    allow_all: false,
                    allowed_track_sids: allowed
                        .iter()
                        .filter_map(|sid| sids.get(sid).cloned())
                        .collect(),
                })
                .collect();
            match local
                .set_track_subscription_permissions(false, permissions)
                .await
            {
                Ok(()) => planned = Some(plan),
                Err(error) => {
                    tracing::warn!("The room's subscriptions could not be set: {error}");
                }
            }
        }
        // Routing: on a change, and once a second for the lease.
        let targets = routing_targets(&consumers);
        if targets.is_empty() {
            continue;
        }
        let settings = routing();
        let due = match &sent {
            None => true,
            Some((at, last)) => {
                at.elapsed() >= ROUTING_MIN_GAP
                    && (*last != settings || at.elapsed() >= ROUTING_RENEW)
            }
        };
        if !due {
            continue;
        }
        sequence += 1;
        let packet = routing_packet(&room.name(), local.sid().as_str(), sequence, now, &settings);
        let data = DataPacket {
            payload: packet.to_string().into_bytes(),
            topic: Some(AUDIO_ROUTING_TOPIC.to_string()),
            reliable: true,
            destination_identities: targets.into_iter().map(ParticipantIdentity::from).collect(),
        };
        if let Err(error) = local.publish_data(data).await {
            tracing::debug!("The audio routing did not reach the program pages: {error}");
        }
        sent = Some((Instant::now(), settings));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer(identity: &str, current: bool, routing: bool) -> Consumer {
        Consumer {
            identity: identity.to_string(),
            current,
            routing,
        }
    }

    fn tracks() -> Vec<HostTrack> {
        let track = |sid: &str, name: &str, audio: bool| HostTrack {
            sid: sid.to_string(),
            name: name.to_string(),
            audio,
        };
        vec![
            track("TR_mic", "microphone", true),
            track("TR_cam", "camera", false),
            track("TR_aux", AUX_TRACK_NAME, true),
            track("TR_sheet", "videorc:html-layer:v1:h:3", false),
        ]
    }

    fn allowed(plan: &BTreeMap<String, BTreeSet<String>>, identity: &str) -> Vec<String> {
        plan[identity].iter().cloned().collect()
    }

    #[test]
    fn a_guest_takes_the_media_and_aux_only_when_current() {
        let plan = subscription_plan(
            &[
                consumer("g_a", true, false),
                consumer("g_old", false, false),
            ],
            &tracks(),
            false,
        );
        assert_eq!(allowed(&plan, "g_a"), vec!["TR_aux", "TR_cam", "TR_mic"]);
        assert_eq!(allowed(&plan, "g_old"), vec!["TR_cam", "TR_mic"]);
    }

    #[test]
    fn only_egress_pages_take_the_html_sheet() {
        let plan = subscription_plan(&[consumer("EG_p", true, true)], &tracks(), false);
        assert_eq!(
            allowed(&plan, "EG_p"),
            vec!["TR_aux", "TR_cam", "TR_mic", "TR_sheet"]
        );
    }

    #[test]
    fn a_takeover_silences_only_a_page_that_cannot_route() {
        let plan = subscription_plan(
            &[
                consumer("EG_new", true, true),
                consumer("EG_legacy", true, false),
                consumer("EG_stale", false, true),
                consumer("g_a", true, false),
            ],
            &tracks(),
            true,
        );
        assert_eq!(
            allowed(&plan, "EG_new"),
            vec!["TR_aux", "TR_cam", "TR_mic", "TR_sheet"]
        );
        assert_eq!(allowed(&plan, "EG_legacy"), vec!["TR_cam", "TR_sheet"]);
        assert_eq!(allowed(&plan, "EG_stale"), vec!["TR_cam", "TR_sheet"]);
        // Guests keep hearing the host.
        assert_eq!(allowed(&plan, "g_a"), vec!["TR_aux", "TR_cam", "TR_mic"]);
    }

    #[test]
    fn routing_goes_to_current_routing_program_pages() {
        let targets = routing_targets(&[
            consumer("EG_a", true, true),
            consumer("EG_b", true, false),
            consumer("EG_c", false, true),
            consumer("g_a", true, true),
        ]);
        assert_eq!(targets, vec!["EG_a"]);
    }

    #[test]
    fn the_routing_packet_has_the_nine_fields() {
        let packet = routing_packet(
            "show_1",
            "PA_host",
            4,
            1_764_000_000_000,
            &ProgramAudioSettings {
                speech_gain: 0.5,
                auxiliary_gain: 1.0,
                speech_muted: false,
                auxiliary_muted: true,
            },
        );
        assert_eq!(packet.as_object().unwrap().len(), 9);
        assert_eq!(packet["publisherSid"], "PA_host");
        assert_eq!(packet["speechGain"], 0.5);
        assert_eq!(packet["auxiliaryMuted"], true);
    }

    #[test]
    fn a_sheet_is_named_by_its_role() {
        assert!(is_sheet("videorc:html-layer:v1:h:3"));
        assert!(!is_sheet("videorc:html-layer:v10"));
        assert!(!is_sheet(AUX_TRACK_NAME));
    }
}
