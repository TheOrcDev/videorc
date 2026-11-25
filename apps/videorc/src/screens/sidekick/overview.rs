//! Overview tab (`buddy-tab.tsx`): one status row leads (`BuddyProfileStatus`),
//! then a config grid of Sidekick Live's details (`BuddyLiveSection`) beside
//! what Sidekick does (`BuddyLivePowers`) over Cloud AI (`CloudAiSection`).

use gpui::{AnyElement, Context, FontWeight, SharedString, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::field::FieldGroup;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};
use videorc_kit::tooltip::tooltip;

use super::live::{LiveView, StatusKind};
use super::{
    SidekickScreen, config_grid_pair, field_beside, field_text, save_error_line, unlock_alert,
};

pub struct OverviewState<'a> {
    pub view: &'a LiveView,
    /// Two columns (`@min-[940px]/page`).
    pub wide: bool,
    pub listen: bool,
    pub consented: bool,
    pub cloud_uses: [String; 6],
    pub cloud_keeps: &'static str,
    /// "4 h 20 min of listening left this month" (`CohostListenAllowance`).
    pub allowance: Option<String>,
    /// A failed listening save, under its card.
    pub listen_error: Option<&'a str>,
}

fn status_tone(kind: StatusKind) -> StatusTone {
    match kind {
        StatusKind::Live => StatusTone::Good,
        StatusKind::Attention => StatusTone::Warn,
        StatusKind::Off | StatusKind::On => StatusTone::Neutral,
    }
}

pub fn render_overview(
    state: OverviewState<'_>,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let foreground = hsla(theme.foreground);
    let border = hsla(theme.border);
    let view = state.view;
    let entity = cx.entity();

    // `BuddyLiveStatusLine`: the glass dot carries the tone, the label is
    // primary and medium, the reason secondary after a "·"; the server's
    // own words for a failed pass take a line of their own.
    let mut status_words = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(6.))
        .gap_y(px(2.))
        .type_scale(text::META)
        .text_color(muted)
        .child(StatusDot::new("sidekick-live-status").tone(status_tone(view.status.kind)))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(foreground)
                .child(view.status.label),
        );
    if let Some(reason) = view.status.reason.as_ref() {
        status_words = status_words
            .child("·")
            .child(div().min_w_0().child(reason.clone()));
    }
    if let Some(detail) = view.status.detail.as_ref() {
        status_words = status_words.child(div().w_full().child(detail.clone()));
    }

    // `SidekickMark` (lg): the page glyph on a quiet tile, monochrome.
    let mark = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(56.))
        .rounded(px(radius::PANEL))
        .bg(hsla(theme.muted))
        .border_1()
        .border_color(border)
        .child(icon(IconName::UserSound, 28., foreground));

    // `BuddyLiveSwitch`: "Sidekick Live" beside its switch, and the reason
    // on hover while it cannot move (`DisabledReason`).
    let switch = Switch::new("sidekick-live")
        .accessibility_label(words::LIVE_SWITCH_LABEL)
        .checked(view.checked)
        .disabled(view.switch_disabled)
        .on_change({
            let entity = entity.clone();
            move |value, window, cx| {
                entity.update(cx, |screen, cx| screen.set_live(value, window, cx));
            }
        });
    let switch = if view.switch_disabled {
        let reason: SharedString = view
            .unlock
            .as_ref()
            .map(|unlock| unlock.reason.clone())
            .unwrap_or_else(|| words::LIVE_LOADING_REASON.to_string())
            .into();
        div()
            .id("sidekick-live-reason")
            .tooltip(tooltip(reason))
            .child(switch)
            .into_any_element()
    } else {
        switch.into_any_element()
    };
    let live_switch = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .child(
            div()
                .type_scale(text::META)
                .font_weight(FontWeight::MEDIUM)
                .text_color(foreground)
                .child(words::LIVE_SWITCH_LABEL),
        )
        .child(switch);

    // "Open Stream Manager" with its chat glyph and its key, always on the
    // row (`commentsWindowEnabled`).
    let open_stream_manager = Button::new("open-stream-manager")
        .variant(ButtonVariant::Outline)
        .icon(IconName::ChatCircle)
        .label(words::OPEN_STREAM_MANAGER)
        .child(ShortcutKeys::for_action(
            &crate::app::menus::ToggleStreamManager,
        ))
        .on_click({
            let entity = entity.clone();
            move |_, window, cx| {
                entity.update(cx, |screen, cx| screen.open_stream_manager(window, cx));
            }
        });

    let status_row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(12.))
        .child(mark)
        .child(
            div()
                .flex()
                .min_w(px(0.))
                .flex_1()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .truncate()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(foreground)
                        .child(words::PAGE_TITLE),
                )
                .child(status_words),
        )
        .child(live_switch)
        .child(open_stream_manager);

    let header = div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(size::GUTTER))
        .border_b_1()
        .border_color(border)
        .child(status_row)
        .children(view.unlock.as_ref().map(|unlock| {
            unlock_alert(
                "sidekick-unlock",
                "sidekick-unlock-action",
                unlock,
                unlock.reason.clone(),
            )
        }));

    // `BuddyLiveSection`: whether Sidekick hears you, its allowance under
    // the sentence, a failed save under the card.
    let locked = view.unlock.is_some();
    let mut listen_words = field_text(
        words::LISTEN_LABEL,
        Some(words::listen_consent_sentence().into()),
        theme,
    );
    if let Some(line) = state.allowance {
        listen_words =
            listen_words.child(div().type_scale(text::META).text_color(muted).child(line));
    }
    let live_section = PanelSection::new("sidekick-live-section")
        .title(words::LIVE_SECTION_TITLE)
        .description(words::live_section_description())
        .action(Badge::new(words::LIVE_SECTION_BADGE).variant(BadgeVariant::Outline))
        .last(state.wide)
        .child(
            FieldGroup::new().grouped().child(
                div().id("sidekick-hears-you").child(field_beside(
                    listen_words,
                    Switch::new("sidekick-listen")
                        .accessibility_label(words::LISTEN_LABEL)
                        .checked(state.listen)
                        .disabled(locked)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |screen, cx| screen.set_listen(value, cx));
                            }
                        }),
                )),
            ),
        )
        .children(save_error_line(state.listen_error, theme));

    // `BuddyLivePowers`: each power with the way to the tab that holds its
    // settings (a ghost button with its chevron, on the title line).
    let mut powers = FieldGroup::new().grouped();
    for (title, description, tab) in words::POWERS {
        let label = words::tab_label(tab);
        let tab_id = tab.to_string();
        let entity = entity.clone();
        powers = powers.child(
            div()
                .id(SharedString::from(format!("power-{title}")))
                .flex()
                .items_start()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(14.))
                                .line_height(px(20.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(foreground)
                                .child(title),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(muted)
                                .child(description),
                        ),
                )
                .child(
                    Button::new(format!("open-{tab}-for-{title}"))
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .accessibility_label(words::power_button_label(label, title))
                        .label(label)
                        .child(icon(IconName::CaretRight, 14., foreground))
                        .on_click(move |_, _, cx| {
                            let index = match tab_id.as_str() {
                                "chat" => 1,
                                "voice" => 3,
                                _ => 0,
                            };
                            entity.update(cx, |screen, cx| screen.select_tab(index, cx));
                        }),
                ),
        );
    }
    let powers_section = PanelSection::new("sidekick-powers-section")
        .title(words::POWERS_TITLE)
        .child(powers);

    // `CloudAiSection`: the one home of cloud-AI consent; the uses as a
    // bulleted list and what is kept, beside the switch.
    let mut uses = div().flex().flex_col().gap(px(2.));
    for use_line in &state.cloud_uses {
        uses = uses.child(
            div()
                .flex()
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .justify_center()
                        .w(px(16.))
                        .child("•"),
                )
                .child(div().flex_1().min_w_0().child(use_line.clone())),
        );
    }
    let cloud_words = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(4.))
        .child(
            div()
                .text_size(px(14.))
                .line_height(px(20.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(foreground)
                .child(words::ALLOW_CLOUD_AI),
        )
        .child(uses.type_scale(text::META).text_color(muted))
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(state.cloud_keeps),
        );
    let consented = state.consented;
    let cloud = PanelSection::new("sidekick-cloud-ai")
        .title(words::CLOUD_AI_TITLE)
        .description(words::CLOUD_AI_DESCRIPTION)
        .last(true)
        .child(
            FieldGroup::new().grouped().child(
                div().id("allow-cloud-ai-field").child(field_beside(
                    cloud_words,
                    Switch::new("allow-cloud-ai")
                        .accessibility_label(words::ALLOW_CLOUD_AI)
                        .checked(consented)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |screen, cx| screen.set_consent(value, cx));
                            }
                        }),
                )),
            ),
        );

    div()
        .flex()
        .flex_col()
        .flex_1()
        .child(header)
        .child(config_grid_pair(
            live_section,
            div().flex().flex_col().child(powers_section).child(cloud),
            state.wide,
            border,
        ))
        .into_any_element()
}

pub fn consent_dialog(handle: &DialogHandle, cx: &mut Context<SidekickScreen>) -> Dialog {
    let entity = cx.entity();
    let decline = entity.clone();
    Dialog::new("sidekick-consent", handle, words::CONSENT_TITLE)
        .description(words::CONSENT_DESCRIPTION)
        .close_button(false)
        .footer(
            Button::new("consent-not-now")
                .variant(ButtonVariant::Ghost)
                .label(words::CONSENT_DECLINE)
                .on_click(move |_, window, cx| {
                    decline.update(cx, |screen, cx| screen.answer_consent(false, window, cx));
                }),
        )
        .footer(
            Button::new("consent-allow")
                .variant(ButtonVariant::Default)
                .label(words::CONSENT_ACCEPT)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| screen.answer_consent(true, window, cx));
                }),
        )
}
