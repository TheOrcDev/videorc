//! Sidekick → Chat (`BuddyRepliesSection`, `BuddyModerationSection`).

use gpui::{AnyElement, Context, Entity, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::buddy::chat::{self, RULES_MAX, SENSITIVITIES, SHOW_ON_STREAM, TONES};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::field::FieldGroup;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::InputState;
use videorc_kit::input_group::{InputGroup, InputGroupAddon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::slider::{Slider, SliderEvent, SliderState};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};
use videorc_protocol::cohost::CohostAutoChat;

use super::live::{LiveView, UnlockAction};
use super::{
    SaveSection, SidekickScreen, config_grid_pair, field_beside, field_description, field_stack,
    field_text, field_text_balanced, save_error_line, tab_lead, unlock_alert,
};

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
const REPLY_TONE_DESCRIPTION: &str = "How the drafted replies read before you edit them.";
const FLAG_SENSITIVITY_DESCRIPTION: &str = "How sure Sidekick must be before a flag shows up. Relaxed shows only the clear cases, Strict shows everything it noticed.";
const PUT_COMMENTS_DESCRIPTION: &str =
    "Puts a chat comment on your stream by itself. You can always show one yourself with H.";
const SHOW_VOICE_NOTE: &str = "What I talk about needs Sidekick to hear you (or live captions).";
const SHOW_PICKS_NOTE: &str =
    "Sidekick's picks: at most one card every 45 seconds; nothing Sidekick flagged is ever shown.";

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
    /// One input per saved rule, keyed on the saved text: a save (or the
    /// backend's trim) rebuilds the row with the stored value.
    rule_inputs: Vec<(String, Entity<InputState>)>,
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
        cx.subscribe_in(
            &rule_draft,
            window,
            |screen, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    screen.add_chat_rule(window, cx);
                }
            },
        )
        .detach();

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
            rule_inputs: Vec::new(),
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

impl SidekickScreen {
    /// Rebuilds the rule inputs when the saved rules changed.
    pub(super) fn sync_rule_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let saved = self.saved_rules();
        let Some(widgets) = self.chat.as_mut() else {
            return;
        };
        let same = widgets.rule_inputs.len() == saved.len()
            && widgets
                .rule_inputs
                .iter()
                .zip(&saved)
                .all(|((shown, _), rule)| shown == rule);
        if same {
            return;
        }
        let mut inputs = Vec::with_capacity(saved.len());
        for (index, rule) in saved.into_iter().enumerate() {
            let input = cx.new(|cx| InputState::new(window, cx).default_value(rule.clone()));
            cx.subscribe_in(
                &input,
                window,
                move |screen, input, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                        let text = input.read(cx).value().to_string();
                        screen.edit_chat_rule(index, &text, cx);
                    }
                },
            )
            .detach();
            inputs.push((rule, input));
        }
        widgets.rule_inputs = inputs;
    }
}

/// `CohostCooldownField`: one AI behaviour, its switch beside its words and
/// its cooldown slider (`max-w-56`) with the cooldown after it.
#[allow(clippy::too_many_arguments)]
fn cooldown_field(
    id: &'static str,
    label: &'static str,
    description: String,
    enabled: bool,
    slider: &Entity<SliderState>,
    seconds: u32,
    locked: bool,
    t: &Theme,
    entity: Entity<SidekickScreen>,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(field_beside(
            field_text_balanced(label, description, t),
            Switch::new(id)
                .accessibility_label(label)
                .checked(enabled)
                .disabled(locked)
                .on_change(move |value, _, cx| {
                    entity.update(cx, |screen, cx| {
                        screen.patch_auto_behaviour(id, Some(value), None, cx);
                    });
                }),
        ))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(
                    div().flex_1().min_w_0().max_w(px(224.)).child(
                        Slider::new(slider)
                            .accessibility_label(format!("{label} cooldown"))
                            .disabled(locked),
                    ),
                )
                .child(
                    div()
                        .flex_none()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(format!("{} cooldown", chat::cooldown_label(seconds))),
                ),
        )
}

pub fn render_chat(
    view: &LiveView,
    settings: Option<&CohostSettingsView>,
    widgets: &ChatWidgets,
    errors: (Option<&str>, Option<&str>),
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let border = hsla(theme.border);
    let (replies_error, moderation_error) = errors;
    let locked = view.unlock.is_some();
    let auto = auto_chat(settings);
    let name =
        chat::display_name(settings.and_then(|s| s.persona.as_ref().map(|p| p.name.as_str())));
    let entity = cx.entity();

    // One lock above both columns; what stays free follows the reason only
    // under a Premium lock (`BuddyUnlockAlert freeNote`).
    let lead = view.unlock.as_ref().map(|unlock| {
        let reason = if unlock.action == Some(UnlockAction::ViewPremium) {
            format!("{} {}", unlock.reason, words::CHAT_FREE_NOTE)
        } else {
            unlock.reason.clone()
        };
        tab_lead(border).child(unlock_alert(
            "sidekick-chat-unlock",
            "chat-unlock-action",
            unlock,
            reason,
        ))
    });

    let answers_secs = widgets.answers_cooldown.read(cx).value().end().round() as u32;
    let banter_secs = widgets.banter_cooldown.read(cx).value().end().round() as u32;
    let tone = settings
        .and_then(|s| s.raw.get("tone"))
        .and_then(|v| v.as_str())
        .unwrap_or("friendly");

    let mut tone_control = SegmentedControl::new("reply-tone")
        // Electron fills it (`w-full`, or a vertical Field's `*:w-full`).
        .full(true)
        .small(true)
        .accessibility_label(REPLY_TONE)
        .value(Some(tone))
        .disabled(locked);
    for (id, label) in TONES {
        tone_control = tone_control.option(Segment::new(id, label));
    }
    let tone_control = tone_control.on_change({
        let entity = entity.clone();
        move |value, _, cx| {
            let tone = value.to_string();
            entity.update(cx, |screen, cx| {
                screen.patch_section(
                    serde_json::json!({ "tone": tone }),
                    SaveSection::Replies,
                    cx,
                );
            });
        }
    });

    let replies = PanelSection::new("sidekick-replies")
        .title(REPLIES)
        .description(chat::replies_description(&name))
        .last(true)
        .child(
            FieldGroup::new()
                .grouped()
                .child(cooldown_field(
                    "answers",
                    ANSWERS,
                    answers_description(&name),
                    auto.answers.enabled,
                    &widgets.answers_cooldown,
                    answers_secs,
                    locked,
                    theme,
                    entity.clone(),
                ))
                .child(cooldown_field(
                    "banter",
                    BANTER,
                    BANTER_DESCRIPTION.to_string(),
                    auto.banter.enabled,
                    &widgets.banter_cooldown,
                    banter_secs,
                    locked,
                    theme,
                    entity.clone(),
                ))
                .child(field_beside(
                    field_text(
                        WRITE_GREETINGS_AI,
                        Some(chat::ai_description(&name).into()),
                        theme,
                    ),
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
                                    screen.patch_section(
                                        serde_json::json!({ "autoChat": next }),
                                        SaveSection::Replies,
                                        cx,
                                    );
                                });
                            }
                        }),
                ))
                .child(field_stack(
                    REPLY_TONE,
                    REPLY_TONE_DESCRIPTION,
                    vec![tone_control.into_any_element()],
                    theme,
                )),
        )
        .children(save_error_line(replies_error, theme));

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
    let draft_empty = widgets.rule_draft.read(cx).value().trim().is_empty();
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

    // Chat rules: each saved rule in its own field with its remove button,
    // then the draft with Add and its Enter key inside it, then the count.
    let mut rules_rest: Vec<AnyElement> = Vec::new();
    if !widgets.rule_inputs.is_empty() {
        let mut saved = div().flex().flex_col().gap(px(6.));
        for (index, (_, input)) in widgets.rule_inputs.iter().enumerate() {
            let number = index + 1;
            saved = saved.child(
                InputGroup::new(format!("chat-rule-{index}"), input)
                    .accessibility_label(format!("Chat rule {number}"))
                    .disabled(locked)
                    .end(
                        InputGroupAddon::end().child(
                            Button::new(format!("remove-rule-{index}"))
                                .variant(ButtonVariant::Ghost)
                                .size(ButtonSize::IconXs)
                                .accessibility_label(format!("Remove chat rule {number}"))
                                .child(icon(IconName::X, 14., muted))
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
                    ),
            );
        }
        rules_rest.push(saved.into_any_element());
    }
    rules_rest.push(
        InputGroup::new("chat-rule-draft", &widgets.rule_draft)
            .accessibility_label(if rules_full { RULES_FULL } else { ADD_A_RULE })
            .disabled(locked || rules_full)
            .end(
                InputGroupAddon::end().child(
                    Button::new("add-chat-rule")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label("Add")
                        .child(ShortcutKeys::accelerator("Enter"))
                        .disabled(locked || rules_full || draft_empty)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |screen, cx| {
                                    screen.add_chat_rule(window, cx);
                                });
                            }
                        }),
                ),
            )
            .into_any_element(),
    );
    rules_rest.push(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(format!("{}/{}", rules.len(), RULES_MAX))
            .into_any_element(),
    );
    let rules_field = field_stack(CHAT_RULES, RULES_HELP, rules_rest, theme);

    let mut sensitivity_control = SegmentedControl::new("flag-sensitivity")
        // Electron fills it (`w-full`, or a vertical Field's `*:w-full`).
        .full(true)
        .small(true)
        .accessibility_label(FLAG_SENSITIVITY)
        .value(Some(sensitivity))
        .disabled(locked);
    for (id, label) in SENSITIVITIES {
        sensitivity_control = sensitivity_control.option(Segment::new(id, label));
    }
    let sensitivity_control = sensitivity_control.on_change({
        let entity = entity.clone();
        move |value, _, cx| {
            let sensitivity = value.to_string();
            entity.update(cx, |screen, cx| {
                screen.patch_section(
                    serde_json::json!({ "sensitivity": sensitivity }),
                    SaveSection::Moderation,
                    cx,
                );
            });
        }
    });

    let mut show_control = SegmentedControl::new("put-comments")
        // Electron fills it (`w-full`, or a vertical Field's `*:w-full`).
        .full(true)
        .small(true)
        .accessibility_label(PUT_COMMENTS)
        .value(Some(show_value))
        .disabled(locked);
    let values = ["off", "voice", "voice-and-picks"];
    for (i, (label, _, _)) in SHOW_ON_STREAM.iter().enumerate() {
        show_control = show_control.option(Segment::new(values[i], *label));
    }
    let show_control = show_control.on_change({
        let entity = entity.clone();
        move |value, _, cx| {
            let (auto, voice) = match value.as_ref() {
                "voice" => (false, true),
                "voice-and-picks" => (true, true),
                _ => (false, false),
            };
            entity.update(cx, |screen, cx| {
                screen.patch_section(
                    serde_json::json!({
                        "autoHighlight": auto,
                        "voiceHighlight": voice
                    }),
                    SaveSection::Moderation,
                    cx,
                );
            });
        }
    });

    let moderation = PanelSection::new("sidekick-moderation")
        .title(MODERATION)
        .description(chat::moderation_description())
        .last(true)
        .child(
            FieldGroup::new()
                .grouped()
                .child(rules_field)
                .child(field_stack(
                    FLAG_SENSITIVITY,
                    FLAG_SENSITIVITY_DESCRIPTION,
                    vec![sensitivity_control.into_any_element()],
                    theme,
                ))
                .child(field_stack(
                    PUT_COMMENTS,
                    PUT_COMMENTS_DESCRIPTION,
                    vec![
                        show_control.into_any_element(),
                        // The notes are one `FieldDescription`, its lines
                        // `gap-0.5` apart.
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(field_description(SHOW_VOICE_NOTE, theme))
                            .child(field_description(SHOW_PICKS_NOTE, theme))
                            .into_any_element(),
                    ],
                    theme,
                )),
        )
        .children(save_error_line(moderation_error, theme));

    div()
        .flex()
        .flex_col()
        .flex_1()
        .children(lead)
        .child(config_grid_pair(
            "sidekick-chat-grid",
            replies,
            moderation,
            border,
        ))
        .into_any_element()
}
