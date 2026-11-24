use super::*;
use gpui::AnyElement;
use videorc_app_core::{nav::PageId, settings_page::about as a};
use videorc_kit::{
    button::{Button, ButtonVariant},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
};

impl SettingsScreen {
    pub(super) fn about_page(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let platform = crate::app::hotkeys::node_platform();
        let (update_text, a::UpdateControl::Link { label, page }) = a::update_row(platform);
        let update_url = a::web_link("https://videorc.com", page);
        let about = PanelSection::new(a::copy::ABOUT_AND_UPDATES)
            .title(a::copy::ABOUT_AND_UPDATES)
            .description(a::copy::ABOUT_DESCRIPTION)
            .child(
                GroupedList::new()
                    .item(
                        div()
                            .child(
                                ListRow::new("version", a::copy::APP_NAME).child(
                                    Button::new("whats-new")
                                        .label(a::copy::WHATS_NEW_BUTTON)
                                        .variant(ButtonVariant::Outline)
                                        .disabled(self.changelog.loading)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.open_changelog(window, cx)
                                        })),
                                ),
                            )
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(format!(
                                        "{} · {}",
                                        env!("CARGO_PKG_VERSION"),
                                        a::release_track_label(platform, false)
                                    )),
                            ),
                    )
                    .item(
                        div()
                            .child(
                                ListRow::new("updates", a::copy::UPDATES).child(
                                    Button::new("open-downloads")
                                        .label(label)
                                        .variant(ButtonVariant::Outline)
                                        .on_click(move |_, _, cx| cx.open_url(&update_url)),
                                ),
                            )
                            .child(
                                div()
                                    .px(px(12.))
                                    .pb(px(8.))
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(update_text),
                            ),
                    ),
            );
        let mut links = GroupedList::new();
        for (label, context, page) in a::ABOUT_LINKS {
            let url = a::web_link("https://videorc.com", page);
            links = links.item(
                div()
                    .child(
                        ListRow::new(page, label).child(
                            Button::new(gpui::SharedString::from(format!("web-link-{page}")))
                                .label(label)
                                .variant(ButtonVariant::Link)
                                .on_click(move |_, _, cx| cx.open_url(&url)),
                        ),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(context),
                    ),
            );
        }
        let support = PanelSection::new(a::copy::SUPPORT)
            .title(a::copy::SUPPORT)
            .description(a::copy::SUPPORT_DESCRIPTION)
            .child(
                GroupedList::new().item(
                    div()
                        .child(
                            ListRow::new("support-bundle", a::copy::SUPPORT_BUNDLE).child(
                                Button::new("open-health")
                                    .label(PageId::Diagnostics.label())
                                    .disabled(!PageId::Diagnostics.ported())
                                    .tooltip(view::NOT_IN_THIS_BUILD)
                                    .variant(ButtonVariant::Outline)
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(Navigate(PageId::Diagnostics))
                                    })),
                            ),
                        )
                        .child(
                            div()
                                .px(px(12.))
                                .pb(px(8.))
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(a::copy::SUPPORT_BUNDLE_DESCRIPTION),
                        ),
                ),
            )
            .child(
                PanelSection::new(a::copy::LINKS)
                    .title(a::copy::LINKS)
                    .child(links),
            );
        div()
            .flex()
            .flex_wrap()
            .items_start()
            .child(div().flex_1().min_w(px(360.)).child(about))
            .child(div().flex_1().min_w(px(360.)).child(support))
            .into_any_element()
    }
}
