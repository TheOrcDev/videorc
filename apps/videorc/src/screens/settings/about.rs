use super::*;
use gpui::{AnyElement, Hsla, Image, ImageFormat, ImageSource, img};
use std::sync::{Arc, LazyLock};
use videorc_app_core::updater::{self as u, UpdateRowControl, UpdateRowView};
use videorc_app_core::{nav::PageId, settings_page::about as a};
use videorc_kit::{
    alert::{Alert, AlertVariant},
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    icon::{IconName, icon},
    list_row::{GroupedList, ListRow},
    panel_section::PanelSection,
    progress::Progress,
    settings_row::SettingsRow,
};

/// `OPEN_HEALTH_LABEL`.
const OPEN_HEALTH: &str = "Open Health";

/// The app's mark, as About shows it (`videorc-logo.png`, a rounded tile with
/// its own transparent margin, so no mask or shadow).
static LOGO: LazyLock<Arc<Image>> = LazyLock::new(|| {
    Arc::new(Image::from_bytes(
        ImageFormat::Png,
        include_bytes!("../../../../desktop/src/renderer/src/assets/videorc-logo.png").to_vec(),
    ))
});

impl SettingsScreen {
    pub(super) fn about_page(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let platform = crate::app::hotkeys::node_platform();
        let ink = hsla(t.foreground);
        let muted = hsla(t.muted_foreground);
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
            } => GroupedList::new()
                .item(
                    SettingsRow::new("updates", u::copy::UPDATES)
                        .description(description)
                        .children(control.map(|control| update_control(control, ink))),
                )
                .into_any_element(),
        };
        // The app's identity, like a macOS About panel: the mark, the name,
        // and the version with its release track; What's new… beside them.
        let identity = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                img(ImageSource::from(LOGO.clone()))
                    .flex_none()
                    .size(px(64.)),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w(px(0.))
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(ink)
                            .child(a::copy::APP_NAME),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_xs()
                            .text_color(muted)
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .child("Version")
                                    .child(
                                        div()
                                            .font_family(videorc_kit::theme::FONT_MONO)
                                            .child(env!("CARGO_PKG_VERSION")),
                                    ),
                            )
                            .child(
                                Badge::new(a::release_track_label(platform, false))
                                    .variant(BadgeVariant::Outline),
                            ),
                    ),
            )
            .child(
                Button::new("whats-new")
                    .label(a::copy::WHATS_NEW_BUTTON)
                    .variant(ButtonVariant::Outline)
                    .disabled(self.changelog.loading)
                    .on_click(cx.listener(|this, _, window, cx| this.open_changelog(window, cx))),
            );
        let about = PanelSection::new(a::copy::ABOUT_AND_UPDATES)
            .title(a::copy::ABOUT_AND_UPDATES)
            .description(a::copy::ABOUT_DESCRIPTION)
            .last(true)
            .child(identity)
            .child(updates);
        // Links: one grouped list, each row a button with its quiet context
        // and the external-link mark.
        let mut links = GroupedList::new().label(a::copy::LINKS);
        for (label, context, page) in a::ABOUT_LINKS {
            let url = a::web_link("https://videorc.com", page);
            let mut row = ListRow::new(gpui::SharedString::from(format!("web-link-{page}")), label)
                .child(icon(IconName::ArrowSquareOut, 16., muted))
                .on_click(move |_, _, cx| cx.open_url(&url));
            if !context.is_empty() {
                row = row.context(context);
            }
            links = links.row(row);
        }
        let support = PanelSection::new(a::copy::SUPPORT)
            .title(a::copy::SUPPORT)
            .description(a::copy::SUPPORT_DESCRIPTION)
            .last(true)
            .child(
                GroupedList::new().item(
                    SettingsRow::new("support-bundle", a::copy::SUPPORT_BUNDLE)
                        .description(a::copy::SUPPORT_BUNDLE_DESCRIPTION)
                        .child(
                            Button::new("open-health")
                                .label(OPEN_HEALTH)
                                .disabled(!PageId::Diagnostics.ported())
                                .variant(ButtonVariant::Outline)
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(Navigate(PageId::Diagnostics))
                                })),
                        ),
                ),
            )
            .child(links);
        div()
            .flex()
            .flex_wrap()
            .flex_1()
            .content_stretch()
            .items_stretch()
            .child(div().flex_1().min_w(px(360.)).child(about))
            .child(
                div()
                    .flex_1()
                    .min_w(px(360.))
                    .border_l_1()
                    .border_color(hsla(t.border))
                    .child(support),
            )
            .into_any_element()
    }
}

/// The update row's one control (`UpdateControl` in `about-settings.tsx`).
fn update_control(control: UpdateRowControl, ink: Hsla) -> AnyElement {
    match control {
        // Leading RefreshIcon, then the words.
        UpdateRowControl::Check { label } => Button::new("update-check")
            .accessibility_label(label)
            .variant(ButtonVariant::Outline)
            .child(icon(IconName::ArrowsClockwise, 16., ink))
            .child(label)
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
                .accessibility_label(label.clone())
                .child(icon(IconName::ArrowsClockwise, 16., ink))
                .child(label)
                .disabled(disabled_reason.is_some())
                .on_click(|_, _, cx| crate::app::updater::install_update(cx));
            if let Some(reason) = disabled_reason {
                button = button.tooltip(reason);
            }
            button.into_any_element()
        }
        UpdateRowControl::Link { label, page } => {
            let url = a::web_link("https://videorc.com", page);
            // The words, then the trailing ExternalLinkIcon.
            Button::new("update-link")
                .accessibility_label(label)
                .variant(ButtonVariant::Outline)
                .child(label)
                .child(icon(IconName::ArrowSquareOut, 16., ink))
                .on_click(move |_, _, cx| cx.open_url(&url))
                .into_any_element()
        }
    }
}
