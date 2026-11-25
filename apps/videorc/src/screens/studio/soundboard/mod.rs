//! Studio → Soundboard (`soundboard-section.tsx`, plan 189 / parity P340–P350):
//! the pads under Scenes, room sounds while the talk-show room is open, and
//! keys 1–9. Words and helpers live in `videorc_app_core::soundboard`; this
//! module draws them and talks to the backend. Pad chrome is kit
//! `SoundPad` / `SoundPadGrid`.

mod pads;
mod room;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use gpui::{Context, Entity, EventEmitter, KeyDownEvent, KeyUpEvent, Window, div, prelude::*};
use serde_json::json;
use tokio::sync::watch;
use videorc_app_core::BackendEvent;
use videorc_app_core::nav::PageId;
use videorc_app_core::protocol::{Sound, SoundMode, SoundVoice, SoundboardState, SoundsPlayback};
use videorc_app_core::soundboard::{
    self, RoomAudioRouting, RoomAux, SystemAudio, copy as words, description, sound_for_key,
    sound_key_digit, voice_by_sound,
};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::studio::scenes_section::session_active;
use videorc_app_core::studio::screen_views::TalkShowRoomView;
use videorc_app_core::studio::{Connection, StudioSnapshot, connection_blocked_reason};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::transport::{AppStudio, OpenPage};
use crate::app::bridge::Mirror;

/// Backend events this section follows; `main.rs` adds them to the filter.
pub const EVENTS: [&str; 2] = ["sounds.changed", "sounds.playback"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoardState {
    Loading,
    Ready,
    Failed,
}

/// Studio Soundboard section under the Scenes gallery (P273 order).
pub struct SoundboardSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    connected: bool,
    disconnected: Option<&'static str>,
    session_active: bool,
    board: Option<SoundboardState>,
    board_state: BoardState,
    voices: Vec<SoundVoice>,
    session_without_sounds: bool,
    load_epoch: u64,
    load_failures: usize,
    /// Keys held for While held pads (`useSoundKeys`).
    held: HashMap<String, String>,
    room_aux: Option<RoomAux>,
    room_routing: RoomAudioRouting,
    room_sliders: room::RoomSliders,
    /// Cancels a stale progress-notify loop when playback changes.
    progress_epoch: u64,
}

impl EventEmitter<OpenPage> for SoundboardSection {}

impl SoundboardSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |section, talk, cx| {
            let open = talk.read(cx).value().open;
            section.on_room_open(open, cx);
        })
        .detach();
        let initial = snapshot.borrow().clone();
        cx.spawn(async move |this, cx| {
            loop {
                if snapshot.changed().await.is_err() {
                    break;
                }
                let snap = snapshot.borrow_and_update().clone();
                if this
                    .update(cx, |section, cx| section.apply_snapshot(&snap, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |this, cx| {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if this
                    .update(cx, |section, cx| section.on_event(event, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let room_sliders = room::RoomSliders::new(cx);
        room::subscribe(&room_sliders, cx);

        let mut section = Self {
            studio,
            runtime,
            talk_show,
            connected: false,
            disconnected: None,
            session_active: false,
            board: None,
            board_state: BoardState::Loading,
            voices: Vec::new(),
            session_without_sounds: false,
            load_epoch: 0,
            load_failures: 0,
            held: HashMap::new(),
            room_aux: None,
            room_routing: RoomAudioRouting::default(),
            room_sliders,
            progress_epoch: 0,
        };
        section.apply_snapshot(&initial, cx);
        let open = section.talk_show.read(cx).value().open;
        section.on_room_open(open, cx);
        section
    }

    fn apply_snapshot(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        let disconnected = connection_blocked_reason(&snapshot.connection);
        let session = session_active(snapshot);
        let mut dirty = false;
        if self.connected != connected {
            self.connected = connected;
            dirty = true;
            if connected {
                self.load_failures = 0;
                self.refresh(cx);
            } else {
                self.board_state = BoardState::Loading;
                self.voices.clear();
                self.session_without_sounds = false;
                self.kick_progress_tick(cx);
            }
        }
        if self.disconnected != disconnected {
            self.disconnected = disconnected;
            dirty = true;
        }
        if self.session_active != session {
            self.session_active = session;
            dirty = true;
        }
        if dirty {
            cx.notify();
        }
    }

    fn on_room_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if open {
            if self.room_aux.is_none() {
                self.room_aux = Some(RoomAux::closed_room_default());
                self.room_routing = RoomAudioRouting::default();
                self.push_aux(cx);
            }
        } else if self.room_aux.take().is_some() {
            self.room_routing = RoomAudioRouting::default();
        }
        cx.notify();
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        match event {
            BackendEvent::Untyped { event, payload } if event == "sounds.changed" => {
                if let Ok(board) = serde_json::from_value::<SoundboardState>(payload) {
                    self.board = Some(board);
                    self.board_state = BoardState::Ready;
                    self.load_failures = 0;
                    cx.notify();
                }
            }
            BackendEvent::Untyped { event, payload } if event == "sounds.playback" => {
                if let Ok(playback) = serde_json::from_value::<SoundsPlayback>(payload) {
                    self.voices = playback.voices;
                    self.session_without_sounds = playback.session_without_sounds;
                    self.kick_progress_tick(cx);
                    cx.notify();
                }
            }
            _ => {}
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.connected {
            return;
        }
        self.load_epoch = self.load_epoch.wrapping_add(1);
        let epoch = self.load_epoch;
        self.board_state = BoardState::Loading;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move { studio.backend().sounds_list().await })
                .await;
            let _ = this.update(cx, |section, cx| {
                if section.load_epoch != epoch {
                    return;
                }
                match result {
                    Ok(Ok(board)) => {
                        section.board = Some(board);
                        section.board_state = BoardState::Ready;
                        section.load_failures = 0;
                    }
                    _ => {
                        section.load_failures = section.load_failures.saturating_add(1);
                        section.board_state = if section.load_failures >= 3 {
                            BoardState::Failed
                        } else {
                            BoardState::Loading
                        };
                        if section.board_state == BoardState::Loading {
                            section.schedule_retry(cx);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn schedule_retry(&mut self, cx: &mut Context<Self>) {
        let waits = [3_000u64, 6_000, 15_000];
        let wait = waits
            .get(self.load_failures.saturating_sub(1))
            .copied()
            .unwrap_or(15_000);
        let epoch = self.load_epoch;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(wait))
                .await;
            let _ = this.update(cx, |section, cx| {
                if section.load_epoch == epoch && section.board_state == BoardState::Loading {
                    section.refresh(cx);
                }
            });
        })
        .detach();
    }

    fn sounds(&self) -> &[Sound] {
        self.board
            .as_ref()
            .map(|b| b.sounds.as_slice())
            .unwrap_or(&[])
    }

    fn monitor(&self) -> bool {
        self.board.as_ref().map(|b| b.monitor).unwrap_or(true)
    }

    pub(crate) fn play(&mut self, id: String, cx: &mut Context<Self>) {
        self.action("sounds.play", Some(id), cx);
    }

    pub(crate) fn stop(&mut self, id: String, cx: &mut Context<Self>) {
        self.action("sounds.stop", Some(id), cx);
    }

    fn stop_all(&mut self, cx: &mut Context<Self>) {
        self.action("sounds.stop", None, cx);
    }

    fn press(&mut self, id: String, cx: &mut Context<Self>) {
        self.action("sounds.press", Some(id), cx);
    }

    fn action(&mut self, method: &'static str, id: Option<String>, cx: &mut Context<Self>) {
        if self.disconnected.is_some() {
            return;
        }
        let studio = self.studio.clone();
        let params = match id {
            Some(id) => json!({ "id": id }),
            None => json!({}),
        };
        self.runtime.spawn(async move {
            let _ = studio.backend().sounds_request(method, params).await;
        });
        cx.notify();
    }

    /// Digit key down while Studio is up (P343).
    pub fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        if self.disconnected.is_some() || event.is_held {
            return false;
        }
        let mods = &event.keystroke.modifiers;
        if mods.control || mods.alt || mods.shift || mods.platform || mods.function {
            return false;
        }
        let Some(digit) = sound_key_digit(&event.keystroke.key) else {
            return false;
        };
        let Some(sound) = sound_for_key(digit, self.sounds()) else {
            return false;
        };
        let id = sound.id.clone();
        self.held.insert(event.keystroke.key.clone(), id.clone());
        self.press(id, cx);
        true
    }

    /// Digit key up: stop a While held pad (P343).
    pub fn key_up(&mut self, event: &KeyUpEvent, cx: &mut Context<Self>) -> bool {
        let Some(id) = self.held.remove(&event.keystroke.key) else {
            return false;
        };
        let hold = self
            .sounds()
            .iter()
            .find(|s| s.id == id)
            .is_some_and(|s| s.mode == SoundMode::Hold);
        if hold {
            self.stop(id, cx);
        }
        true
    }

    /// Window blur / page leave: release every held pad.
    pub fn release_held(&mut self, cx: &mut Context<Self>) {
        let held: Vec<String> = self.held.drain().map(|(_, id)| id).collect();
        for id in held {
            let hold = self
                .sounds()
                .iter()
                .find(|s| s.id == id)
                .is_some_and(|s| s.mode == SoundMode::Hold);
            if hold {
                self.stop(id, cx);
            }
        }
    }

    pub(crate) fn toggle_room_sounds(&mut self, cx: &mut Context<Self>) {
        let Some(aux) = self.room_aux.as_mut() else {
            return;
        };
        aux.enabled = !aux.enabled;
        self.push_aux(cx);
        cx.notify();
    }

    pub(crate) fn toggle_system_share(&mut self, cx: &mut Context<Self>) {
        if !cfg!(debug_assertions) {
            return;
        }
        self.room_routing.system.enabled = !self.room_routing.system.enabled;
        if !self.room_routing.system.enabled {
            self.room_routing.system_state = soundboard::SystemState::Off;
            self.room_routing.reason = None;
        }
        self.push_aux(cx);
        cx.notify();
    }

    pub(crate) fn toggle_system_mute(&mut self, cx: &mut Context<Self>) {
        self.room_routing.system.muted = !self.room_routing.system.muted;
        self.push_aux(cx);
        cx.notify();
    }

    pub(crate) fn toggle_speech_mute(&mut self, cx: &mut Context<Self>) {
        self.room_routing.program.speech_muted = !self.room_routing.program.speech_muted;
        self.push_program();
        cx.notify();
    }

    pub(crate) fn toggle_auxiliary_mute(&mut self, cx: &mut Context<Self>) {
        self.room_routing.program.auxiliary_muted = !self.room_routing.program.auxiliary_muted;
        self.push_program();
        cx.notify();
    }

    pub(crate) fn set_system_gain(&mut self, gain_db: i32, cx: &mut Context<Self>) {
        self.room_routing.system.gain_db = SystemAudio::clamp_gain(gain_db);
        self.push_aux(cx);
        cx.notify();
    }

    pub(crate) fn set_speech_gain(&mut self, gain: f32, cx: &mut Context<Self>) {
        self.room_routing.program.speech_gain = gain.clamp(0., 1.);
        self.push_program();
        cx.notify();
    }

    pub(crate) fn set_auxiliary_gain(&mut self, gain: f32, cx: &mut Context<Self>) {
        self.room_routing.program.auxiliary_gain = gain.clamp(0., 1.);
        self.push_program();
        cx.notify();
    }

    /// Plan 260 S1.8 (L1): the program audio routing goes to the backend's
    /// room while it is open (`cloud.room.routing.set`, as the renderer's
    /// room sent it on to the program pages that route).
    fn push_program(&self) {
        if self.room_aux.is_none() {
            return;
        }
        let params =
            videorc_app_core::studio::room_media::routing_params(&self.room_routing.program);
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .backend()
                .livestream_request(videorc_app_core::studio::room_media::ROUTING_SET, params)
                .await;
        });
    }

    fn push_aux(&self, _cx: &mut Context<Self>) {
        let Some(aux) = self.room_aux.as_ref() else {
            return;
        };
        let params = RoomAudioRouting::aux_set_params(aux.enabled, self.room_routing.system);
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .backend()
                .livestream_request("cloud.room.aux.set", params)
                .await;
        });
    }

    /// Re-render pads while non-loop voices play so the kit progress ring moves.
    fn kick_progress_tick(&mut self, cx: &mut Context<Self>) {
        let needs = self.voices.iter().any(|v| !v.r#loop && v.duration_ms > 0);
        if !needs {
            self.progress_epoch = self.progress_epoch.wrapping_add(1);
            return;
        }
        self.progress_epoch = self.progress_epoch.wrapping_add(1);
        let epoch = self.progress_epoch;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                let cont = this
                    .update(cx, |section, cx| {
                        if section.progress_epoch != epoch {
                            return false;
                        }
                        let needs = section
                            .voices
                            .iter()
                            .any(|v| !v.r#loop && v.duration_ms > 0);
                        if needs {
                            cx.notify();
                        }
                        needs
                    })
                    .unwrap_or(false);
                if !cont {
                    break;
                }
            }
        })
        .detach();
    }
}

impl Render for SoundboardSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let muted = hsla(theme.muted_foreground);
        let ink = hsla(theme.foreground);
        let entity = cx.entity();
        let weak = entity.downgrade();

        let desc = description(
            self.session_active,
            self.monitor(),
            self.session_without_sounds,
        );
        let playing = !self.voices.is_empty();
        let stop_all = entity.clone();
        let stop_button = Button::new("soundboard-stop-all")
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .disabled(!playing || self.disconnected.is_some())
            .tooltip(words::STOP_ALL)
            .child(icon(IconName::Stop, 14., ink))
            .child(words::STOP_ALL)
            .on_click(move |_, _, cx| {
                stop_all.update(cx, |section, cx| section.stop_all(cx));
            });
        // Keep layout stable when idle (Electron `invisible`).
        let stop_action = div()
            .opacity(if playing { 1. } else { 0. })
            .when(!playing, |el| el.invisible())
            .child(stop_button);

        let mut section = PanelSection::new("studio-soundboard")
            .title(words::STUDIO_TITLE)
            .description(desc)
            .action(stop_action);

        if let Some(aux) = self.room_aux.as_ref() {
            section = section.child(room::render(
                aux,
                &self.room_routing,
                &self.room_sliders,
                weak.clone(),
                window,
                cx,
            ));
        }

        let sounds = self.sounds().to_vec();
        let voices: BTreeMap<String, SoundVoice> = voice_by_sound(&self.voices);
        let loaded = self.board_state == BoardState::Ready;

        if !sounds.is_empty() {
            section = section.child(pads::grid(
                &sounds,
                &voices,
                self.disconnected.is_some(),
                weak.clone(),
            ));
            if let Some(reason) = self.disconnected {
                section = section.child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(soundboard::disconnected_line(reason)),
                );
            }
        } else if !loaded {
            if self.disconnected.is_none() {
                match self.board_state {
                    BoardState::Failed => {
                        let retry = entity.clone();
                        section = section.child(
                            Empty::new().title(words::LOAD_FAILED).child(
                                Button::new("soundboard-retry")
                                    .label(words::RETRY)
                                    .variant(ButtonVariant::Outline)
                                    .on_click(move |_, _, cx| {
                                        retry.update(cx, |section, cx| {
                                            section.load_failures = 0;
                                            section.refresh(cx);
                                        });
                                    }),
                            ),
                        );
                    }
                    _ => {
                        let label = self.disconnected.unwrap_or(words::LOADING);
                        section = section.child(Empty::new().title(label));
                    }
                }
            } else {
                section =
                    section.child(Empty::new().title(self.disconnected.unwrap_or(words::LOADING)));
            }
        } else {
            let open = entity.clone();
            section = section.child(
                Empty::new().title(words::STUDIO_NO_SOUNDS).child(
                    Button::new("soundboard-add-in-sounds")
                        .variant(ButtonVariant::Outline)
                        .label(words::ADD_IN_SOUNDS)
                        .on_click(move |_, _, cx| {
                            open.update(cx, |_, cx| cx.emit(OpenPage::of(PageId::Sounds)));
                        }),
                ),
            );
        }

        div()
            .id("studio-soundboard-root")
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .child(section)
    }
}

/// Forwards Studio page digit keys into the soundboard (P343).
pub fn handle_key_down(
    section: &Entity<SoundboardSection>,
    event: &KeyDownEvent,
    cx: &mut gpui::App,
) -> bool {
    section.update(cx, |section, cx| section.key_down(event, cx))
}

pub fn handle_key_up(
    section: &Entity<SoundboardSection>,
    event: &KeyUpEvent,
    cx: &mut gpui::App,
) -> bool {
    section.update(cx, |section, cx| section.key_up(event, cx))
}

pub fn release_held(section: &Entity<SoundboardSection>, cx: &mut gpui::App) {
    let _ = section.update(cx, |section, cx| section.release_held(cx));
}
