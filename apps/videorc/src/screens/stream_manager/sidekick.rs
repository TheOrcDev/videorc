//! The Sidekick pane (P990–P1006): header with Alpha + Sidekick Live, cards
//! waiting chrome, empty copy, and the avatar talk controls at the foot.
//! Card bodies (removal / utterance / command) land in a later slice once
//! the live drivers are wired; the shell and talk consent are here.

use gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::BackendEvent;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::{
    self as buddy, CohostSettingsView, CohostState, TALK_MODES, cards_waiting,
    mode_change_needs_consent, posting_consent_sentence, posting_consent_title, talk_hint,
    talk_label, talk_mode_label,
};
use videorc_app_core::studio::families::{self, write_ai_consent, write_buddy_auto_chat_consent};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, hsla};
use videorc_kit::tokens::text;
use videorc_protocol::cohost::{CohostAutoChat, CohostTalkMode};

use super::SharedStudio;

const SIDEKICK_EMPTY: &str =
    "Sidekick reads chat during a live stream: questions, flags and the room's mood.";
const SIDEKICK_PANE: &str = "Sidekick";
const NOT_NOW: &str = "Not now";
const ALLOW: &str = "Allow";

/// The Sidekick pane entity (header, Live, talk, empty / cards chrome).
pub struct SidekickPane {
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
    state: CohostState,
    settings: CohostSettingsView,
    consented: bool,
    /// Suggest posting consent (`videorc.buddyAutoChatConsent`).
    posting_consented: bool,
    pending_live: bool,
    pending_talk: Option<CohostTalkMode>,
    live_consent: DialogHandle,
    talk_consent: DialogHandle,
    avatar_name: Option<String>,
}

impl SidekickPane {
    pub fn new(
        studio: SharedStudio,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let consented = studio.read_ui_settings(families::ai_consent);
        let posting_consented = studio.read_ui_settings(families::buddy_auto_chat_consent);
        let mut events = studio.backend().subscribe();
        let studio_for_events = studio.clone();
        cx.spawn(async move |this, cx| {
            loop {
                match events.recv().await {
                    Ok(BackendEvent::Untyped { event, payload }) => {
                        let alive = this.update(cx, |pane, cx| match event.as_str() {
                            "cohost.state" => {
                                if let Ok(state) =
                                    serde_json::from_value::<CohostState>(payload.clone())
                                {
                                    pane.state = state;
                                    cx.notify();
                                }
                            }
                            "cohost.settings.changed" => {
                                if let Some(settings) = CohostSettingsView::from_json(&payload) {
                                    pane.settings = settings;
                                }
                                pane.consented = pane.studio.read_ui_settings(families::ai_consent);
                                pane.posting_consented = pane
                                    .studio
                                    .read_ui_settings(families::buddy_auto_chat_consent);
                                cx.notify();
                            }
                            "account.changed" => {
                                pane.consented =
                                    studio_for_events.read_ui_settings(families::ai_consent);
                                pane.posting_consented = studio_for_events
                                    .read_ui_settings(families::buddy_auto_chat_consent);
                                cx.notify();
                            }
                            _ => {}
                        });
                        if alive.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        })
        .detach();
        {
            let studio = studio.clone();
            let runtime = runtime.clone();
            cx.spawn(async move |this, cx| {
                let settings = runtime
                    .spawn({
                        let studio = studio.clone();
                        async move {
                            studio
                                .backend()
                                .request("cohost.settings.get", json!({}))
                                .await
                                .ok()
                        }
                    })
                    .await
                    .ok()
                    .flatten();
                let _ = this.update(cx, |pane, cx| {
                    if let Some(value) = settings {
                        if let Some(settings) = CohostSettingsView::from_json(&value) {
                            pane.settings = settings;
                        }
                    }
                    pane.consented = pane.studio.read_ui_settings(families::ai_consent);
                    pane.posting_consented = pane
                        .studio
                        .read_ui_settings(families::buddy_auto_chat_consent);
                    cx.notify();
                });
            })
            .detach();
        }
        Self {
            studio,
            runtime,
            state: CohostState::default(),
            settings: CohostSettingsView::default(),
            consented,
            posting_consented,
            pending_live: false,
            pending_talk: None,
            live_consent: DialogHandle::new(false),
            talk_consent: DialogHandle::new(false),
            avatar_name: None,
        }
    }

    fn enabled(&self) -> bool {
        self.settings.enabled
    }

    fn auto_chat(&self) -> CohostAutoChat {
        self.settings.auto_chat.clone().unwrap_or_default()
    }

    fn waiting_count(&self) -> usize {
        let removals = self.state.flags.len();
        let utterances = self
            .state
            .utterances
            .iter()
            .filter(|u| u.status == "proposed")
            .count();
        let command = usize::from(self.state.command.is_some());
        removals + utterances + command
    }

    fn set_live(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on && !self.consented {
            self.pending_live = true;
            self.live_consent.open(window, cx);
            cx.notify();
            return;
        }
        self.apply_live(on, cx);
    }

    fn answer_live_consent(&mut self, accept: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.live_consent.close(window, cx);
        if !accept {
            self.pending_live = false;
            cx.notify();
            return;
        }
        let studio = self.studio.clone();
        let turn_on = self.pending_live;
        self.pending_live = false;
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(true)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |pane, cx| {
                pane.consented = true;
                if turn_on {
                    pane.apply_live(true, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_live(&mut self, on: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "enabled": on }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |pane, cx| {
                if let Ok(Ok(value)) = result {
                    if let Some(settings) = CohostSettingsView::from_json(&value) {
                        pane.settings = settings;
                    }
                } else if let Ok(Err(error)) = result {
                    eprintln!("[videorc-app] Stream Manager Sidekick Live: {error}");
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn request_talk(&mut self, next: CohostTalkMode, window: &mut Window, cx: &mut Context<Self>) {
        if next == self.auto_chat().talk() {
            return;
        }
        if mode_change_needs_consent(next, self.posting_consented) {
            self.pending_talk = Some(next);
            self.talk_consent.open(window, cx);
            cx.notify();
            return;
        }
        self.apply_talk(next, cx);
    }

    fn answer_talk_consent(&mut self, accept: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.talk_consent.close(window, cx);
        if !accept {
            self.pending_talk = None;
            cx.notify();
            return;
        }
        let studio = self.studio.clone();
        let next = self.pending_talk.take().unwrap_or(CohostTalkMode::Suggest);
        let write = self.runtime.spawn(async move {
            studio
                .write_settings(vec![write_buddy_auto_chat_consent()])
                .await
        });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |pane, cx| {
                pane.posting_consented = true;
                pane.apply_talk(next, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_talk(&mut self, talk: CohostTalkMode, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request(
                    "cohost.settings.set",
                    json!({ "autoChat": { "talk": talk } }),
                )
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |pane, cx| {
                if let Ok(Ok(value)) = result {
                    if let Some(settings) = CohostSettingsView::from_json(&value) {
                        pane.settings = settings;
                    }
                } else if let Ok(Err(error)) = result {
                    eprintln!("[videorc-app] Stream Manager talk mode: {error}");
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn header(&self, muted: gpui::Hsla, border: gpui::Hsla, cx: &mut Context<Self>) -> AnyElement {
        let enabled = self.enabled();
        let entity = cx.entity();
        div()
            .id("buddy-pane-header")
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .border_b_1()
            .border_color(border)
            .child(icon(IconName::Sparkle, 16.0, muted))
            .child(
                div()
                    .flex_none()
                    .type_scale(text::LABEL)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(words::PAGE_TITLE),
            )
            .child(Badge::new(words::LIVE_SECTION_BADGE).variant(BadgeVariant::Outline))
            .child(div().flex_1())
            .child(
                Switch::new("sidekick-live")
                    .accessibility_label(words::LIVE_SWITCH_LABEL)
                    .checked(enabled)
                    .on_change(move |value, window, app| {
                        entity.update(app, |pane, cx| pane.set_live(value, window, cx));
                    }),
            )
            .into_any_element()
    }

    fn cards_chrome(&self, muted: gpui::Hsla, border: gpui::Hsla) -> Option<AnyElement> {
        let waiting = cards_waiting(self.waiting_count())?;
        Some(
            div()
                .id("buddy-cards")
                .flex()
                .flex_none()
                .flex_col()
                .border_b_1()
                .border_color(border)
                .child(
                    div()
                        .px(px(12.))
                        .pt(px(6.))
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(waiting),
                )
                .into_any_element(),
        )
    }

    fn talk_footer(
        &self,
        muted: gpui::Hsla,
        border: gpui::Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let auto = self.auto_chat();
        let talk = auto.talk();
        let name = self.avatar_name.as_deref();
        let entity = cx.entity();
        let mut control = SegmentedControl::new("buddy-talk")
            .small(true)
            .accessibility_label(talk_label(name))
            .value(Some(SharedString::from(talk_mode_label(talk))));
        for mode in TALK_MODES {
            control = control.option(Segment::new(talk_mode_label(mode), talk_mode_label(mode)));
        }
        control = control.on_change(move |value, window, cx| {
            let next = match value.as_ref() {
                "Off" => CohostTalkMode::Off,
                "Bubble" => CohostTalkMode::Bubble,
                "Suggest" => CohostTalkMode::Suggest,
                _ => return,
            };
            entity.update(cx, |pane, cx| pane.request_talk(next, window, cx));
        });
        let chips = buddy::behaviour_chips(&auto, false);
        let mut chip_row = div().flex().flex_wrap().gap(px(6.));
        for chip in chips {
            chip_row = chip_row.child(Badge::new(chip.text).variant(if chip.on {
                BadgeVariant::Default
            } else {
                BadgeVariant::Outline
            }));
        }
        div()
            .id("buddy-talk-footer")
            .flex()
            .flex_none()
            .flex_col()
            .gap(px(8.))
            .px(px(12.))
            .py(px(10.))
            .border_t_1()
            .border_color(border)
            .child(
                div()
                    .type_scale(text::LABEL)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(talk_label(name)),
            )
            .child(control)
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(talk_hint(talk, name)),
            )
            .child(chip_row)
            .into_any_element()
    }
}

impl Render for SidekickPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let border = hsla(t.border);
        let name = self.avatar_name.clone();
        let empty = self.waiting_count() == 0;
        div()
            .id("sidekick-pane")
            .size_full()
            .flex()
            .flex_col()
            .aria_label(SIDEKICK_PANE)
            .child(self.header(muted, border, cx))
            .children(self.cards_chrome(muted, border))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .px(px(16.))
                    .when(empty, |body| {
                        body.child(Empty::new().description(SIDEKICK_EMPTY))
                    }),
            )
            .child(self.talk_footer(muted, border, cx))
            .child(
                Dialog::new(
                    "sidekick-live-consent",
                    &self.live_consent,
                    words::CONSENT_TITLE,
                )
                .description(words::listen_consent_sentence())
                .footer(
                    Button::new("sm-consent-not-now")
                        .label(NOT_NOW)
                        .variant(ButtonVariant::Ghost)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.answer_live_consent(false, window, cx)
                        })),
                )
                .footer(Button::new("sm-consent-allow").label(ALLOW).on_click(
                    cx.listener(|this, _, window, cx| this.answer_live_consent(true, window, cx)),
                )),
            )
            .child(
                Dialog::new(
                    "buddy-talk-consent",
                    &self.talk_consent,
                    posting_consent_title(name.as_deref()),
                )
                .description(posting_consent_sentence(name.as_deref()))
                .footer(
                    Button::new("talk-consent-not-now")
                        .label(NOT_NOW)
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Sm)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.answer_talk_consent(false, window, cx)
                        })),
                )
                .footer(
                    Button::new("talk-consent-allow")
                        .label(ALLOW)
                        .size(ButtonSize::Sm)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.answer_talk_consent(true, window, cx)
                        })),
                ),
            )
    }
}
