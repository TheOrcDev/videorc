//! Sidekick → Chat (`BuddyRepliesSection`, `BuddyModerationSection`).

use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use videorc_app_core::buddy::chat::{self, RULES_MAX, SENSITIVITIES, SHOW_ON_STREAM, TONES};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::input::{Input, InputState};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};
use videorc_protocol::cohost::CohostAutoChat;

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const ANSWERS: &str = "Answers";
const BANTER: &str = "Banter";
const WRITE_GREETINGS_AI: &str = "Write greetings with AI";
const REPLY_TONE: &str = "Reply tone";
const REPLIES: &str = "Replies";
const MODERATION: &str = "Moderation";
const CHAT_RULES: &str = "Chat rules";
const FLAG_SENSITIVITY: &str = "Flag sensitivity";
const PUT_COMMENTS: &str = "Put comments on stream automatically";
const ADD_A_RULE: &str = "Add a rule…";
const RULES_FULL: &str = "Remove a rule to add another";
const RULES_HELP: &str =
    "Plain-language rules Sidekick flags for you, like “no spoilers” or “English only”.";
const BANTER_DESCRIPTION: &str = "A short remark when you've been quiet for a while, never within a minute of a greeting or an answer.";

fn auto_chat(settings: Option<&CohostSettingsView>) -> CohostAutoChat {
    settings
        .and_then(|s| s.auto_chat.clone())
        .unwrap_or_default()
}

fn answers_description(name: &str) -> String {
    format!(
        "A reply when a viewer asks {name} directly, or after a minute to a question your notes answer. At most one per cooldown."
    )
}

pub struct ChatWidgets {
    pub answers_cooldown: Entity<SliderState>,
    pub banter_cooldown: Entity<SliderState>,
    pub rule_draft: Entity<InputState>,
    answers_live: bool,
    banter_live: bool,
}

impl ChatWidgets {
    pub fn new(window: &mut Window, cx: &mut Context<SidekickScreen>) -> Self {
        let answers_cooldown = cx.new(|_| {
            SliderState::new()
                .min(5.0)
                .max(300.0)
                .step(5.0)
                .default_value(20.0)
        });
        let banter_cooldown = cx.new(|_| {
            SliderState::new()
                .min(5.0)
                .max(1800.0)
                .step(5.0)
                .default_value(240.0)
        });
        let rule_draft = cx.new(|cx| InputState::new(window, cx).placeholder(ADD_A_RULE));
        cx.observe(&rule_draft, |_, _, cx| cx.notify()).detach();

        cx.subscribe(&answers_cooldown, |screen, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end() as u32,
            };
            if let Some(widgets) = screen.chat.as_mut() {
                widgets.answers_live = matches!(event, SliderEvent::Change(_));
            }
            if matches!(event, SliderEvent::Release(_)) {
                screen.patch_auto_behaviour("answers", None, Some(value), cx);
            }
            cx.notify();
        })
        .detach();
        cx.subscribe(&banter_cooldown, |screen, _, event: &SliderEvent, cx| {
            let value = match event {
                SliderEvent::Change(v) | SliderEvent::Release(v) => v.end() as u32,
            };
            if let Some(widgets) = screen.chat.as_mut() {
                widgets.banter_live = matches!(event, SliderEvent::Change(_));
            }
            if matches!(event, SliderEvent::Release(_)) {
                screen.patch_auto_behaviour("banter", None, Some(value), cx);
            }
            cx.notify();
        })
        .detach();

        Self {
            answers_cooldown,
            banter_cooldown,
            rule_draft,
            answers_live: false,
            banter_live: false,
        }
    }

    pub fn sync_cooldowns(
        &self,
        settings: Option<&CohostSettingsView>,
        window: &mut Window,
        cx: &mut Context<SidekickScreen>,
    ) {
        let auto = auto_chat(settings);
        if !self.answers_live {
            let secs = auto.answers.cooldown_seconds as f32;
            self.answers_cooldown.update(cx, |state, cx| {
                if (state.value().end() - secs).abs() >= 1.0 {
                    state.set_value(secs, window, cx);
                }
            });
        }
        if !self.banter_live {
            let secs = auto.banter.cooldown_seconds as f32;
            self.banter_cooldown.update(cx, |state, cx| {
                if (state.value().end() - secs).abs() >= 1.0 {
                    state.set_value(secs, window, cx);
                }
            });
        }
    }
}

pub fn render_chat(
    view: &LiveView,
    settings: Option<&CohostSettingsView>,
    widgets: &ChatWidgets,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let locked = view.unlock.is_some();
    let auto = auto_chat(settings);
    let name =
        chat::display_name(settings.and_then(|s| s.persona.as_ref().map(|p| p.name.as_str())));
    let entity = cx.entity();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let reason = format!("{} {}", unlock.reason, words::CHAT_FREE_NOTE);
        let mut alert = Alert::new("sidekick-chat-unlock")
            .variant(AlertVariant::Warning)
            .title(reason);
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("chat-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Chat: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }

    let answers_secs = widgets.answers_cooldown.read(cx).value().end().round() as u32;
    let banter_secs = widgets.banter_cooldown.read(cx).value().end().round() as u32;
    let tone = settings
        .and_then(|s| s.raw.get("tone"))
        .and_then(|v| v.as_str())
        .unwrap_or("friendly");

    let replies = PanelSection::new("sidekick-replies")
        .title(REPLIES)
        .description(chat::replies_description(&name))
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("answers", ANSWERS)
                        .description(answers_description(&name))
                        .child(
                            Switch::new("answers")
                                .accessibility_label(ANSWERS)
                                .checked(auto.answers.enabled)
                                .disabled(locked)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.patch_auto_behaviour(
                                                "answers",
                                                Some(value),
                                                None,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .row(
                    SettingsRow::new("answers-cooldown", format!("{ANSWERS} cooldown"))
                        .description(format!("{} cooldown", chat::cooldown_label(answers_secs)))
                        .child(
                            Slider::new(&widgets.answers_cooldown)
                                .accessibility_label(format!("{ANSWERS} cooldown"))
                                .disabled(locked),
                        ),
                )
                .row(
                    SettingsRow::new("banter", BANTER)
                        .description(BANTER_DESCRIPTION)
                        .child(
                            Switch::new("banter")
                                .accessibility_label(BANTER)
                                .checked(auto.banter.enabled)
                                .disabled(locked)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.patch_auto_behaviour(
                                                "banter",
                                                Some(value),
                                                None,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .row(
                    SettingsRow::new("banter-cooldown", format!("{BANTER} cooldown"))
                        .description(format!("{} cooldown", chat::cooldown_label(banter_secs)))
                        .child(
                            Slider::new(&widgets.banter_cooldown)
                                .accessibility_label(format!("{BANTER} cooldown"))
                                .disabled(locked),
                        ),
                )
                .row(
                    SettingsRow::new("greetings-ai", WRITE_GREETINGS_AI)
                        .description(chat::ai_description(&name))
                        .child(
                            Switch::new("greetings-ai")
                                .accessibility_label(WRITE_GREETINGS_AI)
                                .checked(auto.greetings.ai)
                                .disabled(locked)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            let mut next = auto_chat(screen.settings.as_ref());
                                            next.greetings.ai = value;
                                            screen.patch_settings(
                                                serde_json::json!({ "autoChat": next }),
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .row(SettingsRow::new("reply-tone", REPLY_TONE).child({
                    let mut control = SegmentedControl::new("reply-tone")
                        .small(true)
                        .accessibility_label(REPLY_TONE)
                        .value(Some(tone))
                        .disabled(locked);
                    for (id, label) in TONES {
                        control = control.option(Segment::new(id, label));
                    }
                    let entity = entity.clone();
                    control.on_change(move |value, _, cx| {
                        let tone = value.to_string();
                        entity.update(cx, |screen, cx| {
                            screen.patch_settings(serde_json::json!({ "tone": tone }), cx);
                        });
                    })
                })),
        );

    let rules: Vec<String> = settings
        .and_then(|s| s.raw.get("rules"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let rules_full = rules.len() >= RULES_MAX;
    let sensitivity = settings
        .and_then(|s| s.raw.get("sensitivity"))
        .and_then(|v| v.as_str())
        .unwrap_or("balanced");
    let auto_highlight = settings
        .and_then(|s| s.raw.get("autoHighlight"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let voice_highlight = settings
        .and_then(|s| s.raw.get("voiceHighlight"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let show_index = chat::show_on_stream_index(auto_highlight, voice_highlight);
    let show_value = ["off", "voice", "voice-and-picks"][show_index];

    let mut rules_list = div().flex().flex_col().gap(px(6.)).child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(RULES_HELP),
    );
    for (index, rule) in rules.iter().enumerate() {
        let rule_text = rule.clone();
        rules_list = rules_list.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .type_scale(text::META)
                        .child(rule_text),
                )
                .child(
                    Button::new(format!("remove-rule-{index}"))
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label("Remove")
                        .disabled(locked)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.remove_chat_rule(index, cx);
                                });
                            }
                        }),
                ),
        );
    }
    rules_list = rules_list
        .child(
            Input::new("chat-rule-draft", &widgets.rule_draft)
                .accessibility_label(if rules_full { RULES_FULL } else { ADD_A_RULE })
                .disabled(locked || rules_full),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    Button::new("add-chat-rule")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(if rules_full { RULES_FULL } else { "Add" })
                        .disabled(locked || rules_full)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.add_chat_rule(window, cx);
                                });
                            }
                        }),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(format!("{}/{}", rules.len(), RULES_MAX)),
                ),
        );

    let moderation = PanelSection::new("sidekick-moderation")
        .title(MODERATION)
        .description(chat::moderation_description())
        .child(
            SettingsGroup::new()
                .row(SettingsRow::new("chat-rules", CHAT_RULES).child(rules_list))
                .row(
                    SettingsRow::new("flag-sensitivity", FLAG_SENSITIVITY).child({
                        let mut control = SegmentedControl::new("flag-sensitivity")
                            .small(true)
                            .accessibility_label(FLAG_SENSITIVITY)
                            .value(Some(sensitivity))
                            .disabled(locked);
                        for (id, label) in SENSITIVITIES {
                            control = control.option(Segment::new(id, label));
                        }
                        let entity = entity.clone();
                        control.on_change(move |value, _, cx| {
                            let sensitivity = value.to_string();
                            entity.update(cx, |screen, cx| {
                                screen.patch_settings(
                                    serde_json::json!({ "sensitivity": sensitivity }),
                                    cx,
                                );
                            });
                        })
                    }),
                )
                .row(SettingsRow::new("put-comments", PUT_COMMENTS).child({
                    let mut control = SegmentedControl::new("put-comments")
                        .small(true)
                        .accessibility_label(PUT_COMMENTS)
                        .value(Some(show_value))
                        .disabled(locked);
                    let values = ["off", "voice", "voice-and-picks"];
                    for (i, (label, _, _)) in SHOW_ON_STREAM.iter().enumerate() {
                        control = control.option(Segment::new(values[i], *label));
                    }
                    let entity = entity.clone();
                    control.on_change(move |value, _, cx| {
                        let (auto, voice) = match value.as_ref() {
                            "voice" => (false, true),
                            "voice-and-picks" => (true, true),
                            _ => (false, false),
                        };
                        entity.update(cx, |screen, cx| {
                            screen.patch_settings(
                                serde_json::json!({
                                    "autoHighlight": auto,
                                    "voiceHighlight": voice
                                }),
                                cx,
                            );
                        });
                    })
                })),
        );

    div()
        .flex()
        .flex_col()
        .child(lead)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(replies)
                .child(moderation),
        )
        .into_any_element()
}
