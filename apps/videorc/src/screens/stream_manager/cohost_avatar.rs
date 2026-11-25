//! The Avatar block's own parts (P1275–P1280; `cohost-pane.tsx`'s
//! `BuddyIdentity`, `BuddySayFooter` and `CohostListenPrompt`): the
//! avatar's picture, name and bubble line; the off-outputs notice; the Say
//! box, the reaction chips and "{name} on stream"; and the one-time
//! listening card. All of it is free (plan 164 D6), on air and off.

use gpui::{AnyElement, ImageSource, ObjectFit, Window, div, img, prelude::*, px};
use videorc_app_core::stream_manager::buddy::{
    REACTION_CHIPS, display_name, listen_disclosure, off_outputs_notice, reaction_disabled_reason,
    sidekick_writes_lines, words as pane_words,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::Input;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{radius, text};
use videorc_kit::tooltip::tooltip;
use videorc_protocol::buddy_pet::BuddyAvatar;
use videorc_protocol::cohost::CohostTalkMode;

use super::cohost::{LAUGH_KEY, SAY_KEY};
use super::sidekick::SidekickPane;
use crate::screens::avatar::pictures;

/// The header picture (`BUDDY_HEADER_PREVIEW_PX`, `size-8`).
const PICTURE_PX: f32 = 32.;
/// The Say box's narrowest (`min-w-48`).
const SAY_MIN_W: f32 = 192.;

impl SidekickPane {
    /// The avatar's identity (`BuddyIdentity`): its still picture for the
    /// state on air, its name, and the bubble while one is up. The default
    /// avatar's pictures ship in the app; a picture of the streamer's own is
    /// a file under user data this window doesn't read yet, so that avatar
    /// shows its name and bubble only.
    pub(super) fn cohost_identity(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let persona = self.settings.persona.as_ref()?;
        let t = theme::resolve(None, window, cx);
        let own_pictures = persona
            .images
            .entries()
            .iter()
            .any(|(_, picture)| picture.is_some());
        let state = if self.cohost.buddy.state.is_empty() {
            "idle"
        } else {
            self.cohost.buddy.state.as_str()
        };
        let picture: Option<ImageSource> = (!own_pictures)
            .then(|| pictures::default_state(state))
            .flatten()
            .map(Into::into);
        let bubble = self
            .cohost
            .buddy
            .bubble
            .as_ref()
            .map(|bubble| bubble.text.trim().to_string())
            .filter(|text| !text.is_empty());
        Some(
            div()
                .flex()
                .min_w(px(0.))
                .items_center()
                .gap(px(8.))
                .children(picture.map(|picture| {
                    img(picture)
                        .flex_none()
                        .size(px(PICTURE_PX))
                        .rounded(px(radius::CHIP))
                        .object_fit(ObjectFit::Contain)
                }))
                .child(
                    div()
                        .flex_shrink()
                        .min_w(px(0.))
                        .truncate()
                        .type_scale(text::META)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child(display_name(Some(persona.name.as_str()))),
                )
                .children(bubble.map(|bubble| {
                    div()
                        .id("buddy-bubble")
                        .flex_1()
                        .min_w(px(0.))
                        .truncate()
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .text_color(hsla(t.muted_foreground))
                        .tooltip(tooltip(bubble.clone()))
                        .child(format!("“{bubble}”"))
                }))
                .into_any_element(),
        )
    }

    /// The Avatar block's footer (`BuddySayFooter`): the off-outputs notice,
    /// the Say box (Enter says it talking, secondary Enter laughing), the
    /// reaction chips and the "{name} on stream" switch.
    pub(super) fn cohost_say_footer(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let persona = self.settings.persona.as_ref()?;
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let name = display_name(Some(persona.name.as_str()));
        let auto = self.settings.auto_chat.clone().unwrap_or_default();
        let outputs = self.cohost.outputs;
        let notice = off_outputs_notice(
            self.settings.enabled,
            auto.talk(),
            self.on_air(),
            outputs.map(|(on_stream, _)| on_stream),
            outputs.is_some_and(|(_, in_recording)| in_recording),
            Some(persona.name.as_str()),
            sidekick_writes_lines(
                auto.answers.enabled,
                auto.banter.enabled,
                auto.greetings.enabled,
                Some(auto.greetings.ai),
            ),
        )
        .map(|notice| {
            let show = Button::new("buddy-off-outputs-show")
                .label(notice.action.clone())
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::Xs)
                .on_click(cx.listener(|pane, _, _, cx| pane.set_avatar_on_stream(true, cx)));
            let alert = Alert::new("buddy-off-outputs")
                .variant(AlertVariant::Quiet)
                .title(notice.title.clone());
            match notice.secondary_action.clone() {
                // Two ways out (plan 239 D3): a row under the words.
                Some(secondary) => alert.description(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(notice.detail.clone())
                        .child(
                            div().flex().flex_wrap().gap(px(6.)).child(show).child(
                                Button::new("buddy-off-outputs-suggest")
                                    .label(secondary)
                                    .variant(ButtonVariant::Ghost)
                                    .size(ButtonSize::Xs)
                                    .on_click(cx.listener(|pane, _, window, cx| {
                                        pane.request_talk(CohostTalkMode::Suggest, window, cx)
                                    })),
                            ),
                        ),
                ),
                None => alert
                    .description(div().child(notice.detail.clone()))
                    .action(show),
            }
        });

        let pack = self.pack_reactions();
        let alive = matches!(persona.avatar, BuddyAvatar::Alive { .. });
        let chips = REACTION_CHIPS.iter().enumerate().map(|(index, chip)| {
            let (id, label) = *chip;
            let reason = reaction_disabled_reason(true, alive, pack.as_deref(), *chip);
            let hint = reason
                .clone()
                .unwrap_or_else(|| pane_words::on_stream(label));
            div()
                .id(("buddy-reaction", index))
                .flex_none()
                .tooltip(tooltip(hint))
                .child(
                    Button::new(("buddy-reaction-chip", index))
                        .label(label)
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .disabled(reason.is_some())
                        .on_click(cx.listener(move |pane, _, _, cx| pane.react(id, cx))),
                )
        });

        let say = div()
            .flex()
            .flex_1()
            .min_w(px(SAY_MIN_W))
            .items_center()
            .gap(px(6.))
            .child(
                div().flex_1().min_w(px(0.)).child(
                    Input::new("buddy-say", &self.cohost.say)
                        .accessibility_label(pane_words::say_as(&name)),
                ),
            )
            .child(
                div()
                    .id("buddy-say-key")
                    .flex_none()
                    .tooltip(tooltip(pane_words::SAY_IT))
                    .child(ShortcutKeys::keystrokes(SAY_KEY)),
            )
            .child(
                div()
                    .id("buddy-laugh-key")
                    .flex_none()
                    .tooltip(tooltip(pane_words::SAY_IT_LAUGHING))
                    .child(ShortcutKeys::keystrokes(LAUGH_KEY)),
            );

        // Plan 174 F-18: the overlay switch is named after the avatar, so it
        // never reads like a question's "Show on stream".
        let switch_label = pane_words::on_stream(&name);
        let entity = cx.entity();
        let switch = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.))
            .line_height(px(16.))
            .text_color(muted)
            .child(
                Switch::new("buddy-show-on-stream")
                    .small(true)
                    .accessibility_label(switch_label.clone())
                    .checked(outputs.is_some_and(|(on_stream, _)| on_stream))
                    .disabled(outputs.is_none())
                    .on_change(move |value, _, app| {
                        entity.update(app, |pane, cx| pane.set_avatar_on_stream(value, cx));
                    }),
            )
            .child(switch_label);

        Some(
            div()
                .flex()
                .flex_none()
                .flex_col()
                .border_t_1()
                .border_color(hsla(t.border))
                .children(notice.map(|alert| div().px(px(8.)).pt(px(8.)).child(alert)))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .px(px(12.))
                        .py(px(8.))
                        .child(say)
                        .child(
                            div()
                                .id("buddy-reactions")
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(4.))
                                .aria_label(pane_words::REACT_ON_STREAM)
                                .children(chips),
                        )
                        .child(switch),
                )
                .into_any_element(),
        )
    }

    /// The one-time "Sidekick can hear you" card (`CohostListenPrompt`):
    /// for someone who runs Sidekick with listening off. Turn on and Not
    /// now are both final.
    pub(super) fn cohost_listen_prompt(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.listen_prompt_visible() {
            return None;
        }
        let t = theme::resolve(None, window, cx);
        let actions = div()
            .flex()
            .flex_wrap()
            .gap(px(4.))
            .pt(px(6.))
            .child(
                Button::new("cohost-listen-turn-on")
                    .label(pane_words::TURN_ON)
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|pane, _, _, cx| pane.listen_turn_on(cx))),
            )
            .child(
                Button::new("cohost-listen-not-now")
                    .label(pane_words::NOT_NOW)
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|pane, _, _, cx| pane.answer_listen_prompt(cx))),
            );
        Some(
            div()
                .flex_none()
                .p(px(8.))
                .child(
                    Alert::new("cohost-listen-prompt")
                        .icon(icon(IconName::Microphone, 16., hsla(t.muted_foreground)))
                        .title(pane_words::LISTEN_TITLE)
                        .description(
                            div()
                                .type_scale(text::META)
                                .child(listen_disclosure())
                                .child(actions),
                        ),
                )
                .into_any_element(),
        )
    }
}
