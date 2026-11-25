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
//! Plan 260 S1.8 (C3): when room scenes are opted in, a Studio scene switch
//! also resolves and commits through `cloud.room.scene.commit`, settling on
//! the presentation's scene entry (5 s), as `room-scene-backend.ts` did.
//! The join chime and the scripted smoke room (P396, P398) wait.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, Image, ImageFormat, Window, div, prelude::*};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use videorc_app_core::cloud_scene::types::SceneOrientation;
use videorc_app_core::cloud_scene::{
    ROOM_SCENES_OFF, USE_SCENES, cloud_scene_from_native, room_scene_canvas, room_sources_ready,
};
use videorc_app_core::guests::session::ControllerFacts;
use videorc_app_core::library::cloud::{CloudRecordingStop, CloudRecordingWatch};
use videorc_app_core::studio::preview_scene::studio_scene_params;
use videorc_app_core::studio::room_frames::{self, FrameCursor, FramePoll, RemoteSource};
use videorc_app_core::studio::room_media::{
    self, AVATAR_SET, CAMERA_SET, HTML_SET, MICROPHONE_SET, MONITOR_SET, PRESENTATION_EVENT,
    PRESENTATION_SET, RETURN_SET, RoomMedia, SCREEN_SET,
};
use videorc_app_core::studio::room_scene::{
    self, BACKEND_SCENE_COMMIT_WAIT, PreparedBackgroundAsset, RoomSceneCommit, SCENE_COMMIT,
    SCENE_RESOLVE, SceneCommitAnswer, SceneCommitSettle, SceneContent,
};
use videorc_app_core::studio::screen_views::TalkShowRoomView;
use videorc_app_core::{BackendEvent, ConnectionState};
use videorc_protocol::Scene;

use super::transport::AppStudio;
use crate::app::bridge::Mirror;

/// The tiles' polling pace: half the renderer's 30 fps until the Show
/// stage's cost is measured (each picture is a whole BMP decoded here).
const TILE_INTERVAL: Duration = Duration::from_millis(66);
/// The monitor's key: the route ignores its identity.
const MONITOR_KEY: &str = "monitor";

/// The setters kept in step with the room: microphone, camera, sheet, the
/// avatar's build, and the room's presentation switches.
const SLOTS: usize = 5;

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
    /// The cloud-controller entry last asked for (what else stays off), so a
    /// repeat publishes nothing.
    controller_notice: Option<Vec<String>>,
    /// The params last sent (microphone, camera, sheet), so a repeat sends
    /// nothing; cleared when the room closes (the backend lets go).
    sent: [Option<Value>; SLOTS],
    /// A slot the backend refused (it didn't hold the seat yet): sent again
    /// once the room's presentation shows it holds it, never in a loop.
    refused: [bool; SLOTS],
    /// The Guests page's room switches (graphics, avatar) and its opt-in to
    /// show the avatar to guests; `None` until set (the backend's own
    /// default stands).
    room_graphics: Option<bool>,
    room_avatar: Option<bool>,
    avatar_guests: bool,
    /// R3: each person's latest picture (camera or screen) and the Program
    /// monitor's, with its cursor, while the room publishes them.
    frames: HashMap<(String, RemoteSource), (FrameCursor, Arc<Image>)>,
    /// R4: the Program monitor takes the runner's return, and Listen.
    monitor: bool,
    listening: bool,
    /// Per-room opt-in for Studio scenes on the program (off by default;
    /// `ROOM_SCENES_OFF` / `USE_SCENES`).
    scenes_enabled: bool,
    /// Show id the scenes opt-in was set for; a new show drops it.
    scenes_show_id: Option<String>,
    /// Last Studio layout-commit revision sent to the room (0 before any).
    last_scene_layout_revision: u64,
    /// Content the backend refused (`held: false`); resent once presentation
    /// shows it holds the seat again.
    pending_scene: Option<(Option<SceneContent>, Vec<PreparedBackgroundAsset>)>,
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
        // the Studio's snapshots and its cloud state. A layout commit while
        // room scenes are on also reaches the room.
        let snapshots = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut watch = snapshots.watch();
            while watch.changed().await.is_ok() {
                if this
                    .update(cx, |host, cx| {
                        host.sync_room(cx);
                        host.sync_room_scene_from_layout(cx);
                    })
                    .is_err()
                {
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
                let media = room_media::presentation_media(&payload);
                let alive = this.update(cx, |host, cx| {
                    if let Some((_, media)) = media {
                        if host.room_open() && host.room_media.as_ref() != Some(&media) {
                            host.room_media = Some(media);
                            cx.notify();
                        }
                    }
                    // The backend holds the room now: anything it refused
                    // before its join goes again.
                    if host.refused.iter().any(|refused| *refused) {
                        for slot in 0..SLOTS {
                            if std::mem::take(&mut host.refused[slot]) {
                                host.sent[slot] = None;
                            }
                        }
                        host.sync_room(cx);
                    }
                    // A scene commit answered held:false is resent once.
                    if host.pending_scene.is_some() {
                        host.retry_pending_scene(cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        // R3: the people's pictures and the monitor's, polled one at a time
        // on the backend's loopback server while the room publishes them.
        let poll_studio = studio.clone();
        let poll_runtime = runtime.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TILE_INTERVAL).await;
                let Ok(wanted) = this.update(cx, |host, cx| host.wanted_feeds(cx)) else {
                    break;
                };
                if wanted.is_empty() {
                    continue;
                }
                let ConnectionState::Connected { ready, .. } =
                    poll_studio.backend().current_state()
                else {
                    continue;
                };
                for (identity, source, after) in wanted {
                    let (port, token) = (ready.port, ready.token.clone());
                    let asked = identity.clone();
                    let job = poll_runtime.spawn(async move {
                        room_frames::poll_remote_frame(port, &token, &asked, source, after.as_ref())
                            .await
                    });
                    let Ok(Ok(poll)) = job.await else {
                        continue;
                    };
                    if this
                        .update(cx, |host, cx| host.take_poll(identity, source, poll, cx))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        })
        .detach();
        // The cloud-controller entry's Turn on.
        if let Some(hub) = cx
            .try_global::<crate::screens::notifications::Shared>()
            .map(|shared| shared.0.clone())
        {
            cx.subscribe(
                &hub,
                |host, _, navigate: &crate::screens::notifications::Navigate, cx| {
                    if matches!(
                        navigate,
                        crate::screens::notifications::Navigate::EnableRoomDevices
                    ) {
                        host.enable_devices(cx);
                    }
                },
            )
            .detach();
        }
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
            controller_notice: None,
            sent: Default::default(),
            refused: [false; SLOTS],
            room_graphics: None,
            room_avatar: None,
            avatar_guests: false,
            frames: HashMap::new(),
            monitor: false,
            listening: false,
            scenes_enabled: false,
            scenes_show_id: None,
            last_scene_layout_revision: 0,
            pending_scene: None,
        };
        host.on_talk_show(&initial);
        host
    }

    /// Whether the talk-show room is open for this show.
    pub fn room_open(&self) -> bool {
        self.studio
            .cloud_now()
            .status
            .as_ref()
            .and_then(|status| status.room.as_ref())
            .and_then(|room| room.get("phase"))
            .and_then(Value::as_str)
            == Some("open")
    }

    fn show_id(&self) -> Option<String> {
        self.studio
            .cloud_now()
            .status
            .as_ref()
            .and_then(|status| status.show.as_ref())
            .map(|show| show.id.clone())
    }

    /// Per-room opt-in for Studio scenes on the program (default off).
    pub fn scenes_enabled(&self) -> bool {
        let Some(show_id) = self.show_id() else {
            return false;
        };
        self.scenes_enabled && self.scenes_show_id.as_deref() == Some(show_id.as_str())
    }

    /// Turn room scenes on or off for the current show (`USE_SCENES` /
    /// `ROOM_SCENES_OFF`). Off by default; a new show starts off again.
    pub fn set_scenes_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.scenes_show_id = self.show_id();
        self.scenes_enabled = enabled;
        if enabled && self.room_open() {
            self.last_scene_layout_revision = 0;
            self.sync_room_scene_from_layout(cx);
        }
        cx.notify();
    }

    /// Copy for a scene command while scenes are off in this room.
    pub fn room_scenes_off_copy() -> (&'static str, &'static str) {
        (ROOM_SCENES_OFF, USE_SCENES)
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

    /// R3: a person's latest picture (`Camera` or `Screen`), or the Program
    /// monitor's (`Monitor`, any identity), while the room publishes it. The
    /// host notifies on every new picture.
    pub fn remote_frame(&self, identity: &str, source: RemoteSource) -> Option<Arc<Image>> {
        let key = match source {
            RemoteSource::Monitor => MONITOR_KEY,
            _ => identity,
        };
        self.frames
            .get(&(key.to_string(), source))
            .map(|(_, image)| image.clone())
    }

    /// The pictures to poll now, each with its cursor; the ones no longer
    /// published are dropped.
    fn wanted_feeds(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Vec<(String, RemoteSource, Option<FrameCursor>)> {
        let mut wanted: Vec<(String, RemoteSource)> = Vec::new();
        if let Some(media) = &self.room_media {
            for person in &media.people {
                if person.camera {
                    wanted.push((person.identity.clone(), RemoteSource::Camera));
                }
                if person.screen {
                    wanted.push((person.identity.clone(), RemoteSource::Screen));
                }
            }
            if media.monitor.is_some_and(|monitor| monitor.video) {
                wanted.push((MONITOR_KEY.to_string(), RemoteSource::Monitor));
            }
        }
        let before = self.frames.len();
        self.frames.retain(|key, _| wanted.contains(key));
        if self.frames.len() != before {
            cx.notify();
        }
        wanted
            .into_iter()
            .map(|(identity, source)| {
                let after = self
                    .frames
                    .get(&(identity.clone(), source))
                    .map(|(cursor, _)| cursor.clone());
                (identity, source, after)
            })
            .collect()
    }

    fn take_poll(
        &mut self,
        identity: String,
        source: RemoteSource,
        poll: FramePoll,
        cx: &mut Context<Self>,
    ) {
        match poll {
            FramePoll::Frame { cursor, bmp } => {
                let image = Arc::new(Image::from_bytes(ImageFormat::Bmp, bmp));
                self.frames.insert((identity, source), (cursor, image));
                cx.notify();
            }
            FramePoll::Empty => {
                if self.frames.remove(&(identity, source)).is_some() {
                    cx.notify();
                }
            }
            FramePoll::Unchanged => {}
        }
    }

    /// While the room is open and the devices are held, the entry that turns
    /// them on (with the controller's other needs); withdrawn otherwise.
    fn sync_controller_notice(&mut self, cx: &mut Context<Self>) {
        let wanted = (self.room_open() && self.devices_held()).then(|| {
            self.studio
                .cloud_now()
                .status
                .and_then(|status| status.controller)
                .and_then(|controller| controller.get("needsEnable").cloned())
                .and_then(|needs| serde_json::from_value::<Vec<String>>(needs).ok())
                .unwrap_or_default()
        });
        if wanted == self.controller_notice {
            return;
        }
        self.controller_notice = wanted.clone();
        if let Some(hub) = cx
            .try_global::<crate::screens::notifications::Shared>()
            .map(|shared| shared.0.clone())
        {
            hub.update(cx, |hub, cx| hub.set_cloud_controller(wanted, cx));
        }
    }

    // --- R4: the Show stage's room controls (`useTalkShowRoom`'s) ---

    /// Shares a screen or window into the room, by its native id (the
    /// device list's `screen:…` / `window:…`; the backend shares it while
    /// the preview runs it, behind Hide screen). The Show stage puts it on
    /// stage after (`addScreen`). Answers why not.
    pub fn share_screen(
        &self,
        source_id: &str,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Result<(), String>> {
        let Some(params) = room_media::screen_params(source_id) else {
            return gpui::Task::ready(
                Err("This screen can't be shared into the room here.".into()),
            );
        };
        let request = self.request(SCREEN_SET, params);
        cx.background_executor().spawn(async move {
            match request.await {
                Ok(Ok(answer)) if room_media::held(&answer) => Ok(()),
                Ok(Ok(_)) => Err("The room is not open.".into()),
                Ok(Err(error)) => Err(error),
                Err(_) => Err("The room is not open.".into()),
            }
        })
    }

    /// Takes the host's screen share down (the Show stage takes it off
    /// stage).
    pub fn stop_screen_share(&self) {
        let _ = self.request(SCREEN_SET, room_media::stop_screen_params());
    }

    /// The Program monitor on or off: the backend's room takes the runner's
    /// return (heard only with Listen), and the runner opens it. A managed
    /// show has no return: its monitor draws the stage (plan 234 D6).
    pub fn set_monitor(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.managed_show() {
            return;
        }
        self.monitor = enabled;
        let _ = self.request(
            MONITOR_SET,
            room_media::monitor_params(enabled, self.listening),
        );
        let _ = self.request(RETURN_SET, room_media::return_params(enabled));
        cx.notify();
    }

    /// Listen to the Program monitor's return (S1.8d d5).
    pub fn set_monitor_listening(&mut self, listening: bool, cx: &mut Context<Self>) {
        self.listening = listening;
        if self.monitor {
            let _ = self.request(MONITOR_SET, room_media::monitor_params(true, listening));
        }
        cx.notify();
    }

    pub fn monitor(&self) -> bool {
        self.monitor
    }

    pub fn monitor_listening(&self) -> bool {
        self.listening
    }

    fn managed_show(&self) -> bool {
        let node = self
            .studio
            .cloud_now()
            .status
            .and_then(|status| status.show)
            .map(|show| show.node_id);
        videorc_app_core::guests::program::is_managed_show(node.as_deref())
    }

    /// One room request on the core's runtime; the answer, or why not.
    fn request(
        &self,
        method: &'static str,
        params: Value,
    ) -> tokio::task::JoinHandle<Result<Value, String>> {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .backend()
                .request(method, params)
                .await
                .map_err(|error| {
                    eprintln!("[videorc-app] Talk-show host: {method}: {error}");
                    error.to_string()
                })
        })
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
        self.sync_controller_notice(cx);
        if !self.room_open() {
            self.sent = Default::default();
            self.refused = [false; SLOTS];
            self.pending_scene = None;
            if self.room_media.take().is_some() || !self.frames.is_empty() {
                self.frames.clear();
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
                Some(room_media::microphone_params(
                    capture.sources.microphone_id.as_deref(),
                    &capture.audio,
                    held,
                )),
            ),
            (
                CAMERA_SET,
                Some(room_media::camera_params(
                    capture.sources.camera_id.as_deref(),
                    capture.layout.source_visibility.camera,
                    held,
                )),
            ),
            (HTML_SET, Some(room_media::html_params(held))),
            (
                AVATAR_SET,
                Some(room_media::avatar_build_params(self.avatar_guests)),
            ),
            (
                PRESENTATION_SET,
                room_media::presentation_params(self.room_graphics, self.room_avatar),
            ),
        ];
        for (slot, (method, params)) in wanted.into_iter().enumerate() {
            let Some(params) = params else {
                continue;
            };
            if self.sent[slot].as_ref() == Some(&params) {
                continue;
            }
            self.sent[slot] = Some(params.clone());
            self.refused[slot] = false;
            // A refusal (the backend doesn't hold the seat yet) is kept, and
            // the room's next presentation sends it again.
            let request = self.request(method, params.clone());
            cx.spawn(async move |this, cx| {
                let held = matches!(request.await, Ok(Ok(ref answer)) if room_media::held(answer));
                if !held {
                    let _ = this.update(cx, |host, _| {
                        if host.sent[slot].as_ref() == Some(&params) {
                            host.refused[slot] = true;
                        }
                    });
                }
            })
            .detach();
        }
    }

    /// The Guests page's room switches: the static graphics and the avatar
    /// on the room's program (`cloud.room.presentation.set`), sent while the
    /// room is open and again after a refusal.
    pub fn set_room_presentation(
        &mut self,
        graphics: Option<bool>,
        avatar: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        if graphics.is_some() {
            self.room_graphics = graphics;
        }
        if avatar.is_some() {
            self.room_avatar = avatar;
        }
        self.sync_room(cx);
        cx.notify();
    }

    /// The host's opt-in to show the avatar to guest pages.
    pub fn set_avatar_guests(&mut self, guests: bool, cx: &mut Context<Self>) {
        self.avatar_guests = guests;
        self.sync_room(cx);
        cx.notify();
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

    /// Commit scene content into the backend's room (`cloud.room.scene.commit`)
    /// and settle on the matching `cloud.room.presentation` scene entry for
    /// up to 5 s. No-ops (returns `None`) when the room is closed or the
    /// backend does not hold the seat.
    pub fn commit_scene(
        &mut self,
        content: Option<SceneContent>,
        assets: Vec<PreparedBackgroundAsset>,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Option<RoomSceneCommit>> {
        if !self.room_open() {
            return gpui::Task::ready(None);
        }
        let Some(show_id) = self.show_id() else {
            return gpui::Task::ready(None);
        };
        self.pending_scene = None;
        let params = room_scene::scene_commit_params(content.as_ref(), &assets);
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let content_retry = content.clone();
        let assets_retry = assets.clone();
        cx.spawn(async move |this, cx| {
            let mut events = studio.backend().subscribe();
            let request = runtime.spawn({
                let studio = studio.clone();
                async move {
                    studio
                        .backend()
                        .request(SCENE_COMMIT, params)
                        .await
                        .map_err(|error| error.to_string())
                }
            });
            let mut settle = SceneCommitSettle::new();
            let deadline = tokio::time::Instant::now() + BACKEND_SCENE_COMMIT_WAIT;
            let mut request = request;
            let answer = loop {
                tokio::select! {
                    biased;
                    answer = &mut request => break answer,
                    event = events.recv() => {
                        match event {
                            Ok(BackendEvent::Untyped { event, payload })
                                if event == PRESENTATION_EVENT =>
                            {
                                if let Some((sid, scene)) =
                                    room_scene::presentation_scene(&payload)
                                {
                                    if sid == show_id {
                                        settle.note(scene);
                                    }
                                }
                            }
                            Err(RecvError::Closed) => break request.await,
                            Err(RecvError::Lagged(_)) | Ok(_) => {}
                        }
                    }
                }
            };
            let Ok(Ok(value)) = answer else {
                return None;
            };
            let answer = SceneCommitAnswer::from_value(&value);
            if !answer.held {
                let _ = this.update(cx, |host, _| {
                    host.pending_scene = Some((content_retry, assets_retry));
                });
                return None;
            }
            let Some(generation) = answer.generation else {
                return None;
            };
            settle.begin(generation, answer.status);
            while settle.needs_wait() {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(left) => break,
                    event = events.recv() => {
                        match event {
                            Ok(BackendEvent::Untyped { event, payload })
                                if event == PRESENTATION_EVENT =>
                            {
                                if let Some((sid, scene)) =
                                    room_scene::presentation_scene(&payload)
                                {
                                    if sid == show_id && settle.note(scene) {
                                        break;
                                    }
                                }
                            }
                            Err(RecvError::Closed) => break,
                            Err(RecvError::Lagged(_)) | Ok(_) => {}
                        }
                    }
                }
            }
            Some(settle.result())
        })
    }

    /// Resolve the Studio's current capture scene for the room canvas,
    /// translate it, and commit when room scenes are on. No-ops when the
    /// room is closed or scenes are off.
    pub fn send_studio_scene_to_room(
        &mut self,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Option<RoomSceneCommit>> {
        if !self.room_open() || !self.scenes_enabled() {
            return gpui::Task::ready(None);
        }
        let snapshot = self.studio.snapshot();
        let mut params =
            studio_scene_params(&snapshot.settings.capture, &snapshot.settings.studio, false);
        let orientation = if snapshot.settings.capture.layout.layout_preset.is_vertical() {
            SceneOrientation::V
        } else {
            SceneOrientation::H
        };
        let canvas = room_scene_canvas(orientation);
        if let Some(video) = params.video.as_mut() {
            video.width = canvas.width.round().max(1.0) as u32;
            video.height = canvas.height.round().max(1.0) as u32;
        }
        if let Some(background) = snapshot.scenes.working_background.clone() {
            params.background = serde_json::from_value(background).ok();
        }
        let animate = snapshot.settings.studio.animate_scene_changes();
        let camera_off = snapshot.settings.capture_doc["sources"]["cameraOff"]
            .as_bool()
            .unwrap_or(false);
        let media = self.room_media.clone();
        let layout_value = serde_json::to_value(&params.layout).unwrap_or(Value::Null);
        let background_value = params
            .background
            .as_ref()
            .and_then(|background| serde_json::to_value(background).ok());
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let Ok(resolve_params) = serde_json::to_value(&params) else {
            return gpui::Task::ready(None);
        };
        cx.spawn(async move |this, cx| {
            let resolve = runtime.spawn({
                let studio = studio.clone();
                async move {
                    studio
                        .backend()
                        .request(SCENE_RESOLVE, resolve_params)
                        .await
                        .map_err(|error| error.to_string())
                }
            });
            let Ok(Ok(value)) = resolve.await else {
                return None;
            };
            let Ok(resolved) = serde_json::from_value::<Scene>(value) else {
                return None;
            };
            let translation = cloud_scene_from_native(
                &resolved,
                &layout_value,
                background_value.as_ref(),
                orientation,
                None,
            );
            let camera_published = media.as_ref().is_some_and(|media| media.camera);
            let screen_published = media
                .as_ref()
                .and_then(|media| media.screen.as_ref())
                .is_some_and(|screen| screen.published);
            if let Err(message) = room_sources_ready(
                translation.needs.camera,
                translation.needs.screen,
                camera_published,
                camera_off,
                screen_published,
                false,
            ) {
                eprintln!("[videorc-app] Talk-show host: room scene: {message}");
                return None;
            }
            let content =
                room_scene::scene_content_for_orientation(orientation, translation.scene, animate);
            let Ok(task) = this.update(cx, |host, cx| {
                host.commit_scene(Some(content), Vec::new(), cx)
            }) else {
                return None;
            };
            task.await
        })
    }

    /// After a Studio layout commit, send the scene into the room when
    /// scenes are opted in.
    fn sync_room_scene_from_layout(&mut self, cx: &mut Context<Self>) {
        if !self.room_open() || !self.scenes_enabled() {
            return;
        }
        let revision = self.studio.layout_commit_revision();
        if revision == 0 || revision <= self.last_scene_layout_revision {
            return;
        }
        self.last_scene_layout_revision = revision;
        self.send_studio_scene_to_room(cx).detach();
    }

    fn retry_pending_scene(&mut self, cx: &mut Context<Self>) {
        let Some((content, assets)) = self.pending_scene.take() else {
            return;
        };
        self.commit_scene(content, assets, cx).detach();
    }
}

impl Render for TalkShowRoomHost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        // P395: no UI.
        div().id("talk-show-room-host").invisible()
    }
}
