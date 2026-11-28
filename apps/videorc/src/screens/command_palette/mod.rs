//! The shell's Search door (`command-palette.tsx`). Commands are rebuilt
//! from confirmed core state at activation as well as while searching; no
//! stale row bypasses a gate. Electron's groups in its order (Session,
//! Pages, Windows, Scenes, Sounds, Avatar, Sidekick, Settings, Appearance),
//! each under its heading; a row's value is the footer's words and what
//! search matches, its context follows the title, its key sits at the end.
use gpui::{
    Context, Entity, EntityInputHandler, EventEmitter, Focusable, ScrollHandle, SharedString,
    Window, div, prelude::*, px,
};
use serde_json::json;
use std::sync::Arc;
use videorc_app_core::buddy::copy::{AVATAR_TABS, TABS as SIDEKICK_TABS};
use videorc_app_core::livestream::go_live_copy::GO_LIVE_COMMAND;
use videorc_app_core::protocol::{SoundboardState, VirtualCameraStatus};
use videorc_app_core::shortcuts::shortcut_accelerator;
use videorc_app_core::studio::audio_section::bound_accelerator;
use videorc_app_core::studio::scene_on_stream::{copy as screen_copy, screen_hide_accelerator};
use videorc_app_core::studio::virtual_camera::OutputCameraView;
use videorc_app_core::studio::{
    StudioBackend, camera_background_view, families, inspector::StartGates,
    transport::TransportView,
};
use videorc_app_core::user_error::{Failure, UserErrorContext, toast_user_error};
use videorc_app_core::{BackendClient, StopOrigin, Studio};
use videorc_app_core::{
    nav::{self, PageId, ThemeChoice},
    settings_page::SettingsTab,
};
use videorc_kit::{
    ShortcutKeys,
    command::{
        CommandEmpty, CommandFooter, CommandGroup, CommandInput, CommandItem, CommandList,
        CommandSeparator, InputEvent, InputState, command_dialog,
    },
    dialog::DialogHandle,
    icon::{IconName, icon},
    theme::{current, hsla},
};

use crate::app::hotkeys::{ShortcutActions, StudioActions};

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Page(PageId),
    Settings(SettingsTab),
    Setup,
    Preview,
    StreamManager,
    Notes,
    CaptionsReader,
    Notifications,
    Record,
    /// Go live…: the Go Live dialog, as the transport's button opens it.
    GoLive,
    /// Hide screen: the global key's own toggle.
    HideScreen,
    Stop,
    Microphone,
    Clip(u32),
    Scene(String),
    /// Studio's Add scene… (plan 231 D14): the Studio page opens its picker.
    AddScene,
    /// Background settings (P575): Scene opens on the camera's Background.
    SceneBackground,
    Theme(ThemeChoice),
    Chat,
    /// Play one soundboard pad (P103).
    PlaySound(String),
    /// Stop every playing sound (P103).
    StopAllSounds,
    /// One of the Avatar page's tabs, by its index in `AVATAR_TABS`.
    AvatarTab(usize),
    /// One of Sidekick's tabs, by its index in `TABS`.
    SidekickTab(usize),
    /// Plan 214 E2: Output → Videorc Camera's switch, to this state.
    VideorcCamera(bool),
}

/// `VIDEORC_CAMERA_COPY.turnOn` / `.turnOff` (`virtual-camera-view.ts`).
const CAMERA_TURN_ON: &str = "Turn Videorc Camera on";
const CAMERA_TURN_OFF: &str = "Turn Videorc Camera off";
/// `VIDEORC_CAMERA_SWITCH_TOAST_ID` (`use-virtual-camera.ts`): one failure
/// toast for the switch, wherever it was pressed.
const CAMERA_SWITCH_TOAST_ID: &str = "virtual-camera-switch";
#[derive(Clone)]
struct Row {
    id: String,
    group: &'static str,
    /// The words on the row.
    label: String,
    /// cmdk's `value`: the footer's words and what search matches.
    value: String,
    /// The secondary context after the title (`Context`).
    context: Option<&'static str>,
    /// The key that runs it, as an accelerator (`CommandShortcut`).
    shortcut: Option<String>,
    /// The look or the switch in use wears the check.
    checked: bool,
    keywords: Vec<String>,
    command: Command,
    enabled: bool,
    /// The row's glyph (`<XIcon className="size-4" />` before the title).
    icon: Option<IconName>,
}
impl Row {
    fn new(
        id: impl Into<String>,
        group: &'static str,
        label: impl Into<String>,
        command: Command,
        enabled: bool,
    ) -> Self {
        let label = label.into();
        let icon = command_icon(&command);
        Self {
            icon,
            id: id.into(),
            group,
            value: label.clone(),
            label,
            context: None,
            shortcut: None,
            checked: false,
            keywords: Vec::new(),
            command,
            enabled,
        }
    }
    fn keywords(mut self, words: &[&str]) -> Self {
        self.keywords = words.iter().map(|s| s.to_string()).collect();
        self
    }
    fn value(mut self, value: impl Into<String>) -> Self {
        self.value = value.into();
        self
    }
    fn context(mut self, context: &'static str) -> Self {
        self.context = Some(context);
        self
    }
    fn shortcut(mut self, accelerator: Option<String>) -> Self {
        self.shortcut = accelerator.filter(|accelerator| !accelerator.is_empty());
        self
    }
    fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }
    fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }
}

/// Each command's glyph in Electron's palette (`command-palette.tsx`, the
/// aliases in `icons.tsx`). Hide screen has none there. Mute picks its
/// speaker at the row, from the microphone's state.
fn command_icon(command: &Command) -> Option<IconName> {
    Some(match command {
        Command::Page(page) => crate::app::shell::page_icon(*page),
        Command::Settings(_) | Command::Setup => IconName::GearSix,
        Command::Preview => IconName::Eye,
        Command::StreamManager | Command::Chat => IconName::ChatCircle,
        Command::Notes => IconName::NotePencil,
        Command::CaptionsReader => IconName::ClosedCaptioning,
        Command::Notifications => IconName::Bell,
        Command::Record => IconName::Record,
        Command::GoLive => IconName::Broadcast,
        Command::HideScreen => return None,
        Command::Stop | Command::StopAllSounds => IconName::Stop,
        Command::Microphone => IconName::SpeakerSlash,
        Command::Clip(_) => IconName::Scissors,
        Command::Scene(_) | Command::AddScene => IconName::SquaresFour,
        Command::SceneBackground => IconName::SlidersHorizontal,
        Command::Theme(ThemeChoice::Light) => IconName::SunFill,
        Command::Theme(ThemeChoice::Dark) => IconName::MoonFill,
        Command::Theme(ThemeChoice::System) => IconName::Desktop,
        Command::PlaySound(_) => IconName::SpeakerHigh,
        // Electron draws the streamer's own Buddy picture (`OwnBuddyIcon`);
        // the Avatar page's glyph stands in.
        Command::AvatarTab(_) => IconName::Smiley,
        Command::SidekickTab(_) => IconName::UserSound,
        Command::VideorcCamera(_) => IconName::VideoCamera,
    })
}

/// Which windows are open when Search opens: their rows say Open or Close.
#[derive(Clone, Copy, Default)]
pub struct OpenWindows {
    pub preview: bool,
    pub notes: bool,
    pub stream_manager: bool,
}
impl EventEmitter<Command> for CommandPalette {}
pub struct CommandPalette {
    studio: Arc<Studio<BackendClient>>,
    runtime: tokio::runtime::Handle,
    pub handle: DialogHandle,
    input: Entity<InputState>,
    rows: Vec<Row>,
    selected: usize,
    scroll: ScrollHandle,
    notifications_available: bool,
    dialogs: Option<Entity<crate::screens::dialogs::DialogsHost>>,
    /// Soundboard pads for ⌘K Sounds (P103); refreshed when Search opens.
    board: Option<SoundboardState>,
    windows: OpenWindows,
    /// Videorc Camera's status for its row; read when Search opens.
    camera: Option<VirtualCameraStatus>,
}
impl CommandPalette {
    pub fn new(
        studio: Arc<Studio<BackendClient>>,
        runtime: tokio::runtime::Handle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search commands…"));
        cx.subscribe_in(
            &input,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    this.selected = 0;
                    this.rows.clear();
                    this.refresh(cx);
                }
                InputEvent::PressEnter {
                    secondary: false,
                    shift: false,
                } => this.run_selected(window, cx),
                _ => {}
            },
        )
        .detach();
        let mut changes = studio.watch();
        cx.spawn(async move |entity, cx| {
            while changes.changed().await.is_ok() {
                changes.borrow_and_update();
                if entity
                    .update(cx, |this, cx| {
                        if this.handle.is_open() {
                            this.refresh(cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            handle: DialogHandle::new(false),
            input,
            rows: Vec::new(),
            selected: 0,
            scroll: ScrollHandle::new(),
            notifications_available: false,
            dialogs: None,
            board: None,
            windows: OpenWindows::default(),
            camera: None,
        }
    }

    /// Videorc Camera's status (`virtualCamera.status`), for its row.
    fn load_camera(&mut self, cx: &mut Context<Self>) {
        if !self.studio.is_connected() {
            return;
        }
        let client = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            client
                .request("virtualCamera.status", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<VirtualCameraStatus>(value).ok())
        });
        cx.spawn(async move |this, cx| {
            let status = job.await.ok().flatten();
            let _ = this.update(cx, |palette, cx| {
                palette.camera = status;
                if palette.handle.is_open() {
                    palette.refresh(cx);
                }
            });
        })
        .detach();
    }

    fn load_board(&mut self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let result = runtime
                .spawn(async move { studio.backend().sounds_list().await })
                .await;
            let _ = this.update(cx, |palette, cx| {
                if let Ok(Ok(board)) = result {
                    palette.board = Some(board);
                    if palette.handle.is_open() {
                        palette.refresh(cx);
                    }
                }
            });
        })
        .detach();
    }
    /// The sidebar's visibility changed while Search may be open.
    pub fn refresh_page_shortcuts(&mut self, cx: &mut Context<Self>) {
        if self.handle.is_open() {
            self.refresh(cx);
        }
    }

    pub fn set_notifications_available(&mut self) {
        self.notifications_available = true;
    }
    /// The shell says which windows are open before Search opens.
    pub fn set_open_windows(&mut self, windows: OpenWindows) {
        self.windows = windows;
    }
    pub fn bind_dialogs(&mut self, dialogs: Entity<crate::screens::dialogs::DialogsHost>) {
        self.dialogs = Some(dialogs);
    }
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.handle.is_open() {
            self.handle.close(window, cx);
        } else {
            self.input
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.selected = 0;
            self.load_board(cx);
            self.load_camera(cx);
            self.refresh(cx);
            self.handle.open(window, cx);
            cx.on_next_frame(window, |this, window, cx| {
                this.input.read(cx).focus_handle(cx).focus(window, cx);
            });
        }
        cx.notify();
    }
    fn catalogue(&self) -> Vec<Row> {
        let s = self.studio.snapshot();
        let connected = self.studio.is_connected();
        let view = TransportView::from_snapshot(&s, &StartGates::of_snapshot(&s), false);
        let globals = s.settings.studio.global_shortcuts();
        let record_key = shortcut_accelerator("record-toggle");
        // Session: the transport's starts or its stop, in its words, then
        // Hide screen, the mute and the clips.
        let mut rows = vec![if view.active {
            Row::new(
                "stop",
                "Session",
                view.stop_label,
                Command::Stop,
                view.record_enabled,
            )
            .keywords(&["stop", "end", "recording", "livestream"])
            .shortcut(record_key)
        } else {
            Row::new(
                "record",
                "Session",
                "Start recording",
                Command::Record,
                view.record_enabled,
            )
            .keywords(&["record"])
            .shortcut(record_key)
        }];
        if !view.active {
            rows.push(
                Row::new(
                    "go-live",
                    "Session",
                    GO_LIVE_COMMAND,
                    Command::GoLive,
                    connected && view.record_enabled,
                )
                .keywords(&["stream", "livestream", "broadcast"]),
            );
        }
        rows.push(
            Row::new(
                "hide-screen",
                "Session",
                screen_copy::HIDE_SCREEN,
                Command::HideScreen,
                connected,
            )
            .shortcut(screen_hide_accelerator(
                globals
                    .get("screenHideToggle")
                    .and_then(serde_json::Value::as_str),
            )),
        );
        // Plan 214 E2 (`command-palette.tsx:356-380`): a mirror of Output →
        // Videorc Camera, never where the camera is hidden, off while it
        // can't run.
        let camera = OutputCameraView::of(
            self.camera.as_ref(),
            connected,
            crate::app::hotkeys::node_platform(),
        );
        if !camera.hidden {
            rows.push(
                Row::new(
                    "videorc-camera",
                    "Session",
                    if camera.checked {
                        CAMERA_TURN_OFF
                    } else {
                        CAMERA_TURN_ON
                    },
                    Command::VideorcCamera(!camera.checked),
                    !camera.disabled,
                )
                .keywords(&[
                    "camera",
                    "virtual camera",
                    "webcam",
                    "meet",
                    "zoom",
                    "teams",
                    "discord",
                    "facetime",
                    "other apps",
                ])
                .context("Output"),
            );
        }
        rows.push(
            Row::new(
                "mic",
                "Session",
                if s.settings.capture.audio.microphone_muted {
                    "Unmute microphone"
                } else {
                    "Mute microphone"
                },
                Command::Microphone,
                connected,
            )
            // `MuteIcon`: the speaker on while muted (Unmute), off to mute.
            .icon(if s.settings.capture.audio.microphone_muted {
                IconName::SpeakerHigh
            } else {
                IconName::SpeakerSlash
            })
            .keywords(&["mic", "microphone", "audio", "mute", "silence"])
            .shortcut(bound_accelerator(&globals, "micToggle")),
        );
        if view.active || s.clips.state == videorc_app_core::protocol::ReplayBufferState::On {
            let clips: [(u32, &str, &str, &[&str]); 2] = [
                (
                    30,
                    "Save a 30-second clip",
                    "clipMark",
                    &["clip", "replay", "marker", "moment", "30", "seconds"],
                ),
                (
                    60,
                    "Save a 1-minute clip",
                    "clipMarkLong",
                    &["clip", "replay", "marker", "moment", "60", "minute", "long"],
                ),
            ];
            for (seconds, label, key, words) in clips {
                rows.push(
                    Row::new(
                        format!("clip-{seconds}"),
                        "Session",
                        label,
                        Command::Clip(seconds),
                        connected,
                    )
                    .keywords(words)
                    .shortcut(bound_accelerator(&globals, key)),
                );
            }
        }
        // Pages: one verb for every page, in sidebar order, Health last.
        // The shell routes every page, as its sidebar row does.
        // `command-palette.tsx:444`: Guests only while it is available
        // (`guestsVisible`), as its sidebar row.
        let guests = videorc_app_core::livestream::cloud_status::guests_visible(
            self.studio.cloud_now().status.as_ref(),
        );
        for page in nav::SIDEBAR_ORDER.into_iter().chain([PageId::Diagnostics]) {
            if page == PageId::Guests && !guests {
                continue;
            }
            rows.push(
                Row::new(
                    format!("page-{}", page.id()),
                    "Pages",
                    page.label(),
                    Command::Page(page),
                    true,
                )
                .value(format!("Open {}", page.label()))
                .keywords(page_keywords(page))
                .shortcut(page.accelerator(guests)),
            );
            // `command-palette.tsx:471-487`: Background settings under Scene.
            if page == PageId::Layouts {
                let mut words: Vec<&str> = camera_background_view::KEYWORDS.to_vec();
                words.extend(camera_background_view::GREEN_SCREEN_KEYWORDS);
                words.extend(["blur strength", "similarity", "spill", "smoothness"]);
                rows.push(
                    Row::new(
                        "scene-background",
                        "Pages",
                        camera_background_view::SETTINGS_LABEL,
                        Command::SceneBackground,
                        true,
                    )
                    .keywords(&words)
                    .context("Scene"),
                );
            }
        }
        rows.push(
            Row::new(
                "notifications",
                "Pages",
                "Open notifications",
                Command::Notifications,
                self.notifications_available,
            )
            .keywords(&["bell", "alerts", "problems", "warnings", "unread", "inbox"])
            .shortcut(shortcut_accelerator("notifications")),
        );
        // Windows: each by its one name, in the Window menu's order.
        let open_or_close = |open: bool, name: &str| {
            if open {
                format!("Close {name}")
            } else {
                format!("Open {name}")
            }
        };
        rows.push(
            Row::new(
                "preview",
                "Windows",
                open_or_close(self.windows.preview, "Preview"),
                Command::Preview,
                // A Preview window exists on macOS and Linux (none on Windows
                // yet).
                cfg!(any(target_os = "macos", target_os = "linux")),
            )
            .keywords(&["monitor", "stage", "window"])
            .shortcut(shortcut_accelerator("preview-window")),
        );
        rows.push(
            Row::new(
                "notes",
                "Windows",
                open_or_close(self.windows.notes, "Notes"),
                Command::Notes,
                true,
            )
            .keywords(&["script", "teleprompter", "window"])
            .shortcut(shortcut_accelerator("notes-window")),
        );
        rows.push(
            Row::new(
                "manager",
                "Windows",
                open_or_close(self.windows.stream_manager, "Stream Manager"),
                Command::StreamManager,
                true,
            )
            .keywords(&["chat", "comments", "activity", "viewers", "window", "buddy"])
            .shortcut(shortcut_accelerator("comments-window")),
        );
        rows.push(
            Row::new(
                "captions-reader",
                "Windows",
                "Open Captions reader",
                Command::CaptionsReader,
                true,
            )
            .keywords(&["subtitles", "window", "reader"])
            .shortcut(shortcut_accelerator("captions-window")),
        );
        // Scenes: Studio's Add scene… (plan 231 D14), then each scene.
        if !s.scenes.scenes.is_empty() {
            rows.push(
                Row::new(
                    "add-scene",
                    "Scenes",
                    "Add scene…",
                    Command::AddScene,
                    !s.scenes.read_only,
                )
                .keywords(&[
                    "new scene",
                    "scene",
                    "app",
                    "window",
                    "display",
                    "camera only",
                ])
                .context("Studio"),
            );
        }
        for scene in &s.scenes.scenes {
            rows.push(
                Row::new(
                    format!("scene-{}", scene.id),
                    "Scenes",
                    format!("Switch to {}", scene.name),
                    Command::Scene(scene.id.clone()),
                    connected,
                )
                .keywords(&["scene", "layout"])
                .context("Scene"),
            );
        }
        // Sounds (P103): each pad with its Studio key, then Stop all.
        if let Some(board) = &self.board {
            for sound in &board.sounds {
                rows.push(
                    Row::new(
                        format!("sound-{}", sound.id),
                        "Sounds",
                        format!("Play sound: {}", sound.name),
                        Command::PlaySound(sound.id.clone()),
                        connected,
                    )
                    .keywords(&["sound", "soundboard", "sfx", "effect", "play"])
                    .shortcut(sound.hotkey.clone()),
                );
            }
            if !board.sounds.is_empty() {
                rows.push(
                    Row::new(
                        "stop-sounds",
                        "Sounds",
                        "Stop all sounds",
                        Command::StopAllSounds,
                        connected,
                    )
                    .keywords(&["sounds", "soundboard", "stop", "silence"]),
                );
            }
        }
        // Avatar and Sidekick: every tab one jump away (plans 239, 150).
        for (index, (id, label)) in AVATAR_TABS.into_iter().enumerate() {
            rows.push(
                Row::new(
                    format!("avatar-{id}"),
                    "Avatar",
                    label,
                    Command::AvatarTab(index),
                    true,
                )
                .value(format!("Open Avatar → {label}"))
                .keywords(avatar_keywords(id))
                .context("Avatar"),
            );
        }
        for (index, (id, label)) in SIDEKICK_TABS.into_iter().enumerate() {
            rows.push(
                Row::new(
                    format!("sidekick-{id}"),
                    "Sidekick",
                    label,
                    Command::SidekickTab(index),
                    true,
                )
                .value(format!("Open Sidekick → {label}"))
                .keywords(sidekick_keywords(id))
                .context("Sidekick"),
            );
        }
        // Settings: every tab one jump away, then Run setup again….
        for tab in videorc_app_core::settings_page::TABS {
            let words: &[&str] = match tab {
                SettingsTab::General => &["theme", "startup", "animate", "preferences"],
                SettingsTab::Permissions => &[
                    "camera access",
                    "screen recording",
                    "microphone access",
                    "system access",
                ],
                SettingsTab::Shortcuts => &["keyboard", "keys", "hotkeys", "bindings"],
                SettingsTab::Remote => &[
                    "phone",
                    "stream deck",
                    "pair",
                    "control",
                    "agents",
                    "ai",
                    "mcp",
                ],
                SettingsTab::About => &["version", "update", "release notes", "support bundle"],
            };
            rows.push(
                Row::new(
                    format!("settings-{}", tab.id()),
                    "Settings",
                    tab.label(),
                    Command::Settings(tab),
                    true,
                )
                .value(format!("Open Settings → {}", tab.label()))
                .keywords(words)
                .context("Settings")
                .shortcut(if tab == SettingsTab::Shortcuts {
                    shortcut_accelerator("shortcuts-page")
                } else {
                    None
                }),
            );
        }
        if !s.session.phase.is_active() {
            rows.push(
                Row::new(
                    "setup",
                    "Settings",
                    "Run setup again…",
                    Command::Setup,
                    connected,
                )
                .keywords(&["first-run", "welcome", "onboarding", "permissions", "setup"])
                .context("Settings"),
            );
        }
        // Appearance: the look in use wears the check (plan 174 A-9).
        let theme = ThemeChoice::parse(s.settings.theme.as_deref());
        for (choice, label, value) in [
            (ThemeChoice::Light, "Light", "Light theme"),
            (ThemeChoice::Dark, "Dark", "Dark theme"),
            (ThemeChoice::System, "System", "System theme"),
        ] {
            let words: &[&str] = if choice == ThemeChoice::System {
                &["theme", "appearance", "mode", "automatic"]
            } else {
                &["theme", "appearance", "mode"]
            };
            rows.push(
                Row::new(
                    format!("theme-{}", choice.as_str()),
                    "Appearance",
                    label,
                    Command::Theme(choice),
                    s.settings.hydrated,
                )
                .value(value)
                .keywords(words)
                .checked(theme == choice),
            );
        }
        rows.push(
            Row::new(
                "chat",
                "Appearance",
                "Chat in Studio",
                Command::Chat,
                s.settings.hydrated,
            )
            .keywords(&["chat", "comments", "messages", "studio"])
            .checked(studio_chat_on(&s)),
        );
        rows
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let query = self.input.read(cx).value();
        let all = self.catalogue();
        let selected_id = self.rows.get(self.selected).map(|r| r.id.clone());
        let indices = videorc_app_core::command_score::filter_sorted(
            all.iter().map(|r| {
                (
                    r.value.as_str(),
                    r.keywords.iter().map(String::as_str).collect(),
                )
            }),
            query.as_ref(),
        );
        // cmdk keeps a group's rows under its one heading: the groups in the
        // order of their best match, each group's rows in theirs.
        let mut groups: Vec<&'static str> = Vec::new();
        for &index in &indices {
            if !groups.contains(&all[index].group) {
                groups.push(all[index].group);
            }
        }
        self.rows = groups
            .iter()
            .flat_map(|group| {
                indices
                    .iter()
                    .filter(|&&index| all[index].group == *group)
                    .map(|&index| all[index].clone())
                    .collect::<Vec<_>>()
            })
            .collect();
        self.selected = selected_id
            .and_then(|id| self.rows.iter().position(|r| r.id == id))
            .unwrap_or(0)
            .min(self.rows.len().saturating_sub(1));
        cx.notify();
    }
    fn run_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return;
        };
        if !self
            .catalogue()
            .iter()
            .any(|r| r.id == row.id && r.enabled && r.command == row.command)
        {
            return;
        }
        self.handle.close(window, cx);
        let studio = self.studio.clone();
        let command = row.command;
        match command {
            Command::Page(_)
            | Command::Settings(_)
            | Command::Setup
            | Command::Preview
            | Command::StreamManager
            | Command::Notes
            | Command::CaptionsReader
            | Command::AddScene
            | Command::SceneBackground
            | Command::AvatarTab(_)
            | Command::SidekickTab(_)
            | Command::Notifications => cx.emit(command),
            Command::GoLive | Command::HideScreen => {
                let action = if command == Command::GoLive {
                    "stream-toggle"
                } else {
                    "screen-hide-toggle"
                };
                StudioActions {
                    studio,
                    runtime: self.runtime.clone(),
                }
                .run(action);
            }
            _ => {
                if command == Command::Stop {
                    cx.emit(Command::Page(PageId::Studio));
                }
                let dialogs = self.dialogs.clone();
                if command == Command::Record {
                    cx.spawn(async move |_, cx| {
                        let outcome = studio.start_recording().await;
                        if let videorc_app_core::StartOutcome::Refused { message } = outcome
                            && let Some(dialogs) = dialogs
                        {
                            dialogs.update(cx, |dialogs, cx| {
                                dialogs.queue_start_blocked(message, cx);
                            });
                        }
                    })
                    .detach();
                    return;
                }
                self.runtime.spawn(async move {
                    match command {
                        Command::Stop => {
                            studio.request_stop(StopOrigin::Palette).await;
                        }
                        Command::Microphone => {
                            studio
                                .set_microphone_muted(
                                    videorc_app_core::studio::MicrophoneMode::Toggle,
                                )
                                .await;
                        }
                        Command::Clip(seconds) => {
                            studio.mark_clip(Some(seconds)).await;
                        }
                        Command::Scene(id) => {
                            studio.apply_saved_scene_by_id(&id).await;
                        }
                        Command::Theme(theme) => {
                            let _ = studio
                                .write_settings(vec![families::write_theme(theme.as_str())])
                                .await;
                        }
                        Command::Chat => {
                            let value = studio_chat_on(&studio.snapshot());
                            let _ = studio
                                .update_studio_settings(|settings| {
                                    settings.set("studioChat", serde_json::json!(!value))
                                })
                                .await;
                        }
                        Command::PlaySound(id) => {
                            let _ = studio
                                .backend()
                                .sounds_request("sounds.play", json!({ "id": id }))
                                .await;
                        }
                        Command::StopAllSounds => {
                            let _ = studio
                                .backend()
                                .sounds_request("sounds.stop", json!({}))
                                .await;
                        }
                        // `camera.setOn(on, { toastFailure: true })`: the
                        // Output page follows `virtualCamera.changed`.
                        Command::VideorcCamera(on) => {
                            let set = studio
                                .backend()
                                .request("virtualCamera.set", json!({ "on": on }))
                                .await;
                            if let Err(error) = set {
                                let context = UserErrorContext {
                                    action: if on { "turn on" } else { "turn off" },
                                    object: "Videorc Camera",
                                };
                                if let Some(command) = toast_user_error(
                                    Failure::Rpc(&error),
                                    context,
                                    CAMERA_SWITCH_TOAST_ID,
                                ) {
                                    studio.post_notices(vec![command]);
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }
        }
        cx.notify();
    }
}
impl CommandPalette {
    /// The list child that holds row `row`: each group adds its heading, and
    /// every group after the first a separator, before its rows.
    fn child_index(&self, row: usize) -> usize {
        let mut index = 0;
        let mut group = None;
        for (at, entry) in self.rows.iter().enumerate() {
            if group != Some(entry.group) {
                index += if group.is_some() { 2 } else { 1 };
                group = Some(entry.group);
            }
            if at == row {
                return index;
            }
            index += 1;
        }
        index
    }
}
impl Render for CommandPalette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = current(window, cx).theme();
        let mut list = CommandList::new("command-results", &self.scroll);
        if self.rows.is_empty() {
            list = list.child(CommandEmpty::new("No results found."));
        }
        let mut group = None;
        for (index, row) in self.rows.iter().enumerate() {
            if group != Some(row.group) {
                // `CommandSeparator` between groups (`my-1 h-px`), with each
                // group's own 6 px pad around it.
                if group.is_some() {
                    list = list.child(div().flex_none().py(px(6.)).child(CommandSeparator::new()));
                }
                list = list.child(CommandGroup::new(row.group));
                group = Some(row.group);
            }
            let selected = index == self.selected;
            let mut item = CommandItem::new(SharedString::from(row.id.clone()), row.label.clone())
                .selected(selected)
                .disabled(!row.enabled);
            if let Some(glyph) = row.icon {
                item = item.icon(glyph);
            }
            if let Some(context) = row.context {
                item = item.child(
                    div()
                        .min_w(px(0.))
                        .truncate()
                        .text_color(hsla(t.muted_foreground))
                        .child(context),
                );
            }
            if let Some(accelerator) = &row.shortcut {
                // `CommandShortcut`: at the end, the key's chip.
                item = item.child(
                    div()
                        .ml_auto()
                        .flex_none()
                        .child(ShortcutKeys::accelerator(accelerator.clone())),
                );
            } else if row.checked {
                item = item.child(div().ml_auto().flex_none().child(icon(
                    IconName::Check,
                    16.,
                    hsla(t.foreground),
                )));
            }
            list = list.child(item.on_click(cx.listener(move |this, _, window, cx| {
                this.selected = index;
                this.run_selected(window, cx);
            })));
        }
        let footer = self
            .rows
            .get(self.selected)
            .map(|r| r.value.clone())
            .unwrap_or_default();
        command_dialog("command-palette", &self.handle).child(
            div()
                .key_context("CommandPalette")
                .capture_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                    if this.input.update(cx, |input, cx| {
                        input.marked_text_range(window, cx).is_some()
                    }) {
                        return;
                    }
                    let delta = match event.keystroke.key.as_str() {
                        "up" => -1isize,
                        "down" => 1,
                        _ => return,
                    };
                    if event.keystroke.modifiers.control
                        || event.keystroke.modifiers.platform
                        || event.keystroke.modifiers.alt
                    {
                        return;
                    }
                    if !this.rows.is_empty() {
                        for _ in 0..this.rows.len() {
                            this.selected = (this.selected as isize + delta)
                                .rem_euclid(this.rows.len() as isize)
                                as usize;
                            if this.rows[this.selected].enabled {
                                break;
                            }
                        }
                        let child = this.child_index(this.selected);
                        this.scroll.scroll_to_item(child);
                        cx.notify();
                    }
                    cx.stop_propagation();
                }))
                .child(CommandInput::new(&self.input))
                .child(list)
                // `CommandFooter`: the selected action, then the key that
                // runs it.
                .child(
                    CommandFooter::new()
                        .child(div().min_w(px(0.)).truncate().child(footer))
                        .child(div().flex_none().child(ShortcutKeys::keystrokes("enter"))),
                ),
        )
    }
}
/// `studioChatOn`: Chat in Studio unless it was turned off.
fn studio_chat_on(snapshot: &videorc_app_core::studio::StudioSnapshot) -> bool {
    snapshot
        .settings
        .studio
        .doc()
        .get("studioChat")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}
/// `AVATAR_KEYWORDS`.
fn avatar_keywords(id: &str) -> &'static [&'static str] {
    match id {
        "profile" => &[
            "persona",
            "name",
            "personality",
            "look",
            "my avatars",
            "library",
            "buddy",
            "pet",
        ],
        "greetings" => &["welcome", "follow", "sub", "raid", "lines"],
        _ => &[],
    }
}
/// `BUDDY_KEYWORDS`.
fn sidekick_keywords(id: &str) -> &'static [&'static str] {
    match id {
        "live" => &["overview", "sidekick live", "status", "listen", "cloud ai"],
        "chat" => &["posting", "suggest", "bubble", "moderation"],
        "community" => &["regulars", "viewers", "people", "link", "forget"],
        "voice" => &["commands", "speak", "listen"],
        "reports" => &["summary", "stream report"],
        "clean-cut" => &["edit", "export", "cut", "recording"],
        _ => &[],
    }
}
/// `PAGE_KEYWORDS`: what people type for a page that is not its name.
fn page_keywords(page: PageId) -> &'static [&'static str] {
    match page {
        PageId::Studio => &["record", "go live", "stage", "transport"],
        PageId::Avatar => &[
            "character",
            "mascot",
            "pet",
            "alive",
            "bubble",
            "greetings",
            "sidekick",
        ],
        PageId::Ai => &[
            "assistant",
            "ai",
            "chat",
            "moderation",
            "voice",
            "reports",
            "clean cut",
        ],
        PageId::Guests => &["guest", "invite", "room", "talk show", "co-host", "link"],
        PageId::Sources => &[
            "camera",
            "microphone",
            "screen",
            "window",
            "devices",
            "audio",
            "mixer",
        ],
        PageId::Layouts => &[
            "layout",
            "layouts",
            "composition",
            "background",
            "takeover",
            "presets",
            "edit scene",
            "scene editor",
        ],
        PageId::Assets => &[
            "assets",
            "backgrounds",
            "overlays",
            "pictures",
            "takeovers",
            "banners",
        ],
        PageId::Sounds => &[
            "assets",
            "soundboard",
            "sound effects",
            "sfx",
            "import sounds",
        ],
        PageId::Live => &[
            "livestream",
            "stream key",
            "youtube",
            "twitch",
            "kick",
            "schedule",
            "go live",
            "channels",
        ],
        PageId::Captions => &["subtitles", "transcription"],
        PageId::Recording => &[
            "recording",
            "quality",
            "resolution",
            "folder",
            "file",
            "storage",
        ],
        PageId::Library => &["recordings", "clips", "markers", "history"],
        PageId::Settings => &[
            "preferences",
            "keyboard",
            "shortcuts",
            "permissions",
            "updates",
            "about",
        ],
        PageId::Diagnostics => &[
            "diagnostics",
            "support bundle",
            "logs",
            "problem",
            "bug",
            "report",
            "checks",
        ],
    }
}
