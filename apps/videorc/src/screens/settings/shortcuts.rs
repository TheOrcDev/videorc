use super::*;
use gpui::{AnyElement, Keystroke, SharedString};
use videorc_app_core::{
    desktop::{accelerator as a, global_shortcuts as g},
    shortcuts as s,
};
use videorc_kit::{
    button::{Button, ButtonVariant},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
    shortcut_keys::ShortcutKeys,
};

#[derive(Default)]
pub(super) struct Recorder {
    action: Option<String>,
    interceptor: Option<gpui::Subscription>,
    generation: u64,
    message: Option<String>,
}
impl SettingsScreen {
    fn shortcut_config(&self) -> g::GlobalShortcutsConfig {
        serde_json::from_value(self.studio.snapshot().settings.studio.global_shortcuts())
            .unwrap_or_default()
    }
    fn shortcut_scenes(&self) -> Vec<(String, String)> {
        self.studio
            .snapshot()
            .scenes
            .scenes
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect()
    }
    pub(super) fn apply_shortcuts(&mut self) {
        let state = self.studio.snapshot();
        if !state.settings.hydrated {
            return;
        }
        let value = state.settings.studio.global_shortcuts();
        if self.applied_shortcuts.as_ref() == Some(&value) {
            return;
        }
        self.hotkeys.apply(
            &serde_json::from_value(value.clone()).unwrap_or_default(),
            crate::app::hotkeys::node_platform(),
        );
        self.applied_shortcuts = Some(value);
    }
    pub fn disarm_shortcut(&mut self, cx: &mut Context<Self>) {
        if self.shortcut.action.take().is_some() {
            self.shortcut.interceptor = None;
            self.shortcut.generation += 1;
            self.hotkeys.set_recorder_armed(false);
            cx.notify();
        }
    }
    fn arm_shortcut(&mut self, action: String, cx: &mut Context<Self>) {
        if self.disabled() || !crate::app::hotkeys::supported(&action) {
            return;
        }
        self.disarm_shortcut(cx);
        self.shortcut.message = None;
        self.shortcut.action = Some(action);
        self.hotkeys.set_recorder_armed(true);
        let weak = cx.entity().downgrade();
        // Interception runs before the keymap, so navigation and Record do
        // not fire while recording. GPUI supplies the unmodified key, not
        // the option-modified text (e.g. Option-M is m, not µ).
        self.shortcut.interceptor = Some(cx.intercept_keystrokes(move |event, _, cx| {
            let _ = weak.update(cx, |this, cx| {
                if this.shortcut.action.is_some() {
                    cx.stop_propagation();
                    this.record_shortcut(&event.keystroke, cx);
                }
            });
        }));
        let generation = self.shortcut.generation;
        cx.spawn(async move |entity, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(30))
                .await;
            let _ = entity.update(cx, |this, cx| {
                if this.shortcut.generation == generation {
                    this.disarm_shortcut(cx);
                }
            });
        })
        .detach();
        cx.notify();
    }
    fn record_shortcut(&mut self, key: &Keystroke, cx: &mut Context<Self>) {
        let Some(action) = self.shortcut.action.clone() else {
            return;
        };
        let platform = Some(crate::app::hotkeys::node_platform());
        let config = self.shortcut_config();
        let scenes = self.shortcut_scenes();
        let input = a::KeyInput {
            code: key_code(&key.key),
            meta: key.modifiers.platform,
            control: key.modifiers.control,
            alt: key.modifiers.alt,
            shift: key.modifiers.shift,
            key_up: false,
        };
        let step = s::shortcut_recorder_step(&input, platform, |value| {
            a::global_shortcut_taken_reason(&config, value, &action, platform, &scenes)
        });
        let value = match step {
            s::RecorderStep::Commit(value) => value,
            s::RecorderStep::Clear => String::new(),
            s::RecorderStep::Cancel => {
                self.disarm_shortcut(cx);
                return;
            }
            s::RecorderStep::Held(_) => return,
            s::RecorderStep::Reject(message) => {
                self.shortcut.message = Some(message);
                cx.notify();
                return;
            }
        };
        self.disarm_shortcut(cx);
        self.shortcut.message = None;
        self.busy = true;
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .update_studio_settings(|settings| {
                    let config =
                        serde_json::from_value(settings.global_shortcuts()).unwrap_or_default();
                    settings.set(
                        g::SETTINGS_FIELD,
                        serde_json::to_value(g::with_global_shortcut(&config, &action, &value))
                            .unwrap_or_default(),
                    );
                })
                .await
                .is_ok()
        });
        self.finish_save(job, cx);
    }
    pub(super) fn shortcuts_page(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let registration = self.hotkeys.registration();
        let config = self.shortcut_config();
        let scenes = self.shortcut_scenes();
        let model = s::shortcuts_view(s::ShortcutsInput {
            config: &config,
            platform: Some(crate::app::hotkeys::node_platform()),
            unavailable: registration.unavailable.as_deref(),
            system_audio_available: self.studio.snapshot().sources.devices.devices.iter().any(
                |device| {
                    device.kind == videorc_app_core::protocol::DeviceKind::SystemAudio
                        && device.status != videorc_app_core::protocol::DeviceStatus::Unavailable
                },
            ),
            scenes: &scenes,
            registered: &registration.registered,
        });
        let mut globals = GroupedList::new();
        for row in model.action_rows.into_iter().chain(model.scene_rows) {
            let armed = self.shortcut.action.as_deref() == Some(&row.action);
            let name = s::shortcut_recorder_name(
                &row.label,
                row.value.as_deref(),
                row.app_key.as_ref(),
                armed,
                Some(crate::app::hotkeys::node_platform()),
            );
            let enabled = crate::app::hotkeys::supported(&row.action);
            let action = row.action.clone();
            globals = globals.item(
                div()
                    .child(
                        ListRow::new(SharedString::from(row.action), row.label).child(
                            Button::new(SharedString::from(format!("record-{action}")))
                                .accessibility_label(name)
                                .label(if armed {
                                    "Press shortcut…".to_string()
                                } else {
                                    row.value
                                        .as_deref()
                                        .filter(|s| !s.is_empty())
                                        .map(|s| {
                                            a::accelerator_label(
                                                Some(s),
                                                Some(crate::app::hotkeys::node_platform()),
                                            )
                                        })
                                        .unwrap_or_else(|| "Unassigned".into())
                                })
                                .variant(ButtonVariant::Outline)
                                .disabled(self.disabled() || !enabled)
                                .tooltip(if enabled {
                                    "Click to change"
                                } else {
                                    view::NOT_IN_THIS_BUILD
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.arm_shortcut(action.clone(), cx)
                                })),
                        ),
                    )
                    .children(row.conflict),
            );
        }
        let mut app = GroupedList::new();
        for (label, action) in [
            (
                "Settings",
                Box::new(crate::app::menus::ShowSettings) as Box<dyn gpui::Action>,
            ),
            (
                "Settings → Shortcuts",
                Box::new(crate::app::menus::ShowShortcuts),
            ),
            ("Open Preview", Box::new(crate::app::menus::TogglePreview)),
        ] {
            app = app
                .item(ListRow::new(label, label).child(ShortcutKeys::for_action(action.as_ref())));
        }
        div()
            .flex()
            .flex_wrap()
            .items_start()
            .child(
                div().flex_1().min_w(px(360.)).child(
                    PanelSection::new(s::GLOBAL_TITLE)
                        .title(s::GLOBAL_TITLE)
                        .description(model.global_description)
                        .children(model.unavailable)
                        .children(self.shortcut.message.clone())
                        .child(globals),
                ),
            )
            .child(
                div().flex_1().min_w(px(360.)).child(
                    PanelSection::new(s::APP_TITLE)
                        .title(s::APP_TITLE)
                        .description(s::APP_DESCRIPTION)
                        .child(app),
                ),
            )
            .into_any_element()
    }
}

fn key_code(key: &str) -> String {
    if key.len() == 1 {
        let c = key.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return format!("Key{}", c.to_ascii_uppercase());
        }
        if c.is_ascii_digit() {
            return format!("Digit{c}");
        }
    }
    if key
        .strip_prefix('f')
        .is_some_and(|n| n.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)))
    {
        return key.to_ascii_uppercase();
    }
    match key {
        "escape" => "Escape",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "enter" => "Enter",
        "space" => "Space",
        "tab" => "Tab",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "insert" => "Insert",
        "-" => "Minus",
        "=" => "Equal",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        "\\" => "Backslash",
        ";" => "Semicolon",
        "'" => "Quote",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        "`" => "Backquote",
        _ => "Unsupported",
    }
    .into()
}
