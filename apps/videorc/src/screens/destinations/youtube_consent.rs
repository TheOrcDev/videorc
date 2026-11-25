//! YouTube consent before OAuth (`YouTubeConsentDialog`, P730–P733).
//! Uses `videorc_app_core::accounts::needs_consent` so Connect opens this
//! first for YouTube, then `Studio::start_platform_sign_in`.

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::accounts::{self, WebLinks};
use videorc_app_core::livestream::copy as page_copy;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::checkbox::{Checkbox, CheckboxChecked};
use videorc_kit::dialog::Dialog;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn open_youtube_consent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.youtube_consent_accepted = false;
        self.youtube_consent.open(window, cx);
        cx.notify();
    }

    pub(super) fn close_youtube_consent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.youtube_consent.close(window, cx);
        self.youtube_consent_accepted = false;
        cx.notify();
    }

    pub(super) fn youtube_consent_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.youtube_consent.is_open() {
            return div().into_any_element();
        }
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let links = WebLinks::production();
        let privacy = format!("{}/privacy", links.origin);
        let terms = format!("{}/terms", links.origin);
        let accepted = self.youtube_consent_accepted;

        Dialog::new(
            "youtube-consent",
            &self.youtube_consent,
            page_copy::YOUTUBE_CONSENT_TITLE,
        )
        .description(page_copy::YOUTUBE_CONSENT_DESCRIPTION)
        .close_button(false)
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(12.))
                .child(link_button(
                    "yt-privacy",
                    page_copy::PRIVACY_POLICY,
                    privacy,
                ))
                .child(link_button("yt-terms", page_copy::VIDEORC_TERMS, terms))
                .child(link_button(
                    "yt-yt-terms",
                    page_copy::YOUTUBE_TERMS,
                    page_copy::YOUTUBE_TERMS_URL,
                ))
                .child(link_button(
                    "yt-google",
                    page_copy::GOOGLE_PRIVACY,
                    page_copy::GOOGLE_PRIVACY_URL,
                )),
        )
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(8.))
                .child(
                    Checkbox::new("youtube-consent-agree")
                        .accessibility_label(page_copy::YOUTUBE_CONSENT_AGREE)
                        .checked(accepted)
                        .on_change({
                            let entity = entity.clone();
                            move |state, _, cx| {
                                let on = matches!(state, CheckboxChecked::Checked);
                                entity.update(cx, |this, cx| {
                                    this.youtube_consent_accepted = on;
                                    cx.notify();
                                });
                            }
                        }),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.foreground))
                        .child(page_copy::YOUTUBE_CONSENT_AGREE),
                ),
        )
        .footer(
            Button::new("youtube-consent-cancel")
                .label(page_copy::CANCEL)
                .variant(ButtonVariant::Outline)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |this, cx| this.close_youtube_consent(window, cx));
                    }
                }),
        )
        .footer(
            Button::new("youtube-consent-continue")
                .label(page_copy::CONTINUE_TO_GOOGLE)
                .variant(ButtonVariant::Default)
                .disabled(!accepted)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |this, cx| {
                            this.close_youtube_consent(window, cx);
                            this.connect_platform("youtube".into(), cx);
                        });
                    }
                }),
        )
        .into_any_element()
    }

    /// Connect a destination: YouTube opens consent first (`needs_consent`).
    pub(super) fn begin_connect(
        &mut self,
        platform: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if accounts::needs_consent(&platform) {
            self.open_youtube_consent(window, cx);
            return;
        }
        self.connect_platform(platform, cx);
    }

    pub(super) fn connect_platform(&mut self, platform: String, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let scopes = accounts::connect_scopes(&platform);
        cx.spawn(async move |this, cx| {
            if let Some(url) = studio.start_platform_sign_in(&platform, scopes).await {
                let _ = this.update(cx, |_, cx| cx.open_url(&url));
            }
        })
        .detach();
    }
}

fn link_button(id: &'static str, label: &'static str, url: impl Into<String>) -> Button {
    let url = url.into();
    Button::new(id)
        .label(label)
        .variant(ButtonVariant::Ghost)
        .on_click(move |_, _, cx| cx.open_url(&url))
}
