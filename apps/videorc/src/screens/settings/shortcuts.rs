use super::*;
use gpui::{AnyElement, Hsla, Keystroke, SharedString};
use videorc_app_core::{
    desktop::{accelerator as a, global_shortcuts as g},
    shortcuts as s,
};
use videorc_kit::theme::TypeScale as _;
use videorc_kit::{
    button::{Button, ButtonSize, ButtonVariant},
    icon::{IconName, icon},
    list_row::{GroupedList, ListRow},
    page::ConfigGrid,
    panel_section::PanelSection,
    settings_row::SettingsRow,
    shortcut_keys::ShortcutKeys,
    tokens::{radius, size},
};

/// The recorder field's colours, read once per frame.
#[derive(Clone, Copy)]
struct Ink {
    muted: Hsla,
    /// The input group's fill (`bg-input/50`).
    fill: Hsla,
    ring: Hsla,
    destructive: Hsla,
}

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
            code: a::code_for_gpui_key(&key.key),
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
        self.set_shortcut(action, value, cx);
    }
    /// Saves `value` as the action's key (empty clears it).
    fn set_shortcut(&mut self, action: String, value: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
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
    /// `ShortcutRecorderField` (`shortcut-recorder.tsx`): one SettingsRow,
    /// the field a 176 px input group (`w-44`) that shows the key, Press
    /// shortcut…, the app's own key and where, or Unassigned, with a clear
    /// button while a key is set.
    fn recorder_row(&self, row: s::RecorderRow, ink: Ink, cx: &mut Context<Self>) -> SettingsRow {
        let platform = crate::app::hotkeys::node_platform();
        let armed = self.shortcut.action.as_deref() == Some(&row.action);
        let name = s::shortcut_recorder_name(
            &row.label,
            row.value.as_deref(),
            row.app_key.as_ref(),
            armed,
            Some(platform),
        );
        let enabled = crate::app::hotkeys::supported(&row.action) && !self.disabled();
        let value = row.value.clone().filter(|value| !value.is_empty());
        let content: AnyElement = if armed {
            div()
                .truncate()
                .text_color(ink.muted)
                .child("Press shortcut…")
                .into_any_element()
        } else if let Some(value) = &value {
            ShortcutKeys::accelerator(value.clone()).into_any_element()
        } else if let Some(app_key) = &row.app_key {
            div()
                .flex()
                .min_w(px(0.))
                .items_center()
                .gap(px(6.))
                .child(ShortcutKeys::accelerator(app_key.accelerator.clone()))
                .child(
                    div()
                        .truncate()
                        .text_color(ink.muted)
                        .child(app_key.place.clone()),
                )
                .into_any_element()
        } else {
            div()
                .truncate()
                .text_color(ink.muted)
                .child("Unassigned")
                .into_any_element()
        };
        let arm_action = row.action.clone();
        let clear_action = row.action.clone();
        let clear_name = format!("Clear the {} shortcut", row.label);
        let border = if armed {
            ink.ring
        } else if row.conflict.is_some() {
            ink.destructive
        } else {
            gpui::transparent_black()
        };
        let mut control = div()
            .id(SharedString::from(format!("record-{}", row.action)))
            .role(gpui::Role::Button)
            .aria_label(name)
            .flex()
            .flex_1()
            .min_w(px(0.))
            .h_full()
            .items_center()
            .gap(px(4.))
            .px(px(10.))
            .type_scale(videorc_kit::tokens::text::META)
            .child(content);
        if enabled {
            control = control.cursor_pointer().on_click(
                cx.listener(move |this, _, _, cx| this.arm_shortcut(arm_action.clone(), cx)),
            );
        }
        let mut field = div()
            .flex()
            .flex_none()
            .items_center()
            .w(px(176.))
            .h(px(size::CONTROL))
            // `InputGroup`: `rounded-chip bg-input/50`, the border clear
            // until armed (ring) or refused (destructive).
            .rounded(px(radius::CHIP))
            .bg(ink.fill)
            .border_1()
            .border_color(border)
            .child(control);
        if value.is_some() && !armed {
            field = field.child(
                div().pr(px(2.)).child(
                    Button::new(SharedString::from(format!("clear-{}", row.action)))
                        .size(ButtonSize::IconXs)
                        .variant(ButtonVariant::Ghost)
                        .accessibility_label(clear_name)
                        .disabled(!enabled)
                        .child(icon(IconName::X, 14., ink.muted))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.set_shortcut(clear_action.clone(), String::new(), cx)
                        })),
                ),
            );
        }
        let mut line = SettingsRow::new(SharedString::from(row.action.clone()), row.label.clone())
            .child(field);
        if let Some(conflict) = row.conflict {
            line = line.error(conflict);
        }
        line
    }

    pub(super) fn shortcuts_page(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let ink = Ink {
            muted: hsla(t.muted_foreground),
            fill: hsla(videorc_kit::theme::with_alpha(t.input, 0.5)),
            ring: hsla(t.ring),
            destructive: hsla(t.destructive),
        };
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
        // The actions, then the scenes in their own labelled group.
        let mut globals = GroupedList::new();
        for row in model.action_rows {
            globals = globals.item(self.recorder_row(row, ink, cx));
        }
        let mut scene_list = GroupedList::new().label("Scenes");
        for row in model.scene_rows {
            scene_list = scene_list.item(self.recorder_row(row, ink, cx));
        }
        // `Esc cancels, Backspace clears.` under the fields.
        let keys_hint = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .px(px(4.))
            .type_scale(videorc_kit::tokens::text::META)
            .text_color(ink.muted)
            .child(ShortcutKeys::accelerator("Escape"))
            .child("cancels,")
            .child(ShortcutKeys::accelerator("Backspace"))
            .child("clears.");
        // App shortcuts: one labelled grouped list per group, compact rows
        // with their keys (`shortcutsByGroup`).
        let mut app = div().flex().flex_col().gap(px(12.));
        for (group, rows) in model.app_groups {
            let mut list = GroupedList::new().label(group);
            for (index, (label, accelerators)) in rows.into_iter().enumerate() {
                let mut keys = div().flex().items_center().gap(px(4.));
                for accelerator in accelerators {
                    keys = keys.child(ShortcutKeys::accelerator(accelerator));
                }
                list = list.row(
                    ListRow::new(
                        SharedString::from(format!("app-key-{group}-{index}")),
                        label,
                    )
                    .compact(true)
                    .child(keys),
                );
            }
            app = app.child(list);
        }
        ConfigGrid::new("settings-shortcuts-grid")
            .pair(true)
            .child(
                div().child(
                    PanelSection::new(s::GLOBAL_TITLE)
                        .title(s::GLOBAL_TITLE)
                        .description(model.global_description)
                        .children(model.unavailable)
                        .children(self.shortcut.message.clone())
                        .child(globals)
                        .child(scene_list)
                        .child(keys_hint)
                        .last(true),
                ),
            )
            .child(
                div().child(
                    PanelSection::new(s::APP_TITLE)
                        .title(s::APP_TITLE)
                        .description(s::APP_DESCRIPTION)
                        .last(true)
                        .child(app),
                ),
            )
            .into_any_element()
    }
}
