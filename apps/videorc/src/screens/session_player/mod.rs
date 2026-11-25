//! The recording player, for any page (plan 260, L4): Electron's
//! `SessionMarkersDialog` and `SessionPlayer`.
//!
//! - [`Mode::Dialog`] is the Library's recording dialog: the picture, the
//!   controls, the marker pins, the session's saved markers (rename, delete
//!   with Undo), Open in default player and Reveal. Sidekick's Reports opens
//!   the same dialog on its report's session (P1219, [`Player::open_session`]).
//! - [`Mode::Embedded`] is the bare player in the host's own layout: the
//!   picture, its status and the controls, no dialog and no markers list.
//!   The host drives it without owning its focus (`SessionPlayerHandle`:
//!   [`Player::toggle_playback`], [`Player::seek_to`], [`Player::seek_by`]),
//!   gives it ranges to jump over while playing ([`Player::set_skip_ranges`],
//!   the Clean cut review's "Preview the cut") and hears the playhead
//!   ([`PlayheadMoved`], `onTimeUpdate`).
//!
//! A page makes one with [`hosted`], from the services the Library installs
//! ([`Services`]); it calls [`Player::close`] when it stops showing it.
//!
//! Recording playback owns a distinct presenter/feed. No live-preview
//! surface or capture scene is borrowed by the player.
mod markers;
mod native;
mod render;

use crate::screens::library::{Core, files::Files};
use gpui::{Context, Entity, FocusHandle, Focusable, Window, prelude::*};
use std::sync::Arc;
use videorc_app_core::buddy::clean_cut_review::{Span, normalize_skip_ranges, skip_target_ms};
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

/// How a page hosts the player.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// The recording dialog with the session's markers (the Library's).
    #[default]
    Dialog,
    /// The bare player in the host's layout.
    Embedded,
}

/// The playhead moved, in ms (`onTimeUpdate`), while a recording is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayheadMoved(pub u64);

impl gpui::EventEmitter<PlayheadMoved> for Player {}

/// What a player needs, installed by the Library for every page.
#[derive(Clone)]
pub struct Services {
    pub core: Arc<Core>,
    pub files: Arc<Files>,
    pub studio: Arc<Studio<BackendClient>>,
    pub runtime: tokio::runtime::Handle,
    pub logger: Logger,
}

impl gpui::Global for Services {}

/// A player for any page, in `mode`; `None` before the Library installed
/// its services.
pub fn hosted(mode: Mode, window: &mut Window, cx: &mut gpui::App) -> Option<Entity<Player>> {
    let services = cx.try_global::<Services>()?.clone();
    Some(cx.new(|cx| {
        Player::new(
            services.core,
            services.files,
            services.studio,
            services.runtime,
            services.logger,
            window,
            cx,
        )
        .with_mode(mode)
    }))
}

pub struct Player {
    mode: Mode,
    /// Removed spans to jump over while playing, normalized.
    skip: Vec<Span>,
    /// The skip already asked for, so one range seeks once.
    skipping_to: Option<u64>,
    /// The playhead last reported to the host.
    reported_ms: Option<u64>,
    /// The picture's height in the host's layout.
    slot_height: f32,
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
    native: Option<native::Native>,
    /// The slot the layer was last placed in (the player's own points), for
    /// the smokes' geometry read.
    smoke_slot: Option<gpui::Bounds<gpui::Pixels>>,
}

/// The live players, for the smoke driver's `session-player-geometry`.
#[derive(Default)]
pub struct SmokePlayers(pub Vec<gpui::WeakEntity<Player>>);

impl gpui::Global for SmokePlayers {}

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
        {
            let weak = cx.weak_entity();
            let players = cx.default_global::<SmokePlayers>();
            players.0.retain(|player| player.upgrade().is_some());
            players.0.push(weak);
        }
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
            mode: Mode::Dialog,
            skip: Vec::new(),
            skipping_to: None,
            reported_ms: None,
            slot_height: 300.,
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
            native: None,
            smoke_slot: None,
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
        self.markers = (self.mode == Mode::Dialog).then(|| MarkersState::open(session));
        self.skipping_to = None;
        self.reported_ms = None;
        self.scrub = None;
        self.error = None;
        self.active = true;
        let playable = session.status != "running"
            && (session.mp4_path.is_some() || session.output_path.is_some());
        self.playable = playable;
        self.need_open = playable;
        self.resume = resume;
        if playable {
            if self.native.is_none() {
                if let Err(error) = self.start_native(window, cx) {
                    self.error = Some(error);
                    self.need_open = false;
                }
            }
            self.open_native();
        }
        if self.mode == Mode::Dialog {
            self.dialog.open(window, cx);
            self.load_markers(false, cx);
            cx.on_next_frame(window, |this, window, cx| this.focus.focus(window, cx));
        }
        cx.notify();
    }
    /// Opens the session the Library lists under `session_id` (Sidekick's
    /// Reports: the report's stream). `false` when the Library has no such
    /// session.
    pub fn open_session(
        &mut self,
        session_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let session = self
            .core
            .data()
            .sessions
            .into_iter()
            .find(|session| session.id == session_id);
        match session {
            Some(session) => {
                self.open(&session, window, cx);
                true
            }
            None => false,
        }
    }
    /// How this player is hosted.
    pub fn with_mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }
    /// The picture's height in the host's layout (300 px by default).
    pub fn set_slot_height(&mut self, height: f32, cx: &mut Context<Self>) {
        self.slot_height = height;
        cx.notify();
    }
    /// Ranges to jump over while playing (`skipRanges`), in any order;
    /// overlaps merge. Empty plays everything.
    pub fn set_skip_ranges(&mut self, ranges: &[Span]) {
        self.skip = normalize_skip_ranges(ranges, None);
        self.skipping_to = None;
    }
    /// `togglePlayback`: play or pause, once the recording is ready.
    pub fn toggle_playback(&self) {
        self.toggle();
    }
    /// `seekTo`: clamped to the recording.
    pub fn seek_to(&self, ms: f64) {
        self.seek(ms);
    }
    /// `seekBy`: from the playhead.
    pub fn seek_by(&self, delta_ms: f64) {
        self.seek(self.status.position_ms as f64 + delta_ms);
    }
    pub fn position_ms(&self) -> u64 {
        self.status.position_ms
    }
    pub fn duration_ms(&self) -> u64 {
        self.status.duration_ms
    }
    pub fn is_playing(&self) -> bool {
        self.status.state == PlaybackState::Playing
    }
    /// Stops playback (the host stopped showing the player).
    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
    }
    /// After each new status: the playhead to the host, and the jump over a
    /// removed span while playing (`applySkip`).
    fn after_status(&mut self, cx: &mut Context<Self>) {
        if !self.ready() {
            return;
        }
        let position = self.status.position_ms;
        if self.reported_ms != Some(position) {
            self.reported_ms = Some(position);
            cx.emit(PlayheadMoved(position));
        }
        if self.status.state != PlaybackState::Playing || self.skip.is_empty() {
            self.skipping_to = None;
            return;
        }
        match skip_target_ms(&self.skip, position as f64, 0.) {
            Some(target) if self.skipping_to != Some(target) => {
                self.skipping_to = Some(target);
                if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
                    element.seek(target.min(self.status.duration_ms));
                }
            }
            Some(_) => {}
            None => self.skipping_to = None,
        }
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
        if let Some(element) = self.native.as_ref().and_then(|n| n.element.as_ref()) {
            element.seek(p::clamp_seek_ms(ms, self.status.duration_ms as f64).round() as u64);
        }
    }
    fn toggle(&self) {
        if !self.ready() {
            return;
        }
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
        if self.playable && self.native.is_none() {
            if self.start_native(window, cx).is_err() {
                self.error = Some("Playback isn't available in this window.".into());
                return;
            }
        }
        self.error = None;
        self.open_native();
        cx.notify();
    }
    fn external(&mut self, reveal: bool, cx: &mut Context<Self>) {
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
        {
            self.native.take();
        }
    }
}

impl Player {
    /// `session-player-open {sessionId}`: the Library's Markers item, as the
    /// smoke asks for it (the ⋯ menu's items aren't in the accessibility tree
    /// for the UI driver yet): the recording opens in this player. False when
    /// the Library has no such recording.
    pub fn smoke_open(
        &mut self,
        session_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(session) = self
            .core
            .data()
            .sessions
            .into_iter()
            .find(|row| row.id == session_id)
        else {
            return false;
        };
        self.open(&session, window, cx);
        true
    }

    /// Whether this is the Library's dialog player (the one Markers opens).
    pub fn smoke_is_dialog(&self) -> bool {
        self.mode == Mode::Dialog
    }

    /// `session-player-geometry`: where the player's layer is. On macOS the
    /// rect the app set, the rect Core Animation displays, and the slot,
    /// which must agree as the live preview's do (`probe:preview-window`).
    pub fn smoke_geometry(&self) -> serde_json::Value {
        let rect = |rect: videorc_preview::LayerRect| serde_json::json!({ "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height });
        #[cfg(target_os = "macos")]
        let (set, shown) = self
            .native
            .as_ref()
            .and_then(|native| native.element.as_ref())
            .map(|element| {
                (
                    element.frame().map(rect),
                    element.displayed_frame().map(rect),
                )
            })
            .unwrap_or((None, None));
        #[cfg(not(target_os = "macos"))]
        let (set, shown): (Option<serde_json::Value>, Option<serde_json::Value>) = {
            let _ = rect;
            (None, None)
        };
        serde_json::json!({
            "mode": match self.mode {
                Mode::Dialog => "dialog",
                Mode::Embedded => "embedded",
            },
            "active": self.active,
            "open": self.session.is_some(),
            "layerFrame": set,
            "displayedFrame": shown,
            "slot": self.smoke_slot.map(|slot| serde_json::json!({
                "x": f32::from(slot.origin.x),
                "y": f32::from(slot.origin.y),
                "width": f32::from(slot.size.width),
                "height": f32::from(slot.size.height),
            })),
        })
    }
}
