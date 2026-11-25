//! Set key… (`scene-dialogs.tsx`, `shortcut-recorder.tsx`; P470, P478,
//! P479): a scene's own key, from any app. The recorder is Settings →
//! Shortcuts' (`shortcuts::shortcut_recorder_step` and the taken check);
//! a key commits at once, and Done only closes.

use gpui::{AnyElement, Context, Keystroke, Window, div, prelude::*, px};
use videorc_app_core::desktop::accelerator::{self as a, accelerator_label};
use videorc_app_core::desktop::global_shortcuts::{
    self as g, GlobalShortcutsConfig, unavailable_reason,
};
use videorc_app_core::shortcuts::{RecorderStep, shortcut_recorder_step};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::super::{platform, wayland};
use super::SceneDialogs;

pub(super) mod copy {
    pub const MENU_ITEM: &str = "Set key…";
    pub const TITLE: &str = "Set key";
    pub const KEY: &str = "Key";
    pub const PRESS: &str = "Press shortcut…";
    pub const UNASSIGNED: &str = "Unassigned";
    pub const CLEAR: &str = "Clear the Key shortcut";
    pub const DONE: &str = "Done";

    /// `sceneKeyDescription`: curly quotes round the name, ASCII
    /// apostrophes.
    pub fn description(name: &str, unavailable: bool) -> String {
        if unavailable {
            format!(
                "This Wayland session can't hear keys while Videorc is in the background, so a key for “{name}” won't work here. Click the field and press the keys."
            )
        } else {
            format!("Puts “{name}” on stream from any app. Click the field and press the keys.")
        }
    }
}

/// The dialog while it is open.
pub(super) struct SettingKey {
    id: String,
    name: String,
    armed: bool,
    error: Option<String>,
    interceptor: Option<gpui::Subscription>,
}

impl SceneDialogs {
    fn scene_action(id: &str) -> String {
        format!("scene:{id}")
    }

    fn shortcuts_config(&self) -> GlobalShortcutsConfig {
        serde_json::from_value(
            self.studio
                .watch()
                .borrow()
                .settings
                .studio
                .global_shortcuts(),
        )
        .unwrap_or_default()
    }

    pub(super) fn show_set_key(
        &mut self,
        id: &str,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.setting_key = Some(SettingKey {
            id: id.to_string(),
            name: name.to_string(),
            armed: false,
            error: None,
            interceptor: None,
        });
        self.set_key.open(window, cx);
        cx.notify();
    }

    fn arm_key(&mut self, cx: &mut Context<Self>) {
        let Some(setting) = &mut self.setting_key else {
            return;
        };
        setting.armed = true;
        setting.error = None;
        // Global keys stay quiet while a key is pressed for the recorder.
        self.hotkeys.set_recorder_armed(true);
        let weak = cx.entity().downgrade();
        // Before the keymap, so nothing else acts on the keys.
        setting.interceptor = Some(cx.intercept_keystrokes(move |event, _, cx| {
            let _ = weak.update(cx, |page, cx| {
                if page
                    .setting_key
                    .as_ref()
                    .is_some_and(|setting| setting.armed)
                {
                    cx.stop_propagation();
                    page.record_key(&event.keystroke, cx);
                }
            });
        }));
        cx.notify();
    }

    pub(super) fn disarm_key(&mut self, cx: &mut Context<Self>) {
        if let Some(setting) = &mut self.setting_key
            && setting.armed
        {
            setting.armed = false;
            setting.interceptor = None;
            self.hotkeys.set_recorder_armed(false);
            cx.notify();
        }
    }

    fn record_key(&mut self, key: &Keystroke, cx: &mut Context<Self>) {
        let Some(setting) = &self.setting_key else {
            return;
        };
        let action = Self::scene_action(&setting.id);
        let platform = platform();
        let config = self.shortcuts_config();
        let scenes: Vec<(String, String)> = self
            .studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .map(|scene| (scene.id.clone(), scene.name.clone()))
            .collect();
        let input = a::KeyInput {
            code: a::code_for_gpui_key(&key.key),
            meta: key.modifiers.platform,
            control: key.modifiers.control,
            alt: key.modifiers.alt,
            shift: key.modifiers.shift,
            key_up: false,
        };
        let step = shortcut_recorder_step(&input, platform, |value| {
            a::global_shortcut_taken_reason(&config, value, &action, platform, &scenes)
        });
        let value = match step {
            RecorderStep::Commit(value) => value,
            RecorderStep::Clear => String::new(),
            RecorderStep::Cancel => {
                self.disarm_key(cx);
                return;
            }
            RecorderStep::Held(_) => return,
            RecorderStep::Reject(message) => {
                if let Some(setting) = &mut self.setting_key {
                    setting.error = Some(message);
                }
                cx.notify();
                return;
            }
        };
        self.disarm_key(cx);
        self.commit_key(action, value);
    }

    /// `withGlobalShortcut`: the key is saved now ('' clears it).
    fn commit_key(&self, action: String, value: String) {
        let studio = self.studio.clone();
        self.run(async move {
            let saved = studio
                .update_studio_settings(|settings| {
                    let config: GlobalShortcutsConfig =
                        serde_json::from_value(settings.global_shortcuts()).unwrap_or_default();
                    settings.set(
                        g::SETTINGS_FIELD,
                        serde_json::to_value(g::with_global_shortcut(&config, &action, &value))
                            .unwrap_or_default(),
                    );
                })
                .await;
            eprintln!("[videorc-app] Scene key: {:?}", saved.is_ok());
        });
    }

    pub(super) fn set_key_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(setting) = &self.setting_key else {
            return div().into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let unavailable = unavailable_reason(cfg!(target_os = "linux"), wayland());
        let value = self
            .shortcuts_config()
            .scenes
            .as_ref()
            .and_then(|keys| keys.get(&setting.id).cloned())
            .filter(|key| !key.trim().is_empty());
        let label = if setting.armed {
            copy::PRESS.to_string()
        } else {
            value
                .as_deref()
                .map(|key| accelerator_label(Some(key), platform()))
                .unwrap_or_else(|| copy::UNASSIGNED.to_string())
        };
        let accessible = if setting.armed {
            format!("{}: press the new shortcut", copy::KEY)
        } else {
            format!("{}: {label}", copy::KEY)
        };
        let mut field = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(div().type_scale(text::LABEL).child(copy::KEY))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        Button::new("scene-key-record")
                            .label(label)
                            .accessibility_label(accessible)
                            .variant(ButtonVariant::Outline)
                            .lit(setting.armed)
                            .on_click(cx.listener(|this, _, _, cx| {
                                if this
                                    .setting_key
                                    .as_ref()
                                    .is_some_and(|setting| setting.armed)
                                {
                                    this.disarm_key(cx);
                                } else {
                                    this.arm_key(cx);
                                }
                            })),
                    )
                    .when(value.is_some() && !setting.armed, |row| {
                        let id = setting.id.clone();
                        row.child(
                            Button::new("scene-key-clear")
                                .size(ButtonSize::IconXs)
                                .variant(ButtonVariant::Ghost)
                                .accessibility_label(copy::CLEAR)
                                .tooltip(copy::CLEAR)
                                .child(icon(IconName::XCircle, 14., hsla(t.muted_foreground)))
                                .on_click(cx.listener(move |this, _, _, _| {
                                    this.commit_key(Self::scene_action(&id), String::new())
                                })),
                        )
                    }),
            );
        if let Some(error) = &setting.error {
            field = field.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(error.clone()),
            );
        }
        let mut body = div().flex().flex_col().gap(px(12.));
        if let Some(reason) = unavailable {
            body = body.child(
                Alert::new("scene-key-unavailable")
                    .variant(AlertVariant::Warning)
                    .title(reason),
            );
        }
        body = body.child(field);

        let page = cx.entity().downgrade();
        Dialog::new("scene-key-dialog", &self.set_key, copy::TITLE)
            .size(DialogSize::Sm)
            .description(copy::description(&setting.name, unavailable.is_some()))
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.disarm_key(cx);
                        page.setting_key = None;
                        cx.notify();
                    });
                }
            })
            .child(body)
            .footer(
                Button::new("scene-key-done")
                    .label(copy::DONE)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.disarm_key(cx);
                        this.succeeded = true;
                        this.setting_key = None;
                        this.set_key.close(window, cx);
                    })),
            )
            .into_any_element()
    }
}
