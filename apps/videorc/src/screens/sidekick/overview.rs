//! Overview tab: status row, Sidekick Live section, powers and Cloud AI
//! (`tabs/buddy-tab.tsx`).

use gpui::{AnyElement, Context, IntoElement, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::live::{LiveView, StatusKind, UnlockAction};

pub struct OverviewState<'a> {
    pub view: &'a LiveView,
    pub listen: bool,
    pub consented: bool,
    pub cloud_uses: &'a [String],
    pub cloud_keeps: &'a str,
}

fn status_tone(kind: StatusKind) -> StatusTone {
    match kind {
        StatusKind::Live => StatusTone::Good,
        StatusKind::Attention => StatusTone::Warn,
        StatusKind::Off | StatusKind::On => StatusTone::Neutral,
    }
}

/// The consent dialog (`buddy-consent-dialog.tsx`).
pub fn consent_dialog<V: 'static>(handle: &DialogHandle, cx: &mut Context<V>) -> AnyElement {
    let entity = cx.entity();
    Dialog::new("sidekick-consent", handle, words::CONSENT_TITLE)
        .size(DialogSize::Sm)
        .description(words::CONSENT_DESCRIPTION)
        .footer(
            Button::new("sidekick-consent-decline")
                .label(words::CONSENT_DECLINE)
                .variant(ButtonVariant::Ghost)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen: &mut super::SidekickScreen, cx| {
                            screen.answer_consent(false, window, cx)
                        })
                    }
                }),
        )
        .footer(
            Button::new("sidekick-consent-accept")
                .label(words::CONSENT_ACCEPT)
                .variant(ButtonVariant::Default)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |screen: &mut super::SidekickScreen, cx| {
                            screen.answer_consent(true, window, cx)
                        })
                    }
                }),
        )
        .into_any_element()
}

pub fn render_overview<V: 'static>(
    state: OverviewState<'_>,
    window: &mut Window,
    cx: &mut Context<V>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let entity = cx.entity().downgrade();
    let view = state.view;

    let mut status_row = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(StatusDot::new("sidekick-status").tone(status_tone(view.status.kind)))
        .child(
            div()
                .type_scale(text::SECTION)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(view.status.label),
        );
    if let Some(reason) = &view.status.reason {
        status_row = status_row.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(reason.clone()),
        );
    }
    if let Some(detail) = &view.status.detail {
        status_row = status_row.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(detail.clone()),
        );
    }

    let live_switch = Switch::new("sidekick-live-switch")
        .accessibility_label(words::LIVE_SWITCH_LABEL)
        .checked(view.checked)
        .disabled(view.switch_disabled)
        .on_change({
            let entity = entity.clone();
            move |on, window, app| {
                let _ = entity.update(app, |screen: &mut super::SidekickScreen, cx| {
                    screen.set_live(on, window, cx)
                });
            }
        });

    let mut header = div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(status_row)
        .child(
            div()
                .ml_auto()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().type_scale(text::META).child(words::LIVE_SWITCH_LABEL))
                .child(live_switch),
        );

    if view.stream_manager {
        header = header.child(
            Button::new("sidekick-open-manager")
                .label(words::OPEN_STREAM_MANAGER)
                .variant(ButtonVariant::Ghost)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, app| {
                        let _ = entity.update(app, |screen: &mut super::SidekickScreen, cx| {
                            screen.open_stream_manager(window, cx)
                        });
                    }
                }),
        );
    }

    let mut sections: Vec<AnyElement> = Vec::new();
    sections.push(header.into_any_element());

    if let Some(unlock) = &view.unlock {
        let mut alert = Alert::new("sidekick-lock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("sidekick-unlock")
                    .label(label)
                    .variant(ButtonVariant::Outline)
                    .on_click(|_, _, _| {}),
            );
        }
        sections.push(alert.into_any_element());
    }

    let listen_row = SettingsRow::new("sidekick-listen", words::LISTEN_LABEL)
        .description(words::listen_consent_sentence())
        .child(
            Switch::new("sidekick-listen-switch")
                .accessibility_label(words::LISTEN_LABEL)
                .checked(state.listen)
                .disabled(view.unlock.is_some() || !view.checked)
                .on_change({
                    let entity = entity.clone();
                    move |on, _, app| {
                        let _ = entity.update(app, |screen: &mut super::SidekickScreen, cx| {
                            screen.set_listen(on, cx)
                        });
                    }
                }),
        );

    sections.push(
        PanelSection::new("sidekick-live")
            .title(words::LIVE_SECTION_TITLE)
            .action(Badge::new(words::LIVE_SECTION_BADGE).variant(BadgeVariant::Outline))
            .description(words::live_section_description())
            .child(listen_row)
            .into_any_element(),
    );

    let mut powers = GroupedList::new().label(words::POWERS_TITLE);
    for (title, description, tab) in words::POWERS {
        let tab_label = words::tab_label(tab);
        let button = words::power_button_label(tab_label, title);
        powers = powers.item(
            ListRow::new(title, title).context(description).child(
                Button::new(format!("sidekick-power-{tab}"))
                    .label(button)
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        let tab = tab.to_string();
                        move |_, _, app| {
                            let _ = entity.update(app, |screen: &mut super::SidekickScreen, cx| {
                                screen.select_tab(
                                    match tab.as_str() {
                                        "chat" => 1,
                                        "voice" => 3,
                                        _ => 0,
                                    },
                                    cx,
                                );
                            });
                        }
                    }),
            ),
        );
    }
    sections.push(powers.into_any_element());

    let mut uses = GroupedList::new().label("Uses");
    for (index, line) in state.cloud_uses.iter().enumerate() {
        uses = uses.item(ListRow::new(format!("cloud-use-{index}"), line.clone()));
    }

    let cloud = PanelSection::new("sidekick-cloud-ai")
        .title(words::CLOUD_AI_TITLE)
        .description(words::CLOUD_AI_DESCRIPTION)
        .last(true)
        .child(
            SettingsRow::new("sidekick-allow-cloud", words::ALLOW_CLOUD_AI).child(
                Switch::new("sidekick-allow-cloud-switch")
                    .accessibility_label(words::ALLOW_CLOUD_AI)
                    .checked(state.consented)
                    .on_change({
                        let entity = entity.clone();
                        move |on, _, app| {
                            let _ = entity.update(app, |screen: &mut super::SidekickScreen, cx| {
                                screen.set_consent(on, cx)
                            });
                        }
                    }),
            ),
        )
        .child(uses)
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(state.cloud_keeps.to_string()),
        );
    sections.push(cloud.into_any_element());

    ScrollArea::new("sidekick-overview")
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(16.))
                .p(px(size::GUTTER))
                .children(sections),
        )
        .into_any_element()
}
