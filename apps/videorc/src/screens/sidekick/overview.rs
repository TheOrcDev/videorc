//! Overview tab (`BuddyProfileStatus`, `BuddyLiveSection`, powers, Cloud AI).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::shortcut_keys::ShortcutKeys;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};

use super::SidekickScreen;
use super::live::{LiveView, StatusKind, UnlockAction};

pub struct OverviewState<'a> {
    pub view: &'a LiveView,
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
    let border = hsla(theme.border);
    let view = state.view;
    let entity = cx.entity();

    let mut status_words = div().flex().flex_wrap().items_center().gap(px(6.)).child(
        StatusDot::new("sidekick-live-status")
            .tone(status_tone(view.status.kind))
            .label(view.status.label),
    );
    if let Some(reason) = view.status.reason.as_ref() {
        status_words = status_words.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(format!("· {reason}")),
        );
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
        .child(icon(IconName::UserSound, 28., hsla(theme.foreground)));

    let mut status_row = div()
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
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(words::PAGE_TITLE),
                )
                .child(status_words),
        );

    let checked = view.checked;
    let disabled = view.switch_disabled;
    status_row = status_row.child(
        Switch::new("sidekick-live")
            .accessibility_label(words::LIVE_SWITCH_LABEL)
            .checked(checked)
            .disabled(disabled)
            .on_change({
                let entity = entity.clone();
                move |value, window, cx| {
                    entity.update(cx, |screen, cx| screen.set_live(value, window, cx));
                }
            }),
    );

    if view.stream_manager {
        let entity = entity.clone();
        status_row = status_row.child(
            Button::new("open-stream-manager")
                .variant(ButtonVariant::Outline)
                .label(words::OPEN_STREAM_MANAGER)
                .child(ShortcutKeys::for_action(
                    &crate::app::menus::ToggleStreamManager,
                ))
                .on_click(move |_, window, cx| {
                    entity.update(cx, |screen, cx| screen.open_stream_manager(window, cx));
                }),
        );
    }

    let mut header = div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(size::GUTTER))
        .border_b_1()
        .border_color(border)
        .child(status_row);

    if let Some(detail) = view.status.detail.as_ref() {
        header = header.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(detail.clone()),
        );
    }
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("sidekick-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => crate::app::accounts::sign_in(cx),
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        header = header.child(alert);
    }

    let locked = view.unlock.is_some();
    let live_section = PanelSection::new("sidekick-live-section")
        .title(words::LIVE_SECTION_TITLE)
        .description(words::live_section_description())
        .action(Badge::new(words::LIVE_SECTION_BADGE).variant(BadgeVariant::Outline))
        .child(
            SettingsGroup::new().row(
                SettingsRow::new("sidekick-hears-you", words::LISTEN_LABEL)
                    .description(words::listen_consent_sentence())
                    .child(
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
                    ),
            ),
        )
        .children(
            state
                .allowance
                .map(|line| div().type_scale(text::META).text_color(muted).child(line)),
        )
        .children(state.listen_error.map(|line| {
            div()
                .type_scale(text::META)
                .text_color(hsla(theme.destructive))
                .child(line.to_string())
        }));

    let mut powers = GroupedList::new();
    for (title, description, tab) in words::POWERS {
        let label = words::tab_label(tab);
        let tab_id = tab.to_string();
        let entity = entity.clone();
        powers = powers.row(
            ListRow::new(format!("power-{title}"), title)
                .context(description)
                .child(
                    Button::new(format!("open-{tab}-for-{title}"))
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .accessibility_label(words::power_button_label(label, title))
                        .label(label)
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

    let consented = state.consented;
    let mut uses_block = div().flex().flex_col().gap(px(4.));
    for use_line in &state.cloud_uses {
        uses_block = uses_block.child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(format!("• {use_line}")),
        );
    }
    uses_block = uses_block.child(
        div()
            .type_scale(text::META)
            .text_color(muted)
            .child(state.cloud_keeps),
    );
    let cloud = PanelSection::new("sidekick-cloud-ai")
        .title(words::CLOUD_AI_TITLE)
        .description(words::CLOUD_AI_DESCRIPTION)
        .child(
            SettingsGroup::new().row(
                SettingsRow::new("allow-cloud-ai", words::ALLOW_CLOUD_AI).child(
                    Switch::new("allow-cloud-ai")
                        .accessibility_label(words::ALLOW_CLOUD_AI)
                        .checked(consented)
                        .on_change({
                            let entity = entity.clone();
                            move |value, _, cx| {
                                entity.update(cx, |screen, cx| screen.set_consent(value, cx));
                            }
                        }),
                ),
            ),
        )
        .child(uses_block);

    div()
        .flex()
        .flex_col()
        .gap(px(0.))
        .child(header)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(live_section)
                .child(powers_section)
                .child(cloud),
        )
        .into_any_element()
}

pub fn consent_dialog(handle: &DialogHandle, cx: &mut Context<SidekickScreen>) -> impl IntoElement {
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
