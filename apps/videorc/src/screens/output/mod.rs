//! The Output page (plan 260 Phase 3, L4): local recording, Clips, Videorc
//! Camera, and where recordings go. Words and state come from
//! `videorc_app_core::studio::{clips, recordings_folder, virtual_camera,
//! capture_config, inspector}`; this module draws them with `videorc_kit`.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, Focusable, Keystroke, PathPromptOptions,
    SharedString, Subscription, WeakEntity, Window, div, prelude::*, px,
};
use serde_json::{Value, json};
use videorc_app_core::account::entitlements::{
    EntitlementGate, ProfileKind, video_profile_entitlement_gate,
};
use videorc_app_core::desktop::camera_extension::camera_extension_approval_url;
use videorc_app_core::desktop::{accelerator as accel, global_shortcuts as keys};
use videorc_app_core::protocol::{
    EncoderPreferenceState, VideoSettings, VirtualCameraStatus, WindowsH264EncoderPreference,
};
use videorc_app_core::shortcuts as recorder;
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::capture_config::{self, VIDEO_PRESETS};
use videorc_app_core::studio::clips as clips_copy;
use videorc_app_core::studio::cloud_clips::{
    self as cloud_clips, CloudClipJob, CloudClipsStatus, JobAction, Orientation,
};
use videorc_app_core::studio::health_page::format_bitrate;
use videorc_app_core::studio::inspector::format_video_quality;
use videorc_app_core::studio::output_quality::{self as quality, Compatibility};
use videorc_app_core::studio::performance_check::{self as perf, LineTone, PerformanceLine};
use videorc_app_core::studio::recordings_folder::{self, StoredFolder, copy as folder_copy};
use videorc_app_core::studio::virtual_camera::{
    CameraAction, CameraTone, OutputCameraView, VIDEORC_CAMERA,
};
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::field::{Field, FieldError, FieldGroup};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::GroupedList;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::select::{Select, SelectOption};
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::shortcut_recorder::ShortcutRecorder;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::toggle_group::{ToggleGroup, ToggleItem};
use videorc_kit::tokens::text;

use gpui_base::input::InputEvent;
use videorc_kit::input::{Input, InputState};

use crate::app::hotkeys::{self, Hotkeys};
use crate::app::shell::Shell;

pub type AppStudio = Studio<BackendClient>;

const SAVE_RECORDING_ON: &str =
    "Each recording is saved as an MP4 in your recordings folder and listed in Library.";
const SAVE_RECORDING_OFF: &str =
    "Go Live streams without saving a file. Turn this on to save one and choose its quality.";
const LOCAL_DESCRIPTION: &str =
    "Videorc saves each recording as an MP4. Finished recordings are in Library.";
const SEPARATE_DESCRIPTION: &str = "Also saves a Screen file with the system audio track at this recording size, and a Camera file with the microphone track at the camera's own size, beside the Combined recording. A source that is off records as silence. Streams and preview stay composed.";
const SESSION_LOCK: &str =
    "Locked while you're recording or live. Changes apply the next time you record or go live.";
const KEEP_ORIGINAL_DESCRIPTION: &str =
    "Also keeps the capture MKV, with lossless audio, beside the MP4. Uses more disk space.";
const CAMERA_SECTION_TITLE: &str = "Camera for other apps";
const CAMERA_SECTION_DESCRIPTION: &str =
    "Your program as a camera other apps can choose, the way the Preview shows it.";
const CAMERA_DESCRIPTION: &str = "Shows your program as a camera in Meet, Zoom, Teams and Discord. No sound. Meet shows you a mirror image; everyone else sees it right.";
const FOLDER_SECTION_DESCRIPTION: &str =
    "The folder each recording is saved to, and what Videorc keeps there.";
const ENCODER_LABEL: &str = "Fallback video encoder";
const ENCODER_DESCRIPTION: &str = "Used only when this PC's hardware encoder can't start. Intel Quick Sync encodes on the Intel graphics chip instead of the processor, and falls back to software if its own check fails.";
const ENCODER_ENV_DESCRIPTION: &str = "Set by a launch setting for this run.";
/// The two clip keys (plan 199 D5): the 30-second clip, then the minute.
const CLIP_KEY_ACTIONS: [&str; 2] = ["clip-mark", "clip-mark-long"];
/// The recorder gives up after this long without a key (Settings' rule).
const RECORDER_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

fn encoder_preference_value(preference: WindowsH264EncoderPreference) -> SharedString {
    SharedString::from(match preference {
        WindowsH264EncoderPreference::Auto => "auto",
        WindowsH264EncoderPreference::QuickSync => "quick-sync",
        WindowsH264EncoderPreference::Software => "software",
    })
}

fn parse_encoder_preference(value: &str) -> Option<WindowsH264EncoderPreference> {
    match value {
        "auto" => Some(WindowsH264EncoderPreference::Auto),
        "quick-sync" => Some(WindowsH264EncoderPreference::QuickSync),
        "software" => Some(WindowsH264EncoderPreference::Software),
        _ => None,
    }
}

/// `recordingVideoPresetOptions` (`lib/capture.ts`), in its order.
const RECORDING_PRESETS: &[&str] = &[
    "record-4k30",
    "record-4k60-experimental",
    "tutorial-1440p30",
    "tutorial-1080p30",
    "tutorial-720p30",
    "tutorial-540p30",
    "vertical-1080x1920",
];

const HORIZONTAL_RESOLUTIONS: &[(u32, u32, &str)] = &[
    (3840, 2160, "4K"),
    (2560, 1440, "1440p"),
    (1920, 1080, "1080p"),
    (1280, 720, "720p"),
];

const VERTICAL_RESOLUTIONS: &[(u32, u32, &str)] = &[
    (2160, 3840, "4K"),
    (1440, 2560, "1440p"),
    (1080, 1920, "1080p"),
    (720, 1280, "720p"),
];

fn preset_id(preset: &videorc_app_core::protocol::VideoPreset) -> String {
    serde_json::to_value(preset)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "custom".into())
}

/// The preset's words as Electron's preset options say them:
/// `formatVideoQuality(preset, { bitrate: true })` ("1080p · 30 fps ·
/// 6 Mbps"), with the experimental and YouTube names theirs.
fn preset_label(name: &str) -> String {
    match capture_config::video_preset(name) {
        Some(value) => {
            let width = value["width"].as_u64().unwrap_or(0) as u32;
            let height = value["height"].as_u64().unwrap_or(0) as u32;
            let fps = value["fps"].as_u64().unwrap_or(0) as u32;
            let mut words = format_video_quality(width, height, fps);
            if let Some(rate) = value["bitrateKbps"]
                .as_f64()
                .and_then(|kbps| format_bitrate(Some(kbps)))
            {
                words = format!("{words} · {rate}");
            }
            if name.ends_with("-experimental") {
                format!("{words} · experimental")
            } else if name.starts_with("stream-youtube-") {
                format!("YouTube · {words}")
            } else {
                words
            }
        }
        None => name.to_string(),
    }
}

fn same_size(a_w: u32, a_h: u32, b_w: u32, b_h: u32) -> bool {
    a_w.max(a_h) == b_w.max(b_h) && a_w.min(a_h) == b_w.min(b_h)
}

fn pick_recording_resolution(
    video: &videorc_app_core::protocol::VideoSettings,
    width: u32,
    height: u32,
) -> Value {
    let recording: Vec<_> = VIDEO_PRESETS
        .iter()
        .filter(|(preset, ..)| preset.starts_with("tutorial-") || preset.starts_with("record-"))
        .copied()
        .collect();
    let standard_rate = recording.iter().any(|&(_, w, h, fps, bitrate)| {
        same_size(w, h, video.width, video.height)
            && fps == video.fps
            && bitrate == video.bitrate_kbps
    });
    let next = recording
        .iter()
        .find(|&&(_, w, h, fps, _)| same_size(w, h, width, height) && fps == video.fps);
    json!({
        "preset": "custom",
        "width": width,
        "height": height,
        "fps": video.fps,
        "bitrateKbps": if standard_rate {
            next.map(|(.., bitrate)| *bitrate).unwrap_or(video.bitrate_kbps)
        } else {
            video.bitrate_kbps
        },
    })
}

fn recording_preset_options(current: &str, vertical: bool) -> Vec<(String, String)> {
    let mut options: Vec<(String, String)> = RECORDING_PRESETS
        .iter()
        .filter_map(|name| {
            let (_, width, height, ..) = VIDEO_PRESETS
                .iter()
                .find(|(preset, ..)| *preset == *name)
                .copied()?;
            let orientation_fits = if vertical {
                height > width
            } else {
                width >= height
            };
            orientation_fits.then(|| ((*name).to_string(), preset_label(name)))
        })
        .collect();
    if current == "custom" || options.iter().any(|(value, _)| value == current) {
        return options;
    }
    options.push((current.to_string(), preset_label(current)));
    options
}

#[derive(Debug, Clone, PartialEq)]
struct OutputModel {
    session_locked: bool,
    record_enabled: bool,
    separate_enabled: bool,
    separate_supported: bool,
    quality_locked: bool,
    preset: String,
    preset_options: Vec<(String, String)>,
    vertical: bool,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
    quality_label: String,
    clips_on: bool,
    clips_description: String,
    disk_estimate: String,
    disk_detail: String,
    folder: recordings_folder::RecordingsFolderView,
    folder_path: Option<PathBuf>,
    keep_original: bool,
    camera: OutputCameraView,
    connected: bool,
    stream_enabled: bool,
    video: VideoSettings,
    compatibility: Compatibility,
    performance_line: Option<PerformanceLine>,
    /// The next take also writes the Screen and Camera files (the check
    /// counts their encoders, plan 200 D4).
    separate_files: bool,
}

impl OutputModel {
    fn of(snapshot: &StudioSnapshot, camera: Option<&VirtualCameraStatus>) -> Self {
        let capture = &snapshot.settings.capture;
        let video = &capture.video;
        let vertical = capture.layout.layout_preset.is_vertical();
        let preset = preset_id(&video.preset);
        let session_locked =
            snapshot.session.phase.is_active() && !snapshot.session.status.replay_only;
        let record_enabled = capture.record_enabled;
        let quality_locked = session_locked || !record_enabled;
        let (disk_estimate, disk_detail) = clips_copy::disk_use(
            video.bitrate_kbps,
            &format_video_quality(video.width, video.height, video.fps),
        );
        let folder_state = &snapshot.recordings_folder;
        Self {
            session_locked,
            record_enabled,
            separate_enabled: capture.separate_source_recordings.enabled,
            separate_supported: cfg!(target_os = "macos"),
            quality_locked,
            preset_options: recording_preset_options(&preset, vertical),
            preset,
            vertical,
            width: video.width,
            height: video.height,
            fps: video.fps,
            bitrate_kbps: video.bitrate_kbps,
            quality_label: format_video_quality(video.width, video.height, video.fps),
            clips_on: snapshot.clips.on,
            clips_description: snapshot.clips.switch_description.clone(),
            disk_estimate,
            disk_detail,
            folder: folder_state.view(),
            folder_path: folder_state
                .folder
                .as_ref()
                .map(|folder| folder.path.clone()),
            keep_original: snapshot.settings.studio.keep_original_recording(),
            camera: OutputCameraView::of(
                camera,
                matches!(snapshot.connection, Connection::Connected { .. }),
                hotkeys::node_platform(),
            ),
            connected: matches!(snapshot.connection, Connection::Connected { .. }),
            stream_enabled: capture.stream_enabled,
            video: video.clone(),
            compatibility: quality::compatibility(
                hotkeys::node_platform(),
                record_enabled,
                capture.stream_enabled,
                video,
            ),
            performance_line: perf::performance_line(
                &snapshot.performance,
                video,
                videorc_app_core::format::device_noun(hotkeys::node_platform()),
                snapshot.clips.on,
            ),
            separate_files: cfg!(target_os = "macos")
                && record_enabled
                && capture.separate_source_recordings.enabled,
        }
    }
}

/// The clip-key recorder (Settings → Shortcuts' rules): one armed row.
#[derive(Default)]
struct Recorder {
    action: Option<String>,
    interceptor: Option<Subscription>,
    generation: u64,
    message: Option<(String, String)>,
    /// The modifiers held while armed (`acceleratorModifiersLabel`, "⇧⌘"),
    /// shown before the key lands; empty when none are.
    held: String,
}

/// Cloud Clips while a room is open: the show it reads, what it read, and
/// the one action in flight.
#[derive(Default)]
struct CloudClips {
    show_id: Option<String>,
    status: Option<CloudClipsStatus>,
    jobs: Vec<CloudClipJob>,
    orientation: Orientation,
    busy: bool,
    error: Option<String>,
    reading: bool,
}

pub struct OutputPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    hotkeys: Hotkeys,
    model: OutputModel,
    camera_status: Option<VirtualCameraStatus>,
    camera_pending: bool,
    camera_action: Option<CameraAction>,
    camera_error: Option<String>,
    encoder: Option<EncoderPreferenceState>,
    command_copied: bool,
    recorder: Recorder,
    cloud: CloudClips,
    active: bool,
    /// The four typed fields, made with the first render (they need a
    /// window), and the refusal under one of them with the canvas it was
    /// refused against.
    fields: Option<Vec<(quality::Field, Entity<InputState>)>>,
    field_refusal: Option<(quality::Field, &'static str, (u32, u32))>,
    check_error: Option<String>,
    #[allow(dead_code)]
    shell: Option<WeakEntity<Shell>>,
    facts_ticket: u64,
}

/// The open room's show: cloud Clips replaces the native section while it
/// is open (`cloudStatus.room.phase === 'open' && cloudStatus.show`).
fn open_room_show(studio: &AppStudio) -> Option<String> {
    let status = studio.cloud_now().status?;
    let open = status
        .room
        .as_ref()
        .is_some_and(|room| room["phase"].as_str() == Some("open"));
    open.then_some(status.show?.id)
}

impl OutputPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        hotkeys: Hotkeys,
        cx: &mut Context<Self>,
    ) -> Self {
        let model = OutputModel::of(&*studio.watch().borrow(), None);
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut cloud_rx = studio_watch.cloud();
            let mut events = studio_watch.backend().subscribe();
            loop {
                let event = tokio::select! {
                    changed = studio_rx.changed() => {
                        if changed.is_err() { break; }
                        None
                    }
                    changed = cloud_rx.changed() => {
                        if changed.is_err() { break; }
                        None
                    }
                    event = events.recv() => match event {
                        Ok(event) => Some(event),
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
                    },
                };
                let snapshot = studio_rx.borrow().clone();
                let _ = this.update(cx, |panel, cx| {
                    if let Some(videorc_app_core::BackendEvent::Untyped { event, payload }) = event
                        && event == "virtualCamera.changed"
                    {
                        panel.camera_status = serde_json::from_value(payload).ok();
                    }
                    panel.rebuild(&snapshot, cx);
                    panel.follow_room(cx);
                });
            }
        })
        .detach();
        // The plan's lock reads the caption feed's entitlements.
        if let Some(feed) = crate::screens::captions::feed::feed(cx) {
            cx.observe(&feed, |_, _, cx| cx.notify()).detach();
        }
        // Cloud Clips reads every two seconds while the page shows it.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(cloud_clips::READ_EVERY)
                    .await;
                if this
                    .update(cx, |panel, cx| panel.read_cloud_clips(cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let mut panel = Self {
            studio,
            runtime,
            hotkeys,
            model,
            camera_status: None,
            camera_pending: false,
            camera_action: None,
            camera_error: None,
            encoder: None,
            command_copied: false,
            recorder: Recorder::default(),
            cloud: CloudClips::default(),
            active: false,
            fields: None,
            field_refusal: None,
            check_error: None,
            shell: None,
            facts_ticket: 0,
        };
        panel.refresh_encoder(cx);
        panel
    }

    pub fn bind_shell(&mut self, shell: WeakEntity<Shell>) {
        self.shell = Some(shell);
    }

    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.active = active;
        if active {
            self.refresh_camera(cx);
            self.schedule_folder_facts(cx);
            self.follow_room(cx);
            self.read_cloud_clips(cx);
            self.refresh_encoder(cx);
        } else {
            self.disarm_recorder(cx);
        }
    }

    fn refresh_encoder(&mut self, cx: &mut Context<Self>) {
        if !cfg!(windows) {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let state = runtime
                .spawn(async move {
                    let answer = studio
                        .backend()
                        .request("encoder.preference.get", Value::Null)
                        .await
                        .ok()?;
                    serde_json::from_value::<EncoderPreferenceState>(answer).ok()
                })
                .await
                .ok()
                .flatten();
            let _ = this.update(cx, |panel, cx| {
                if panel.encoder != state {
                    panel.encoder = state;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn set_encoder_preference(
        &mut self,
        preference: WindowsH264EncoderPreference,
        cx: &mut Context<Self>,
    ) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let state = runtime
                .spawn(async move {
                    let answer = studio
                        .backend()
                        .request(
                            "encoder.preference.set",
                            json!({ "preference": preference }),
                        )
                        .await
                        .ok()?;
                    serde_json::from_value::<EncoderPreferenceState>(answer).ok()
                })
                .await
                .ok()
                .flatten();
            let _ = this.update(cx, |panel, cx| {
                if let Some(state) = state {
                    panel.encoder = Some(state);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    // ── Cloud Clips (P666–P668) ──────────────────────────────────────────

    /// A new room (or none) starts the section over, as Electron keys it
    /// by the show.
    fn follow_room(&mut self, cx: &mut Context<Self>) {
        let show = open_room_show(&self.studio);
        if show != self.cloud.show_id {
            self.cloud = CloudClips {
                show_id: show,
                ..CloudClips::default()
            };
            self.read_cloud_clips(cx);
            cx.notify();
        }
    }

    fn read_cloud_clips(&mut self, cx: &mut Context<Self>) {
        let Some(show_id) = self.cloud.show_id.clone() else {
            return;
        };
        if !self.active || self.cloud.reading {
            return;
        }
        self.cloud.reading = true;
        let studio = self.studio.clone();
        let read_show = show_id.clone();
        let job = self
            .runtime
            .spawn(async move { studio.cloud_clips_read(&read_show).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await.ok().flatten();
            let _ = this.update(cx, |panel, cx| {
                panel.cloud.reading = false;
                if panel.cloud.show_id.as_deref() != Some(show_id.as_str()) {
                    return;
                }
                let (status, jobs) = match answer {
                    Some((status, jobs)) => (Some(status), jobs),
                    None => (None, panel.cloud.jobs.clone()),
                };
                if panel.cloud.status != status || panel.cloud.jobs != jobs {
                    panel.cloud.status = status;
                    panel.cloud.jobs = jobs;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// One cloud Clips action at a time; a refusal says the one thing
    /// Electron said, and a new status replaces the read one.
    fn cloud_act<F, Fut>(&mut self, run: F, cx: &mut Context<Self>)
    where
        F: FnOnce(Arc<AppStudio>, String) -> Fut,
        Fut:
            std::future::Future<Output = Result<Option<CloudClipsStatus>, String>> + Send + 'static,
    {
        let Some(show_id) = self.cloud.show_id.clone() else {
            return;
        };
        if self.cloud.busy {
            return;
        }
        self.cloud.busy = true;
        self.cloud.error = None;
        let job = self
            .runtime
            .spawn(run(self.studio.clone(), show_id.clone()));
        cx.spawn(async move |this, cx| {
            let result = job
                .await
                .unwrap_or_else(|_| Err(cloud_clips::copy::ACTION_FAILED.into()));
            let _ = this.update(cx, |panel, cx| {
                panel.cloud.busy = false;
                if panel.cloud.show_id.as_deref() != Some(show_id.as_str()) {
                    return;
                }
                match result {
                    Ok(Some(status)) => panel.cloud.status = Some(status),
                    Ok(None) => {}
                    Err(_) => panel.cloud.error = Some(cloud_clips::copy::ACTION_FAILED.into()),
                }
                panel.read_cloud_clips(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn enable_cloud_clips(&mut self, cx: &mut Context<Self>) {
        let orientation = self.cloud.orientation;
        self.cloud_act(
            move |studio, show| async move {
                studio
                    .cloud_clips_enable(&show, orientation)
                    .await
                    .map(Some)
            },
            cx,
        );
    }

    fn disable_cloud_clips(&mut self, cx: &mut Context<Self>) {
        let Some(generation) =
            cloud_clips::disable_generation(self.cloud.status.as_ref()).map(str::to_string)
        else {
            return;
        };
        self.cloud_act(
            move |studio, show| async move {
                studio
                    .cloud_clips_disable(&show, &generation)
                    .await
                    .map(Some)
            },
            cx,
        );
    }

    fn cloud_job_action(
        &mut self,
        action: JobAction,
        job_id: String,
        marker_id: String,
        cx: &mut Context<Self>,
    ) {
        let generation = self
            .cloud
            .status
            .as_ref()
            .and_then(|status| status.generation.clone());
        self.cloud_act(
            move |studio, show| async move {
                let done: Result<(), String> = match action {
                    JobAction::Cancel => studio.cloud_clips_cancel(&job_id).await,
                    JobAction::Discard => studio.cloud_clips_discard(&job_id).await,
                    JobAction::Retry => match generation {
                        Some(generation) => {
                            studio
                                .cloud_clips_retry(&show, &marker_id, &generation)
                                .await
                        }
                        None => Err(cloud_clips::copy::ACTION_FAILED.into()),
                    },
                };
                done.map(|()| None)
            },
            cx,
        );
    }

    // ── The clip keys (P663/P664) ────────────────────────────────────────

    fn shortcut_config(&self) -> keys::GlobalShortcutsConfig {
        serde_json::from_value(self.studio.snapshot().settings.studio.global_shortcuts())
            .unwrap_or_default()
    }

    fn shortcut_scenes(&self) -> Vec<(String, String)> {
        self.studio
            .snapshot()
            .scenes
            .scenes
            .iter()
            .map(|scene| (scene.id.clone(), scene.name.clone()))
            .collect()
    }

    fn disarm_recorder(&mut self, cx: &mut Context<Self>) {
        if self.recorder.action.take().is_some() {
            self.recorder.interceptor = None;
            self.recorder.generation += 1;
            self.recorder.held.clear();
            self.hotkeys.set_recorder_armed(false);
            cx.notify();
        }
    }

    fn arm_recorder(&mut self, action: String, cx: &mut Context<Self>) {
        if !hotkeys::supported(&action) {
            return;
        }
        self.disarm_recorder(cx);
        self.recorder.message = None;
        self.recorder.action = Some(action);
        self.hotkeys.set_recorder_armed(true);
        let weak = cx.entity().downgrade();
        // Interception runs before the keymap, so navigation and Record do
        // not fire while the key is being recorded.
        self.recorder.interceptor = Some(cx.intercept_keystrokes(move |event, _, cx| {
            let _ = weak.update(cx, |this, cx| {
                if this.recorder.action.is_some() {
                    cx.stop_propagation();
                    this.record_key(&event.keystroke, cx);
                }
            });
        }));
        let generation = self.recorder.generation;
        cx.spawn(async move |entity, cx| {
            cx.background_executor().timer(RECORDER_IDLE).await;
            let _ = entity.update(cx, |this, cx| {
                if this.recorder.generation == generation {
                    this.disarm_recorder(cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    /// The modifiers held while armed, as the recorder shows them ("⇧⌘…").
    fn hold_modifiers(&mut self, modifiers: &gpui::Modifiers, cx: &mut Context<Self>) {
        if self.recorder.action.is_none() {
            return;
        }
        let platform = Some(hotkeys::node_platform());
        // A key-up reads as the modifiers alone (`shortcutRecorderStep`).
        let input = accel::KeyInput {
            code: String::new(),
            meta: modifiers.platform,
            control: modifiers.control,
            alt: modifiers.alt,
            shift: modifiers.shift,
            key_up: true,
        };
        let held = match recorder::shortcut_recorder_step(&input, platform, |_| None) {
            recorder::RecorderStep::Held(held) => {
                accel::accelerator_modifiers_label(&held, platform)
            }
            _ => String::new(),
        };
        if held != self.recorder.held {
            self.recorder.held = held;
            cx.notify();
        }
    }

    fn record_key(&mut self, key: &Keystroke, cx: &mut Context<Self>) {
        let Some(action) = self.recorder.action.clone() else {
            return;
        };
        let platform = Some(hotkeys::node_platform());
        let config = self.shortcut_config();
        let scenes = self.shortcut_scenes();
        let input = accel::KeyInput {
            code: accel::code_for_gpui_key(&key.key),
            meta: key.modifiers.platform,
            control: key.modifiers.control,
            alt: key.modifiers.alt,
            shift: key.modifiers.shift,
            key_up: false,
        };
        let step = recorder::shortcut_recorder_step(&input, platform, |value| {
            accel::global_shortcut_taken_reason(&config, value, &action, platform, &scenes)
        });
        let value = match step {
            recorder::RecorderStep::Commit(value) => value,
            recorder::RecorderStep::Clear => String::new(),
            recorder::RecorderStep::Cancel => {
                self.disarm_recorder(cx);
                return;
            }
            recorder::RecorderStep::Held(_) => {
                self.hold_modifiers(&key.modifiers, cx);
                return;
            }
            recorder::RecorderStep::Reject(message) => {
                self.recorder.message = Some((action, message));
                cx.notify();
                return;
            }
        };
        self.disarm_recorder(cx);
        self.save_clip_key(action, value, cx);
    }

    /// Saves a clip key (empty clears it); Settings applies the saved keys
    /// to the OS on the change.
    fn save_clip_key(&mut self, action: String, value: String, cx: &mut Context<Self>) {
        self.recorder.message = None;
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_studio_settings(|settings| {
                    let config =
                        serde_json::from_value(settings.global_shortcuts()).unwrap_or_default();
                    settings.set(
                        keys::SETTINGS_FIELD,
                        serde_json::to_value(keys::with_global_shortcut(&config, &action, &value))
                            .unwrap_or_default(),
                    );
                })
                .await;
        });
        cx.notify();
    }

    fn rebuild(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let next = OutputModel::of(snapshot, self.camera_status.as_ref());
        if self.model != next {
            let folder_changed = self.model.folder_path != next.folder_path;
            self.model = next;
            if folder_changed {
                self.schedule_folder_facts(cx);
            }
            cx.notify();
        }
    }

    // ── Typed fields (P659) ──────────────────────────────────────────────

    /// The four inputs, made once a window is there. Enter and leaving the
    /// field commit; typing commits nothing.
    fn ensure_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.fields.is_some() {
            return;
        }
        let mut fields = Vec::new();
        for (field, label) in quality::FIELDS {
            let state = cx.new(|cx| InputState::new(window, cx).placeholder(label));
            cx.subscribe(&state, move |this, _, event: &InputEvent, cx| match event {
                InputEvent::PressEnter { .. } | InputEvent::Blur => this.commit_field(field, cx),
                InputEvent::Change => {
                    if this
                        .field_refusal
                        .is_some_and(|(refused, ..)| refused == field)
                    {
                        this.field_refusal = None;
                        cx.notify();
                    }
                }
                _ => {}
            })
            .detach();
            fields.push((field, state));
        }
        self.fields = Some(fields);
    }

    fn field_state(&self, field: quality::Field) -> Option<Entity<InputState>> {
        self.fields
            .as_ref()?
            .iter()
            .find(|(candidate, _)| *candidate == field)
            .map(|(_, state)| state.clone())
    }

    /// Each unfocused field shows the setting.
    fn sync_fields(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(fields) = self.fields.clone() else {
            return;
        };
        for (field, state) in fields {
            let value = field.of(&self.model.video).to_string();
            let focused = state.read(cx).focus_handle(cx).is_focused(window);
            if !focused && state.read(cx).value().to_string() != value {
                state.update(cx, |state, cx| state.set_value(value, window, cx));
            }
        }
    }

    fn commit_field(&mut self, field: quality::Field, cx: &mut Context<Self>) {
        let Some(state) = self.field_state(field) else {
            return;
        };
        if self.model.quality_locked {
            return;
        }
        let draft = state.read(cx).value().to_string();
        let video = self.model.video.clone();
        match quality::commit(&video, field, &draft, self.model.vertical) {
            quality::Commit::Unchanged => {}
            quality::Commit::Refused(rule) => {
                self.field_refusal = Some((field, rule, (video.width, video.height)));
                cx.notify();
            }
            quality::Commit::Value(value) => {
                self.field_refusal = None;
                let studio = self.studio.clone();
                self.run_studio(async move {
                    let _ = studio
                        .update_capture_config(|config| {
                            capture_config::set_path(
                                config,
                                &["video", field.key()],
                                Some(json!(value)),
                            );
                            capture_config::set_path(
                                config,
                                &["video", "preset"],
                                Some(json!("custom")),
                            );
                        })
                        .await;
                });
                self.push_model(cx);
            }
        }
    }

    /// Escape: the field shows the setting again.
    fn revert_field(&mut self, field: quality::Field, window: &mut Window, cx: &mut Context<Self>) {
        let Some(state) = self.field_state(field) else {
            return;
        };
        let value = field.of(&self.model.video).to_string();
        state.update(cx, |state, cx| state.set_value(value, window, cx));
        self.field_refusal = None;
        cx.notify();
    }

    // ── The performance check (P655) ─────────────────────────────────────

    fn run_performance_check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.model.session_locked {
            return;
        }
        let scale = window.scale_factor();
        let display = window.display(cx).map(|display| {
            let size = display.bounds().size;
            (
                (f32::from(size.width) * scale).round() as u32,
                (f32::from(size.height) * scale).round() as u32,
            )
        });
        let params = perf::ceiling(&self.model.video, display, self.model.separate_files);
        self.check_error = None;
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.run_performance_check(params).await });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.check_error = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(message)) => Some(format!("Couldn't check this computer. {message}")),
                    Err(_) => Some("Couldn't check this computer.".into()),
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    // ── The plan's lock (P656) ───────────────────────────────────────────

    /// `videoProfileEntitlementGate({ kind: 'recording', video })`, over the
    /// entitlements the caption feed reads on every connection.
    fn profile_gate(&self, cx: &App) -> EntitlementGate {
        let entitlements = crate::screens::captions::feed::feed(cx)
            .and_then(|feed| feed.read(cx).entitlements().cloned());
        video_profile_entitlement_gate(
            entitlements.as_ref(),
            ProfileKind::Recording,
            &self.model.video,
        )
    }

    fn push_model(&mut self, cx: &mut Context<Self>) {
        self.rebuild(&*self.studio.watch().borrow(), cx);
    }

    fn run_studio<F>(&self, work: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.runtime.spawn(work);
    }

    fn schedule_folder_facts(&mut self, cx: &mut Context<Self>) {
        self.facts_ticket = self.facts_ticket.wrapping_add(1);
        let ticket = self.facts_ticket;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio.read_recordings_folder_facts().await;
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.facts_ticket == ticket {
                    panel.push_model(cx);
                }
            });
        })
        .detach();
    }

    fn set_record_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.model.session_locked {
            return;
        }
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_capture_config(|config| {
                    capture_config::set_path(
                        config,
                        &["recordEnabled"],
                        Some(Value::Bool(enabled)),
                    );
                })
                .await;
        });
        self.push_model(cx);
    }

    fn set_separate_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.model.quality_locked || !self.model.separate_supported {
            return;
        }
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_capture_config(|config| {
                    capture_config::set_path(
                        config,
                        &["separateSourceRecordings", "enabled"],
                        Some(Value::Bool(enabled)),
                    );
                })
                .await;
        });
        self.push_model(cx);
    }

    fn set_preset(&mut self, preset: SharedString, cx: &mut Context<Self>) {
        if self.model.quality_locked {
            return;
        }
        let Some(video) = capture_config::video_preset(preset.as_ref()) else {
            return;
        };
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_capture_config(|config| {
                    capture_config::set_path(config, &["video"], Some(video));
                })
                .await;
        });
        self.push_model(cx);
    }

    fn set_resolution(&mut self, width: u32, height: u32, cx: &mut Context<Self>) {
        if self.model.quality_locked {
            return;
        }
        let snapshot = self.studio.snapshot();
        let video = pick_recording_resolution(&snapshot.settings.capture.video, width, height);
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_capture_config(|config| {
                    capture_config::set_path(config, &["video"], Some(video));
                })
                .await;
        });
        self.push_model(cx);
    }

    fn set_clips_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.run_studio(async move {
            studio.set_clips_enabled(enabled).await;
        });
        self.push_model(cx);
    }

    fn set_keep_original(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.run_studio(async move {
            let _ = studio
                .update_studio_settings(|settings| {
                    settings.set("keepOriginalRecording", Value::Bool(enabled));
                })
                .await;
        });
        self.push_model(cx);
    }

    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose a recordings folder".into()),
        });
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = receiver.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let folder = StoredFolder::picked(path);
            studio.set_recordings_folder(folder).await;
            let _ = this.update(cx, |panel, cx| {
                panel.schedule_folder_facts(cx);
                panel.push_model(cx);
            });
        })
        .detach();
    }

    fn use_default_folder(&mut self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.run_studio(async move {
            studio.use_default_recordings_folder().await;
        });
        self.schedule_folder_facts(cx);
        self.push_model(cx);
    }

    fn reveal_folder(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.model.folder_path.clone() else {
            return;
        };
        cx.reveal_path(&path);
    }

    fn refresh_camera(&mut self, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        let client = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            client
                .request("virtualCamera.status", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let status = job.await.ok().flatten();
            let _ = this.update(cx, |panel, cx| {
                panel.camera_status = status;
                panel.push_model(cx);
            });
        })
        .detach();
    }

    fn connected(&self) -> bool {
        self.model.connected
    }

    fn set_camera_on(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.camera_pending || self.model.camera.disabled {
            return;
        }
        self.camera_pending = true;
        self.camera_error = None;
        let client = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            client
                .request("virtualCamera.set", json!({ "on": on }))
                .await
                .map(|value| serde_json::from_value::<VirtualCameraStatus>(value).ok())
                .map_err(|error| error.message)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.camera_pending = false;
                match result {
                    Ok(Ok(Some(status))) => {
                        panel.camera_status = Some(status);
                        panel.camera_error = None;
                    }
                    Ok(Ok(None)) => {
                        panel.camera_error = Some("Couldn't update Videorc Camera".into())
                    }
                    Ok(Err(message)) => panel.camera_error = Some(message),
                    Err(_) => panel.camera_error = Some("Couldn't update Videorc Camera".into()),
                }
                panel.push_model(cx);
            });
        })
        .detach();
        cx.notify();
    }

    /// The button beside the switch: macOS' approval, Linux's module load.
    fn run_camera_action(&mut self, action: CameraAction, cx: &mut Context<Self>) {
        if self.camera_action.is_some() || !self.connected() {
            return;
        }
        match action {
            CameraAction::OpenApprovalSettings => {
                cx.open_url(camera_extension_approval_url(None));
            }
            CameraAction::LoadModule => self.load_camera_module(cx),
            // Windows' driver setup waits for its platform pass (plan 260:
            // Windows is hidden until proven); the row never offers it.
            CameraAction::SetUp => {}
        }
    }

    /// Linux: `pkexec modprobe v4l2loopback …`; polkit asks for the
    /// password, and the backend's next probe settles the status.
    #[cfg(target_os = "linux")]
    fn load_camera_module(&mut self, cx: &mut Context<Self>) {
        self.camera_action = Some(CameraAction::LoadModule);
        self.camera_error = None;
        let job = self
            .runtime
            .spawn_blocking(crate::platform::linux::v4l2loopback::load_module);
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.camera_action = None;
                panel.camera_error = match result {
                    Ok(result) if result.ok() => None,
                    Ok(result) => result.message,
                    Err(_) => Some("Couldn't do that. Try again in a moment.".into()),
                };
                panel.refresh_camera(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    #[cfg(not(target_os = "linux"))]
    fn load_camera_module(&mut self, cx: &mut Context<Self>) {
        self.camera_error = Some("Videorc Camera's module load runs on Linux only.".into());
        cx.notify();
    }

    /// Linux: the install command to paste into a terminal.
    fn copy_camera_command(&mut self, command: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(command));
        self.command_copied = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.command_copied = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// P655: the performance check's line under the preset, with "Use …"
    /// and "Check this computer" / "Check again".
    fn performance_row(
        &self,
        model: &OutputModel,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let line = model.performance_line.clone()?;
        let mut row = div()
            .id("output-performance-check")
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .type_scale(text::META)
            .text_color(hsla(match line.tone {
                LineTone::Warning => t.foreground,
                LineTone::Muted => t.muted_foreground,
            }));
        if line.busy {
            row = row
                .child(videorc_kit::spinner::Spinner::new("output-performance-spinner").size(14.));
        } else if line.tone == LineTone::Warning {
            // The tone rides on the icon; the words stay monochrome.
            row = row.child(icon(IconName::WarningFill, 14., hsla(t.warning)));
        }
        row = row.child(line.text.clone());
        if let Some((preset, label)) = line.apply.clone() {
            let preset = SharedString::from(preset_id(&preset));
            row = row.child(
                Button::new("output-performance-apply")
                    .label(label)
                    .variant(ButtonVariant::Outline)
                    .size(videorc_kit::button::ButtonSize::Xs)
                    .disabled(model.quality_locked)
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.set_preset(preset.clone(), cx)),
                    ),
            );
        }
        if let Some(check) = line.check_label {
            let mut button = Button::new("output-performance-run")
                .label(check)
                .variant(ButtonVariant::Ghost)
                .size(videorc_kit::button::ButtonSize::Xs)
                .disabled(model.session_locked || !model.connected)
                .on_click(
                    cx.listener(|this, _, window, cx| this.run_performance_check(window, cx)),
                );
            if let Some(hint) = line.check_hint {
                button = button.tooltip(hint);
            }
            row = row.child(button);
        }
        let mut column = div().flex().flex_col().gap(px(8.)).child(row);
        if let Some(error) = &self.check_error {
            column = column.child(FieldError::new(error.clone()));
        }
        Some(column.into_any_element())
    }

    /// P656 and P657: the plan's lock, then why this output can't run or
    /// is risky here.
    fn quality_alerts(&self, model: &OutputModel, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let mut alerts = Vec::new();
        if let EntitlementGate::Locked {
            reason,
            upgrade_url,
            ..
        } = self.profile_gate(cx)
        {
            let mut alert = Alert::new("output-profile-lock")
                .variant(AlertVariant::Locked)
                .title(reason);
            if let Some(url) = upgrade_url {
                alert = alert.action(
                    Button::new("output-profile-unlock")
                        .label("View Premium")
                        .variant(ButtonVariant::Outline)
                        .size(videorc_kit::button::ButtonSize::Xs)
                        .on_click(move |_, _, cx| cx.open_url(url)),
                );
            }
            alerts.push(alert.into_any_element());
        }
        if let Some((message, blocking)) = model.compatibility.message() {
            alerts.push(
                Alert::new("output-compatibility")
                    .variant(if blocking {
                        AlertVariant::Destructive
                    } else {
                        AlertVariant::Warning
                    })
                    .title(message.to_string())
                    .into_any_element(),
            );
        }
        alerts
    }

    /// P659: Width, Height, FPS and Bitrate kbps. Enter or leaving commits,
    /// Escape puts the setting back, a refused size says the rule.
    fn field_grid(&self, model: &OutputModel, cx: &mut Context<Self>) -> gpui::AnyElement {
        // `grid grid-cols-2 gap-4`, each value a vertical Field.
        let mut grid = div().grid().grid_cols(2).gap(px(16.));
        let refusal = self
            .field_refusal
            .filter(|(.., canvas)| *canvas == (model.width, model.height));
        for (field, label) in quality::FIELDS {
            let Some(state) = self.field_state(field) else {
                continue;
            };
            let refused = refusal.filter(|(refused, ..)| *refused == field);
            let (_, _, step) = quality::limits(field, model.vertical);
            // A step press moves the draft, like Chrome's number spinner:
            // the press focuses the field first (the kit's step buttons take
            // no focus), so the step stays a draft that Enter or leaving the
            // field commits and `sync_fields` never puts back.
            let focus_on_press = state.clone();
            grid = grid.child(
                div()
                    .when(!model.quality_locked, |cell| {
                        cell.on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                            focus_on_press.read(cx).focus_handle(cx).focus(window, cx);
                        })
                    })
                    .on_key_down(cx.listener(
                        move |this, event: &gpui::KeyDownEvent, window, cx| {
                            if event.keystroke.key == "escape" {
                                this.revert_field(field, window, cx);
                            }
                        },
                    ))
                    .child(
                        Field::new(SharedString::from(format!(
                            "output-field-{}-field",
                            field.key()
                        )))
                        .label(label)
                        .child(
                            Input::new(
                                SharedString::from(format!("output-field-{}", field.key())),
                                &state,
                            )
                            .accessibility_label(label)
                            .stepper(f64::from(step))
                            .disabled(model.quality_locked)
                            .invalid(refused.is_some()),
                        )
                        // `FieldError` under the input, the label staying
                        // foreground, as `OutputNumberInput` puts it.
                        .when_some(refused, |row, (_, rule, _)| row.error(rule)),
                    ),
            );
        }
        grid.into_any_element()
    }

    /// Clips on this computer: the ring's switch, its disk use, the two clip
    /// keys and where clips go.
    fn native_clips_section(
        &self,
        model: &OutputModel,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> PanelSection {
        let entity = cx.entity();
        let mut rows = GroupedList::new()
            .item(
                SettingsRow::new("output-clips-switch", clips_copy::copy::KEEP_LAST_SECONDS)
                    .description(model.clips_description.clone())
                    .child(
                        Switch::new("output-clips-enabled")
                            .accessibility_label(clips_copy::copy::KEEP_LAST_SECONDS)
                            .checked(model.clips_on)
                            .on_change(move |value, _, cx| {
                                entity.update(cx, |this, cx| this.set_clips_enabled(value, cx))
                            }),
                    ),
            )
            .item(
                SettingsRow::new("output-clips-disk", clips_copy::copy::DISK_USE)
                    .description(model.disk_detail.clone())
                    // `text-sm tabular-nums text-muted-foreground`.
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .text_color(hsla(t.muted_foreground))
                            .child(model.disk_estimate.clone()),
                    ),
            );
        for row in self.clip_key_rows(t, cx) {
            rows = rows.item(row);
        }
        rows = rows.item(
            SettingsRow::new("output-clips-folder", clips_copy::copy::WHERE_CLIPS_GO)
                .description(clips_copy::copy::WHERE_CLIPS_GO_DESCRIPTION),
        );
        PanelSection::new("output-clips")
            .icon(icon(
                IconName::ScissorsDuotone,
                16.,
                hsla(t.muted_foreground),
            ))
            .title(clips_copy::copy::CLIPS)
            .description(clips_copy::copy::SECTION_DESCRIPTION)
            .child(rows)
    }

    /// The two clip keys as Settings → Shortcuts records them: press the
    /// field, then the keys; Escape cancels, Backspace or Clear clears.
    fn clip_key_rows(
        &self,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let platform = Some(hotkeys::node_platform());
        let registration = self.hotkeys.registration();
        let config = self.shortcut_config();
        let scenes = self.shortcut_scenes();
        let view = recorder::shortcuts_view(recorder::ShortcutsInput {
            config: &config,
            platform,
            unavailable: registration.unavailable.as_deref(),
            system_audio_available: false,
            scenes: &scenes,
            registered: &registration.registered,
        });
        view.action_rows
            .into_iter()
            .filter(|row| CLIP_KEY_ACTIONS.contains(&row.action.as_str()))
            .map(|row| {
                let armed = self.recorder.action.as_deref() == Some(row.action.as_str());
                // The core's spoken binding (`shortcutRecorderName` after
                // "<label>: "); the kit puts the label and the armed words.
                let spoken = recorder::shortcut_recorder_name(
                    &row.label,
                    row.value.as_deref(),
                    row.app_key.as_ref(),
                    false,
                    platform,
                );
                let prefix = format!("{}: ", row.label);
                let spoken = spoken.strip_prefix(&prefix).unwrap_or(&spoken).to_string();
                let value = row.value.clone().filter(|value| !value.is_empty());
                // The key, or the app's own key and where; nothing while
                // armed or unbound (the kit's Press shortcut… / Unassigned).
                let keys: Option<gpui::AnyElement> = if armed {
                    None
                } else if let Some(value) = &value {
                    Some(ShortcutKeys::accelerator(value.clone()).into_any_element())
                } else {
                    row.app_key.as_ref().map(|app_key| {
                        div()
                            .flex()
                            .min_w(px(0.))
                            .items_center()
                            .gap(px(6.))
                            .child(ShortcutKeys::accelerator(app_key.accelerator.clone()))
                            .child(
                                div()
                                    .truncate()
                                    .text_color(hsla(t.muted_foreground))
                                    .child(app_key.place.clone()),
                            )
                            .into_any_element()
                    })
                };
                let message = self
                    .recorder
                    .message
                    .as_ref()
                    .filter(|(action, _)| *action == row.action)
                    .map(|(_, message)| message.clone())
                    .or(row.conflict.clone());
                let action = row.action.clone();
                let clear_action = row.action.clone();
                let mut control =
                    ShortcutRecorder::new(SharedString::from(format!("output-record-{action}")))
                        .label(row.label.clone())
                        .value_label(spoken)
                        .tooltip("Click to change")
                        .armed(armed)
                        .invalid(row.conflict.is_some())
                        .disabled(!hotkeys::supported(&action))
                        .on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.arm_recorder(action.clone(), cx)
                            }),
                        );
                if let Some(keys) = keys {
                    control = control.keys(keys);
                }
                if armed {
                    control = control.armed_preview(self.recorder.held.clone());
                }
                if value.is_some() {
                    control = control.on_clear(cx.listener(move |this, _, _, cx| {
                        this.save_clip_key(clear_action.clone(), String::new(), cx)
                    }));
                }
                // `ShortcutRecorderField`: a SettingsRow, its refusal as the
                // row's error.
                SettingsRow::new(
                    SharedString::from(format!("output-key-{}", row.action)),
                    row.label,
                )
                .when_some(message, |field, message| field.error(message))
                .child(control)
                .into_any_element()
            })
            .collect()
    }

    /// Cloud Clips while a room is open (`CloudClipsSection`): the same
    /// Clips actions with cloud ownership, never the native camera session.
    fn cloud_clips_section(
        &self,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> PanelSection {
        use cloud_clips::copy;
        let state = &self.cloud;
        let status = state.status.as_ref();
        let connected = self.model.connected;
        // `text-sm` (14 / 20) body copy; the costs line is `text-xs`.
        let body_text = |words: String, color: videorc_kit::tokens::Color| {
            div()
                .text_size(px(14.))
                .line_height(px(20.))
                .text_color(hsla(color))
                .child(words)
        };
        let entity = cx.entity();
        let orientation = ToggleGroup::new("output-cloud-clips-orientation")
            .accessibility_label(copy::ORIENTATION_LABEL)
            .value([state.orientation.wire()])
            .item(ToggleItem::new(
                Orientation::Horizontal.wire(),
                copy::HORIZONTAL,
            ))
            .item(ToggleItem::new(
                Orientation::Vertical.wire(),
                copy::VERTICAL,
            ))
            .on_change(move |values, _, cx| {
                let Some(next) = values
                    .first()
                    .and_then(|value| Orientation::of_wire(value.as_ref()))
                else {
                    return;
                };
                entity.update(cx, |this, cx| {
                    this.cloud.orientation = next;
                    cx.notify();
                });
            });
        let mut buttons = div().flex().gap(px(8.)).child(
            Button::new("output-cloud-clips-enable")
                .label(copy::ENABLE)
                .variant(ButtonVariant::Outline)
                .disabled(!connected || state.busy || !cloud_clips::can_enable(status))
                .on_click(cx.listener(|this, _, _, cx| this.enable_cloud_clips(cx))),
        );
        if cloud_clips::disable_generation(status).is_some() {
            buttons = buttons.child(
                Button::new("output-cloud-clips-disable")
                    .label(copy::DISABLE)
                    .variant(ButtonVariant::Ghost)
                    .disabled(state.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.disable_cloud_clips(cx))),
            );
        }
        // The section's own children, 12 px apart (`PanelSection`'s content).
        let mut body: Vec<AnyElement> = vec![
            body_text(
                cloud_clips::status_line(status).to_string(),
                t.muted_foreground,
            )
            .into_any_element(),
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(copy::COSTS)
                .into_any_element(),
            orientation.into_any_element(),
            buttons.into_any_element(),
            body_text(copy::HOW_TO_SAVE.to_string(), t.muted_foreground).into_any_element(),
        ];
        if let Some(error) = &state.error {
            body.push(
                Alert::new("output-cloud-clips-error")
                    .title(error.clone())
                    .into_any_element(),
            );
        }
        let show_id = state.show_id.clone().unwrap_or_default();
        let has_generation = status
            .and_then(|status| status.generation.as_ref())
            .is_some();
        for row in cloud_clips::job_rows(&state.jobs, &show_id) {
            let mut actions = div().flex().gap(px(8.));
            for (action, label) in row.actions.iter().copied() {
                let job_id = row.id.clone();
                let marker_id = row.marker_id.clone();
                actions = actions.child(
                    Button::new(SharedString::from(format!(
                        "output-cloud-clip-{}-{label}",
                        row.id
                    )))
                    .label(label)
                    .variant(ButtonVariant::Ghost)
                    .size(videorc_kit::button::ButtonSize::Xs)
                    .disabled(state.busy || (action == JobAction::Retry && !has_generation))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.cloud_job_action(action, job_id.clone(), marker_id.clone(), cx)
                    })),
                );
            }
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(body_text(row.text, t.foreground))
                    .child(actions)
                    .into_any_element(),
            );
        }
        PanelSection::new("output-cloud-clips")
            .title(copy::TITLE)
            .description(copy::DESCRIPTION)
            .children(body)
    }
}

impl Render for OutputPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_fields(window, cx);
        self.sync_fields(window, cx);
        let t = theme::current(window, cx).theme();
        let model = self.model.clone();
        let resolutions = if model.vertical {
            VERTICAL_RESOLUTIONS
        } else {
            HORIZONTAL_RESOLUTIONS
        };
        let selected_resolution = resolutions
            .iter()
            .find(|&&(w, h, _)| same_size(w, h, model.width, model.height))
            .map(|&(_, _, label)| label);

        let mut local = PanelSection::new("output-local")
            .icon(icon(
                IconName::FileVideoDuotone,
                16.,
                hsla(t.muted_foreground),
            ))
            .title("Local recording")
            .description(LOCAL_DESCRIPTION);
        if model.session_locked {
            local = local.child(
                Alert::new("output-session-lock")
                    .variant(AlertVariant::Warning)
                    .title(SESSION_LOCK),
            );
        }
        let save_desc = if model.record_enabled {
            SAVE_RECORDING_ON
        } else {
            SAVE_RECORDING_OFF
        };
        let entity = cx.entity();
        let mut local_rows = GroupedList::new().item(
            SettingsRow::new("output-save-recording", "Save a local recording")
                .description(save_desc)
                .child(
                    Switch::new("output-save")
                        .accessibility_label("Save a local recording")
                        .checked(model.record_enabled)
                        .disabled(model.session_locked)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |this, cx| this.set_record_enabled(value, cx))
                            }
                        }),
                ),
        );
        if model.separate_supported {
            local_rows = local_rows.item(
                SettingsRow::new(
                    "output-separate-source-recordings",
                    "Separate source recordings",
                )
                .description(SEPARATE_DESCRIPTION)
                .child(
                    Switch::new("output-separate")
                        .accessibility_label("Separate source recordings")
                        .checked(model.separate_enabled)
                        .disabled(model.quality_locked)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |this, cx| this.set_separate_enabled(value, cx))
                            }
                        }),
                ),
            );
        }
        local = local.child(local_rows);

        // The quality: a plain FieldGroup under the grouped rows, as
        // `LocalRecordingSection` lays it out (preset, Resolution, the four
        // values, the Windows encoder).
        let mut preset = Select::new("video-preset")
            .accessibility_label("Recording preset")
            .placeholder("Recording preset")
            .disabled(model.quality_locked)
            .value(Some(SharedString::from(model.preset.clone())));
        for (value, label) in &model.preset_options {
            preset = preset.option(value.clone(), label.clone());
        }
        // `SelectSeparator` before Custom when there are presets.
        if !model.preset_options.is_empty() {
            preset = preset.option_item(SelectOption::separator());
        }
        preset = preset.option("custom", "Custom");
        let entity = cx.entity();
        preset = preset.on_change(move |value, _, cx| {
            entity.update(cx, |this, cx| this.set_preset(value, cx));
        });
        // `FieldDescription` after the trigger, then the check line and the
        // alerts as the Field's footer: the kit pulls the description up 4 px
        // when anything follows it, as Electron's `nth-last-2:-mt-1`.
        let mut preset_field = Field::new("output-preset")
            .label("Recording preset")
            .child(preset)
            .description("Editing a value below switches the preset to Custom.");
        for footer in self
            .performance_row(&model, t, cx)
            .into_iter()
            .chain(self.quality_alerts(&model, cx))
        {
            preset_field = preset_field.footer(footer);
        }
        let mut quality_fields = FieldGroup::new().child(preset_field);
        let entity = cx.entity();
        let mut resolution = SegmentedControl::new("output-resolution")
            .accessibility_label("Resolution")
            .disabled(model.quality_locked)
            .value(selected_resolution);
        for &(_, _, label) in resolutions {
            resolution = resolution.option(Segment::new(label, label));
        }
        resolution = resolution.on_change(move |value, _, cx| {
            if let Some(&(width, height, _)) = resolutions
                .iter()
                .find(|&&(_, _, label)| label == value.as_str())
            {
                entity.update(cx, |this, cx| this.set_resolution(width, height, cx));
            }
        });
        quality_fields = quality_fields
            .child(
                Field::new("output-resolution-row")
                    .label("Resolution")
                    .child(resolution),
            )
            .child(self.field_grid(&model, cx));
        if let Some(encoder) = self
            .encoder
            .as_ref()
            .filter(|state| state.quick_sync_available)
        {
            let entity = cx.entity();
            let env_override = encoder.env_override;
            let mut select = Select::new("encoder-preference")
                .accessibility_label(ENCODER_LABEL)
                .disabled(env_override || !model.connected)
                // `w-44`.
                .width(176.0)
                .value(Some(encoder_preference_value(encoder.preference)));
            for &(preference, label) in &[
                (WindowsH264EncoderPreference::Auto, "Automatic"),
                (WindowsH264EncoderPreference::QuickSync, "Intel Quick Sync"),
                (WindowsH264EncoderPreference::Software, "Software only"),
            ] {
                select = select.option(encoder_preference_value(preference), label);
            }
            select = select.on_change(move |value, _, cx| {
                if let Some(preference) = parse_encoder_preference(value.as_ref()) {
                    entity.update(cx, |this, cx| this.set_encoder_preference(preference, cx));
                }
            });
            // `EncoderPreferenceField`: a plain Field around its own row, the
            // label with its Beta badge (`gap-2`) and the line 2 px under it
            // (`gap-0.5`, `text-xs`) on the left, the select on the right.
            quality_fields = quality_fields.child(
                Field::new("output-encoder-preference")
                    .horizontal()
                    .compact(true)
                    .label(ENCODER_LABEL)
                    .label_after(Badge::new("Beta").variant(BadgeVariant::Outline))
                    .description(if env_override {
                        ENCODER_ENV_DESCRIPTION
                    } else {
                        ENCODER_DESCRIPTION
                    })
                    .child(div().flex_none().child(select)),
            );
        }
        local = local.child(quality_fields);

        let clips = if self.cloud.show_id.is_some() {
            self.cloud_clips_section(t, cx).into_any_element()
        } else {
            self.native_clips_section(&model, t, cx).into_any_element()
        };

        let mut camera_section = None;
        if !model.camera.hidden {
            let entity = cx.entity();
            let mut trailing = div().flex().flex_none().items_center().gap(px(8.));
            // Windows' Set up waits for its platform pass (see `run_camera_action`).
            if let Some(action) = model.camera.action.filter(|a| *a != CameraAction::SetUp) {
                let label = if self.camera_action == Some(action) {
                    action.pending_label()
                } else {
                    action.label()
                };
                trailing = trailing.child(
                    Button::new("output-videorc-camera-action")
                        .label(label)
                        .variant(ButtonVariant::Outline)
                        .disabled(
                            !model.connected || self.camera_pending || self.camera_action.is_some(),
                        )
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.run_camera_action(action, cx)),
                        ),
                );
            }
            trailing = trailing.child(
                Switch::new("output-videorc-camera-switch")
                    .accessibility_label(VIDEORC_CAMERA)
                    .checked(model.camera.checked)
                    .disabled(model.camera.disabled || self.camera_pending)
                    .on_change(move |value, _, cx| {
                        entity.update(cx, |this, cx| this.set_camera_on(value, cx))
                    }),
            );
            let mut description = div().flex().flex_col().child(CAMERA_DESCRIPTION);
            if let Some(line) = &model.camera.line {
                // `StatusLine`: the tone rides on the icon; the words stay
                // monochrome (foreground when it warns, else secondary).
                let mark = if line.busy {
                    Some(
                        div()
                            .flex_none()
                            .mt(px(2.))
                            .child(
                                videorc_kit::spinner::Spinner::new("output-videorc-camera-spinner")
                                    .size(14.),
                            )
                            .into_any_element(),
                    )
                } else {
                    match line.tone {
                        CameraTone::Warn => Some(
                            div()
                                .flex_none()
                                .mt(px(2.))
                                .child(icon(IconName::WarningFill, 14., hsla(t.warning)))
                                .into_any_element(),
                        ),
                        CameraTone::Good => Some(
                            div()
                                .flex_none()
                                .mt(px(6.))
                                .child(
                                    StatusDot::new("output-videorc-camera-dot")
                                        .tone(StatusTone::Good),
                                )
                                .into_any_element(),
                        ),
                        CameraTone::Neutral => None,
                    }
                };
                description = description.child(
                    div()
                        .id("output-videorc-camera-status")
                        .mt(px(4.))
                        .flex()
                        .items_start()
                        .gap(px(6.))
                        .text_color(hsla(if line.tone == CameraTone::Warn {
                            t.foreground
                        } else {
                            t.muted_foreground
                        }))
                        .children(mark)
                        .child(line.text.clone()),
                );
            }
            if let Some(command) = model.camera.command.clone() {
                let copy_command = command.clone();
                description = description.child(
                    div()
                        .mt(px(6.))
                        .flex()
                        .min_w(px(0.))
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .id("output-videorc-camera-command")
                                .min_w(px(0.))
                                .truncate()
                                .px(px(6.))
                                .py(px(2.))
                                .rounded(px(videorc_kit::tokens::radius::CHIP))
                                .bg(hsla(t.inset))
                                .font_family(theme::FONT_MONO)
                                .type_scale(text::META)
                                .text_color(hsla(t.foreground))
                                .child(command),
                        )
                        .child({
                            let copy_label = if self.command_copied {
                                "Copied"
                            } else {
                                "Copy"
                            };
                            // `<CopyIcon data-icon="inline-start" />`, 12 px
                            // in an xs button.
                            Button::new("output-videorc-camera-copy")
                                .accessibility_label(copy_label)
                                .variant(ButtonVariant::Ghost)
                                .size(videorc_kit::button::ButtonSize::Xs)
                                .icon(IconName::Copy)
                                .label(copy_label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.copy_camera_command(copy_command.clone(), cx)
                                }))
                        }),
                );
            }
            camera_section = Some(
                PanelSection::new("output-videorc-camera")
                    .icon(icon(
                        IconName::VideoCameraDuotone,
                        16.,
                        hsla(t.muted_foreground),
                    ))
                    .title(CAMERA_SECTION_TITLE)
                    .description(CAMERA_SECTION_DESCRIPTION)
                    .child(
                        GroupedList::new().item(
                            SettingsRow::new("output-videorc-camera-row", VIDEORC_CAMERA)
                                .description(description)
                                .when_some(self.camera_error.clone(), |row, error| row.error(error))
                                .child(trailing),
                        ),
                    ),
            );
        }

        let entity = cx.entity();
        // `flex shrink-0 flex-wrap justify-end gap-2`; Choose… leads with
        // its folder icon.
        let mut folder_actions = div()
            .flex()
            .flex_none()
            .flex_wrap()
            .justify_end()
            .gap(px(8.))
            .child(
                Button::new("recordings-choose")
                    .accessibility_label(folder_copy::CHOOSE)
                    .variant(ButtonVariant::Outline)
                    .icon(IconName::FolderOpen)
                    .label(folder_copy::CHOOSE)
                    .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
            );
        if model.folder.can_reveal {
            folder_actions = folder_actions.child(
                Button::new("recordings-reveal")
                    .label(videorc_app_core::notices::reveal_in_file_manager_label())
                    .variant(ButtonVariant::Outline)
                    .on_click(cx.listener(|this, _, _, cx| this.reveal_folder(cx))),
            );
        }
        if model.folder.custom {
            folder_actions = folder_actions.child(
                Button::new("recordings-default")
                    .label(folder_copy::USE_DEFAULT)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| this.use_default_folder(cx))),
            );
        }
        // The path and its free space are the row's description; a problem
        // is its error.
        let folder_detail = div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .child(
                div()
                    .min_w(px(0.))
                    .truncate()
                    .child(model.folder.path.clone()),
            )
            .children(model.folder.detail.clone());
        let folder = PanelSection::new("output-recordings")
            .title("Where recordings go")
            .description(FOLDER_SECTION_DESCRIPTION)
            .last(true)
            .child(
                GroupedList::new()
                    .item(
                        SettingsRow::new("recordings-folder", folder_copy::RECORDINGS_FOLDER)
                            .description(folder_detail)
                            .when_some(model.folder.problem, |row, problem| row.error(problem))
                            .child(folder_actions),
                    )
                    .item(
                        SettingsRow::new("keep-original", "Keep original recording")
                            .description(KEEP_ORIGINAL_DESCRIPTION)
                            .child(
                                Switch::new("keep-original-recording")
                                    .accessibility_label("Keep original recording")
                                    .checked(model.keep_original)
                                    .on_change(move |value, _, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.set_keep_original(value, cx)
                                        })
                                    }),
                            ),
                    ),
            );

        div()
            .id("output-page")
            // While a clip key is armed (its field holds focus), the
            // modifiers held so far show in it.
            .on_modifiers_changed(cx.listener(
                |this, event: &gpui::ModifiersChangedEvent, _, cx| {
                    this.hold_modifiers(&event.modifiers, cx)
                },
            ))
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                // `RecordingTab`: flush sections, each with its own 16 px
                // padding and the hairline under it.
                ScrollArea::new("output-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .child(local)
                        .child(clips)
                        .children(camera_section)
                        .child(folder),
                ),
            )
    }
}
