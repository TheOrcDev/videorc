//! The Output page (plan 260 Phase 3, L4): local recording, Clips, Videorc
//! Camera, and where recordings go. Words and state come from
//! `videorc_app_core::studio::{clips, recordings_folder, virtual_camera,
//! capture_config, inspector}`; this module draws them with `videorc_kit`.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{Context, PathPromptOptions, SharedString, WeakEntity, Window, div, prelude::*, px};
use serde_json::{Value, json};
use videorc_app_core::desktop::camera_extension::camera_extension_approval_url;
use videorc_app_core::protocol::{
    VirtualCameraPlatformStep, VirtualCameraState, VirtualCameraStatus,
};
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::capture_config::{self, VIDEO_PRESETS};
use videorc_app_core::studio::clips as clips_copy;
use videorc_app_core::studio::inspector::format_video_quality;
use videorc_app_core::studio::recordings_folder::{self, StoredFolder, copy as folder_copy};
use videorc_app_core::studio::virtual_camera::{VIDEORC_CAMERA, camera_copy, camera_hidden};
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::select::Select;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::tabs::Tabs;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

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
const OFFLINE_LOCK: &str = "Videorc is reconnecting. These controls come back in a moment.";
/// `platformCopy(platform).deviceNoun`: "Mac", "PC" or "computer".
fn device_noun() -> &'static str {
    videorc_app_core::format::device_noun(crate::app::hotkeys::node_platform())
}

const RECORDING_PRESETS: &[&str] = &[
    "tutorial-540p30",
    "tutorial-720p30",
    "tutorial-1080p30",
    "tutorial-1440p30",
    "record-4k30",
    "record-4k60-experimental",
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

fn preset_label(name: &str) -> String {
    match capture_config::video_preset(name) {
        Some(value) => {
            let width = value["width"].as_u64().unwrap_or(0) as u32;
            let height = value["height"].as_u64().unwrap_or(0) as u32;
            let fps = value["fps"].as_u64().unwrap_or(0) as u32;
            format_video_quality(width, height, fps)
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
struct CameraLine {
    text: String,
    tone: StatusTone,
    busy: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct CameraModel {
    hidden: bool,
    checked: bool,
    disabled: bool,
    line: Option<CameraLine>,
    show_approval: bool,
}

impl CameraModel {
    fn of(status: Option<&VirtualCameraStatus>, connected: bool) -> Self {
        let Some(status) = status.filter(|status| !camera_hidden(Some(status))) else {
            return Self {
                hidden: true,
                checked: false,
                disabled: true,
                line: None,
                show_approval: false,
            };
        };
        let mut model = Self {
            hidden: false,
            checked: status.on && status.available,
            disabled: !connected || !status.available,
            line: None,
            show_approval: false,
        };
        let say = |text: String, tone: StatusTone, busy: bool| CameraLine { text, tone, busy };
        if !status.available {
            model.line = Some(say(
                status
                    .message
                    .clone()
                    .filter(|_| status.platform_step == Some(VirtualCameraPlatformStep::Failed))
                    .unwrap_or_else(|| camera_copy::cant_run(device_noun())),
                StatusTone::Warn,
                false,
            ));
        } else {
            match status.state {
                VirtualCameraState::Off => {}
                VirtualCameraState::Installing => {
                    let text =
                        if status.platform_step == Some(VirtualCameraPlatformStep::Installing) {
                            camera_copy::INSTALLING
                        } else {
                            camera_copy::STARTING
                        };
                    model.line = Some(say(text.into(), StatusTone::Neutral, true));
                }
                VirtualCameraState::NeedsApproval => {
                    if status.platform_step == Some(VirtualCameraPlatformStep::NeedsReboot) {
                        model.line = Some(say(
                            camera_copy::needs_restart(device_noun()),
                            StatusTone::Warn,
                            false,
                        ));
                    } else {
                        model.line = Some(say(
                            format!(
                                "Allow {VIDEORC_CAMERA} in System Settings → {}.",
                                camera_copy::APPROVAL_PATH_MACOS_15
                            ),
                            StatusTone::Warn,
                            false,
                        ));
                        model.show_approval = true;
                    }
                }
                VirtualCameraState::NeedsSetup => {
                    model.line = Some(say(
                        camera_copy::NEEDS_SETUP.into(),
                        StatusTone::Warn,
                        false,
                    ));
                }
                VirtualCameraState::Ready => {
                    model.line = Some(say(camera_copy::READY.into(), StatusTone::Good, false));
                }
                VirtualCameraState::Streaming => {
                    let text = match status.viewers.filter(|count| *count > 0) {
                        Some(apps) => camera_copy::in_use(i64::from(apps)),
                        None => camera_copy::READY.to_string(),
                    };
                    model.line = Some(say(text, StatusTone::Good, false));
                }
                VirtualCameraState::Unavailable => {
                    let detail = status.message.as_deref().unwrap_or(camera_copy::RETRYING);
                    model.line = Some(say(
                        format!("{} {detail}", camera_copy::STOPPED),
                        StatusTone::Warn,
                        false,
                    ));
                }
            }
        }
        if !connected {
            model.line = Some(say(OFFLINE_LOCK.into(), StatusTone::Neutral, false));
        }
        model
    }
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
    camera: CameraModel,
    connected: bool,
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
            camera: CameraModel::of(
                camera,
                matches!(snapshot.connection, Connection::Connected { .. }),
            ),
            connected: matches!(snapshot.connection, Connection::Connected { .. }),
        }
    }
}

pub struct OutputPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    model: OutputModel,
    camera_status: Option<VirtualCameraStatus>,
    camera_pending: bool,
    camera_error: Option<String>,
    #[allow(dead_code)]
    shell: Option<WeakEntity<Shell>>,
    facts_ticket: u64,
}

impl OutputPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let model = OutputModel::of(&*studio.watch().borrow(), None);
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut events = studio_watch.backend().subscribe();
            loop {
                let event = tokio::select! {
                    changed = studio_rx.changed() => {
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
                });
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            model,
            camera_status: None,
            camera_pending: false,
            camera_error: None,
            shell: None,
            facts_ticket: 0,
        }
    }

    pub fn bind_shell(&mut self, shell: WeakEntity<Shell>) {
        self.shell = Some(shell);
    }

    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if active {
            self.refresh_camera(cx);
            self.schedule_folder_facts(cx);
        }
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

    fn open_camera_approval(&mut self, cx: &mut Context<Self>) {
        cx.open_url(camera_extension_approval_url(None));
    }

    fn settings_row(
        &self,
        id: &'static str,
        title: impl Into<SharedString>,
        description: impl Into<SharedString>,
        control: impl IntoElement,
        t: &videorc_kit::tokens::Theme,
    ) -> impl IntoElement {
        div().child(ListRow::new(id, title).child(control)).child(
            div()
                .px(px(12.))
                .pb(px(8.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(description.into()),
        )
    }
}

impl Render for OutputPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let model = self.model.clone();
        let resolutions = if model.vertical {
            VERTICAL_RESOLUTIONS
        } else {
            HORIZONTAL_RESOLUTIONS
        };
        let selected_resolution = resolutions
            .iter()
            .position(|&(w, h, _)| same_size(w, h, model.width, model.height))
            .unwrap_or(resolutions.len());

        let mut local = PanelSection::new("output-local")
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
            self.settings_row(
                "output-save-recording",
                "Save a local recording",
                save_desc,
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
                t,
            ),
        );
        if model.separate_supported {
            local_rows = local_rows.item(
                self.settings_row(
                    "output-separate-source-recordings",
                    "Separate source recordings",
                    SEPARATE_DESCRIPTION,
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
                    t,
                ),
            );
        }
        let mut preset = Select::new("video-preset")
            .placeholder("Recording preset")
            .disabled(model.quality_locked)
            .width(280.0)
            .value(Some(SharedString::from(model.preset.clone())));
        for (value, label) in &model.preset_options {
            preset = preset.option(value.clone(), label.clone());
        }
        preset = preset.option("custom", "Custom");
        let entity = cx.entity();
        preset = preset.on_change(move |value, _, cx| {
            entity.update(cx, |this, cx| this.set_preset(value, cx));
        });
        local_rows = local_rows.item(
            div()
                .child(ListRow::new("output-preset", "Recording preset").child(preset))
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(8.))
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Editing a value below switches the preset to Custom."),
                ),
        );
        let entity = cx.entity();
        let mut resolution = Tabs::new("output-resolution").selected(selected_resolution);
        for &(_, _, label) in resolutions {
            resolution = if model.quality_locked {
                resolution.disabled_tab(label)
            } else {
                resolution.tab(label)
            };
        }
        let resolution_sizes: Vec<(u32, u32)> =
            resolutions.iter().map(|&(w, h, _)| (w, h)).collect();
        resolution = resolution.on_select(move |index, _, cx| {
            if let Some(&(width, height)) = resolution_sizes.get(index) {
                entity.update(cx, |this, cx| this.set_resolution(width, height, cx));
            }
        });
        local_rows = local_rows.item(
            div()
                .child(ListRow::new("output-resolution-row", "Resolution").child(resolution))
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(8.))
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(format!(
                            "{} × {} · {} fps · {} kbps",
                            model.width, model.height, model.fps, model.bitrate_kbps
                        )),
                ),
        );
        local = local.child(local_rows);

        let entity = cx.entity();
        let clips = PanelSection::new("output-clips")
            .title(clips_copy::copy::CLIPS)
            .description(clips_copy::copy::SECTION_DESCRIPTION)
            .child(
                GroupedList::new()
                    .item(
                        self.settings_row(
                            "output-clips-switch",
                            clips_copy::copy::KEEP_LAST_SECONDS,
                            model.clips_description.clone(),
                            Switch::new("output-clips-enabled")
                                .accessibility_label(clips_copy::copy::KEEP_LAST_SECONDS)
                                .checked(model.clips_on)
                                .on_change(move |value, _, cx| {
                                    entity.update(cx, |this, cx| this.set_clips_enabled(value, cx))
                                }),
                            t,
                        ),
                    )
                    .item(
                        self.settings_row(
                            "output-clips-disk",
                            clips_copy::copy::DISK_USE,
                            model.disk_detail.clone(),
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(model.disk_estimate.clone()),
                            t,
                        ),
                    )
                    .item(
                        ListRow::new("output-clips-folder", clips_copy::copy::WHERE_CLIPS_GO)
                            .meta(clips_copy::copy::WHERE_CLIPS_GO_DESCRIPTION),
                    ),
            );

        let mut camera_section = None;
        if !model.camera.hidden {
            let entity = cx.entity();
            let mut trailing = div().flex().items_center().gap(px(8.));
            if model.camera.show_approval {
                trailing = trailing.child(
                    Button::new("output-videorc-camera-action")
                        .label("Open System Settings")
                        .variant(ButtonVariant::Outline)
                        .disabled(!model.connected || self.camera_pending)
                        .on_click(cx.listener(|this, _, _, cx| this.open_camera_approval(cx))),
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
            let mut description = div().flex().flex_col().gap(px(4.)).child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(CAMERA_DESCRIPTION),
            );
            if let Some(line) = &model.camera.line {
                let status = if line.busy {
                    StatusDot::new("output-videorc-camera-status")
                        .tone(StatusTone::Neutral)
                        .label(line.text.clone())
                } else {
                    StatusDot::new("output-videorc-camera-status")
                        .tone(line.tone)
                        .label(line.text.clone())
                };
                description = description.child(status);
            }
            if let Some(error) = &self.camera_error {
                description = description.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.destructive))
                        .child(error.clone()),
                );
            }
            camera_section = Some(
                PanelSection::new("output-videorc-camera")
                    .title(CAMERA_SECTION_TITLE)
                    .description(CAMERA_SECTION_DESCRIPTION)
                    .child(
                        GroupedList::new().item(
                            div()
                                .child(
                                    ListRow::new("output-videorc-camera-row", VIDEORC_CAMERA)
                                        .child(trailing),
                                )
                                .child(div().px(px(12.)).pb(px(8.)).child(description)),
                        ),
                    ),
            );
        }

        let entity = cx.entity();
        let mut folder_actions = div().flex().flex_wrap().justify_end().gap(px(8.)).child(
            Button::new("recordings-choose")
                .label(folder_copy::CHOOSE)
                .variant(ButtonVariant::Outline)
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
        let mut folder_detail = div().flex().flex_col().gap(px(2.)).child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.foreground))
                .child(model.folder.path.clone()),
        );
        if let Some(detail) = &model.folder.detail {
            folder_detail = folder_detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(detail.clone()),
            );
        }
        if let Some(problem) = model.folder.problem {
            folder_detail = folder_detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(problem),
            );
        }
        let folder = PanelSection::new("output-recordings")
            .title("Where recordings go")
            .description(FOLDER_SECTION_DESCRIPTION)
            .last(true)
            .child(
                GroupedList::new()
                    .item(
                        div()
                            .child(
                                ListRow::new("recordings-folder", folder_copy::RECORDINGS_FOLDER)
                                    .child(folder_actions),
                            )
                            .child(div().px(px(12.)).pb(px(8.)).child(folder_detail)),
                    )
                    .item(
                        self.settings_row(
                            "keep-original",
                            "Keep original recording",
                            KEEP_ORIGINAL_DESCRIPTION,
                            Switch::new("keep-original-recording")
                                .accessibility_label("Keep original recording")
                                .checked(model.keep_original)
                                .on_change(move |value, _, cx| {
                                    entity.update(cx, |this, cx| this.set_keep_original(value, cx))
                                }),
                            t,
                        ),
                    ),
            );

        div()
            .id("output-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("output-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(8.))
                        .child(local)
                        .child(clips)
                        .children(camera_section)
                        .child(folder),
                ),
            )
    }
}
