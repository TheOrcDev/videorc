//! The sidebar's update chip (P021, Electron's `SidebarUpdateChip`): above
//! the account row, only while an update is in flight or ready. A click
//! installs when the update is downloaded and nothing records or streams;
//! otherwise it opens Settings → About, which tells the whole story. Its
//! name is its words; the version is in the tooltip; the dot is green only
//! when a click installs.

use gpui::{App, IntoElement, WeakEntity, div, prelude::*, px};
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::updater::{ChipAction, ChipTone, UpdateStatus, update_chip};
use videorc_kit::{
    icon::{IconName, icon},
    status_dot::{StatusDot, StatusTone},
    theme::hsla,
    tokens::{Theme, radius, size},
    tooltip::tooltip,
};

use super::shell::Shell;
use super::updater;

/// The chip, or nothing while no update is in flight or ready.
pub fn chip(shell: WeakEntity<Shell>, t: &Theme, cx: &App) -> Option<impl IntoElement> {
    let status = updater::status(cx);
    // Only a downloaded update reads the capture (the snapshot is large and
    // the sidebar draws often).
    let capture = matches!(status, UpdateStatus::Downloaded { .. }) && updater::capture_active(cx);
    let chip = update_chip(&status, capture)?;
    let action = chip.action;
    let tone = match chip.tone {
        ChipTone::Good => StatusTone::Good,
        ChipTone::Neutral => StatusTone::Neutral,
    };
    let (accent, foreground) = (hsla(t.accent), hsla(t.foreground));
    // `sidebar.tsx`: a `px-3 pb-1` band over the footer, and in it a 28 px
    // row button at the row radius, 14 px words in the primary ink, the
    // flat accent block on hover.
    Some(
        div().px(px(12.)).pb(px(4.)).child(
            gpui_base::Button::new("sidebar-update-chip")
                .accessibility_label(chip.label.clone())
                .tooltip(tooltip(chip.detail))
                .w_full()
                .h(px(size::ROW_COMPACT))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(10.))
                .rounded(px(radius::ROW))
                .text_size(px(14.))
                .line_height(px(20.))
                .text_color(foreground)
                .hover(move |style| style.bg(accent))
                .child(
                    div()
                        .relative()
                        .flex_none()
                        .size(px(16.))
                        .child(icon(
                            IconName::ArrowsClockwise,
                            16.,
                            hsla(t.muted_foreground),
                        ))
                        .child(
                            div()
                                .absolute()
                                .top(px(-2.))
                                .right(px(-2.))
                                .child(StatusDot::new("sidebar-update-chip-dot").tone(tone)),
                        ),
                )
                .child(div().flex_1().min_w(px(0.)).truncate().child(chip.label))
                .on_click(move |_, window, cx| match action {
                    ChipAction::Install => updater::install_update(cx),
                    ChipAction::Settings => {
                        let _ = shell.update(cx, |shell, cx| {
                            shell.open_settings(Some(SettingsTab::About), window, cx)
                        });
                    }
                }),
        ),
    )
}
