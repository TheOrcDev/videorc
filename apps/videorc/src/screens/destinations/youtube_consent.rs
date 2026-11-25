//! YouTube consent before OAuth (`YouTubeConsentDialog`, P730–P733).
//! Connect opens this when [`videorc_app_core::accounts::needs_consent`];
//! Continue calls [`crate::app::accounts::connect_provider`] (Destinations
//! shows its own browser wait on the card). Disconnect asks first (P720),
//! then [`crate::app::accounts::disconnect_provider`].

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::accounts::{self, WebLinks};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::setup::{self, Question, SignInWait};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::checkbox::{Checkbox, CheckboxChecked};
use videorc_kit::dialog::Dialog;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use crate::app::accounts as app_accounts;

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
        let links = cx
            .try_global::<app_accounts::Shared>()
            .map(|shared| shared.web.clone())
            .unwrap_or_else(WebLinks::production);
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
                            this.connect_platform("youtube", cx);
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
        self.connect_platform(&platform, cx);
    }

    /// `connect_provider` with Destinations' own browser-wait card
    /// (`shows_browser_step: true`).
    pub(super) fn connect_platform(&mut self, platform: &str, cx: &mut Context<Self>) {
        let from = setup::account_version(self.studio.platforms_now().account(platform));
        self.memory.sign_in.insert(
            platform.to_string(),
            SignInWait {
                from: from.clone(),
                url: None,
                copied: false,
            },
        );
        self.rebuild_from_studio();
        cx.notify();

        let scopes = accounts::connect_scopes(platform);
        let platform_owned = platform.to_string();
        let entity = cx.entity();
        app_accounts::connect_provider(cx, platform, scopes, true, move |page, cx| {
            entity.update(cx, |this, cx| {
                match page {
                    Some(url) => {
                        if let Some(wait) = this.memory.sign_in.get_mut(&platform_owned) {
                            if wait.from == from {
                                wait.url = Some(url);
                            }
                        }
                    }
                    None => {
                        this.memory.sign_in.remove(&platform_owned);
                    }
                }
                this.rebuild(cx);
            });
        });
    }

    pub(super) fn cancel_sign_in(&mut self, platform: &str, cx: &mut Context<Self>) {
        self.memory.sign_in.remove(platform);
        self.rebuild(cx);
    }

    pub(super) fn copy_sign_in_link(&mut self, platform: &str, cx: &mut Context<Self>) {
        let Some(wait) = self.memory.sign_in.get_mut(platform) else {
            return;
        };
        let Some(url) = wait.url.clone() else {
            return;
        };
        wait.copied = true;
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
        self.rebuild(cx);
    }

    /// Ask before Disconnect (P720), then [`app_accounts::disconnect_provider`].
    pub(super) fn ask_disconnect(
        &mut self,
        platform: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.disconnect_platform = Some(platform);
        self.disconnect_confirm.open(window, cx);
        cx.notify();
    }

    pub(super) fn close_disconnect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.disconnect_confirm.close(window, cx);
        self.disconnect_platform = None;
        cx.notify();
    }

    pub(super) fn confirm_disconnect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(platform) = self.disconnect_platform.take() {
            self.memory.sign_in.remove(&platform);
            app_accounts::disconnect_provider(cx, &platform);
        }
        self.disconnect_confirm.close(window, cx);
        self.rebuild(cx);
    }

    pub(super) fn disconnect_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(platform) = &self.disconnect_platform else {
            return div().into_any_element();
        };
        if !self.disconnect_confirm.is_open() {
            return div().into_any_element();
        }
        let Some(words) = setup::question_view(
            &Question::Disconnect {
                platform: platform.clone(),
            },
            &[],
        ) else {
            return div().into_any_element();
        };
        let entity = cx.entity();
        let _ = window;
        Dialog::new("dest-disconnect", &self.disconnect_confirm, words.title)
            .description(words.description)
            .close_button(false)
            .footer(
                Button::new("dest-disconnect-cancel")
                    .label(page_copy::CANCEL)
                    .variant(ButtonVariant::Outline)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.close_disconnect(window, cx));
                        }
                    }),
            )
            .footer(
                Button::new("dest-disconnect-confirm")
                    .label(words.confirm)
                    .variant(ButtonVariant::Destructive)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.confirm_disconnect(window, cx));
                        }
                    }),
            )
            .into_any_element()
    }
}

fn link_button(id: &'static str, label: &'static str, url: impl Into<String>) -> Button {
    let url = url.into();
    Button::new(id)
        .label(label)
        .variant(ButtonVariant::Ghost)
        .on_click(move |_, _, cx| cx.open_url(&url))
}
