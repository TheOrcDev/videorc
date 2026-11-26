//! YouTube Channel select/refresh (P723–P724) and X Live (P725–P729).

use gpui::{AnyElement, Context, SharedString, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::setup::{ChannelView, XLiveView};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::select::Select;
use videorc_kit::settings_row::SettingsRow;
use videorc_kit::theme::{TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn channel_row(
        &self,
        dest_id: &str,
        channel: &ChannelView,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let selected = channel
            .options
            .get(channel.selected.max(0) as usize)
            .map(|(id, _)| SharedString::from(id.clone()));
        let mut select = Select::new(format!("dest-channel-{dest_id}"))
            .accessibility_label(page_copy::CHANNEL)
            .disabled(disabled || !channel.enabled)
            .width(240.0)
            .placeholder(channel.placeholder.clone())
            .value(selected)
            .on_change({
                let entity = entity.clone();
                move |value: SharedString, _, cx| {
                    let channel_id = value.to_string();
                    entity.update(cx, |this, _| {
                        this.select_youtube_channel(channel_id);
                    });
                }
            });
        for (id, label) in &channel.options {
            select = select.option(id.clone(), label.clone());
        }
        SettingsRow::new(format!("dest-channel-row-{dest_id}"), page_copy::CHANNEL)
            .child(
                div().flex().items_center().gap(px(8.)).child(select).child(
                    Button::new(format!("dest-channel-refresh-{dest_id}"))
                        .label(if channel.loading {
                            page_copy::CHECKING
                        } else {
                            page_copy::REFRESH_CHANNELS
                        })
                        .variant(ButtonVariant::Outline)
                        .disabled(disabled || !channel.refresh_enabled)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, _| this.refresh_youtube_channels());
                            }
                        }),
                ),
            )
            .into_any_element()
    }

    pub(super) fn x_live_block(
        &self,
        dest_id: &str,
        x_live: &XLiveView,
        disabled: bool,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let mut column = div().flex().flex_col().gap(px(6.)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .child(Badge::new(x_live.badge.clone()).variant(if x_live.ready {
                    BadgeVariant::Success
                } else {
                    BadgeVariant::Warning
                }))
                .child(
                    Button::new(format!("dest-x-check-{dest_id}"))
                        .label(x_live.check_label.clone())
                        .variant(ButtonVariant::Ghost)
                        .disabled(disabled || !x_live.check_enabled)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, _| this.refresh_x_capability());
                            }
                        }),
                ),
        );
        if let Some(message) = &x_live.message {
            column = column.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(message.clone()),
            );
        }
        if !x_live.ready {
            let mut actions = div().flex().flex_wrap().gap(px(8.));
            if x_live.authorize {
                actions = actions.child(
                    Button::new(format!("dest-x-authorize-{dest_id}"))
                        .label(page_copy::AUTHORIZE_X_LIVE)
                        .variant(ButtonVariant::Default)
                        .disabled(disabled)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, cx| this.authorize_x_live(cx));
                            }
                        }),
                );
            }
            if x_live.use_key_instead {
                let dest = dest_id.to_string();
                actions = actions.child(
                    Button::new(format!("dest-x-manual-{dest_id}"))
                        .label(page_copy::USE_STREAM_KEY_INSTEAD)
                        .variant(ButtonVariant::Outline)
                        .disabled(disabled)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, _| {
                                    this.set_auth_mode(dest.clone(), "manual-rtmp".to_string());
                                });
                            }
                        }),
                );
            }
            column = column.child(actions);
        }
        if !x_live.links.is_empty() {
            let mut links = div().flex().flex_wrap().gap(px(8.));
            for (i, link) in x_live.links.iter().enumerate() {
                let url = link.url.clone();
                links = links.child(
                    Button::new(format!("dest-x-link-{dest_id}-{i}"))
                        .label(link.label.clone())
                        .variant(ButtonVariant::Ghost)
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                );
            }
            column = column.child(links);
        }
        column.into_any_element()
    }

    fn select_youtube_channel(&self, channel_id: String) {
        let account_id = self
            .studio
            .platforms_now()
            .account("youtube")
            .map(|a| a.account_id.clone());
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.select_youtube_channel(&channel_id, account_id).await;
        });
    }

    fn refresh_youtube_channels(&self) {
        let account_id = self
            .studio
            .platforms_now()
            .account("youtube")
            .map(|a| a.account_id.clone());
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.refresh_youtube_channels(account_id, false).await;
        });
    }

    fn refresh_x_capability(&self) {
        let account_id = self
            .studio
            .platforms_now()
            .account("x")
            .map(|a| a.account_id.clone());
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.refresh_x_capability(account_id).await;
        });
    }

    fn authorize_x_live(&self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.start_x_live_authorization().await });
        cx.spawn(async move |_, cx| {
            if let Ok(Some(url)) = job.await {
                cx.update(|cx| cx.open_url(&url));
            }
        })
        .detach();
    }
}
