//! The shell's Search door. Commands are rebuilt from confirmed core state
//! at activation as well as while searching; no stale row bypasses a gate.
use gpui::{
    Context, Entity, EntityInputHandler, EventEmitter, Focusable, ScrollHandle, SharedString,
    Window, div, prelude::*, px,
};
use std::sync::Arc;
use videorc_app_core::studio::{families, inspector::StartGates, transport::TransportView};
use videorc_app_core::{BackendClient, StopOrigin, Studio};
use videorc_app_core::{
    nav::{self, PageId, ThemeChoice},
    settings_page::SettingsTab,
};
use videorc_kit::{
    ShortcutKeys,
    command::{CommandInput, CommandItem, CommandList, InputEvent, InputState, command_dialog},
    dialog::DialogHandle,
    theme::{current, hsla},
};

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
    Stop,
    Microphone,
    Clip(u32),
    Scene(String),
    Theme(ThemeChoice),
    Chat,
    Unavailable,
}
#[derive(Clone)]
struct Row {
    id: String,
    group: &'static str,
    label: String,
    keywords: Vec<String>,
    command: Command,
    enabled: bool,
}
impl Row {
    fn new(
        id: impl Into<String>,
        group: &'static str,
        label: impl Into<String>,
        command: Command,
        enabled: bool,
    ) -> Self {
        Self {
            id: id.into(),
            group,
            label: label.into(),
            keywords: Vec::new(),
            command,
            enabled,
        }
    }
    fn keywords(mut self, words: &[&str]) -> Self {
        self.keywords = words.iter().map(|s| s.to_string()).collect();
        self
    }
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
        }
    }
    pub fn set_notifications_available(&mut self) {
        self.notifications_available = true;
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
        let view = TransportView::from_snapshot(&s, &StartGates::default(), false);
        let mut rows = vec![if view.active {
            Row::new(
                "stop",
                "Session",
                view.stop_label,
                Command::Stop,
                view.record_enabled,
            )
        } else {
            Row::new(
                "record",
                "Session",
                "Start recording",
                Command::Record,
                view.record_enabled,
            )
        }];
        if !view.active {
            rows.push(
                Row::new(
                    "go-live",
                    "Session",
                    "Go live…",
                    Command::Unavailable,
                    false,
                )
                .keywords(&["stream", "livestream", "broadcast"]),
            );
        }
        rows.push(Row::new(
            "hide-screen",
            "Session",
            "Hide screen",
            Command::Unavailable,
            false,
        ));
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
            .keywords(&["mic", "audio", "silence"]),
        );
        if view.active || s.clips.state == videorc_app_core::protocol::ReplayBufferState::On {
            for (seconds, label) in [(30, "Save a 30-second clip"), (60, "Save a 1-minute clip")] {
                rows.push(
                    Row::new(
                        format!("clip-{seconds}"),
                        "Session",
                        label,
                        Command::Clip(seconds),
                        connected,
                    )
                    .keywords(&["clip", "replay", "marker", "moment"]),
                );
            }
        }
        for page in nav::PAGES {
            rows.push(
                Row::new(
                    format!("page-{}", page.id()),
                    "Pages",
                    page.label(),
                    Command::Page(page),
                    page.ported(),
                )
                .keywords(page_keywords(page)),
            );
        }
        rows.push(Row::new(
            "notifications",
            "Pages",
            "Open notifications",
            Command::Notifications,
            self.notifications_available,
        ));
        rows.push(Row::new(
            "preview",
            "Windows",
            "Open/Close Preview",
            Command::Preview,
            cfg!(target_os = "macos"),
        ));
        rows.push(Row::new(
            "manager",
            "Windows",
            "Stream Manager",
            Command::StreamManager,
            true,
        ));
        rows.push(Row::new("notes", "Windows", "Notes", Command::Notes, true));
        rows.push(Row::new(
            "Captions reader",
            "Windows",
            "Captions reader",
            Command::CaptionsReader,
            true,
        ));
        rows.push(Row::new(
            "add-scene",
            "Scenes",
            "Add scene…",
            Command::Unavailable,
            false,
        ));
        for scene in &s.scenes.scenes {
            rows.push(Row::new(
                format!("scene-{}", scene.id),
                "Scenes",
                format!("Switch to {}", scene.name),
                Command::Scene(scene.id.clone()),
                connected,
            ));
        }
        for tab in videorc_app_core::settings_page::TABS {
            let words: &[&str] = match tab {
                SettingsTab::General => &["theme", "startup", "preferences"],
                SettingsTab::Permissions => {
                    &["camera access", "screen recording", "microphone access"]
                }
                SettingsTab::Shortcuts => &["keyboard", "keys", "hotkeys", "bindings"],
                SettingsTab::Remote => &["phone", "stream deck", "pair", "agents", "mcp"],
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
                .keywords(words),
            );
        }
        if !s.session.phase.is_active() {
            rows.push(Row::new(
                "setup",
                "Settings",
                "Run setup again…",
                Command::Setup,
                connected,
            ));
        }
        for (theme, label) in [
            (ThemeChoice::Light, "Light"),
            (ThemeChoice::Dark, "Dark"),
            (ThemeChoice::System, "System"),
        ] {
            rows.push(Row::new(
                format!("theme-{}", theme.as_str()),
                "Appearance",
                label,
                Command::Theme(theme),
                s.settings.hydrated,
            ));
        }
        rows.push(Row::new(
            "chat",
            "Appearance",
            "Chat in Studio",
            Command::Chat,
            s.settings.hydrated,
        ));
        rows
    }
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let query = self.input.read(cx).value();
        let all = self.catalogue();
        let selected_id = self.rows.get(self.selected).map(|r| r.id.clone());
        let indices = videorc_app_core::command_score::filter_sorted(
            all.iter().map(|r| {
                (
                    r.label.as_str(),
                    r.keywords.iter().map(String::as_str).collect(),
                )
            }),
            query.as_ref(),
        );
        self.rows = indices.into_iter().map(|i| all[i].clone()).collect();
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
            | Command::Notifications => cx.emit(command),
            _ => {
                if command == Command::Stop {
                    cx.emit(Command::Page(PageId::Studio));
                }
                let dialogs = self.dialogs.clone();
                if command == Command::Record {
                    cx.spawn(async move |_, cx| {
                        let outcome = studio.start_recording().await;
                        if let videorc_app_core::StartOutcome::Refused { message } = outcome {
                            if let Some(dialogs) = dialogs {
                                let _ = dialogs.update(cx, |dialogs, cx| {
                                    dialogs.queue_start_blocked(message, cx);
                                });
                            }
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
                            let value = studio
                                .snapshot()
                                .settings
                                .studio
                                .doc()
                                .get("studioChat")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(true);
                            let _ = studio
                                .update_studio_settings(|settings| {
                                    settings.set("studioChat", serde_json::json!(!value))
                                })
                                .await;
                        }
                        _ => {}
                    }
                });
            }
        }
        cx.notify();
    }
}
impl Render for CommandPalette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = current(window, cx).theme();
        let mut list = CommandList::new("command-results", &self.scroll);
        if self.rows.is_empty() {
            list = list.child(div().p(px(24.)).child("No results found."));
        }
        for (index, row) in self.rows.iter().enumerate() {
            list = list.child(
                CommandItem::new(SharedString::from(row.id.clone()), row.label.clone())
                    .selected(index == self.selected)
                    .disabled(!row.enabled)
                    .child(div().ml_auto().text_color(hsla(t.muted_foreground)).child(
                        if row.enabled {
                            row.group
                        } else {
                            "Unavailable in this build."
                        },
                    ))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.selected = index;
                        this.run_selected(window, cx);
                    })),
            );
        }
        let title = self
            .rows
            .get(self.selected)
            .map(|r| r.label.clone())
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
                        this.scroll.scroll_to_item(this.selected);
                        cx.notify();
                    }
                    cx.stop_propagation();
                }))
                .child(CommandInput::new(&self.input))
                .child(list)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .p(px(12.))
                        .border_t_1()
                        .border_color(hsla(t.border))
                        .child(title)
                        .child(ShortcutKeys::keystrokes("enter")),
                ),
        )
    }
}
fn page_keywords(page: PageId) -> &'static [&'static str] {
    match page {
        PageId::Studio => &["record", "go live", "stage", "transport"],
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
            "composition",
            "background",
            "takeover",
            "presets",
            "edit scene",
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
        PageId::Assets => &["assets", "backgrounds", "overlays", "pictures", "banners"],
        PageId::Sounds => &["assets", "soundboard", "sfx", "sound effects"],
        PageId::Settings => &[
            "preferences",
            "keyboard",
            "shortcuts",
            "permissions",
            "updates",
            "about",
        ],
        PageId::Diagnostics => &[
            "health",
            "diagnostics",
            "logs",
            "support",
            "performance",
            "problems",
        ],
        PageId::Captions => &["subtitles", "transcription"],
        PageId::Recording => &["quality", "resolution", "folder", "file", "storage"],
        PageId::Library => &["recordings", "clips", "markers", "history"],
        PageId::Guests => &["guest", "invite", "room", "talk show", "co-host", "link"],
        PageId::Avatar => &["character", "mascot", "pet", "greetings", "sidekick"],
        PageId::Ai => &[
            "assistant",
            "ai",
            "chat",
            "moderation",
            "voice",
            "reports",
            "clean cut",
        ],
    }
}
