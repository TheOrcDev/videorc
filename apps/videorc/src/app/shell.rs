//! The main window's shell (plan 260 S2.1): the sidebar from the core's
//! navigation model (`videorc_app_core::nav`, Electron's `sidebar-pages.ts`),
//! an empty page for the one chosen, and the status bar with the backend's
//! line. The screens fill the pages in Phase 3; the kit (`videorc-kit`)
//! replaces these plain elements when it lands.

use gpui::{Context, Entity, FontWeight, SharedString, Window, div, prelude::*, px, rgb};
use videorc_app_core::nav::{self, PageId, ZONES};
use videorc_app_core::{BackendState, ConnectionState, Tone};

use super::bridge::Mirror;
use super::session::SessionPanel;

/// The status bar's line: the supervisor's words, and whether the typed
/// client has the backend's `backend.ready`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLine {
    pub text: String,
    pub tone: Tone,
}

impl StatusLine {
    pub fn of(backend: &BackendState) -> Self {
        Self {
            text: backend.status_text(),
            tone: backend.tone(),
        }
    }
}

/// The client's connection, in words.
pub fn connection_text(state: &ConnectionState) -> String {
    match state {
        ConnectionState::WaitingForBackend => "Waiting for the backend".into(),
        ConnectionState::Connecting { .. } => "Connecting…".into(),
        ConnectionState::Connected { .. } => "Connected".into(),
        ConnectionState::Disconnected { reason, .. } => format!("Disconnected: {reason}"),
        #[allow(unreachable_patterns)]
        _ => String::new(),
    }
}

// Plain colours until the kit's tokens land (dark, the app's default look).
const GROUND: u32 = 0x161618;
const SIDEBAR: u32 = 0x1c1c1f;
const HAIRLINE: u32 = 0x2c2c30;
const TEXT: u32 = 0xe8e8ea;
const MUTED: u32 = 0x8e8e93;
const SELECTED: u32 = 0x2f2f35;

fn tone_colour(tone: Tone) -> u32 {
    match tone {
        Tone::Ready => 0x30d158,
        Tone::Busy => 0xffd60a,
        Tone::Failed => 0xff453a,
        Tone::Stopped => 0x8e8e93,
    }
}

pub struct Shell {
    page: PageId,
    backend: Entity<Mirror<StatusLine>>,
    connection: Entity<Mirror<String>>,
    /// S2.4: Record, the clock, Stop and Go Live, on the Studio page.
    session: Entity<SessionPanel>,
}

impl Shell {
    pub fn new(
        backend: Entity<Mirror<StatusLine>>,
        connection: Entity<Mirror<String>>,
        session: Entity<SessionPanel>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&backend, |_, _, cx| cx.notify()).detach();
        cx.observe(&connection, |_, _, cx| cx.notify()).detach();
        Self {
            page: PageId::Studio,
            backend,
            connection,
            session,
        }
    }

    pub fn page(&self) -> PageId {
        self.page
    }

    fn open(&mut self, page: PageId, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != page {
            self.page = page;
            window.set_window_title(&nav::window_title(page));
            cx.notify();
        }
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut column = div()
            .w(px(220.))
            .h_full()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(8.))
            .pt(px(40.))
            .bg(rgb(SIDEBAR))
            .border_r_1()
            .border_color(rgb(HAIRLINE));
        for (group, pages) in ZONES {
            if let Some(label) = group.label() {
                column = column.child(
                    div()
                        .pt(px(10.))
                        .pb(px(4.))
                        .px(px(8.))
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child(label),
                );
            }
            for &page in pages {
                let selected = page == self.page;
                let shortcut: SharedString = page
                    .shortcut_key()
                    .map(|key| format!("⌘{}", key.to_ascii_uppercase()))
                    .unwrap_or_default()
                    .into();
                column = column.child(
                    div()
                        .id(page.id())
                        .flex()
                        .justify_between()
                        .items_center()
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(px(6.))
                        .text_size(px(13.))
                        .text_color(rgb(TEXT))
                        .when(selected, |row| row.bg(rgb(SELECTED)))
                        .cursor_pointer()
                        .child(page.label())
                        .child(
                            div()
                                .text_color(rgb(MUTED))
                                .text_size(px(11.))
                                .child(shortcut),
                        )
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.open(page, window, cx)),
                        ),
                );
            }
        }
        column
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.backend.read(cx).value().clone();
        let connection = self.connection.read(cx).value().clone();
        let page = self.page;
        let session = self.session.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(GROUND))
            .text_color(rgb(TEXT))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_row()
                    .child(self.sidebar(cx))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .px(px(24.))
                            .gap(px(8.))
                            .child(
                                div()
                                    .text_size(px(20.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(page.label()),
                            )
                            .map(|content| {
                                if page == PageId::Studio {
                                    content.child(session)
                                } else {
                                    content.child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(rgb(MUTED))
                                            .child("This page comes in plan 260's Phase 3."),
                                    )
                                }
                            }),
                    ),
            )
            .child(
                div()
                    .h(px(28.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(rgb(HAIRLINE))
                    .text_size(px(12.))
                    .child(
                        div()
                            .size(px(8.))
                            .rounded(px(4.))
                            .bg(rgb(tone_colour(status.tone))),
                    )
                    .child(status.text)
                    .child(div().text_color(rgb(MUTED)).child(connection)),
            )
    }
}
