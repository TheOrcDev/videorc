//! The remote-control surface (Stream Deck, the phone remote): what the
//! remotes are shown, and the intents they send.
//!
//! The Electron renderer's `RemoteSurfacePublisher` (`lib/remote-surface.ts`)
//! and `executeRemoteIntent` (`lib/studio-actions/remote.ts`), on the
//! Studio. The Studio builds [`RemoteSurface`] from every snapshot it
//! publishes, and [`Studio::drive`] sends it (`remote.surface.publish`)
//! once the bootstrap read the backend: after a 25 ms debounce, never the
//! same body twice on one connection, again after every reconnect (the
//! backend's slate is blank), and with a bounded retry when a publish
//! fails. The remotes render keys from it; `remote.describe` answers it.
//!
//! The state is minimal by design and the ONLY payload remote sockets
//! receive: booleans, opaque ids and the names the streamer typed. Never a
//! token, a path, a URL, a device name or a frame.
//!
//! What the scene does not hold reaches the surface as [`RemoteExtras`]:
//! the takeovers, the banners, the sounds, Hide screen and Sidekick Live
//! the Studio reads and follows itself (`remote_lists.rs`); the app's
//! windows and the Stream Manager's screen the app reports
//! ([`Studio::set_remote_app_facts`]). Until then they read closed, empty
//! and off.
//!
//! An admitted `remote.intent` runs here too, beside the event receiver,
//! and is answered with `remote.intent.ack` (`{intentId, ok, message?}`).
//! The session's, the microphone's and System audio's intents run below;
//! the picture's, the banners', the sounds', Hide screen's, the clip's and
//! the comment's in `remote_actions.rs`; the windows', the Stream
//! Manager's and Sidekick Live's in `remote_app.rs` (a window key is the
//! app's to run, and answers "Update Videorc" while no app listens).

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde::Serialize;
use serde_json::Value;
use videorc_protocol::{DeviceKind, DeviceStatus, RecordingState};

use super::audio_mixer;
use super::remote_actions::{BannerVerb, PrivacyMode, SoundVerb};
use super::remote_app::BuddyLiveVerb;
use super::session::{SessionActivity, SessionStartIntent};
use super::{Connection, MicrophoneMode, StartOutcome, Studio, StudioBackend, StudioSnapshot};
use crate::client::RemoteIntentEnvelope;
use crate::client::methods::RemoteIntentAckParams;
use crate::scenes::v2::layout_preset_label;

use super::capture_config::{HORIZONTAL_LAYOUT_PRESETS, VERTICAL_LAYOUT_PRESETS};

/// Same-change bursts go out as one publish (`PUBLISH_DEBOUNCE_MS`).
pub const PUBLISH_DEBOUNCE: Duration = Duration::from_millis(25);
/// The retries after a failed publish (`PUBLISH_RETRY_DELAYS_MS`): without
/// them a failed first publish leaves `remote.describe` empty until
/// something else changes.
pub const PUBLISH_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

/// What a phone or a deck reads when Videorc refuses a key
/// (`REMOTE_INTENT_COPY`). Shown as they are: plain copy, one next step.
pub mod copy {
    pub const ALREADY_RUNNING: &str = "You're already recording or live.";
    pub const RECORD_DID_NOT_START: &str = "Recording didn't start. Check Studio on your computer.";
    pub const NOT_RUNNING: &str = "You're not recording or live.";
    pub const DID_NOT_STOP: &str = "Couldn't stop. Check Studio on your computer.";
    pub const TOGGLE_FAILED: &str = "That didn't work. Check Studio on your computer.";
    pub const STREAM_NOT_SET_UP: &str = "Use Go Live on your computer first.";
    pub const MICROPHONE: &str = "Couldn't change the microphone.";
    pub const SYSTEM_AUDIO: &str = "System audio isn't available.";
    pub const SCENE_MISSING: &str = "That scene isn't available anymore.";
    pub const SCENE_FAILED: &str = "Couldn't switch the scene.";
    pub const TAKEOVER_MISSING: &str = "That takeover isn't available anymore.";
    pub const TAKEOVER_SHOW: &str = "Couldn't show the takeover.";
    pub const TAKEOVER_HIDE: &str = "Couldn't hide the takeover.";
    pub const BANNER_MISSING: &str = crate::studio::scene_editor::BANNER_ACTION_MISSING;
    pub const BANNER_SHOW: &str = crate::studio::scene_editor::BANNER_ACTION_SHOW;
    pub const BANNER_HIDE: &str = crate::studio::scene_editor::BANNER_ACTION_HIDE;
    pub const BANNERS_HIDE: &str = crate::studio::scene_editor::BANNER_ACTION_HIDE_ALL;
    pub const SOUND_MISSING: &str = crate::soundboard::SOUND_ACTION_MISSING;
    pub const SCREEN_MISSING: &str = "That screen isn't connected. Pick your screens again.";
    pub const MESSAGE_MISSING: &str = "Choose a message to put on stream.";
    pub const CLIPS_OFF: &str = crate::studio::clips::copy::CLIPS_OFF_INTENT;
    pub const WINDOW_MISSING: &str = "That window isn't available.";
    pub const SCREENS_SAME: &str = "Pick two different screens.";
    pub const STREAM_MANAGER_WAYLAND: &str =
        "Wayland doesn't let Videorc move windows. Hold the key to bring the Stream Manager up.";
    pub const UNSUPPORTED: &str = "This version of Videorc can't do that. Update Videorc.";
    /// What a key reads when its executor failed in a way it has no words
    /// for (Electron's `catch`); the raw error is for the log only.
    pub const FAILED: &str = "Something went wrong. Check Studio on your computer.";
}

/// An intent's answer: whether Videorc did it, and the words the remote
/// shows (a refusal's own sentence where one exists; a done key's only
/// where Electron says one, as Sidekick Live's).
pub type IntentOutcome = (bool, Option<String>);

/// Done: the remote reads the result from `remote.state`.
pub fn accepted() -> IntentOutcome {
    (true, None)
}

/// Refused, with the words the remote shows.
pub fn refused(message: impl Into<String>) -> IntentOutcome {
    (false, Some(message.into()))
}

/// `RemoteSurfaceSnapshot`: what `remote.surface.publish` sends.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteSurface {
    pub state: RemoteState,
    pub describe: RemoteDescribe,
}

/// `RemoteSurfaceState`: the projection deck keys render.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub screen_hidden: bool,
    pub saved_scenes: Vec<RemoteNamed>,
    pub active_saved_scene_id: Option<String>,
    pub session_state: &'static str,
    pub session_active: bool,
    pub record_enabled: bool,
    pub stream_enabled: bool,
    pub mic_muted: bool,
    pub output_session: RemoteOutputSession,
    pub layout_preset: String,
    pub active_takeover_id: Option<String>,
    pub windows: RemoteWindows,
    pub system_audio_on: bool,
    pub system_audio_available: bool,
    pub buddy_live: bool,
    pub stream_manager: RemoteStreamManager,
}

/// `outputSession`: booleans from the output's owner. The GPUI app has no
/// renderer room, so the owner is the native session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutputSession {
    pub owner: &'static str,
    pub freshness: &'static str,
    pub room_open: bool,
    pub microphone_confirmed: bool,
    pub camera_off: Option<bool>,
}

/// An id and the name the streamer typed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RemoteNamed {
    pub id: String,
    pub name: String,
}

/// Which of the app's windows are open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct RemoteWindows {
    pub notes: bool,
    pub comments: bool,
    pub preview: bool,
}

/// The Stream Manager Screen key (plan 230 D5): the screen it sits on
/// (`None` while closed), whether it shows, whether viewers really do not
/// see it. Never its frame.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStreamManager {
    pub screen_id: Option<String>,
    pub visible: bool,
    pub hidden_from_stream: bool,
}

/// A banner as the remotes see it (`BannerSummary`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RemoteBanner {
    pub id: String,
    pub name: String,
    pub shown: bool,
}

/// A sound as the remotes see it (`RemoteSoundSummary`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RemoteSound {
    pub id: String,
    pub name: String,
    pub playing: bool,
}

/// Whether the Stream Manager Screen key can move the window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenMoves {
    #[default]
    Supported,
    Wayland,
}

/// `RemoteSurfaceDescribe`: the catalog the keys pick from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDescribe {
    pub layout_presets: Vec<&'static str>,
    /// Each preset's name as the desktop shows it (plan 174 I-14).
    pub layout_labels: serde_json::Map<String, Value>,
    pub takeovers: Vec<RemoteNamed>,
    pub banners: Vec<RemoteBanner>,
    pub sounds: Vec<RemoteSound>,
    pub windows: [&'static str; 3],
    pub screens: Vec<RemoteNamed>,
    pub screen_moves: ScreenMoves,
}

/// What the surface shows past the snapshot: the lists and states the
/// Studio follows (`remote_lists.rs`) and the app's facts
/// ([`RemoteAppFacts`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteExtras {
    pub screen_hidden: bool,
    pub active_takeover_id: Option<String>,
    pub windows: RemoteWindows,
    pub takeovers: Vec<RemoteNamed>,
    pub banners: Vec<RemoteBanner>,
    pub sounds: Vec<RemoteSound>,
    pub buddy_live: bool,
    pub stream_manager: RemoteStreamManager,
    pub screens: Vec<RemoteNamed>,
    pub screen_moves: ScreenMoves,
}

/// What only the app can tell the surface: which of its windows are open,
/// where the Stream Manager is, and the screens its Screen key can pick.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteAppFacts {
    pub windows: RemoteWindows,
    pub stream_manager: RemoteStreamManager,
    pub screens: Vec<RemoteNamed>,
    pub screen_moves: ScreenMoves,
}

/// An intent's string field (`typeof fields.x === 'string' ? fields.x :
/// undefined`).
pub(super) fn text_field<'a>(intent: &'a Value, key: &str) -> Option<&'a str> {
    intent.get(key).and_then(Value::as_str)
}

/// The wire word of a session state.
fn state_word(state: &RecordingState) -> &'static str {
    match state {
        RecordingState::Idle => "idle",
        RecordingState::Starting => "starting",
        RecordingState::Recording => "recording",
        RecordingState::Streaming => "streaming",
        RecordingState::Stopping => "stopping",
        RecordingState::Failed => "failed",
    }
}

/// `isSessionActive`: a session owns the transport, or a start or a stop is
/// on its way. A Clips ring's replay-only session is not one.
pub fn session_active(snapshot: &StudioSnapshot) -> bool {
    let session = &snapshot.session;
    let owns = session.phase.is_active() && !session.status.replay_only;
    owns || session.start_pending || session.stop_pending
}

/// `remoteOutputIntent`: what the session records and streams, or, idle,
/// the saved mode.
fn output_intent(snapshot: &StudioSnapshot, active: bool) -> SessionStartIntent {
    let capture = &snapshot.settings.capture;
    let saved = SessionStartIntent {
        record: capture.record_enabled,
        stream: capture.stream_enabled,
    };
    if !active {
        return saved;
    }
    if let Some(intent) = snapshot.session.intent {
        return intent;
    }
    let status = &snapshot.session.status;
    match status.state {
        RecordingState::Recording | RecordingState::Streaming => {
            match SessionActivity::of(status) {
                SessionActivity::Recording => SessionStartIntent::RECORD,
                SessionActivity::LiveStream => SessionStartIntent {
                    record: false,
                    stream: true,
                },
                SessionActivity::RecordAndStream => SessionStartIntent {
                    record: true,
                    stream: true,
                },
            }
        }
        RecordingState::Starting if status.session_id.is_some() => SessionStartIntent {
            record: status.output_path.is_some(),
            stream: status.stream_url.is_some(),
        },
        _ => saved,
    }
}

/// System audio's device status and what its switch shows
/// (`systemAudioStatus`, `systemAudioShown`). The status is the listed
/// device's own (`devices.find(kind === 'system-audio')?.status`), never the
/// Studio row's Mac stand-in (`system_audio_row_status`): until a list names
/// the device, the remotes are told it isn't available.
fn system_audio(snapshot: &StudioSnapshot) -> (Option<DeviceStatus>, bool) {
    let status = snapshot
        .sources
        .devices
        .devices
        .iter()
        .find(|device| device.kind == DeviceKind::SystemAudio)
        .map(|device| device.status.clone());
    let facts = &snapshot.system_audio;
    let confirmed = if facts.issue.is_some() || facts.joining {
        None
    } else {
        facts.confirmed
    };
    let shown = confirmed.unwrap_or(snapshot.settings.capture.audio.system_audio_enabled);
    (status, shown)
}

/// The surface of one snapshot.
pub fn surface_of(snapshot: &StudioSnapshot, extras: &RemoteExtras) -> RemoteSurface {
    let active = session_active(snapshot);
    let outputs = output_intent(snapshot, active);
    let capture = &snapshot.settings.capture;
    let mic_muted = if active {
        snapshot
            .system_audio
            .applied_microphone_muted
            .unwrap_or(capture.audio.microphone_muted)
    } else {
        capture.audio.microphone_muted
    };
    let (status, shown) = system_audio(snapshot);
    let available = status == Some(DeviceStatus::Available);
    let connected = matches!(snapshot.connection, Connection::Connected { .. });
    let layout_preset = serde_json::to_value(&capture.layout.layout_preset)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let presets: Vec<&'static str> = HORIZONTAL_LAYOUT_PRESETS
        .iter()
        .chain(VERTICAL_LAYOUT_PRESETS.iter())
        .copied()
        .collect();
    // Both orientations are always listed, so the vertical twins say so.
    let layout_labels = presets
        .iter()
        .map(|preset| {
            (
                (*preset).to_string(),
                Value::String(layout_preset_label(preset, true)),
            )
        })
        .collect();
    RemoteSurface {
        state: RemoteState {
            screen_hidden: extras.screen_hidden,
            saved_scenes: snapshot
                .scenes
                .scenes
                .iter()
                .map(|scene| RemoteNamed {
                    id: scene.id.clone(),
                    name: scene.name.clone(),
                })
                .collect(),
            active_saved_scene_id: snapshot.scenes.on_stream_id.clone(),
            session_state: state_word(&snapshot.session.status.state),
            session_active: active,
            record_enabled: outputs.record,
            stream_enabled: outputs.stream,
            mic_muted,
            output_session: RemoteOutputSession {
                owner: "native",
                freshness: if connected { "fresh" } else { "stale" },
                room_open: false,
                microphone_confirmed: connected,
                camera_off: None,
            },
            layout_preset,
            active_takeover_id: extras.active_takeover_id.clone(),
            windows: extras.windows,
            system_audio_on: available && shown,
            system_audio_available: available,
            buddy_live: extras.buddy_live,
            stream_manager: extras.stream_manager.clone(),
        },
        describe: RemoteDescribe {
            layout_presets: presets,
            layout_labels,
            takeovers: extras.takeovers.clone(),
            banners: extras.banners.clone(),
            sounds: extras.sounds.clone(),
            windows: ["notes", "comments", "preview"],
            screens: extras.screens.clone(),
            screen_moves: extras.screen_moves,
        },
    }
}

/// The publisher's bookkeeping, apart from the Studio's state.
#[derive(Debug, Default)]
pub(super) struct RemotePublisher {
    /// What the app holds, for the surface.
    pub(super) extras: RemoteExtras,
    /// The newest surface, as its body and as JSON.
    latest: Option<(String, Value)>,
    /// The body the backend holds on this connection.
    published: Option<String>,
    /// A new number on every connection, so a publish that answers after
    /// a reconnect never counts for the new one.
    generation: u64,
    /// Intents waiting for the driver.
    intents: Vec<RemoteIntentEnvelope>,
    /// The app's receiver for the keys only it can run (`remote_app.rs`);
    /// `None` while no app listens.
    pub(super) app_intents:
        Option<tokio::sync::mpsc::UnboundedSender<super::remote_app::AppRemoteIntent>>,
    /// Which lists this connection's events already said (`remote_lists.rs`):
    /// a read that answers later never overwrites them.
    pub(super) heard: super::remote_lists::ListsHeard,
    /// The soundboard in board order, and the sounds playing now, for
    /// `describe.sounds`.
    pub(super) board: Vec<RemoteNamed>,
    pub(super) playing: Vec<String>,
}

impl RemotePublisher {
    /// A new connection (or none): its backend holds nothing published,
    /// and its lists are read afresh.
    pub(super) fn forget_connection(&mut self) {
        self.latest = None;
        self.published = None;
        self.generation += 1;
        self.heard = super::remote_lists::ListsHeard::default();
        // No sound plays on a backend that is gone (`disconnect`).
        self.playing.clear();
        self.extras.sounds = super::remote_lists::sounds_of(&self.board, &self.playing);
    }

    /// This connection's number, for a read that answers after it.
    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    /// Records the newest surface. True when it is news for the backend.
    pub(super) fn note(&mut self, surface: &RemoteSurface) -> bool {
        let Ok(value) = serde_json::to_value(surface) else {
            return false;
        };
        let body = value.to_string();
        if self
            .latest
            .as_ref()
            .is_some_and(|(latest, _)| *latest == body)
        {
            return false;
        }
        let news = self.published.as_deref() != Some(body.as_str());
        self.latest = Some((body, value));
        news
    }

    /// The surface still to send, with the connection it is for.
    fn due(&self) -> Option<(String, Value, u64)> {
        let (body, value) = self.latest.as_ref()?;
        (self.published.as_deref() != Some(body.as_str()))
            .then(|| (body.clone(), value.clone(), self.generation))
    }
}

impl<B: StudioBackend> Studio<B> {
    /// Every extra at once (tests, a smoke): the windows, the takeovers,
    /// the banners, the sounds, Buddy Live, the Stream Manager's screen and
    /// Hide screen. Republishes when it changed. The app reports only its
    /// own facts ([`Self::set_remote_app_facts`]); the Studio follows the
    /// rest itself.
    pub fn set_remote_extras(&self, extras: RemoteExtras) {
        self.edit_remote(|remote| remote.extras = extras);
    }

    /// The app's windows and the Stream Manager's screen, for the surface.
    /// Call it whenever they may have changed: the same facts are not news.
    pub fn set_remote_app_facts(&self, facts: RemoteAppFacts) {
        self.edit_remote(|remote| {
            let extras = &mut remote.extras;
            extras.windows = facts.windows;
            extras.stream_manager = facts.stream_manager;
            extras.screens = facts.screens;
            extras.screen_moves = facts.screen_moves;
        });
    }

    /// One edit of the publisher; the surface is noted again when the
    /// extras changed. Never holds the lock past the edit.
    pub(super) fn edit_remote(&self, edit: impl FnOnce(&mut RemotePublisher)) {
        let changed = {
            let mut remote = self.remote_lock();
            let before = remote.extras.clone();
            edit(&mut remote);
            remote.extras != before
        };
        if changed {
            let snapshot = self.snapshot();
            self.note_remote_surface(&snapshot);
        }
    }

    /// The surface of what the Studio just published, once the bootstrap
    /// read this connection's backend.
    pub(super) fn note_remote_surface(&self, snapshot: &StudioSnapshot) {
        if !snapshot.bootstrapped || !matches!(snapshot.connection, Connection::Connected { .. }) {
            return;
        }
        let news = {
            let mut remote = self.remote_lock();
            let surface = surface_of(snapshot, &remote.extras);
            remote.note(&surface)
        };
        if news {
            self.remote_publish_kick.notify_one();
        }
    }

    /// The surface the Studio would publish now (for the app and tests).
    pub fn remote_surface(&self) -> RemoteSurface {
        let snapshot = self.snapshot();
        let remote = self.remote_lock();
        surface_of(&snapshot, &remote.extras)
    }

    /// Sends the surface whenever it changed. [`Self::drive`] runs it.
    pub(super) async fn publish_remote_surface_when_kicked(self: &Arc<Self>) {
        loop {
            self.remote_publish_kick.notified().await;
            tokio::time::sleep(PUBLISH_DEBOUNCE).await;
            self.flush_remote_surface().await;
        }
    }

    /// Sends the newest surface until the backend holds it. Never holds a
    /// lock across the request. A test without a driver calls it.
    #[doc(hidden)]
    pub async fn flush_remote_surface(&self) {
        let mut attempt = 0;
        loop {
            let Some((body, value, generation)) = self.remote_lock().due() else {
                return;
            };
            match self.backend.remote_surface_publish(value).await {
                Ok(()) => {
                    attempt = 0;
                    let mut remote = self.remote_lock();
                    if remote.generation == generation {
                        remote.published = Some(body);
                    }
                }
                Err(error) => {
                    let Some(delay) = PUBLISH_RETRY_DELAYS.get(attempt) else {
                        // Out of retries: say so once, then wait for the
                        // next change or reconnect. The keys keep the last
                        // state they saw.
                        self.config.logger.warn(format!(
                            "Studio: remote.surface.publish failed after retries: {} ({})",
                            error.message, error.code
                        ));
                        return;
                    };
                    attempt += 1;
                    tokio::time::sleep(*delay).await;
                    if self.remote_lock().generation != generation {
                        // A new connection: its own publish is on the way.
                        return;
                    }
                }
            }
        }
    }

    /// An admitted intent, for the driver.
    pub(super) fn queue_remote_intent(&self, envelope: RemoteIntentEnvelope) {
        self.remote_lock().intents.push(envelope);
        self.remote_intent_kick.notify_one();
    }

    /// Runs the intents as they come, side by side (a Stop answers while a
    /// Record still starts). [`Self::drive`] runs it.
    pub(super) async fn run_remote_intents_when_kicked(self: &Arc<Self>) {
        let mut running = FuturesUnordered::new();
        loop {
            tokio::select! {
                () = self.remote_intent_kick.notified() => {
                    let intents = std::mem::take(&mut self.remote_lock().intents);
                    for envelope in intents {
                        running.push(self.run_remote_intent(envelope));
                    }
                }
                Some(()) = running.next(), if !running.is_empty() => {}
            }
        }
    }

    /// `executeRemoteIntent`: one intent, then its ack. A lost ack is not
    /// news: the remote also reads the state.
    #[doc(hidden)]
    pub async fn run_remote_intent(self: &Arc<Self>, envelope: RemoteIntentEnvelope) {
        let (ok, message) = self.execute_remote_intent(&envelope).await;
        let _ = self
            .backend
            .remote_intent_ack(RemoteIntentAckParams {
                intent_id: envelope.intent_id,
                ok,
                message,
            })
            .await;
    }

    async fn execute_remote_intent(
        self: &Arc<Self>,
        envelope: &RemoteIntentEnvelope,
    ) -> IntentOutcome {
        let Some(kind) = envelope.kind() else {
            return refused(copy::UNSUPPORTED);
        };
        let intent = &envelope.intent;
        let active = session_active(&self.snapshot());
        match kind {
            "recordStart" if active => refused(copy::ALREADY_RUNNING),
            "recordStart" => match self.start_recording().await {
                StartOutcome::Started => accepted(),
                StartOutcome::Busy => refused(copy::ALREADY_RUNNING),
                StartOutcome::Refused { .. } => refused(copy::RECORD_DID_NOT_START),
            },
            "recordStop" | "streamStop" if !active => refused(copy::NOT_RUNNING),
            "recordStop" | "streamStop" => {
                if self.stop().await {
                    accepted()
                } else {
                    refused(copy::DID_NOT_STOP)
                }
            }
            "recordToggle" => {
                let committed = if active {
                    self.stop().await
                } else {
                    self.start_recording().await == StartOutcome::Started
                };
                if committed {
                    accepted()
                } else {
                    refused(copy::TOGGLE_FAILED)
                }
            }
            "streamStart" if active => refused(copy::ALREADY_RUNNING),
            // Going live needs the Go Live dialog's checks, on the computer.
            "streamStart" => refused(copy::STREAM_NOT_SET_UP),
            "micMute" | "micUnmute" | "micToggle" => {
                let mode = match kind {
                    "micMute" => MicrophoneMode::Mute,
                    "micUnmute" => MicrophoneMode::Unmute,
                    _ => MicrophoneMode::Toggle,
                };
                if self.set_microphone_muted(mode).await {
                    accepted()
                } else {
                    refused(copy::MICROPHONE)
                }
            }
            "systemAudioOn" | "systemAudioOff" | "systemAudioToggle" => {
                let mode = match kind {
                    "systemAudioOn" => "on",
                    "systemAudioOff" => "off",
                    _ => "toggle",
                };
                let (status, shown) = system_audio(&self.snapshot());
                match audio_mixer::system_audio_target(mode, status.as_ref(), shown) {
                    // Accepted = requested: the key renders the confirmed
                    // mix from `remote.state` once the session reports it.
                    Some(target) => {
                        self.set_system_audio_enabled(target).await;
                        accepted()
                    }
                    None => refused(copy::SYSTEM_AUDIO),
                }
            }
            "sceneApply" => self.remote_scene_apply(intent).await,
            "takeoverShow" => {
                self.remote_takeover_show(text_field(intent, "assetId"))
                    .await
            }
            "takeoverHide" => self.remote_takeover_hide().await,
            "bannerShow" => {
                self.remote_banner(BannerVerb::Show, text_field(intent, "bannerId"))
                    .await
            }
            "bannerHide" => {
                self.remote_banner(BannerVerb::Hide, text_field(intent, "bannerId"))
                    .await
            }
            "bannerToggle" => {
                self.remote_banner(BannerVerb::Toggle, text_field(intent, "bannerId"))
                    .await
            }
            "soundPlay" => {
                self.remote_sound(SoundVerb::Press, text_field(intent, "soundId"))
                    .await
            }
            "soundStop" => {
                self.remote_sound(SoundVerb::Stop, text_field(intent, "soundId"))
                    .await
            }
            "screenHide" => self.remote_screen_privacy(PrivacyMode::Hide).await,
            "screenShow" => self.remote_screen_privacy(PrivacyMode::Show).await,
            "screenHideToggle" => self.remote_screen_privacy(PrivacyMode::Toggle).await,
            // Electron hands the intent id in as the clip's `requestId`; only
            // a talk show room's clip carries it, and app-core has none yet.
            "clipMark" => self.remote_clip_mark(intent.get("seconds")).await,
            "commentHighlight" => match text_field(intent, "messageId").filter(|id| !id.is_empty())
            {
                Some(message_id) => self.remote_comment_highlight(message_id).await,
                None => refused(copy::MESSAGE_MISSING),
            },
            "commentHighlightClear" => self.remote_comment_highlight_clear().await,
            "windowFront" => self.remote_window_front(intent).await,
            "streamManagerScreenSwap" => self.remote_screen_swap(intent),
            "streamManagerFrontOrClose" => self.remote_stream_manager_front_or_close().await,
            "buddyLiveOn" => self.remote_buddy_live(BuddyLiveVerb::On).await,
            "buddyLiveOff" => self.remote_buddy_live(BuddyLiveVerb::Off).await,
            "buddyLiveToggle" => self.remote_buddy_live(BuddyLiveVerb::Toggle).await,
            _ => refused(copy::UNSUPPORTED),
        }
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
