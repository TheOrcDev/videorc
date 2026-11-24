//! The backend's events, typed with `videorc-protocol` where Phase 2 reads
//! them, and the connection-scoped filter that narrows what a socket hears.
//!
//! Mirrors `BackendEventMap` and `validateBackendEventPayload` in
//! `apps/desktop/src/shared/backend-rpc-contract.ts`: a typed event whose
//! payload does not fit its type, and any event this client does not type,
//! are logged and passed on as JSON. Neither is ever fatal: the socket stays
//! up and the next event arrives as usual.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use videorc_protocol::{
    BackendConnection, CompositorFrameReady, CompositorStatus, DeviceList, HealthEvent,
    PreviewSurfaceStatus, RecordingFinalizationEvent, RecordingStatus, Scene, ServerEvent,
};

use crate::log::Logger;

/// The event names this client types.
pub mod names {
    /// The first event on every loopback socket: the renderer credential.
    pub const BACKEND_READY: &str = "backend.ready";
    pub const RECORDING_STATUS: &str = "recording.status";
    pub const SCENE_CHANGED: &str = "scene.changed";
    pub const COMPOSITOR_STATUS: &str = "compositor.status";
    pub const PREVIEW_SURFACE_STATUS: &str = "preview.surface.status";
    /// The small latest-wins frame lane native preview presents from.
    pub const PREVIEW_FRAME_READY: &str = "preview.frameReady";
    /// The device list changed (a camera plugged in, a display gone); the
    /// payload is the whole list, as `devices.list` answers it.
    pub const DEVICES_CHANGED: &str = "devices.changed";
    /// One health event: a session's warning or error, or a backend notice.
    pub const HEALTH_EVENT: &str = "health.event";
    /// The background MP4 export of a finished recording, step by step.
    pub const RECORDING_FINALIZATION: &str = "recording.finalization";
    /// The backend dropped events for this socket because it read too
    /// slowly; state built from events must be read again.
    pub const EVENTS_LAGGED: &str = "events.lagged";
    /// A Stream Deck or phone intent the backend admitted and relays to the
    /// UI process to run (plan 220 S2.4c, D5): `{intentId, intent: {kind, …}}`.
    pub const REMOTE_INTENT: &str = "remote.intent";
    /// Plan 220 S3.0f: the events the Studio's toasts read, passed on as
    /// JSON (`crate::notices` reads their payloads): each destination's
    /// runtime state, the clip ring's state and saves, and a clip mark.
    pub const STREAM_TARGETS: &str = "stream.targets";
    pub const REPLAY_STATE: &str = "replay.state";
    pub const REPLAY_SAVED: &str = "replay.saved";
    pub const REPLAY_SAVE_FAILED: &str = "replay.saveFailed";
    pub const CLIP_MARKED: &str = "clip.marked";
}

/// `remote.intent`'s payload: the backend's ticket id and the intent as the
/// remote sent it (`kind` plus its fields). The intent stays JSON: the core
/// matches on `kind` and reads what each kind needs
/// (`RemoteIntentEnvelope::kind`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIntentEnvelope {
    pub intent_id: String,
    pub intent: Value,
}

impl RemoteIntentEnvelope {
    /// The intent's wire tag, when it has one.
    pub fn kind(&self) -> Option<&str> {
        self.intent.get("kind").and_then(Value::as_str)
    }
}

/// `events.lagged`'s payload. The backend's struct is private to its relay
/// (`EventsLaggedPayload` in `main.rs`), so the shape lives here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsLagged {
    pub skipped: u64,
    pub occurred_at: String,
}

/// One event, as the core sees it.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    /// `backend.ready`: emitted once per connection, after the event filter
    /// is in place, so it marks the start of each connection's events.
    Ready(BackendConnection),
    RecordingStatus(Box<RecordingStatus>),
    SceneChanged(Box<Scene>),
    CompositorStatus(Box<CompositorStatus>),
    PreviewSurfaceStatus(Box<PreviewSurfaceStatus>),
    PreviewFrameReady(Box<CompositorFrameReady>),
    DevicesChanged(Box<DeviceList>),
    HealthEvent(Box<HealthEvent>),
    RecordingFinalization(Box<RecordingFinalizationEvent>),
    EventsLagged(EventsLagged),
    /// `remote.intent`: an admitted remote intent for the core to run and
    /// ack (`crate::remote`).
    RemoteIntent(Box<RemoteIntentEnvelope>),
    /// This client's own queue fell behind and dropped `skipped` events
    /// (a slow subscriber). Like `events.lagged`: read the state again.
    ClientLagged {
        skipped: u64,
    },
    /// The connection ended (`connection.closed` in `backendClient.ts`).
    /// The client reconnects on its own; requests fail until it has.
    ConnectionClosed {
        reason: String,
    },
    /// An event this client does not type: passed on as it arrived.
    Untyped {
        event: String,
        payload: Value,
    },
    /// A typed event whose payload did not fit its type: passed on as it
    /// arrived, with the reason.
    Unreadable {
        event: String,
        payload: Value,
        error: String,
    },
}

impl BackendEvent {
    /// The wire name, or the local name for the client's own events.
    pub fn name(&self) -> &str {
        match self {
            BackendEvent::Ready(_) => names::BACKEND_READY,
            BackendEvent::RecordingStatus(_) => names::RECORDING_STATUS,
            BackendEvent::SceneChanged(_) => names::SCENE_CHANGED,
            BackendEvent::CompositorStatus(_) => names::COMPOSITOR_STATUS,
            BackendEvent::PreviewSurfaceStatus(_) => names::PREVIEW_SURFACE_STATUS,
            BackendEvent::PreviewFrameReady(_) => names::PREVIEW_FRAME_READY,
            BackendEvent::DevicesChanged(_) => names::DEVICES_CHANGED,
            BackendEvent::HealthEvent(_) => names::HEALTH_EVENT,
            BackendEvent::RecordingFinalization(_) => names::RECORDING_FINALIZATION,
            BackendEvent::EventsLagged(_) => names::EVENTS_LAGGED,
            BackendEvent::RemoteIntent(_) => names::REMOTE_INTENT,
            BackendEvent::ClientLagged { .. } => "client.lagged",
            BackendEvent::ConnectionClosed { .. } => "connection.closed",
            BackendEvent::Untyped { event, .. } | BackendEvent::Unreadable { event, .. } => event,
        }
    }

    /// Types one wire event. Never fails: an unknown name is
    /// [`BackendEvent::Untyped`], a payload that does not fit is
    /// [`BackendEvent::Unreadable`].
    pub fn from_wire(event: ServerEvent) -> Self {
        let ServerEvent { event, payload } = event;
        fn typed<T: serde::de::DeserializeOwned>(
            event: String,
            payload: Value,
            wrap: impl FnOnce(T) -> BackendEvent,
        ) -> BackendEvent {
            match T::deserialize(&payload) {
                Ok(value) => wrap(value),
                Err(error) => BackendEvent::Unreadable {
                    event,
                    payload,
                    error: error.to_string(),
                },
            }
        }
        match event.as_str() {
            names::BACKEND_READY => typed(event, payload, BackendEvent::Ready),
            names::RECORDING_STATUS => typed(event, payload, |status| {
                BackendEvent::RecordingStatus(Box::new(status))
            }),
            names::SCENE_CHANGED => typed(event, payload, |scene| {
                BackendEvent::SceneChanged(Box::new(scene))
            }),
            names::COMPOSITOR_STATUS => typed(event, payload, |status| {
                BackendEvent::CompositorStatus(Box::new(status))
            }),
            names::PREVIEW_SURFACE_STATUS => typed(event, payload, |status| {
                BackendEvent::PreviewSurfaceStatus(Box::new(status))
            }),
            names::PREVIEW_FRAME_READY => typed(event, payload, |frame| {
                BackendEvent::PreviewFrameReady(Box::new(frame))
            }),
            names::DEVICES_CHANGED => typed(event, payload, |devices| {
                BackendEvent::DevicesChanged(Box::new(devices))
            }),
            names::HEALTH_EVENT => typed(event, payload, |health| {
                BackendEvent::HealthEvent(Box::new(health))
            }),
            names::RECORDING_FINALIZATION => typed(event, payload, |finalization| {
                BackendEvent::RecordingFinalization(Box::new(finalization))
            }),
            names::EVENTS_LAGGED => typed(event, payload, BackendEvent::EventsLagged),
            names::REMOTE_INTENT => typed(event, payload, |envelope| {
                BackendEvent::RemoteIntent(Box::new(envelope))
            }),
            _ => BackendEvent::Untyped { event, payload },
        }
    }
}

/// Types a wire event and logs what it could not type: an unknown name once
/// per name (`seen` remembers them), every payload that did not fit.
pub fn route_event(
    event: ServerEvent,
    logger: &Logger,
    seen: &mut HashSet<String>,
) -> BackendEvent {
    let typed = BackendEvent::from_wire(event);
    match &typed {
        BackendEvent::Untyped { event, .. } => {
            if seen.insert(event.clone()) {
                logger.info(format!(
                    "Backend event \"{event}\" has no typed shape in this client; passing it on as JSON."
                ));
            }
        }
        BackendEvent::Unreadable { event, error, .. } => {
            logger.warn(format!(
                "Backend event \"{event}\" did not match its type ({error}); passing it on as JSON."
            ));
        }
        _ => {}
    }
    typed
}

/// Which events a connection hears. The backend keeps the filter per socket
/// (`events.setIncluded` / `events.setExcluded`), so the client sends it again
/// on every connection. `backend.ready` always arrives first, before any
/// filter applies.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum EventFilter {
    /// Every event (a fresh socket's default).
    #[default]
    All,
    /// Only these events; an empty list mutes the socket (a command-only
    /// socket, like `loadValidatedPlatformAccountsOnIsolatedClient`).
    Include(Vec<String>),
    /// Every event but these (the Studio mutes `preview.frameReady` while
    /// main presents).
    Exclude(Vec<String>),
}

impl EventFilter {
    pub fn include<I, S>(events: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        EventFilter::Include(events.into_iter().map(Into::into).collect())
    }

    pub fn exclude<I, S>(events: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        EventFilter::Exclude(events.into_iter().map(Into::into).collect())
    }

    /// Whether the backend lets `event` through this filter (it applies the
    /// same rule in `ConnectionEventFilter::allows`).
    pub fn allows(&self, event: &str) -> bool {
        match self {
            EventFilter::All => true,
            EventFilter::Include(events) => events.iter().any(|name| name == event),
            EventFilter::Exclude(events) => !events.iter().any(|name| name == event),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire(event: &str, payload: Value) -> ServerEvent {
        ServerEvent {
            event: event.to_string(),
            payload,
        }
    }

    #[test]
    fn an_unknown_event_is_logged_once_and_passed_on() {
        let logger = Logger::silent();
        let mut seen = HashSet::new();
        let first = route_event(wire("totally.new", json!({"a": 1})), &logger, &mut seen);
        match &first {
            BackendEvent::Untyped { event, payload } => {
                assert_eq!(event, "totally.new");
                assert_eq!(payload["a"], 1);
            }
            other => panic!("expected Untyped, got {other:?}"),
        }
        let _ = route_event(wire("totally.new", json!(null)), &logger, &mut seen);
        let lines: Vec<_> = logger
            .recent()
            .into_iter()
            .filter(|line| line.message.contains("totally.new"))
            .collect();
        assert_eq!(lines.len(), 1, "logged once per name: {lines:?}");
        assert_eq!(first.name(), "totally.new");
    }

    #[test]
    fn a_typed_event_that_does_not_fit_is_logged_and_passed_on() {
        let logger = Logger::silent();
        let mut seen = HashSet::new();
        let event = route_event(
            wire(names::RECORDING_STATUS, json!({"state": "levitating"})),
            &logger,
            &mut seen,
        );
        let BackendEvent::Unreadable {
            event,
            payload,
            error,
        } = event
        else {
            panic!("expected Unreadable");
        };
        assert_eq!(event, names::RECORDING_STATUS);
        assert_eq!(payload["state"], "levitating");
        assert!(error.contains("levitating"), "{error}");
        assert!(
            logger
                .recent()
                .iter()
                .any(|line| line.message.contains("did not match its type"))
        );

        // The next good one types as usual.
        let good = route_event(
            wire(names::RECORDING_STATUS, json!({"state": "idle"})),
            &logger,
            &mut seen,
        );
        assert!(matches!(good, BackendEvent::RecordingStatus(_)));
    }

    #[test]
    fn known_events_type_from_their_wire_shape() {
        let ready = BackendEvent::from_wire(wire(
            names::BACKEND_READY,
            json!({"host": "127.0.0.1", "port": 50123, "token": "t", "pid": 42, "parentPid": 41}),
        ));
        let BackendEvent::Ready(connection) = ready else {
            panic!("expected Ready");
        };
        assert_eq!(connection.port, 50123);
        assert_eq!(connection.parent_pid, Some(41));

        let lagged = BackendEvent::from_wire(wire(
            names::EVENTS_LAGGED,
            json!({"skipped": 7, "occurredAt": "2026-11-08T00:00:00Z"}),
        ));
        assert!(matches!(
            lagged,
            BackendEvent::EventsLagged(EventsLagged { skipped: 7, .. })
        ));

        let frame = BackendEvent::from_wire(wire(
            names::PREVIEW_FRAME_READY,
            json!({
                "targetFps": 60, "width": 1920, "height": 1080, "runId": "r",
                "sceneRevision": 2, "frameSceneRevision": 2, "framesRendered": 9,
                "metalTargetIosurfaceId": 77, "updatedAt": "now"
            }),
        ));
        let BackendEvent::PreviewFrameReady(frame) = frame else {
            panic!("expected PreviewFrameReady");
        };
        assert_eq!(frame.metal_target_iosurface_id, Some(77));
    }

    #[test]
    fn the_studio_events_type_from_their_wire_shape() {
        let devices = BackendEvent::from_wire(wire(
            names::DEVICES_CHANGED,
            json!({
                "devices": [{
                    "id": "camera:1", "name": "FaceTime HD Camera", "kind": "camera",
                    "status": "available", "width": 1920, "height": 1080
                }],
                "warnings": ["Screen recording permission is required."]
            }),
        ));
        let BackendEvent::DevicesChanged(devices) = devices else {
            panic!("expected DevicesChanged");
        };
        assert_eq!(devices.devices.len(), 1);
        assert_eq!(devices.devices[0].width, Some(1920));
        assert_eq!(devices.warnings.len(), 1);

        let health = BackendEvent::from_wire(wire(
            names::HEALTH_EVENT,
            json!({
                "id": "h1", "sessionId": "s1", "level": "warn",
                "code": "recording-stop-finalize-overrun",
                "message": "Still finishing the recording.", "permissionPane": null,
                "createdAt": "2026-11-08T00:00:00Z"
            }),
        ));
        let BackendEvent::HealthEvent(health) = health else {
            panic!("expected HealthEvent");
        };
        assert_eq!(health.code, "recording-stop-finalize-overrun");

        let finalization = BackendEvent::from_wire(wire(
            names::RECORDING_FINALIZATION,
            json!({
                "sessionId": "s1", "state": "finalized", "mp4Path": "/tmp/a.mp4",
                "updatedAt": "2026-11-08T00:00:00Z"
            }),
        ));
        let BackendEvent::RecordingFinalization(finalization) = finalization else {
            panic!("expected RecordingFinalization");
        };
        assert_eq!(finalization.mp4_path.as_deref(), Some("/tmp/a.mp4"));
    }

    #[test]
    fn the_filter_mirrors_the_backend_rule() {
        assert!(EventFilter::All.allows("anything"));
        let include = EventFilter::include([names::RECORDING_STATUS]);
        assert!(include.allows(names::RECORDING_STATUS));
        assert!(!include.allows(names::SCENE_CHANGED));
        assert!(!EventFilter::include(Vec::<String>::new()).allows("x"));
        let exclude = EventFilter::exclude([names::PREVIEW_FRAME_READY]);
        assert!(!exclude.allows(names::PREVIEW_FRAME_READY));
        assert!(exclude.allows(names::COMPOSITOR_STATUS));
    }
}
