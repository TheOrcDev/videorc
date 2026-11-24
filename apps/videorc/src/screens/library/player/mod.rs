//! Recording playback owns a distinct presenter/feed. No live-preview
//! surface or capture scene is borrowed by the Library player.
mod markers;
#[cfg(target_os = "macos")]
mod native;
mod render;

use super::{Core, files::Files};
use gpui::{Context, Entity, FocusHandle, Focusable, Window, prelude::*};
use std::sync::Arc;
use videorc_app_core::library::{markers::MarkersState, player as p};
use videorc_app_core::{BackendClient, Logger, Studio};
use videorc_kit::{
    command::InputEvent,
    dialog::DialogHandle,
    input::InputState,
    slider::{SliderEvent, SliderState, SliderValue},
};
use videorc_protocol::{
    SessionListItem,
    playback::{PlaybackState, PlaybackStatus},
};

pub struct Player {
    core: Arc<Core>,
    files: Arc<Files>,
    studio: Arc<Studio<BackendClient>>,
    runtime: tokio::runtime::Handle,
    logger: Logger,
    dialog: DialogHandle,
    focus: FocusHandle,
    active: bool,
    playable: bool,
    session: Option<p::PlayerSession>,
    markers: Option<MarkersState>,
    slider: Entity<SliderState>,
    input: Entity<InputState>,
    scrub: Option<f64>,
    status: PlaybackStatus,
    connected: bool,
    error: Option<String>,
    resume: Option<p::Resume>,
    resume_in_flight: Option<p::Resume>,
    desired_muted: bool,
    opening_from: Option<String>,
    need_open: bool,
    marker_epoch: u64,
    deleting: std::collections::BTreeMap<String, std::rc::Rc<std::cell::Cell<bool>>>,
    delete_flushes: std::collections::BTreeMap<String, std::rc::Rc<dyn Fn(&mut gpui::App)>>,
    #[cfg(target_os = "macos")]
    native: Option<native::Native>,
}
impl Player {
    pub fn new(
        core: Arc<Core>,
        files: Arc<Files>,
        studio: Arc<Studio<BackendClient>>,
        runtime: tokio::runtime::Handle,
        logger: Logger,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // A percentage slider keeps one entity throughout the recording;
        // backend milliseconds are converted at the input/output boundary.
        let slider = cx.new(|_| SliderState::new().min(0.).max(100.).step(0.01));
        let input = cx.new(|cx| InputState::new(window, cx));
        cx.subscribe_in(&slider, window, |this, _, event: &SliderEvent, _, cx| {
            let (SliderEvent::Change(SliderValue::Single(value))
            | SliderEvent::Release(SliderValue::Single(value))) = event
            else {
                return;
            };
            if !this.active || !this.ready() {
                return;
            }
            let ms = f64::from(*value) / 100. * this.status.duration_ms as f64;
            match event {
                SliderEvent::Change(_) => this.scrub = Some(ms),
                SliderEvent::Release(_) => {
                    this.scrub = None;
                    this.seek(ms);
                }
            }
            cx.notify();
        })
        .detach();
        cx.subscribe_in(&input, window, |this, _, event: &InputEvent, _, cx| {
            if let Some(markers) = this.markers.as_mut() {
                if matches!(event, InputEvent::Change) {
                    markers.draft = this.input.read(cx).value().to_string();
                }
            }
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.rename_marker(cx);
            }
            cx.notify();
        })
        .detach();
        let mut data = core.watch();
        cx.spawn(async move |entity, cx| {
            let mut revision = None;
            while data.changed().await.is_ok() {
                let changes = data.borrow_and_update().marker_changes.clone();
                if entity
                    .update(cx, |this, cx| {
                        let next = this.markers.as_ref().map(|m| {
                            (
                                m.session_id.clone(),
                                changes.get(&m.session_id).copied().unwrap_or(0),
                            )
                        });
                        if revision != next {
                            revision = next;
                            if this.active {
                                this.load_markers(false, cx);
                            }
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.on_release(|this, cx| this.flush_deletes(cx)).detach();
        cx.on_app_quit(move |this, cx| {
            this.stop(cx);
            async {}
        })
        .detach();
        Self {
            core,
            files,
            studio,
            runtime,
            logger,
            dialog: DialogHandle::new(false),
            focus: cx.focus_handle(),
            active: false,
            playable: false,
            session: None,
            markers: None,
            slider,
            input,
            scrub: None,
            status: PlaybackStatus::closed(String::new()),
            connected: false,
            error: None,
            resume: None,
            resume_in_flight: None,
            desired_muted: false,
            opening_from: None,
            need_open: false,
            marker_epoch: 0,
            deleting: Default::default(),
            delete_flushes: Default::default(),
            #[cfg(target_os = "macos")]
            native: None,
        }
    }
    pub fn open(&mut self, session: &SessionListItem, window: &mut Window, cx: &mut Context<Self>) {
        self.stop_playback(cx);
        self.status = PlaybackStatus::closed(String::new());
        self.marker_epoch += 1;
        let same = self
            .session
            .as_ref()
            .is_some_and(|p| p.session_id == session.id);
        let resume = if same {
            self.session.as_mut().map(p::PlayerSession::retry)
        } else {
            None
        };
        if !same {
            self.desired_muted = false;
            self.session = Some(p::PlayerSession::new(session.id.clone()));
        }
        self.markers = Some(MarkersState::open(session));
        self.scrub = None;
        self.error = None;
        self.active = true;
        let playable = session.status != "running"
            && (session.mp4_path.is_some() || session.output_path.is_some());
        self.playable = playable;
        self.need_open = playable;
        self.resume = resume;
        #[cfg(target_os = "macos")]
        if playable {
            if self.native.is_none() {
                if let Err(error) = self.start_native(window, cx) {
                    self.error = Some(error);
                    self.need_open = false;
                }
            }
            self.open_native();
        }
        self.dialog.open(window, cx);
        self.load_markers(false, cx);
        cx.on_next_frame(window, |this, window, cx| this.focus.focus(window, cx));
        cx.notify();
    }
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.stop_playback(cx);
        self.dialog.close(window, cx);
    }
    fn stop_playback(&mut self, cx: &mut Context<Self>) {
        if !self.active {
            return;
        }
        self.active = false;
        self.flush_deletes(cx);
        self.need_open = false;
        self.resume = None;
        self.resume_in_flight = None;
        self.scrub = None;
        #[cfg(target_os = "macos")]
        if let Some(native) = &mut self.native {
            if let Some(element) = &mut native.element {
                element.set_visible(false);
                element.pause();
                element.close();
            }
        }
        cx.notify();
    }
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
        #[cfg(target_os = "macos")]
        {
            self.native.take();
        }
    }
    fn ready(&self) -> bool {
        self.active
            && self.playable
            && self.connected
            && matches!(
                self.status.state,
                PlaybackState::Paused | PlaybackState::Playing | PlaybackState::Ended
            )
            && self.status.duration_ms > 0
    }
    fn seek(&self, ms: f64) {
        if !self.ready() {
            return;
        }
        #[cfg(target_os = "macos")]
        if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
            element.seek(p::clamp_seek_ms(ms, self.status.duration_ms as f64).round() as u64);
        }
    }
    fn toggle(&self) {
        if !self.ready() {
            return;
        }
        #[cfg(target_os = "macos")]
        if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
            if self.status.state == PlaybackState::Playing {
                element.pause();
            } else {
                element.play();
            }
        }
    }
    fn mute(&mut self) {
        if !self.ready() {
            return;
        }
        self.desired_muted = !self.status.muted;
        #[cfg(target_os = "macos")]
        if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
            element.set_muted(self.desired_muted);
        }
    }
    fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.active {
            return;
        }
        self.resume = self.session.as_mut().map(p::PlayerSession::retry);
        self.need_open = self.playable;
        #[cfg(target_os = "macos")]
        if self.playable && self.native.is_none() {
            if self.start_native(window, cx).is_err() {
                self.error = Some("Playback isn't available in this window.".into());
                return;
            }
        }
        self.error = None;
        #[cfg(target_os = "macos")]
        self.open_native();
        cx.notify();
    }
    fn external(&mut self, reveal: bool, cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        if !reveal {
            if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
                element.pause();
            }
        }

        let Some(session) = &self.session else {
            return;
        };
        let id = session.session_id.clone();
        let files = self.files.clone();
        let job = self.runtime.spawn(async move { files.path(&id).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                match result {
                    Ok(Ok(path)) => {
                        if reveal {
                            cx.reveal_path(&path)
                        } else {
                            cx.open_with_system(&path)
                        }
                    }
                    _ => this.error = Some("Couldn't open the recording.".into()),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            self.native.take();
        }
    }
}
