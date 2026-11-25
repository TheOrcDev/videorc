//! Talk-show room host (`talk-show-room-host.tsx`; P395–P399). Draws
//! nothing: it watches the cloud recording for the Library and tracks the
//! host identity so Videorc Camera can retire with the room (P399).
//!
//! Plan 260 S1.8 (L1): the backend holds this app's room
//! (`VIDEORC_ROOM_HOST=backend`), so the host does what the renderer's
//! `use-talk-show-room.ts` does for a backend that holds the seat: while
//! the room is open it sends the Sources microphone and camera
//! (`cloud.room.microphone.set`, `cloud.room.camera.set`) and the HTML
//! sheet's switch, held after a takeover from another device until the
//! streamer turns the devices on (plan 249 S24); and it keeps what the room
//! publishes and who is in it (`cloud.room.presentation`'s media) for the
//! Show stage, the guest tiles and the Program monitor ([`Self::room_media`]).
//! The join chime and the scripted smoke room (P396, P398) wait.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, Window, div, prelude::*};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use videorc_app_core::BackendEvent;
use videorc_app_core::guests::session::ControllerFacts;
use videorc_app_core::library::cloud::{CloudRecordingStop, CloudRecordingWatch};
use videorc_app_core::studio::room_media::{
    self, CAMERA_SET, HTML_SET, MICROPHONE_SET, PRESENTATION_EVENT, RoomMedia,
};
use videorc_app_core::studio::screen_views::TalkShowRoomView;

use super::transport::AppStudio;
use crate::app::bridge::Mirror;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Mounted once under Studio. Returns no chrome (P395).
pub struct TalkShowRoomHost {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    recording_watch: CloudRecordingWatch,
    last_host_identity: Option<String>,
    last_recording_active: bool,
    /// What the backend's room publishes and who is in it, for the open
    /// room's show (S1.8; `None` until it says, and after the room closes).
    room_media: Option<RoomMedia>,
    /// The takeover hold the streamer last turned the devices on for.
    enabled_epoch: u64,
    /// The params last sent (microphone, camera, sheet), so a repeat sends
    /// nothing; cleared when the room closes (the backend lets go).
    sent: [Option<Value>; 3],
}

impl TalkShowRoomHost {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |host, mirror, cx| {
            let view = mirror.read(cx).value().clone();
            host.on_talk_show(&view);
            host.sync_room(cx);
            cx.notify();
        })
        .detach();
        // The Sources microphone and camera, and the controller, change on
        // the Studio's snapshots and its cloud state.
        let snapshots = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut watch = snapshots.watch();
            while watch.changed().await.is_ok() {
                if this.update(cx, |host, cx| host.sync_room(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let clouds = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut watch = clouds.cloud();
            while watch.changed().await.is_ok() {
                if this.update(cx, |host, cx| host.sync_room(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        // What the backend's room publishes and who is in it.
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                };
                let BackendEvent::Untyped { event, payload } = event else {
                    continue;
                };
                if event != PRESENTATION_EVENT {
                    continue;
                }
                let Some((_, media)) = room_media::presentation_media(&payload) else {
                    continue;
                };
                let alive = this.update(cx, |host, cx| {
                    if host.room_open() && host.room_media.as_ref() != Some(&media) {
                        host.room_media = Some(media);
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        let initial = talk_show.read(cx).value().clone();
        let mut host = Self {
            studio,
            runtime,
            talk_show,
            recording_watch: CloudRecordingWatch::default(),
            last_host_identity: None,
            last_recording_active: false,
            room_media: None,
            enabled_epoch: 0,
            sent: [None, None, None],
        };
        host.on_talk_show(&initial);
        host
    }

    fn room_open(&self) -> bool {
        self.studio
            .cloud_now()
            .status
            .as_ref()
            .and_then(|status| status.room.as_ref())
            .and_then(|room| room.get("phase"))
            .and_then(Value::as_str)
            == Some("open")
    }

    fn controller(&self) -> Option<ControllerFacts> {
        let status = self.studio.cloud_now().status?;
        serde_json::from_value(status.controller?).ok()
    }

    /// What the backend's room publishes and who is in it, while the room
    /// is open: the Show stage's people and the Program monitor read it.
    pub fn room_media(&self) -> Option<&RoomMedia> {
        self.room_media.as_ref()
    }

    /// The devices are held after a takeover from another device (plan 249
    /// S24): nothing captures here until the streamer turns them on.
    pub fn devices_held(&self) -> bool {
        room_media::devices_held(self.controller().as_ref(), self.enabled_epoch)
    }

    /// The streamer turns this computer's devices on after a takeover (the
    /// cloud-controller notice's Continue): the microphone, camera and sheet
    /// go to the room.
    pub fn enable_devices(&mut self, cx: &mut Context<Self>) {
        self.enabled_epoch = room_media::device_hold_epoch(self.controller().as_ref());
        self.sync_room(cx);
        cx.notify();
    }

    /// While the room is open, the microphone, camera and sheet the backend's
    /// room publishes follow the Studio (each sent once per change). The
    /// backend answers `held: false` while it doesn't hold the seat, and
    /// lets every device go when the room ends.
    fn sync_room(&mut self, cx: &mut Context<Self>) {
        if !self.room_open() {
            self.sent = [None, None, None];
            if self.room_media.take().is_some() {
                cx.notify();
            }
            return;
        }
        let held = self.devices_held();
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture;
        let wanted = [
            (
                MICROPHONE_SET,
                room_media::microphone_params(
                    capture.sources.microphone_id.as_deref(),
                    &capture.audio,
                    held,
                ),
            ),
            (
                CAMERA_SET,
                room_media::camera_params(
                    capture.sources.camera_id.as_deref(),
                    capture.layout.source_visibility.camera,
                    held,
                ),
            ),
            (HTML_SET, room_media::html_params(held)),
        ];
        for (slot, (method, params)) in wanted.into_iter().enumerate() {
            if self.sent[slot].as_ref() == Some(&params) {
                continue;
            }
            self.sent[slot] = Some(params.clone());
            let studio = self.studio.clone();
            self.runtime.spawn(async move {
                if let Err(error) = studio.backend().request(method, params).await {
                    eprintln!("[videorc-app] Talk-show host: {method}: {error}");
                }
            });
        }
    }

    fn on_talk_show(&mut self, view: &TalkShowRoomView) {
        // P397: cloud recording watch → Library waits for the take's row.
        let active = view.recording;
        let since = view.recording_since.as_deref();
        if active != self.last_recording_active || active {
            let stopped = self.recording_watch.note(active, since, now_ms());
            self.last_recording_active = active;
            if stopped {
                eprintln!("[videorc-app] Talk-show host: cloud recording stopped (Library watch)");
            }
        }

        // P399: Videorc Camera retire when the host identity changes. The
        // RoomProgramCamera store + backend upload IO land with the room
        // transport; until then we only track the identity so a later
        // wiring can call `retire` on the same transitions.
        let host_identity = view.host_identity.clone();
        if host_identity != self.last_host_identity {
            if self.last_host_identity.is_some() || host_identity.is_some() {
                eprintln!(
                    "[videorc-app] Talk-show host: Videorc Camera retire for {:?}",
                    host_identity
                );
            }
            self.last_host_identity = host_identity;
        }

        // P396 join-request chime and P398 scripted room wait for the
        // LiveKit controller and the smoke bridge.
    }

    /// The last cloud recording stop this host saw (Library).
    pub fn last_recording_stop(&self) -> Option<CloudRecordingStop> {
        self.recording_watch.last_stop()
    }
}

impl Render for TalkShowRoomHost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        // P395: no UI.
        div().id("talk-show-room-host").invisible()
    }
}
