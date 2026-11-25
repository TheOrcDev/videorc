//! The Studio's Audio section (`audio-section.tsx` and
//! `RetroAudioSectionView`): Microphone and System audio on one Mixer scale
//! (plan 201 D1), in the default look and Retro LCD. Words and state come
//! from app-core (`audio_section`, `audio_mixer`, `audio_levels`); this
//! module draws them on the kit and calls the Studio.
//!
//! ⌘/Ctrl+↑/↓ (P218) moves focus between the channel strips, as Electron's
//! MixerChannels does for `[data-slot=channel-strip]`.

pub mod meter;

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding,
    SharedString, Window, actions, div, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::studio::audio_levels::MicLevels;
use videorc_app_core::studio::audio_mixer::{
    self, MICROPHONE_GAIN_DEFAULT, MICROPHONE_GAIN_RANGE, SYSTEM_AUDIO_GAIN_DEFAULT,
    SYSTEM_AUDIO_GAIN_RANGE, copy as words,
};
use videorc_app_core::studio::audio_section::{
    AudioInputs, AudioMeters, AudioMetersView, AudioSectionView, IssueAction, STUDIO_AUDIO_FOCUS,
    SystemAudioRowView,
};
use videorc_app_core::studio::cloud::CloudState;
use videorc_app_core::studio::screen_views::talk_show_room;
use videorc_app_core::studio::source_selection::{PICKER_NONE_VALUE, PickerView, SourceKind};
use videorc_app_core::{Studio, StudioSnapshot};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kbd::Kbd;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::select::Select;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::transport::{AppStudio, OpenPage};
use crate::lcd;

use meter::{lcd_meter, meta_line, segmented_meter};

actions!(studio_audio, [FocusPreviousStrip, FocusNextStrip]);

/// Key context while focus is inside the Audio Mixer (P218).
pub const KEY_CONTEXT: &str = "StudioAudio";

/// How often a falling meter redraws while nothing new arrives.
const METER_TICK: Duration = Duration::from_millis(33);

/// Binds ⌘/Ctrl+↑/↓ for the Audio section; call once at start.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("secondary-up", FocusPreviousStrip, Some(KEY_CONTEXT)),
        KeyBinding::new("secondary-down", FocusNextStrip, Some(KEY_CONTEXT)),
    ]);
}

pub struct AudioSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    view: AudioSectionView,
    meters: AudioMeters,
    meters_view: AudioMetersView,
    retro: bool,
    takeover_active: bool,
    room_open: bool,
    mic_gain: Entity<SliderState>,
    sys_gain: Entity<SliderState>,
    mic_gain_live: bool,
    sys_gain_live: bool,
    settling: bool,
    /// Focus target for the Microphone channel strip (P218).
    mic_focus: FocusHandle,
    /// Focus target for the System audio channel strip (P218).
    sys_focus: FocusHandle,
}

impl EventEmitter<OpenPage> for AudioSection {}

impl Focusable for AudioSection {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.mic_focus.clone()
    }
}

impl AudioSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        mut levels: watch::Receiver<MicLevels>,
        mut cloud: watch::Receiver<CloudState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let snap = snapshot.borrow().clone();
        let levels_now = levels.borrow().clone();
        let room_open = talk_show_room(cloud.borrow().status.as_ref()).open;
        let inputs = AudioInputs {
            takeover_active: false,
            room_open,
        };
        let view = AudioSectionView::from_snapshot(&snap, &levels_now, Instant::now(), inputs);
        let mut meters = AudioMeters::default();
        let meters_view = meters.step(&snap, &levels_now, Instant::now());
        let mic_gain = cx.new(|_| {
            SliderState::new()
                .min(MICROPHONE_GAIN_RANGE.0)
                .max(MICROPHONE_GAIN_RANGE.1)
                .step(1.0)
                .default_value(view.microphone.gain_db as f32)
        });
        let sys_gain = cx.new(|_| {
            let gain = view
                .system_audio
                .as_ref()
                .map(|row| row.gain_db as f32)
                .unwrap_or(SYSTEM_AUDIO_GAIN_DEFAULT);
            SliderState::new()
                .min(SYSTEM_AUDIO_GAIN_RANGE.0)
                .max(SYSTEM_AUDIO_GAIN_RANGE.1)
                .step(1.0)
                .default_value(gain)
        });

        cx.subscribe(&mic_gain, |this, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            this.mic_gain_live = matches!(event, SliderEvent::Change(_));
            let studio = this.studio.clone();
            this.runtime.spawn(async move {
                studio.set_microphone_gain(value).await;
            });
            cx.notify();
        })
        .detach();
        cx.subscribe(&sys_gain, |this, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end(),
            };
            this.sys_gain_live = matches!(event, SliderEvent::Change(_));
            let studio = this.studio.clone();
            this.runtime.spawn(async move {
                studio.set_system_audio_gain(value).await;
            });
            cx.notify();
        })
        .detach();

        let mut section = Self {
            studio: studio.clone(),
            runtime: runtime.clone(),
            view,
            meters,
            meters_view,
            retro: snap.settings.studio.retro_lcd_studio(),
            takeover_active: false,
            room_open,
            mic_gain,
            sys_gain,
            mic_gain_live: false,
            sys_gain_live: false,
            settling: false,
            mic_focus: cx.focus_handle(),
            sys_focus: cx.focus_handle(),
        };

        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = snapshot.changed() => changed.is_ok(),
                    changed = levels.changed() => changed.is_ok(),
                    changed = cloud.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let alive = this.update(cx, |section, cx| {
                    section.room_open =
                        talk_show_room(cloud.borrow_and_update().status.as_ref()).open;
                    let snap = snapshot.borrow_and_update().clone();
                    let levels_now = levels.borrow_and_update().clone();
                    section.apply_snapshot(&snap, &levels_now, cx);
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut connection = studio.watch();
        let mut last_generation = connection.borrow().connection_generation;
        cx.spawn(async move |this, cx| {
            loop {
                if connection.changed().await.is_err() {
                    break;
                }
                let generation = connection.borrow_and_update().connection_generation;
                if generation == last_generation {
                    continue;
                }
                last_generation = generation;
                let alive = this.update(cx, |section, cx| section.refresh_takeover(cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();

        section.refresh_takeover(cx);
        section
    }

    fn inputs(&self) -> AudioInputs {
        AudioInputs {
            takeover_active: self.takeover_active,
            room_open: self.room_open,
        }
    }

    fn apply_snapshot(
        &mut self,
        snapshot: &StudioSnapshot,
        levels: &MicLevels,
        cx: &mut Context<Self>,
    ) {
        let now = Instant::now();
        self.view = AudioSectionView::from_snapshot(snapshot, levels, now, self.inputs());
        self.retro = snapshot.settings.studio.retro_lcd_studio();
        self.meters_view = self.meters.step(snapshot, levels, now);
        self.ensure_meter_ticks(cx);
        cx.notify();
    }

    fn sync_gains_on_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mic = self.view.microphone.gain_db as f32;
        if !self.mic_gain_live {
            self.mic_gain.update(cx, |state, cx| {
                if (state.value().end() - mic).abs() >= 0.5 {
                    state.set_value(mic, window, cx);
                }
            });
        }
        if let Some(system) = &self.view.system_audio {
            let gain = system.gain_db as f32;
            if !self.sys_gain_live {
                self.sys_gain.update(cx, |state, cx| {
                    if (state.value().end() - gain).abs() >= 0.5 {
                        state.set_value(gain, window, cx);
                    }
                });
            }
        }
    }

    fn ensure_meter_ticks(&mut self, cx: &mut Context<Self>) {
        if self.meters.settled() || self.settling {
            return;
        }
        self.settling = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(METER_TICK).await;
                let cont = this.update(cx, |section, cx| {
                    let snapshot = section.studio.watch().borrow().clone();
                    let levels = section.studio.mic_levels().borrow().clone();
                    section.meters_view = section.meters.step(&snapshot, &levels, Instant::now());
                    let done = section.meters.settled();
                    if done {
                        section.settling = false;
                    }
                    cx.notify();
                    !done
                });
                if !cont.unwrap_or(false) {
                    break;
                }
            }
        })
        .detach();
    }

    fn refresh_takeover(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let read = self
            .runtime
            .spawn(async move { backend.screens_active().await });
        cx.spawn(async move |this, cx| {
            let Ok(answer) = read.await else {
                return;
            };
            this.update(cx, |section, cx| {
                let active = matches!(answer, Ok(Some(_)));
                if section.takeover_active != active {
                    section.takeover_active = active;
                    let snapshot = section.studio.watch().borrow().clone();
                    let levels = section.studio.mic_levels().borrow().clone();
                    section.apply_snapshot(&snapshot, &levels, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn mute_toggle(&self) {
        let studio = self.studio.clone();
        let muted = !self.view.microphone.muted;
        self.runtime.spawn(async move {
            let ok = studio.request_microphone_mute(muted).await;
            eprintln!("[videorc-app] Studio mute: {ok}");
        });
    }

    fn select_microphone(&self, value: String) {
        let studio = self.studio.clone();
        let picked = (value != PICKER_NONE_VALUE).then_some(value);
        self.runtime.spawn(async move {
            let result = studio
                .select_source_device(SourceKind::Microphone, picked.as_deref())
                .await;
            eprintln!("[videorc-app] Studio mic pick: {result:?}");
        });
    }

    fn set_system_audio(&self, enabled: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_system_audio_enabled(enabled).await;
        });
    }

    fn resume_system_audio(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.resume_system_audio().await;
        });
    }

    fn reset_mic_gain(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_microphone_gain(MICROPHONE_GAIN_DEFAULT).await;
        });
    }

    fn reset_sys_gain(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .set_system_audio_gain(SYSTEM_AUDIO_GAIN_DEFAULT)
                .await;
        });
    }

    /// ⌘/Ctrl+↑: move focus to the previous channel strip (P218).
    fn focus_previous_strip(
        &mut self,
        _: &FocusPreviousStrip,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_strip_focus(-1, window, cx);
    }

    /// ⌘/Ctrl+↓: move focus to the next channel strip (P218).
    fn focus_next_strip(
        &mut self,
        _: &FocusNextStrip,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_strip_focus(1, window, cx);
    }

    fn move_strip_focus(&mut self, direction: i8, window: &mut Window, cx: &mut Context<Self>) {
        let has_system = self.view.system_audio.is_some();
        let mic_here = self.mic_focus.contains_focused(window, cx);
        let sys_here = self.sys_focus.contains_focused(window, cx);
        let index = if sys_here {
            1
        } else if mic_here {
            0
        } else if direction > 0 {
            0
        } else if has_system {
            1
        } else {
            0
        };
        let next = index + direction as isize;
        let target = match (next, has_system) {
            (0, _) => Some(self.mic_focus.clone()),
            (1, true) => Some(self.sys_focus.clone()),
            _ => None,
        };
        if let Some(handle) = target {
            handle.focus(window, cx);
        }
    }
}

fn fill_select(id: &'static str, picker: &PickerView, disabled: bool) -> Select {
    let selected = picker
        .items
        .iter()
        .find(|item| item.selected && item.heading.is_empty())
        .map(|item| item.value.clone());
    let mut select = Select::new(id)
        .placeholder(if picker.placeholder {
            picker.label.clone()
        } else {
            "Choose…".to_string()
        })
        .disabled(disabled)
        .width(280.0)
        .value(selected.map(SharedString::from));
    for item in &picker.items {
        if !item.heading.is_empty() {
            continue;
        }
        if item.disabled && !item.selected {
            continue;
        }
        select = select.option(item.value.clone(), item.label.clone());
    }
    select
}

fn chip_badge(label: &str, tone: &str) -> Badge {
    let variant = match tone {
        "good" => BadgeVariant::Success,
        "warn" => BadgeVariant::Warning,
        _ => BadgeVariant::Neutral,
    };
    Badge::new(label.to_string()).variant(variant)
}

fn gain_row(
    id: &'static str,
    text_value: &str,
    reset: Option<&str>,
    slider: &Entity<SliderState>,
    aria: &'static str,
    disabled: bool,
    on_reset: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let mut row = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .child(div().type_scale(text::META).child(words::GAIN))
                .child(div().type_scale(text::META).child(text_value.to_string())),
        )
        .child(
            Slider::new(slider)
                .accessibility_label(aria)
                .disabled(disabled),
        );
    if let Some(reset) = reset {
        row = row.child(
            Button::new(id)
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::Xs)
                .label(reset.to_string())
                .on_click(on_reset),
        );
    }
    row.into_any_element()
}

impl AudioSection {
    fn microphone_standard(
        &self,
        theme: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mic = &self.view.microphone;
        let muted = mic.muted;
        let mut header = div().flex().items_center().justify_between().gap(px(8.));
        header = header.child(
            div()
                .type_scale(text::LABEL)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(words::MICROPHONE),
        );
        let mut controls = div().flex().items_center().gap(px(6.));
        if let Some(chip) = mic.mute_chip {
            controls = controls.child(chip_badge(chip, "neutral"));
        }
        if let Some(accel) = mic.mute_accelerator.as_ref() {
            controls = controls.child(Kbd::new(accel.clone()));
        }
        let mute_label = if muted {
            words::UNMUTE_MICROPHONE
        } else {
            words::MUTE_MICROPHONE
        };
        controls = controls.child(
            Button::new("studio-mic-mute")
                .variant(if muted {
                    ButtonVariant::Default
                } else {
                    ButtonVariant::Secondary
                })
                .size(ButtonSize::Xs)
                .accessibility_label(words::MUTE_MICROPHONE)
                .tooltip(mute_label)
                .label(if muted { words::MUTED } else { "Mute" })
                .on_click(cx.listener(|this, _, _, _| this.mute_toggle())),
        );
        header = header.child(controls);

        let disabled = mic.disabled_reason.is_some();
        let mut body = div()
            .id("studio-microphone")
            .relative()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pl(px(12.))
            .child(header);
        if let Some(status) = mic.status.as_ref() {
            body = body.child(meta_line(theme, status.message.clone()));
        }
        if let Some(reason) = mic.disabled_reason.as_ref() {
            body = body.child(meta_line(theme, reason.clone()));
        }
        let entity = cx.entity();
        body = body.child(
            fill_select("studio-mic-picker", &mic.picker, disabled).on_change(
                move |value, _, cx| {
                    entity.update(cx, |section, _| {
                        section.select_microphone(value.to_string());
                    });
                },
            ),
        );
        body = body.child(segmented_meter(
            self.meters_view.microphone,
            muted || mic.takeover_hold.is_some(),
            theme,
        ));
        if let Some(hint) = mic.takeover_hint {
            body = body.child(meta_line(theme, hint));
        }
        let reset = mic.gain_reset.clone();
        body = body.child(gain_row(
            "studio-mic-gain-reset",
            &mic.gain_text,
            reset.as_deref(),
            &self.mic_gain,
            words::MICROPHONE_GAIN,
            false,
            cx.listener(|this, _, _, _| this.reset_mic_gain()),
        ));
        if mic.level_unavailable {
            body = body.child(meta_line(theme, words::SESSION_LEVEL_UNAVAILABLE));
        }
        // Screen-reader signal word (Receiving / Muted / …).
        body = body.child(
            div()
                .absolute()
                .size(px(1.))
                .overflow_hidden()
                .opacity(0.)
                .child(mic.signal),
        );
        body.into_any_element()
    }

    fn system_standard(
        &self,
        row: &SystemAudioRowView,
        theme: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut header = div().flex().items_center().justify_between().gap(px(8.));
        header = header.child(
            div()
                .type_scale(text::LABEL)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(words::SYSTEM_AUDIO),
        );
        let mut controls = div().flex().items_center().gap(px(6.));
        if let Some(chip) = row.chip {
            controls = controls.child(chip_badge(chip.label, chip.tone));
        }
        if let Some(accel) = row.toggle_accelerator.as_ref() {
            controls = controls.child(Kbd::new(accel.clone()));
        }
        let checked = row.checked;
        let entity = cx.entity();
        controls = controls.child(
            Switch::new("studio-system-audio")
                .accessibility_label(words::SYSTEM_AUDIO)
                .checked(checked)
                .disabled(row.disabled)
                .small(true)
                .on_change(move |value, _, cx| {
                    entity.update(cx, |section, _| section.set_system_audio(value));
                }),
        );
        header = header.child(controls);

        let mut body = div()
            .id("studio-system-audio-row")
            .flex()
            .flex_col()
            .gap(px(8.))
            .pl(px(12.))
            .child(header);
        if let Some(issue) = row.issue.as_ref() {
            let action = row.issue_action;
            let buttons = match action {
                Some(IssueAction::OpenPermissions) => Some(
                    Button::new("studio-open-permissions")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(words::OPEN_PERMISSIONS)
                        .on_click(cx.listener(|_, _, _, cx| {
                            cx.emit(OpenPage::settings(SettingsTab::Permissions));
                        })),
                ),
                Some(IssueAction::Resume) => Some(
                    Button::new("studio-system-audio-resume")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(words::RESUME)
                        .on_click(cx.listener(|this, _, _, _| this.resume_system_audio())),
                ),
                None => None,
            };
            let mut alert = Alert::new("studio-system-audio-issue")
                .variant(AlertVariant::Warning)
                .title(issue.clone());
            if let Some(button) = buttons {
                alert = alert.action(button);
            }
            body = body.child(alert);
        }
        if row.show_level {
            body = body.child(segmented_meter(self.meters_view.system_audio, false, theme));
        }
        if row.idle_line {
            body = body.child(meta_line(theme, words::IDLE_LINE));
        }
        if row.show_gain {
            let reset = row.gain_reset.clone();
            body = body.child(gain_row(
                "studio-sys-gain-reset",
                &row.gain_text,
                reset.as_deref(),
                &self.sys_gain,
                words::SYSTEM_AUDIO_GAIN,
                row.permission_required,
                cx.listener(|this, _, _, _| this.reset_sys_gain()),
            ));
        }
        body.into_any_element()
    }

    fn microphone_retro(
        &self,
        theme: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mic = &self.view.microphone;
        let muted = mic.muted;
        let lit = hsla(theme.foreground);
        let dim = hsla(theme.muted_foreground);
        let mut header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .py(px(6.))
            .child(
                div()
                    .text_color(lit)
                    .type_scale(text::LABEL)
                    .child(words::MICROPHONE),
            );
        let mut controls = div().flex().items_center().gap(px(8.));
        if let Some(accel) = mic.mute_accelerator.as_ref() {
            controls = controls.child(div().text_color(dim).child(Kbd::new(accel.clone())));
        }
        let mute_words = if muted { words::MUTED } else { "Mute" };
        let mute_tip = if muted {
            words::UNMUTE_MICROPHONE
        } else {
            words::MUTE_MICROPHONE
        };
        let speaker = if muted {
            IconName::SpeakerSlash
        } else {
            IconName::SpeakerHigh
        };
        let mute_ink = if muted {
            lcd::solid(theme)
        } else {
            lcd::dim(theme)
        };
        controls = controls.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(icon(speaker, 14., mute_ink))
                .child(lcd::value_button(
                    "studio-lcd-mic-mute",
                    theme,
                    mute_words,
                    muted,
                    false,
                    Some(SharedString::from(mute_tip)),
                    cx.listener(|this, _, _, _| this.mute_toggle()),
                )),
        );
        header = header.child(controls);

        let disabled = mic.disabled_reason.is_some();
        let mut body = div().flex().flex_col().gap(px(6.)).child(header);
        body = body.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .child(div().text_color(dim).type_scale(text::META).child("Device"))
                .child({
                    let entity = cx.entity();
                    fill_select("studio-lcd-mic-picker", &mic.picker, disabled).on_change(
                        move |value, _, cx| {
                            entity.update(cx, |section, _| {
                                section.select_microphone(value.to_string());
                            });
                        },
                    )
                }),
        );
        if let Some(status) = mic.status.as_ref() {
            body = body.child(meta_line(theme, status.message.clone()));
        }
        body = body.child(lcd_meter(
            self.meters_view.microphone,
            &self.meters_view.microphone_lcd,
            muted || mic.takeover_hold.is_some(),
            theme,
        ));
        if let Some(hold) = mic.takeover_hold {
            let hint = mic.takeover_hint.unwrap_or("");
            body = body.child(meta_line(
                theme,
                format!(
                    "{}. {hint}",
                    videorc_app_core::studio::takeover_microphone::TAKEOVER_MUTED_LABEL
                ),
            ));
            let _ = hold;
        }
        if mic.level_unavailable {
            body = body.child(meta_line(theme, words::SESSION_LEVEL_UNAVAILABLE));
        }
        let reset = mic.gain_reset.clone();
        body = body.child(gain_row(
            "studio-lcd-mic-gain-reset",
            &mic.gain_text,
            reset.as_deref(),
            &self.mic_gain,
            words::MICROPHONE_GAIN,
            false,
            cx.listener(|this, _, _, _| this.reset_mic_gain()),
        ));
        body.into_any_element()
    }

    fn system_retro(
        &self,
        row: &SystemAudioRowView,
        theme: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .py(px(6.))
            .child(
                div()
                    .text_color(lcd::lit(theme))
                    .type_scale(text::LABEL)
                    .child(words::SYSTEM_AUDIO),
            );
        // P229–P231: Needs permission / Resume / issue word beside the
        // On/Off switch, as Electron's RetroSystemAudioValue — not an alert.
        let mut controls = div().flex().items_center().gap(px(8.));
        if row.permission_required {
            let tip = row
                .issue
                .clone()
                .unwrap_or_else(|| "System audio needs Screen Recording permission.".into());
            controls = controls.child(lcd::value_button(
                "studio-lcd-open-permissions",
                theme,
                "Needs permission",
                false,
                false,
                Some(SharedString::from(tip)),
                cx.listener(|_, _, _, cx| {
                    cx.emit(OpenPage::settings(SettingsTab::Permissions));
                }),
            ));
        } else {
            if matches!(row.issue_action, Some(IssueAction::Resume)) {
                let tip = row.issue.clone().map(SharedString::from);
                controls = controls.child(lcd::value_button(
                    "studio-lcd-system-audio-resume",
                    theme,
                    words::RESUME,
                    false,
                    false,
                    tip,
                    cx.listener(|this, _, _, _| this.resume_system_audio()),
                ));
            } else if let Some(chip) = row.chip {
                let tip = row.issue.clone().map(SharedString::from);
                let mut word = div()
                    .id("studio-lcd-system-audio-status")
                    .min_w_0()
                    .truncate()
                    .text_color(lcd::dim(theme))
                    .child(chip.label);
                if let Some(tip) = tip {
                    word = word.tooltip(videorc_kit::tooltip::tooltip(tip));
                }
                controls = controls.child(word);
            }
            let checked = row.checked;
            let entity = cx.entity();
            controls = controls.child(lcd::switch_words(
                "studio-lcd-system-audio",
                theme,
                checked,
                row.disabled,
                words::SYSTEM_AUDIO,
                move |_, _, cx| {
                    entity.update(cx, |section, _| section.set_system_audio(!checked));
                },
            ));
        }
        header = header.child(controls);
        let mut body = div().flex().flex_col().gap(px(6.)).child(header);
        if row.show_level {
            body = body.child(lcd_meter(
                self.meters_view.system_audio,
                &self.meters_view.system_audio_lcd,
                false,
                theme,
            ));
        }
        if row.idle_line {
            body = body.child(meta_line(theme, words::IDLE_LINE));
        }
        if row.show_gain {
            let reset = row.gain_reset.clone();
            body = body.child(gain_row(
                "studio-lcd-sys-gain-reset",
                &row.gain_text,
                reset.as_deref(),
                &self.sys_gain,
                words::SYSTEM_AUDIO_GAIN,
                row.permission_required,
                cx.listener(|this, _, _, _| this.reset_sys_gain()),
            ));
        }
        body.into_any_element()
    }
}

impl Render for AudioSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_gains_on_window(window, cx);
        let theme = theme::resolve(None, window, cx);
        let border = hsla(theme.border);
        let mic = if self.retro {
            self.microphone_retro(&theme, cx)
        } else {
            self.microphone_standard(&theme, cx)
        };
        let system = self.view.system_audio.clone().map(|row| {
            if self.retro {
                self.system_retro(&row, &theme, cx)
            } else {
                self.system_standard(&row, &theme, cx)
            }
        });
        // No "Audio" heading (plan 235 D3); the Mixer keeps the name for
        // screen readers via aria-label on the channels column. Each strip
        // is a focus target so ⌘/Ctrl+↑/↓ can move between them (P218).
        let mut channels = div()
            .id("studio-audio-channels")
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(Self::focus_previous_strip))
            .on_action(cx.listener(Self::focus_next_strip))
            .flex()
            .flex_col()
            .gap(px(0.))
            .aria_label(words::AUDIO)
            .child(
                div()
                    .id("studio-channel-strip-microphone")
                    .track_focus(&self.mic_focus)
                    .tab_index(0)
                    .child(mic),
            );
        if let Some(row) = system {
            let strip = if self.retro {
                div()
                    .id("studio-channel-strip-system-audio")
                    .track_focus(&self.sys_focus)
                    .tab_index(0)
                    .child(lcd::separator(&theme))
                    .child(row)
                    .into_any_element()
            } else {
                div()
                    .id("studio-channel-strip-system-audio")
                    .track_focus(&self.sys_focus)
                    .tab_index(0)
                    .border_t_1()
                    .border_color(border)
                    .pt(px(size::GUTTER))
                    .mt(px(size::GUTTER))
                    .child(row)
                    .into_any_element()
            };
            channels = channels.child(strip);
        }
        let body = if self.retro {
            lcd::panel("studio-lcd-audio", &theme, words::AUDIO, channels).into_any_element()
        } else {
            channels.into_any_element()
        };
        PanelSection::new(STUDIO_AUDIO_FOCUS).child(body)
    }
}
