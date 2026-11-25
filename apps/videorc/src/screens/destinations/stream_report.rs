//! Destinations → After the stream (`StreamReportEmailSection`, P791–P796).
//!
//! Words and view rules come from `livestream::stream_report`. The Studio's
//! `stream_report_store` drives them over `streamReport.*`: the first read's
//! own retries, a failed save's toast and re-read, and `account.changed`.

use gpui::{AnyElement, Context, Window, prelude::*};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::stream_report::{
    DESCRIPTION, EMAIL_LABEL, EmailControl, HISTORY_LABEL, OPEN, SEND_LAST, SIGNED_OUT_REASON,
    SectionView, TITLE, TRY_AGAIN, YOUR_STREAMS, YOUR_STREAMS_DESCRIPTION,
};
use videorc_app_core::livestream::watchdog_section::LIVE_URL;
use videorc_app_core::studio::stream_report_store::StreamReportStore;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn stream_report_view(store: &StreamReportStore) -> SectionView {
        store.section.view()
    }

    pub(super) fn stream_report_section(
        &self,
        view: &SectionView,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let mut section = PanelSection::new("destinations-stream-report")
            .title(TITLE)
            .description(DESCRIPTION);

        if view.signed_out {
            section = section.child(
                Alert::new("stream-report-sign-in")
                    .variant(AlertVariant::Locked)
                    .title(SIGNED_OUT_REASON)
                    .action(
                        Button::new("stream-report-sign-in")
                            .label(page_copy::AUTH_SIGN_IN)
                            .variant(ButtonVariant::Outline)
                            .on_click(|_, _, cx| {
                                crate::app::accounts::sign_in(cx);
                            }),
                    ),
            );
        }

        let email_child: AnyElement = match view.email_control {
            EmailControl::TryAgain => Button::new("stream-report-retry")
                .label(TRY_AGAIN)
                .variant(ButtonVariant::Outline)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, _| this.reload_stream_report());
                    }
                })
                .into_any_element(),
            EmailControl::Switch { checked, enabled } => Switch::new("stream-report-email")
                .accessibility_label(EMAIL_LABEL)
                .checked(checked)
                .disabled(!enabled)
                .on_change({
                    let entity = entity.clone();
                    move |value, _, cx| {
                        entity.update(cx, |this, _| this.set_stream_report_email(value));
                    }
                })
                .into_any_element(),
        };

        section = section.child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("stream-report-email", EMAIL_LABEL)
                        .description(view.email_description.clone())
                        .child(email_child),
                )
                .row(
                    SettingsRow::new("stream-report-history", HISTORY_LABEL)
                        .description(view.history_description)
                        .child(
                            Switch::new("stream-report-history")
                                .accessibility_label(HISTORY_LABEL)
                                .checked(view.history_checked)
                                .disabled(!view.history_enabled)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |this, _| {
                                            this.set_stream_report_history(value)
                                        });
                                    }
                                }),
                        ),
                )
                .row(
                    SettingsRow::new("stream-report-your-streams", YOUR_STREAMS)
                        .description(YOUR_STREAMS_DESCRIPTION)
                        .child(
                            Button::new("stream-report-open")
                                .label(OPEN)
                                .variant(ButtonVariant::Outline)
                                .on_click(|_, _, cx| cx.open_url(LIVE_URL)),
                        ),
                )
                .row(
                    SettingsRow::new("stream-report-send-last", SEND_LAST)
                        .description(view.send_line.clone())
                        .child(
                            Button::new("stream-report-send")
                                .label(view.send_label)
                                .variant(ButtonVariant::Outline)
                                .disabled(!view.send_enabled)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |this, _| this.send_last_stream_report());
                                    }
                                }),
                        ),
                ),
        );

        section.into_any_element()
    }

    fn set_stream_report_email(&self, enabled: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_stream_report_email(enabled).await;
        });
    }

    fn set_stream_report_history(&self, enabled: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.set_stream_report_history(enabled).await;
        });
    }

    fn reload_stream_report(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.reload_stream_report().await;
        });
    }

    fn send_last_stream_report(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.send_last_stream_report().await;
        });
    }
}
