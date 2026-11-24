//! Sidekick → Reports (`buddy-report-card.tsx`).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const STREAM_REPORT: &str = "Stream report";
const MARKERS: &str = "Markers";
const STREAM: &str = "Stream";
const EMPTY_TITLE: &str = "No stream reports yet";
const EMPTY_MESSAGE: &str = "The report appears here after your first stream with Sidekick.";
const OFF_NOTE: &str = "Sidekick was off for this stream.";
const REPORT_SECTIONS: &[&str] = &[
    "Said on stream",
    "Posted as you",
    "Missed questions",
    "Open promises",
    "Moments",
    "Alerts",
    "Commands",
    "Regulars back",
    "Milestones",
];

pub fn render_reports(
    view: &LiveView,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-reports-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("reports-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Reports: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }

    let mut sections = div().flex().flex_col().gap(px(12.));
    for label in REPORT_SECTIONS {
        sections = sections.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(*label),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child("Nothing yet."),
                ),
        );
    }

    let report = PanelSection::new("sidekick-stream-report")
        .title(STREAM_REPORT)
        .action(
            Button::new("report-markers")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(MARKERS)
                .disabled(true),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(format!("{STREAM}: none yet")),
                )
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(EMPTY_TITLE),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(EMPTY_MESSAGE),
                )
                .child(
                    Alert::new("sidekick-report-off")
                        .variant(AlertVariant::Quiet)
                        .title(OFF_NOTE),
                )
                .child(sections),
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
                .child(report),
        )
        .into_any_element()
}
