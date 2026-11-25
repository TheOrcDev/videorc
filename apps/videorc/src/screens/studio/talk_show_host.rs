//! Talk-show room host (`talk-show-room-host.tsx`; P395–P399). Draws
//! nothing: it watches the cloud recording for the Library and tracks the
//! host identity so Videorc Camera can retire with the room (P399). The
//! LiveKit room controller (setLayout, tracks, join chime, scripted smoke
//! room) lands with S1.8; until then Guests and Show stage read cloud room
//! state directly.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, Window, div, prelude::*};
use videorc_app_core::library::cloud::{CloudRecordingStop, CloudRecordingWatch};
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
    #[allow(dead_code)]
    studio: Arc<AppStudio>,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    recording_watch: CloudRecordingWatch,
    last_host_identity: Option<String>,
    last_recording_active: bool,
}

impl TalkShowRoomHost {
    pub fn new(
        studio: Arc<AppStudio>,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |host, mirror, cx| {
            let view = mirror.read(cx).value().clone();
            host.on_talk_show(&view);
            cx.notify();
        })
        .detach();
        let initial = talk_show.read(cx).value().clone();
        let mut host = Self {
            studio,
            talk_show,
            recording_watch: CloudRecordingWatch::default(),
            last_host_identity: None,
            last_recording_active: false,
        };
        host.on_talk_show(&initial);
        host
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
