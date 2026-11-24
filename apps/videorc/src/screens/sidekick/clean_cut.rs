//! Sidekick → Clean cut (`clean-cut/clean-cut-card.tsx`).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::SidekickScreen;
use super::live::{LiveView, UnlockAction};

const CLEAN_CUT: &str = "Clean cut";
const EVERY_RECORDING: &str = "Make a clean cut of every recording";
const RECORDINGS: &str = "Recordings";
const SEARCH_RECORDINGS: &str = "Search recordings…";
const NO_RECORDINGS: &str = "No recordings match";
const KIND_OF_CUT: &str = "Kind of cut";
const MAKE_CLEAN: &str = "Make a clean cut";
const ALLOW_CLOUD: &str = "Allow cloud AI…";

pub fn render_clean_cut(
    view: &LiveView,
    consented: bool,
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let entity = cx.entity();

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-clean-cut-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("clean-cut-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Clean cut: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }
    if !consented {
        lead = lead.child(
            Alert::new("sidekick-clean-cut-consent")
                .variant(AlertVariant::Warning)
                .title("Clean cut needs cloud AI.")
                .action(
                    Button::new("clean-cut-allow-cloud")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(ALLOW_CLOUD)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |screen, cx| screen.set_consent(true, cx));
                            }
                        }),
                ),
        );
    }

    let settings = PanelSection::new("sidekick-clean-cut")
        .title(CLEAN_CUT)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("every-recording", EVERY_RECORDING).child(
                        Switch::new("every-recording")
                            .accessibility_label(EVERY_RECORDING)
                            .checked(false)
                            .disabled(true),
                    ),
                )
                .row(
                    SettingsRow::new("kind-of-cut", KIND_OF_CUT).child(
                        SegmentedControl::new("kind-of-cut")
                            .small(true)
                            .accessibility_label(KIND_OF_CUT)
                            .value(Some("clean"))
                            .disabled(true)
                            .option(Segment::new("clean", "Clean"))
                            .option(Segment::new("condensed", "Condensed")),
                    ),
                ),
        )
        .child(
            Button::new("make-clean-cut")
                .variant(ButtonVariant::Default)
                .label(MAKE_CLEAN)
                .disabled(true),
        );

    let recordings = PanelSection::new("sidekick-clean-cut-recordings")
        .title(RECORDINGS)
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(SEARCH_RECORDINGS),
        )
        .child(
            div()
                .type_scale(text::META)
                .text_color(muted)
                .child(NO_RECORDINGS),
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
                .child(settings)
                .child(recordings),
        )
        .into_any_element()
}
