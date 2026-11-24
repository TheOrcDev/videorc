//! Plan 260 S1.8a: the backend joins the talk show's room as the host
//! (`host:<showId>`, D9), with no media yet. Behind a dev switch
//! (`VIDEORC_BACKEND_ROOM=1`, debug builds only); without it the renderer
//! holds the host connection as before and nothing here runs.
//!
//! With the switch on, the backend follows `cloud.state`: while the room is
//! open it holds the seat with its own token (`room_token`, which then never
//! reaches the renderer: `cloud.room.token.refresh` refuses with
//! `cloud-room-held-by-backend`), and reports its own client state through
//! `report_client`, the renderer's reports being ignored. The rules are the
//! renderer's (`lib/talk-show-room.ts`): LiveKit's own reconnect, then a
//! fresh token and a rejoin after 1, 2, 4, 8 and 15 s; a deleted room or a
//! removal ends it; a duplicate identity is another device taking the seat
//! (`TAKEN_OVER_DETAIL` after 3 s). S1.8b moves the data topics (the stage
//! first, `stage_message`: on every join and every change, as the renderer
//! sent it), S1.8c the host's media, S1.8d the subscriptions (the plan's S1.8
//! cut).
//!
//! macOS only for now: the SDK is a macOS dependency until the native
//! Windows and Linux builds pass (S0.8).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// The room's reason (LiveKit's protocol enum), not the participant's.
use livekit::DisconnectReason;
use livekit::prelude::{DataPacket, Room, RoomEvent, RoomOptions};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot, watch};

use crate::cloud_talk::{CloudRoomClientState, RoomClientReportParams, TAKEN_OVER_DETAIL};
use crate::state::AppState;

/// The dev switch.
pub(crate) const SWITCH_ENV: &str = "VIDEORC_BACKEND_ROOM";

/// The data topic the guest page listens on for the stage (`guest-wire.ts`,
/// the renderer's `STAGE_TOPIC`).
pub(crate) const STAGE_TOPIC: &str = "videorc.stage";
/// At most two screens on the stage (plan 251, `STAGE_MAX_SCREENS`).
const STAGE_MAX_SCREENS: usize = 2;

/// The rejoin backoff, as the renderer's (seconds).
const REJOIN_BACKOFF_S: [u64; 5] = [1, 2, 4, 8, 15];
/// How long a duplicate identity waits before it reports the take-over.
const TAKE_OVER_WAIT: Duration = Duration::from_secs(3);

/// Whether the backend holds (or is getting) the host seat.
static HOLDS_SEAT: AtomicBool = AtomicBool::new(false);

/// The switch: debug builds with `VIDEORC_BACKEND_ROOM=1`.
pub(crate) fn enabled() -> bool {
    cfg!(debug_assertions) && std::env::var(SWITCH_ENV).as_deref() == Ok("1")
}

/// Whether the backend holds the host seat, so the renderer must stay out.
pub(crate) fn holds_seat() -> bool {
    HOLDS_SEAT.load(Ordering::Acquire)
}

/// Starts following `cloud.state` when the switch is on.
pub(crate) fn start(state: AppState) {
    if !enabled() {
        return;
    }
    tracing::info!("{SWITCH_ENV}=1: the backend holds the talk show's host seat (no media yet)");
    tokio::spawn(follow(state));
}

/// The stage message for the guest page (`stageMessage` in
/// `talk-show-room.ts`), from a `cloud.state` payload's `room.stage`: who is
/// on stage, the screen (and with two screens up, `screens` names both), and
/// `captions` while the on-stage guests are captioned. None without a stage.
pub(crate) fn stage_message(payload: &Value, captions: bool) -> Option<Vec<u8>> {
    let stage = payload.get("room")?.get("stage")?;
    let on_stage: Vec<String> = stage
        .get("onStage")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // `stageScreens`: two named screens win, else the one `screen`.
    let mut screens: Vec<String> = Vec::new();
    for identity in stage
        .get("screens")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !identity.is_empty() && !screens.iter().any(|named| named == identity) {
            screens.push(identity.to_string());
        }
    }
    if screens.len() < STAGE_MAX_SCREENS
        && let Some(screen) = stage.get("screen").and_then(Value::as_str)
    {
        screens = vec![screen.to_string()];
    }
    let named: Vec<String> = screens
        .into_iter()
        .filter(|identity| on_stage.contains(identity))
        .take(STAGE_MAX_SCREENS)
        .collect();
    let mut message = serde_json::json!({
        "v": 1,
        "onStage": on_stage,
        "screen": named.first(),
    });
    if named.len() == STAGE_MAX_SCREENS {
        message["screens"] = serde_json::json!(named);
    }
    if captions {
        message["captions"] = Value::Bool(true);
    }
    serde_json::to_vec(&message).ok()
}

/// Whether a `cloud.state` payload has the room open.
fn room_open(payload: &serde_json::Value) -> bool {
    payload
        .get("room")
        .and_then(|room| room.get("phase"))
        .and_then(serde_json::Value::as_str)
        == Some("open")
}

async fn follow(state: AppState) {
    let mut events = state.events.subscribe();
    let mut holding: Option<oneshot::Sender<()>> = None;
    // The latest stage message, for the hold to publish on join and change.
    let (stage, _) = watch::channel::<Option<Vec<u8>>>(None);
    // A hold that ended by itself (a take-over, a deleted room) is not
    // retried until the room closes once: the seat is someone else's.
    let mut ended_while_open = false;
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        };
        if event.event != "cloud.state" {
            continue;
        }
        let open = room_open(&event.payload);
        // Guest captions are not in `cloud.state` yet: the guest page's
        // "Live captions are on" line waits for S1.8d's in-process mix.
        let message = stage_message(&event.payload, false);
        stage.send_if_modified(|current| {
            let changed = *current != message;
            *current = message;
            changed
        });
        if holding.as_ref().is_some_and(oneshot::Sender::is_closed) {
            holding = None;
            ended_while_open = open;
        }
        if !open {
            ended_while_open = false;
        }
        match (open, holding.is_some()) {
            (true, false) if !ended_while_open => {
                let (stop, stopped) = oneshot::channel();
                HOLDS_SEAT.store(true, Ordering::Release);
                tokio::spawn(hold(state.clone(), stopped, stage.subscribe()));
                holding = Some(stop);
            }
            (false, true) => {
                if let Some(stop) = holding.take() {
                    let _ = stop.send(());
                }
            }
            _ => {}
        }
    }
}

fn report(state: &AppState, client: CloudRoomClientState, detail: Option<&str>) {
    if let Some(context) = crate::cloud_context(state) {
        context.report_client(RoomClientReportParams {
            state: client,
            detail: detail.map(str::to_string),
        });
    }
}

fn room_options() -> RoomOptions {
    let mut options = RoomOptions::default();
    // Guest by guest, never the program page (S0.8); dynacast as the
    // renderer's room.
    options.auto_subscribe = false;
    options.adaptive_stream = false;
    options.dynacast = true;
    options
}

/// Holds the seat until `stop` fires or the room ends it.
async fn hold(
    state: AppState,
    mut stop: oneshot::Receiver<()>,
    mut stage: watch::Receiver<Option<Vec<u8>>>,
) {
    let mut attempt = 0usize;
    loop {
        report(&state, CloudRoomClientState::Connecting, None);
        let token = match crate::cloud_context(&state) {
            Some(context) => context
                .room_token(crate::account::stored_session_token())
                .await
                .map_err(|error| format!("{error:#}")),
            None => Err("Videorc Cloud is unavailable".to_string()),
        };
        let connected = match token {
            Ok(token) => {
                tokio::select! {
                    _ = &mut stop => return leave(&state, None).await,
                    connected = Room::connect(&token.url, &token.host_token, room_options()) => {
                        connected.map_err(|error| error.to_string())
                    }
                }
            }
            Err(error) => Err(error),
        };
        match connected {
            Err(error) => {
                tracing::warn!("The backend could not join the talk show's room: {error}");
                report(&state, CloudRoomClientState::Disconnected, None);
            }
            Ok((room, mut events)) => {
                attempt = 0;
                report(&state, CloudRoomClientState::Connected, None);
                // Data messages are not replayed: the stage goes out on every
                // join, then on every change.
                let message = stage.borrow_and_update().clone();
                publish_stage(&room, message).await;
                let reason = loop {
                    tokio::select! {
                        _ = &mut stop => return leave(&state, Some(room)).await,
                        changed = stage.changed() => {
                            if changed.is_ok() {
                                let message = stage.borrow_and_update().clone();
                                publish_stage(&room, message).await;
                            }
                        }
                        event = events.recv() => match event {
                            Some(RoomEvent::Reconnecting) => {
                                report(&state, CloudRoomClientState::Reconnecting, None);
                            }
                            Some(RoomEvent::Reconnected) => {
                                report(&state, CloudRoomClientState::Connected, None);
                            }
                            Some(RoomEvent::Disconnected { reason }) => break reason,
                            None => break DisconnectReason::UnknownReason,
                            Some(_) => {}
                        },
                    }
                };
                tracing::info!("The talk show's room disconnected the backend: {reason:?}");
                match reason {
                    DisconnectReason::DuplicateIdentity => {
                        tokio::select! {
                            _ = &mut stop => return leave(&state, None).await,
                            _ = tokio::time::sleep(TAKE_OVER_WAIT) => {}
                        }
                        report(
                            &state,
                            CloudRoomClientState::Disconnected,
                            Some(TAKEN_OVER_DETAIL),
                        );
                        HOLDS_SEAT.store(false, Ordering::Release);
                        return;
                    }
                    DisconnectReason::RoomDeleted | DisconnectReason::ParticipantRemoved => {
                        report(&state, CloudRoomClientState::Disconnected, None);
                        HOLDS_SEAT.store(false, Ordering::Release);
                        return;
                    }
                    _ => report(&state, CloudRoomClientState::Disconnected, None),
                }
            }
        }
        let delay = REJOIN_BACKOFF_S[attempt.min(REJOIN_BACKOFF_S.len() - 1)];
        attempt += 1;
        tokio::select! {
            _ = &mut stop => return leave(&state, None).await,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
    }
}

async fn publish_stage(room: &Room, message: Option<Vec<u8>>) {
    let Some(payload) = message else {
        return;
    };
    let packet = DataPacket {
        payload,
        topic: Some(STAGE_TOPIC.to_string()),
        reliable: true,
        ..DataPacket::default()
    };
    if let Err(error) = room.local_participant().publish_data(packet).await {
        tracing::warn!("The stage did not reach the talk show's room: {error}");
    }
}

/// The room closed (or never opened) here: leave it and give the seat back.
async fn leave(state: &AppState, room: Option<Room>) {
    if let Some(room) = room
        && let Err(error) = room.close().await
    {
        tracing::warn!("The backend could not leave the talk show's room cleanly: {error}");
    }
    report(state, CloudRoomClientState::Idle, None);
    HOLDS_SEAT.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_room_is_open_only_in_the_open_phase() {
        assert!(room_open(
            &serde_json::json!({ "room": { "phase": "open" } })
        ));
        for payload in [
            serde_json::json!({ "room": { "phase": "opening" } }),
            serde_json::json!({ "room": { "phase": "closing" } }),
            serde_json::json!({ "room": null }),
            serde_json::json!({}),
        ] {
            assert!(!room_open(&payload), "{payload}");
        }
    }

    fn stage(value: serde_json::Value) -> serde_json::Value {
        serde_json::from_slice(
            &stage_message(&serde_json::json!({ "room": { "stage": value } }), false).unwrap(),
        )
        .unwrap()
    }

    // The cases of `stageMessage` in talk-show-room.ts.
    #[test]
    fn the_stage_message_is_the_renderers() {
        assert_eq!(
            stage(serde_json::json!({ "onStage": ["host:s", "guest-a"], "screen": "guest-a" })),
            serde_json::json!({ "v": 1, "onStage": ["host:s", "guest-a"], "screen": "guest-a" })
        );
        // A screen of someone off stage is not named.
        assert_eq!(
            stage(serde_json::json!({ "onStage": ["host:s"], "screen": "guest-b" })),
            serde_json::json!({ "v": 1, "onStage": ["host:s"], "screen": null })
        );
        // Two screens: `screens` names both, `screen` stays the first.
        assert_eq!(
            stage(serde_json::json!({
                "onStage": ["host:s", "a", "b"],
                "screen": "a",
                "screens": ["a", "b"]
            })),
            serde_json::json!({
                "v": 1,
                "onStage": ["host:s", "a", "b"],
                "screen": "a",
                "screens": ["a", "b"]
            })
        );
        let captioned = stage_message(
            &serde_json::json!({ "room": { "stage": { "onStage": [] } } }),
            true,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&captioned).unwrap(),
            serde_json::json!({ "v": 1, "onStage": [], "screen": null, "captions": true })
        );
        assert!(stage_message(&serde_json::json!({ "room": null }), false).is_none());
    }

    #[test]
    fn the_rejoin_backoff_is_the_renderers() {
        assert_eq!(REJOIN_BACKOFF_S, [1, 2, 4, 8, 15]);
        let options = room_options();
        assert!(!options.auto_subscribe && !options.adaptive_stream && options.dynacast);
    }
}
