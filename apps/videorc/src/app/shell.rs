//! The main window's shell (plan 260 S2.1): the sidebar from the core's
//! navigation model (`videorc_app_core::nav`, Electron's `sidebar-pages.ts`),
//! an empty page for the one chosen, and the status bar with the backend's
//! line. The screens fill the pages in Phase 3; the kit (`videorc-kit`)
//! replaces these plain elements when it lands.

use crate::screens::settings::{Navigate, SettingsScreen};
use gpui::{Context, Entity, Focusable, Window, div, prelude::*, px};
use videorc_app_core::nav::{self, PageId, ZONES};
use videorc_app_core::{BackendState, ConnectionState, Tone};
use videorc_kit::{
    shortcut_keys::ShortcutKeys,
    theme::{self, FONT, TypeScale, hsla},
    tokens::{Theme, radius, size, text},
};

use super::bridge::Mirror;
use crate::preview::Preview;
use crate::screens::sources::SourcesPanel;
use crate::screens::studio::{StudioPage, transport::OpenPage};

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

fn tone_colour(tone: Tone, t: &Theme) -> u32 {
    match tone {
        Tone::Ready => t.success,
        Tone::Busy => t.warning,
        Tone::Failed => t.destructive,
        Tone::Stopped => t.muted_foreground,
    }
}

pub struct Shell {
    page: PageId,
    backend: Entity<Mirror<StatusLine>>,
    connection: Entity<Mirror<String>>,
    /// The Studio page (plan 260 Phase 3): the preview, the transport and
    /// the session inspector.
    studio: Entity<StudioPage>,
    /// The preview (plan 260 S2.3a, L1): its slot is the Studio page's.
    preview: Entity<Preview>,
    /// Phase 3: Sources ⌘2.
    sources: Entity<SourcesPanel>,
    settings: Entity<SettingsScreen>,
}

impl Shell {
    pub fn new(
        backend: Entity<Mirror<StatusLine>>,
        connection: Entity<Mirror<String>>,
        studio: Entity<StudioPage>,
        preview: Entity<Preview>,
        sources: Entity<SourcesPanel>,
        settings: Entity<SettingsScreen>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&backend, |_, _, cx| cx.notify()).detach();
        cx.observe(&connection, |_, _, cx| cx.notify()).detach();
        // The preview notifies only when its slot's words or its window
        // change, never per video frame.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        cx.observe(&sources, |_, _, cx| cx.notify()).detach();
        // The Studio's jumps ("Open Destinations", a Session row) open that page.
        cx.subscribe_in(&studio, |this, _, open: &OpenPage, window, cx| {
            this.open_page(open.0, window, cx)
        })
        .detach();
        cx.subscribe(&settings, |this, _, Navigate(page), cx| {
            this.page = *page;
            this.preview.update(cx, |preview, _| {
                preview.set_docked_shown(*page == PageId::Studio)
            });
            cx.notify();
        })
        .detach();
        Self {
            page: PageId::Studio,
            backend,
            connection,
            studio,
            preview,
            sources,
            settings,
        }
    }

    pub fn open_settings(
        &mut self,
        tab: Option<videorc_app_core::settings_page::SettingsTab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.settings.update(cx, |settings, cx| {
            if let Some(tab) = tab {
                settings.select(tab, cx);
            } else {
                settings.refresh(cx);
            }
        });
        self.open_page(PageId::Settings, window, cx);
        window.activate_window();
    }

    pub fn page(&self) -> PageId {
        self.page
    }

    pub fn open_page(&mut self, page: PageId, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != page {
            self.settings
                .update(cx, |settings, cx| settings.disarm_shortcut(cx));
            self.page = page;
            if page == PageId::Settings {
                self.settings
                    .update(cx, |settings, cx| settings.refresh(cx));
            }
            window.set_window_title(&nav::window_title(page));
            // A docked slot that is not on screen presents nothing.
            self.preview.update(cx, |preview, _| {
                preview.set_docked_shown(page == PageId::Studio)
            });
            // Space records only while the Studio page holds focus.
            if page == PageId::Studio {
                let focus = self.studio.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
            }
            cx.notify();
        }
    }

    fn sidebar(&self, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let mut column = div()
            .w(px(220.))
            .h_full()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(8.))
            .pt(px(40.))
            .bg(hsla(t.glass_solid))
            .border_r_1()
            .border_color(hsla(t.border));
        for (group, pages) in ZONES {
            if let Some(label) = group.label() {
                column = column.child(
                    div()
                        .pt(px(10.))
                        .pb(px(4.))
                        .px(px(8.))
                        .type_scale(text::LABEL)
                        .text_color(hsla(t.muted_foreground))
                        .child(label),
                );
            }
            for &page in pages {
                let selected = page == self.page;
                let shortcut = page
                    .key()
                    .and_then(super::menus::page_action)
                    .map(|action| ShortcutKeys::for_action(action.as_ref()));
                column =
                    column.child(
                        div()
                            .id(page.id())
                            .flex()
                            .justify_between()
                            .items_center()
                            .px(px(8.))
                            .py(px(5.))
                            .rounded(px(radius::ROW))
                            .type_scale(text::SECTION)
                            .text_color(hsla(t.foreground))
                            .when(selected, |row| row.bg(hsla(t.accent)))
                            .cursor_pointer()
                            .child(page.label())
                            .children(shortcut)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_page(page, window, cx)
                            })),
                    );
            }
        }
        column
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        window.set_window_title(&nav::window_title(self.page));
        let status = self.backend.read(cx).value().clone();
        let connection = self.connection.read(cx).value().clone();
        let page = self.page;
        let sources = self.sources.clone();
        div()
            .size_full()
            .font_family(FONT)
            .flex()
            .flex_col()
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .flex_row()
                    .child(self.sidebar(t, cx))
                    .child(if page == PageId::Studio {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(self.studio.clone())
                    } else if page == PageId::Sources {
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .px(px(24.))
                            .gap(px(8.))
                            .child(div().type_scale(text::SECTION).child(page.label()))
                            .child(sources)
                    } else {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .px(px(24.))
                            .gap(px(8.))
                            .child(div().type_scale(text::SECTION).child(page.label()))
                            .map(|body| {
                                if page == PageId::Settings {
                                    body.child(self.settings.clone())
                                } else {
                                    body.child(
                                        div()
                                            .type_scale(text::META)
                                            .text_color(hsla(t.muted_foreground))
                                            .child("This page comes in plan 260's Phase 3."),
                                    )
                                }
                            })
                    }),
            )
            .child(
                div()
                    .h(px(size::STATUS_BAR))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(hsla(t.border))
                    .type_scale(text::META)
                    .child(
                        div()
                            .size(px(8.))
                            .rounded_full()
                            .bg(hsla(tone_colour(status.tone, t))),
                    )
                    .child(status.text)
                    .child(div().text_color(hsla(t.muted_foreground)).child(connection)),
            )
    }
}
