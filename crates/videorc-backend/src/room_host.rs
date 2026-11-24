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
//! (`TAKEN_OVER_DETAIL` after 3 s). S1.8b moves the data topics, S1.8c the
//! host's media, S1.8d the subscriptions (the plan's S1.8 cut).
//!
//! macOS only for now: the SDK is a macOS dependency until the native
//! Windows and Linux builds pass (S0.8).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use livekit::prelude::{DisconnectReason, Room, RoomEvent, RoomOptions};
use tokio::sync::{broadcast, oneshot};

use crate::cloud_talk::{CloudRoomClientState, RoomClientReportParams, TAKEN_OVER_DETAIL};
use crate::state::AppState;

/// The dev switch.
pub(crate) const SWITCH_ENV: &str = "VIDEORC_BACKEND_ROOM";

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
                tokio::spawn(hold(state.clone(), stopped));
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
async fn hold(state: AppState, mut stop: oneshot::Receiver<()>) {
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
                let reason = loop {
                    tokio::select! {
                        _ = &mut stop => return leave(&state, Some(room)).await,
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

    #[test]
    fn the_rejoin_backoff_is_the_renderers() {
        assert_eq!(REJOIN_BACKOFF_S, [1, 2, 4, 8, 15]);
        let options = room_options();
        assert!(!options.auto_subscribe && !options.adaptive_stream && options.dynacast);
    }
}
