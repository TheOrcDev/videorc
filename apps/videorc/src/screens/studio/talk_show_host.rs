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
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, RenderImage, Window, div, prelude::*};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use videorc_app_core::cloud_scene::types::SceneOrientation;
use videorc_app_core::cloud_scene::{
    ROOM_SCENES_OFF, ROOM_SOURCES_READY_POLL_MS, ROOM_SOURCES_READY_WAIT_MS, USE_SCENES,
    cloud_scene_from_native, room_scene_canvas, room_scene_message, room_sources_ready,
};
use videorc_app_core::guests::session::ControllerFacts;
use videorc_app_core::guests::view::stage_with_screen;
use videorc_app_core::guests::wire::{RoomStatus, Stage};
use videorc_app_core::library::cloud::{CloudRecordingStop, CloudRecordingWatch};
use videorc_app_core::studio::preview_scene::studio_scene_params;
use videorc_app_core::studio::room_background::{self, LiveClockMemory};
use videorc_app_core::studio::room_frames::{
    self, FrameCursor, FramePoll, RemoteSource, bgra_from_room_bmp,
};
use videorc_app_core::studio::room_media::{
    self, AVATAR_SET, CAMERA_SET, HTML_SET, MICROPHONE_SET, MONITOR_SET, PRESENTATION_EVENT,
    PRESENTATION_SET, RETURN_SET, RoomMedia, SCREEN_SET, STAGE_SET, host_shape_for_camera,
    stage_has_screen, stage_set_params,
};
use videorc_app_core::studio::room_scene::{
    self, BACKEND_SCENE_COMMIT_WAIT, PreparedBackgroundAsset, RoomSceneCommit, SCENE_COMMIT,
    SCENE_RESOLVE, SceneCommitAnswer, SceneCommitSettle, SceneContent,
};
use videorc_app_core::studio::room_screen_source::{
    RoomScreenSources, RoomScreenWant, room_screen_needs_switch_native, room_screen_want,
};
use videorc_app_core::studio::screen_views::TalkShowRoomView;
use videorc_app_core::{BackendEvent, ConnectionState};
use videorc_kit::toast::{ToastData, ToastKind};
use videorc_protocol::Scene;

use super::room_picture::{self, background_with_encoded};
use super::transport::AppStudio;
use crate::app::bridge::Mirror;

/// The tiles' polling pace: half the renderer's 30 fps until the Show
/// stage's cost is measured (each picture is a whole BMP decoded here).
const TILE_INTERVAL: Duration = Duration::from_millis(66);
/// One tile poll, its picture already decoded.
enum HostPoll {
    Frame(FrameCursor, Arc<RenderImage>),
    Empty,
    Unchanged,
    /// A picture whose BMP is not the room route's dialect: skipped, and
    /// named in the log (its header) so a tile that never draws says why.
    Undecodable(String),
}

/// A BMP's header in a few words, for the log: the header size, width,
/// height, bits and compression.
fn bmp_header_words(bmp: &[u8]) -> String {
    let u32_at = |at: usize| {
        bmp.get(at..at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
    };
    let i32_at = |at: usize| u32_at(at).map(|value| value as i32);
    let bits = bmp
        .get(28..30)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u16::from_le_bytes);
    format!(
        "{} bytes, magic {:?}, header {:?}, {:?}x{:?}, {:?} bits, compression {:?}",
        bmp.len(),
        bmp.get(0..2).map(String::from_utf8_lossy),
        u32_at(14),
        i32_at(18),
        i32_at(22),
        bits,
        u32_at(30),
    )
}

/// The poll's BMP as a picture GPUI draws (BGRA, as the route wrote it). A
/// BMP that does not decode is skipped like an unchanged one.
fn host_poll(poll: FramePoll) -> HostPoll {
    match poll {
        FramePoll::Frame { cursor, bmp } => bgra_from_room_bmp(&bmp)
            .and_then(|frame| image::RgbaImage::from_raw(frame.width, frame.height, frame.pixels))
            .map_or_else(
                || HostPoll::Undecodable(bmp_header_words(&bmp)),
                |pixels| {
                    HostPoll::Frame(
                        cursor,
                        Arc::new(RenderImage::new(vec![image::Frame::new(pixels)])),
                    )
                },
            ),
        FramePoll::Empty => HostPoll::Empty,
        FramePoll::Unchanged => HostPoll::Unchanged,
    }
}

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
    /// App user-data root: managed backgrounds live under `background-assets`.
    user_data_dir: PathBuf,
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
    /// Decoded once off the main thread and drawn as a `RenderImage`: a
    /// replaced or removed one goes through `cx.drop_image`, so its texture
    /// leaves the GPU (an `Image` source would keep every frame's decode in
    /// the asset cache and its texture in the atlas for good).
    frames: HashMap<(String, RemoteSource), (FrameCursor, Arc<RenderImage>)>,
    /// Each feed's last poll outcome, logged when it changes (a tile that
    /// stays empty names its cause once, not 15 times a second).
    poll_outcomes: HashMap<(String, RemoteSource), String>,
    /// The feeds last asked for, logged when the set changes.
    logged_wanted: Vec<(String, RemoteSource)>,
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
    /// Live background phase clock continued across scene sends (S14).
    live_background: Option<LiveClockMemory>,
}

impl TalkShowRoomHost {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        user_data_dir: PathBuf,
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
            loop {
                let state = watch.borrow().clone();
                if this
                    .update(cx, |host, cx| {
                        host.apply_gallery_room_media(state.gallery_room_media.clone(), cx);
                        host.sync_room(cx);
                    })
                    .is_err()
                {
                    break;
                }
                if watch.changed().await.is_err() {
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
                    if let Some((_, media)) = media
                        && host.room_open()
                        && host.room_media.as_ref() != Some(&media)
                    {
                        host.room_media = Some(media);
                        cx.notify();
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
                        let poll = room_frames::poll_remote_frame(
                            port,
                            &token,
                            &asked,
                            source,
                            after.as_ref(),
                        )
                        .await;
                        // The decode runs here, off the main thread.
                        poll.map(host_poll)
                    });
                    let poll = match job.await {
                        Ok(Ok(poll)) => poll,
                        Ok(Err(error)) => HostPoll::Undecodable(format!("poll failed: {error:#}")),
                        Err(error) => HostPoll::Undecodable(format!("poll task failed: {error}")),
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
            user_data_dir,
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
            poll_outcomes: HashMap::new(),
            logged_wanted: Vec::new(),
            monitor: false,
            listening: false,
            scenes_enabled: false,
            scenes_show_id: None,
            last_scene_layout_revision: 0,
            pending_scene: None,
            live_background: None,
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
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
    pub fn room_scenes_off_copy() -> (&'static str, &'static str) {
        (ROOM_SCENES_OFF, USE_SCENES)
    }

    fn press_toast(&self, id: &str, toast: ToastData, cx: &mut Context<Self>) {
        if let Some(hub) = cx
            .try_global::<crate::screens::notifications::Shared>()
            .map(|shared| shared.0.clone())
        {
            hub.update(cx, |hub, cx| hub.press_toast(id.to_string(), toast, cx));
        }
    }

    /// Toast while scenes are off: Use scenes turns them on and retries.
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
    fn toast_scenes_off(&self, cx: &mut Context<Self>) {
        let host = cx.entity().downgrade();
        let mut toast =
            ToastData::new(ToastKind::Warning, ROOM_SCENES_OFF).action(USE_SCENES, move |_, cx| {
                let _ = host.update(cx, |host, cx| {
                    host.set_scenes_enabled(true, cx);
                    host.send_studio_scene_to_room(cx).detach();
                });
            });
        toast.timeout = Some(Some(videorc_app_core::notices::WITH_DESCRIPTION));
        self.press_toast("room-scenes", toast, cx);
    }

    fn toast_room_scene(&self, message: &str, ok: bool, cx: &mut Context<Self>) {
        if message.is_empty() {
            return;
        }
        let kind = if ok {
            ToastKind::Info
        } else {
            ToastKind::Warning
        };
        self.press_toast("room-scene", ToastData::new(kind, message.to_string()), cx);
    }

    /// Explicit scene apply into the room (Electron `applySceneInRoom`): when
    /// scenes are off, toast with Use scenes; otherwise send.
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
    pub fn apply_studio_scene_to_room(
        &mut self,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Option<RoomSceneCommit>> {
        if !self.room_open() {
            return gpui::Task::ready(None);
        }
        if !self.scenes_enabled() {
            self.toast_scenes_off(cx);
            return gpui::Task::ready(None);
        }
        self.send_studio_scene_to_room(cx)
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

    /// Gallery/smoke seed (`gallery-seed-show-stage`): synthetic media so
    /// tiles and the host camera-off avatar paint without LiveKit.
    fn apply_gallery_room_media(&mut self, media: Option<RoomMedia>, cx: &mut Context<Self>) {
        match media {
            Some(media) if self.room_media.as_ref() != Some(&media) => {
                self.room_media = Some(media);
                cx.notify();
            }
            None if !self.room_open() && self.room_media.take().is_some() => {
                cx.notify();
            }
            _ => {}
        }
    }

    /// R3: a person's latest picture (`Camera` or `Screen`), or the Program
    /// monitor's (`Monitor`, any identity), while the room publishes it. The
    /// host notifies on every new picture.
    pub fn remote_frame(&self, identity: &str, source: RemoteSource) -> Option<Arc<RenderImage>> {
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
        if wanted != self.logged_wanted {
            eprintln!(
                "[videorc-app] room tiles wanted: {:?} (room media: {})",
                wanted,
                if self.room_media.is_some() {
                    "known"
                } else {
                    "none"
                }
            );
            self.logged_wanted = wanted.clone();
        }
        let gone: Vec<_> = self
            .frames
            .keys()
            .filter(|key| !wanted.contains(key))
            .cloned()
            .collect();
        for key in &gone {
            if let Some((_, frame)) = self.frames.remove(key) {
                cx.drop_image(frame, None);
            }
        }
        if !gone.is_empty() {
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
        poll: HostPoll,
        cx: &mut Context<Self>,
    ) {
        let outcome = match &poll {
            HostPoll::Frame(..) => "frames".to_string(),
            HostPoll::Empty => "no picture".to_string(),
            HostPoll::Unchanged => String::new(),
            HostPoll::Undecodable(why) => why.clone(),
        };
        if !outcome.is_empty()
            && self.poll_outcomes.get(&(identity.clone(), source)) != Some(&outcome)
        {
            eprintln!("[videorc-app] room tile {identity} {source:?}: {outcome}");
            self.poll_outcomes
                .insert((identity.clone(), source), outcome);
        }
        match poll {
            HostPoll::Frame(cursor, image) => {
                // The frame it replaces leaves the GPU.
                if let Some((_, before)) = self.frames.insert((identity, source), (cursor, image)) {
                    cx.drop_image(before, None);
                }
                cx.notify();
            }
            HostPoll::Empty => {
                if let Some((_, before)) = self.frames.remove(&(identity, source)) {
                    cx.drop_image(before, None);
                    cx.notify();
                }
            }
            HostPoll::Unchanged | HostPoll::Undecodable(_) => {}
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
        drop(self.request(SCREEN_SET, room_media::stop_screen_params()));
    }

    /// The whole stage in one frame (`cloud.stage.set`), as Electron's
    /// `setStage`. The Show stage uses this for layouts, Bring on / Send
    /// backstage, and Screens cards.
    pub fn set_stage(
        &self,
        stage: Stage,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Result<(), String>> {
        let camera_shape = self.studio.snapshot().settings.capture.layout.camera_shape;
        let shape = match camera_shape {
            videorc_protocol::CameraShape::Circle => Some("circle"),
            _ => Some("rounded"),
        };
        let params = stage_set_params(&stage, host_shape_for_camera(shape));
        let request = self.request(STAGE_SET, params);
        cx.background_executor().spawn(async move {
            match request.await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(error),
                Err(_) => Err("The room is not open.".into()),
            }
        })
    }

    /// Puts the host's published screen on the program (`cloud.stage.set`),
    /// as Electron's `applySceneToRoom` does when the stage names no screen.
    pub fn set_stage_with_host_screen(
        &self,
        cx: &mut Context<Self>,
    ) -> gpui::Task<Result<(), String>> {
        let Some(status) = self.studio.cloud_now().status else {
            return gpui::Task::ready(Err("The room is not open.".into()));
        };
        let Some(room) = status.room.as_ref().and_then(RoomStatus::from_value) else {
            return gpui::Task::ready(Err("The room is not open.".into()));
        };
        let Some(host) = self
            .talk_show
            .read(cx)
            .value()
            .host_identity
            .clone()
            .filter(|id| !id.is_empty())
        else {
            return gpui::Task::ready(Err("The room is not open.".into()));
        };
        let next = stage_with_screen(&room.stage, Some(host.as_str()));
        self.set_stage(next, cx)
    }

    /// The Program monitor on or off: the backend's room takes the runner's
    /// return (heard only with Listen), and the runner opens it. A managed
    /// show has no return: its monitor draws the stage (plan 234 D6).
    pub fn set_monitor(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.managed_show() {
            return;
        }
        self.monitor = enabled;
        // request() spawns on Tokio; dropping its JoinHandle detaches the RPC.
        drop(self.request(
            MONITOR_SET,
            room_media::monitor_params(enabled, self.listening),
        ));
        drop(self.request(RETURN_SET, room_media::return_params(enabled)));
        cx.notify();
    }

    /// Listen to the Program monitor's return (S1.8d d5).
    pub fn set_monitor_listening(&mut self, listening: bool, cx: &mut Context<Self>) {
        self.listening = listening;
        if self.monitor {
            drop(self.request(MONITOR_SET, room_media::monitor_params(true, listening)));
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
                for (_, (_, frame)) in self.frames.drain() {
                    cx.drop_image(frame, None);
                }
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
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
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
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
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
    #[allow(
        dead_code,
        reason = "Room parity API retained for remaining Show stage controls"
    )]
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
                                    && sid == show_id
                                {
                                    settle.note(scene);
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
            let generation = answer.generation?;
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
                                    && sid == show_id && settle.note(scene)
                                {
                                    break;
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
    /// then screen-switch → background prepare → readiness wait → commit
    /// when room scenes are on. No-ops when the room is closed or scenes
    /// are off. Surfaces result messages via toast when possible.
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
        let working_background = snapshot.scenes.working_background.clone();
        if let Some(background) = working_background.clone() {
            params.background = serde_json::from_value(background).ok();
        }
        let animate = snapshot.settings.studio.animate_scene_changes();
        let camera_off = snapshot.settings.capture_doc["sources"]["cameraOff"]
            .as_bool()
            .unwrap_or(false);
        let capture_off = !snapshot.settings.capture.layout.source_visibility.capture;
        let screen_id = snapshot.settings.capture.sources.screen_id.clone();
        let window_id = snapshot.settings.capture.sources.window_id.clone();
        let screen_want = room_screen_want(RoomScreenSources {
            screen_id: screen_id.as_deref(),
            window_id: window_id.as_deref(),
            capture_off,
        });
        let layout_value = serde_json::to_value(&params.layout).unwrap_or(Value::Null);
        let background_value = params
            .background
            .as_ref()
            .and_then(|background| serde_json::to_value(background).ok());
        let live_memory = self.live_background.clone();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let user_data_dir = self.user_data_dir.clone();
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
                background_value.as_ref().or(working_background.as_ref()),
                orientation,
                None,
            );

            // S14: scene's own screen/window on the room share first.
            if translation.needs.screen {
                match &screen_want {
                    RoomScreenWant::Unsupported { reason } => {
                        let _ = this.update(cx, |host, cx| {
                            host.toast_room_scene(reason, false, cx);
                        });
                        return None;
                    }
                    RoomScreenWant::Source {
                        native_id: Some(native_id),
                        source_kind,
                        ..
                    } => {
                        let current = this
                            .update(cx, |host, _| {
                                host.room_media
                                    .as_ref()
                                    .and_then(|media| media.screen.as_ref())
                                    .map(|screen| screen.source_id.clone())
                            })
                            .ok()
                            .flatten();
                        // share_screen takes the device-list native id
                        // (screen|window:screencapturekit:…); Err → leave the
                        // old share and refuse the scene (Electron adapter).
                        if room_screen_needs_switch_native(&screen_want, current.as_deref()) {
                            let share = this
                                .update(cx, |host, cx| host.share_screen(native_id, cx))
                                .ok()?;
                            if let Err(error) = share.await {
                                let message = format!(
                                    "The scene's {} couldn't be shared in the room: {error}",
                                    source_kind.as_str()
                                );
                                let _ = this.update(cx, |host, cx| {
                                    host.toast_room_scene(&message, false, cx);
                                });
                                return None;
                            }
                        }
                    }
                    RoomScreenWant::Source {
                        native_id: None, ..
                    }
                    | RoomScreenWant::Keep => {}
                }
            }

            // S14: background behind every source.
            let mut scene = translation.scene;
            let mut assets: Vec<PreparedBackgroundAsset> = Vec::new();
            let mut background_note: Option<String> = None;
            if let Some(background) = working_background.as_ref() {
                let picture = match room_picture::encode_working_background_picture(
                    background,
                    &user_data_dir,
                ) {
                    Ok(picture) => picture,
                    Err(note) => {
                        background_note = Some(format!(
                            "The background couldn't be sent to the room: {note}"
                        ));
                        None
                    }
                };
                if background_note.is_none() {
                    let prepared_bg = match picture.as_ref() {
                        Some(encoded) => background_with_encoded(background, encoded),
                        None => background.clone(),
                    };
                    let picture_bytes = picture.as_ref().map(|encoded| encoded.bytes.clone());
                    let prepared = this
                        .update(cx, |host, _| {
                            room_background::prepare_room_background(
                                &prepared_bg,
                                now_ms(),
                                host.live_background.as_ref().or(live_memory.as_ref()),
                                picture_bytes.as_deref(),
                            )
                        })
                        .ok()?;
                    match prepared {
                        Ok((prepared, memory)) => {
                            scene.background = Some(prepared.background);
                            if let Some(asset) = prepared.asset {
                                assets.push(asset);
                            }
                            let _ = this.update(cx, |host, _| {
                                if let Some(memory) = memory {
                                    host.live_background = Some(memory);
                                }
                            });
                        }
                        Err(note) => {
                            background_note = Some(note);
                        }
                    }
                }
            }

            // Atomic: sources the scene shows are in the room before it changes.
            let deadline =
                std::time::Instant::now() + Duration::from_millis(ROOM_SOURCES_READY_WAIT_MS);
            let ready_error = loop {
                let sample = this
                    .update(cx, |host, _| {
                        if !host.room_open() {
                            return Err("The room is not connected.");
                        }
                        let media = host.room_media.as_ref();
                        let camera_published = media.is_some_and(|media| media.camera);
                        let screen_published = media
                            .and_then(|media| media.screen.as_ref())
                            .is_some_and(|screen| screen.published);
                        let on_stage = host
                            .studio
                            .cloud_now()
                            .status
                            .as_ref()
                            .and_then(|status| status.room.as_ref())
                            .and_then(RoomStatus::from_value)
                            .is_some_and(|room| stage_has_screen(&room.stage));
                        room_sources_ready(
                            translation.needs.camera,
                            translation.needs.screen,
                            camera_published,
                            camera_off,
                            screen_published,
                            on_stage,
                        )
                    })
                    .ok()?;
                match sample {
                    Ok(()) => break None,
                    Err(message) if std::time::Instant::now() >= deadline => {
                        break Some(message.to_string());
                    }
                    Err(_) => {
                        cx.background_executor()
                            .timer(Duration::from_millis(ROOM_SOURCES_READY_POLL_MS))
                            .await;
                    }
                }
            };
            if let Some(message) = ready_error {
                let _ = this.update(cx, |host, cx| {
                    host.toast_room_scene(&message, false, cx);
                });
                return None;
            }

            // The scene's screen box shows the stage's screen: the host's,
            // unless a guest's is already up (Electron applySceneToRoom).
            if translation.needs.screen {
                let uplift = this
                    .update(cx, |host, _| {
                        let room = host
                            .studio
                            .cloud_now()
                            .status
                            .as_ref()
                            .and_then(|status| status.room.as_ref())
                            .and_then(RoomStatus::from_value);
                        let screen_published = host
                            .room_media
                            .as_ref()
                            .and_then(|media| media.screen.as_ref())
                            .is_some_and(|screen| screen.published);
                        room.is_some_and(|room| !stage_has_screen(&room.stage)) && screen_published
                    })
                    .ok()?;
                if uplift {
                    let set = this
                        .update(cx, |host, cx| host.set_stage_with_host_screen(cx))
                        .ok()?;
                    if let Err(error) = set.await {
                        let message = format!("The room's screen couldn't be put up: {error}");
                        let _ = this.update(cx, |host, cx| {
                            host.toast_room_scene(&message, false, cx);
                        });
                        return None;
                    }
                }
            }

            let content = room_scene::scene_content_for_orientation(orientation, scene, animate);
            let Ok(task) = this.update(cx, |host, cx| host.commit_scene(Some(content), assets, cx))
            else {
                return None;
            };
            let commit = task.await;
            let _ = this.update(cx, |host, cx| {
                let mut parts: Vec<String> = Vec::new();
                if let Some(commit) = commit.as_ref()
                    && let Some(message) =
                        room_scene_message(commit.state, commit.reason.as_deref())
                {
                    parts.push(message);
                }

                if let Some(note) = background_note {
                    parts.push(note);
                }
                if !parts.is_empty() {
                    let ok = commit.as_ref().is_some_and(|commit| {
                        matches!(
                            commit.state,
                            videorc_app_core::cloud_scene::RoomSceneCommitState::Applied
                                | videorc_app_core::cloud_scene::RoomSceneCommitState::Preview
                        )
                    });
                    host.toast_room_scene(&parts.join(" "), ok, cx);
                }
            });
            commit
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
