use super::*;
use gpui::AnyElement;
use videorc_app_core::updater::{self as u, UpdateRowControl, UpdateRowView};
use videorc_app_core::{nav::PageId, settings_page::about as a};
use videorc_kit::{
    alert::{Alert, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
    progress::Progress,
};

impl SettingsScreen {
    pub(super) fn about_page(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let platform = crate::app::hotkeys::node_platform();
        // P1430, P1431: the update row in the updater's state, or its calm
        // alert with Try again (never the updater's own words).
        let update_view = u::update_row_view(
            &crate::app::updater::status(cx),
            crate::app::updater::capture_active(cx),
        );
        let updates: AnyElement = match update_view {
            UpdateRowView::Error { title, description } => Alert::new("update-error")
                .variant(AlertVariant::Warning)
                .title(title)
                .description(description)
                .action(
                    Button::new("update-try-again")
                        .label(u::copy::TRY_AGAIN)
                        .size(ButtonSize::Xs)
                        .variant(ButtonVariant::Outline)
                        .on_click(|_, _, cx| crate::app::updater::check(cx)),
                )
                .into_any_element(),
            UpdateRowView::Row {
                description,
                control,
            } => div()
                .child(
                    ListRow::new("updates", u::copy::UPDATES)
                        .children(control.map(|control| update_control(control))),
                )
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(8.))
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(description),
                )
                .into_any_element(),
        };
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
                    .item(updates),
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

/// The update row's one control (`UpdateControl` in `about-settings.tsx`).
fn update_control(control: UpdateRowControl) -> AnyElement {
    match control {
        UpdateRowControl::Check { label } => Button::new("update-check")
            .label(label)
            .variant(ButtonVariant::Outline)
            .on_click(|_, _, cx| crate::app::updater::check(cx))
            .into_any_element(),
        UpdateRowControl::Checking => Button::new("update-checking")
            .label(u::copy::CHECKING)
            .variant(ButtonVariant::Outline)
            .disabled(true)
            .into_any_element(),
        UpdateRowControl::Progress { percent } => div()
            .id("update-download")
            .flex_none()
            .w(px(128.))
            .child(Progress::new(f32::from(percent)).accessibility_label(u::copy::UPDATE_DOWNLOAD))
            .into_any_element(),
        UpdateRowControl::Install {
            label,
            disabled_reason,
        } => {
            let mut button = Button::new("update-install")
                .label(label)
                .disabled(disabled_reason.is_some())
                .on_click(|_, _, cx| crate::app::updater::install_update(cx));
            if let Some(reason) = disabled_reason {
                button = button.tooltip(reason);
            }
            button.into_any_element()
        }
        UpdateRowControl::Link { label, page } => {
            let url = a::web_link("https://videorc.com", page);
            Button::new("update-link")
                .label(label)
                .variant(ButtonVariant::Outline)
                .on_click(move |_, _, cx| cx.open_url(&url))
                .into_any_element()
        }
    }
}
