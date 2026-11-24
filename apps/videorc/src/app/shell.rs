//! The main window's shell (plan 260 S2.1): the sidebar from the core's
//! navigation model (`videorc_app_core::nav`, Electron's `sidebar-pages.ts`),
//! an empty page for the one chosen, and the status bar with the backend's
//! line. The screens fill the pages in Phase 3; the kit (`videorc-kit`)
//! replaces these plain elements when it lands.

use crate::screens::command_palette::{Command, CommandPalette};
use crate::screens::notifications::{Centre, Hub, Navigate as NoticeNavigate, ToggleNotifications};
use crate::screens::settings::{Navigate, SettingsScreen};
use gpui::{Context, Entity, Focusable, Window, div, prelude::*, px};
use videorc_app_core::nav::{self, PageId, ZONES};
use videorc_app_core::notices::NoticeAction;
use videorc_app_core::{BackendState, ConnectionState, Tone};
use videorc_kit::{
    shortcut_keys::ShortcutKeys,
    status_bar::StatusBar,
    status_bar_action::StatusBarAction,
    status_dot::{StatusDot, StatusTone},
    theme::{self, FONT, TypeScale, hsla},
    tokens::{Theme, radius, text},
};

use super::bridge::Mirror;
use crate::preview::Preview;
use crate::screens::output::OutputPanel;
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

fn status_tone(tone: Tone) -> StatusTone {
    match tone {
        Tone::Ready => StatusTone::Good,
        Tone::Busy => StatusTone::Warn,
        Tone::Failed => StatusTone::Error,
        Tone::Stopped => StatusTone::Neutral,
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
    /// Phase 3: Output ⌘5.
    output: Entity<OutputPanel>,
    settings: Entity<SettingsScreen>,
    health: Entity<crate::screens::health::HealthScreen>,
    palette: Entity<CommandPalette>,
    notices: Entity<Centre>,
    notice_hub: Entity<Hub>,
}

impl Shell {
    pub fn new(
        backend: Entity<Mirror<StatusLine>>,
        connection: Entity<Mirror<String>>,
        studio: Entity<StudioPage>,
        preview: Entity<Preview>,
        sources: Entity<SourcesPanel>,
        output: Entity<OutputPanel>,
        settings: Entity<SettingsScreen>,
        health: Entity<crate::screens::health::HealthScreen>,
        palette: Entity<CommandPalette>,
        notice_hub: Entity<Hub>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let notices = cx.new(|cx| Centre::new(notice_hub.clone(), "main", window, cx));
        palette.update(cx, |palette, _| palette.set_notifications_available());
        cx.subscribe_in(
            &notice_hub,
            window,
            |this, _, navigation: &NoticeNavigate, window, cx| match navigation {
                NoticeNavigate::Settings(tab) => this.open_settings(Some(*tab), window, cx),
                NoticeNavigate::Action(NoticeAction::OpenHealth) => {
                    this.open_page(PageId::Diagnostics, window, cx);
                    window.activate_window();
                }
                NoticeNavigate::Action(NoticeAction::OpenPage(page)) => {
                    this.open_page(*page, window, cx);
                    window.activate_window();
                }
                NoticeNavigate::Action(NoticeAction::Copy { text }) => {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.clone()))
                }
                NoticeNavigate::Action(NoticeAction::OpenUrl { url }) => cx.open_url(url),
                _ => {}
            },
        )
        .detach();
        cx.observe(&backend, |_, _, cx| cx.notify()).detach();
        cx.observe(&connection, |_, _, cx| cx.notify()).detach();
        // The preview notifies only when its slot's words or its window
        // change, never per video frame.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        cx.observe(&sources, |_, _, cx| cx.notify()).detach();
        cx.observe(&output, |_, _, cx| cx.notify()).detach();
        // Both routes use the same lifecycle, title and focus updates.
        cx.subscribe_in(&studio, window, |this, _, open: &OpenPage, window, cx| {
            this.open_page(open.0, window, cx);
        })
        .detach();
        cx.subscribe_in(&settings, window, |this, _, Navigate(page), window, cx| {
            this.open_page(*page, window, cx);
        })
        .detach();
        cx.subscribe_in(
            &palette,
            window,
            |this, _, command: &Command, window, cx| match command {
                Command::Notifications => this.notices.update(cx, |centre, cx| centre.toggle(cx)),
                Command::Page(page) => this.open_page(*page, window, cx),
                Command::Settings(tab) => this.open_settings(Some(*tab), window, cx),
                Command::Setup => {
                    this.open_page(PageId::Settings, window, cx);
                    this.settings
                        .update(cx, |settings, cx| settings.open_setup(window, cx));
                }
                Command::Preview => this
                    .preview
                    .update(cx, |preview, cx| preview.toggle_floating(cx)),
                Command::StreamManager => {
                    window.dispatch_action(Box::new(super::menus::ToggleStreamManager), cx)
                }
                _ => {}
            },
        )
        .detach();
        Self {
            page: PageId::Studio,
            backend,
            connection,
            studio,
            preview,
            sources,
            output,
            settings,
            health,
            palette,
            notices,
            notice_hub,
        }
    }

    pub fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings
            .update(cx, |settings, cx| settings.disarm_shortcut(cx));
        self.palette
            .update(cx, |palette, cx| palette.toggle(window, cx));
        window.activate_window();
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
            self.health.update(cx, |health, cx| {
                health.set_active(page == PageId::Diagnostics, cx)
            });
            self.output.update(cx, |output, cx| {
                output.set_active(page == PageId::Recording, cx)
            });
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
        let output = self.output.clone();
        div()
            .size_full()
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| this.notice_hub.update(cx, |hub, _| hub.pressed())),
            )
            .on_key_down(
                cx.listener(|this, _, _, cx| this.notice_hub.update(cx, |hub, _| hub.pressed())),
            )
            .on_action(cx.listener(|this, _: &ToggleNotifications, _, cx| {
                this.notices.update(cx, |centre, cx| centre.toggle(cx))
            }))
            .on_action(
                cx.listener(|this, _: &super::menus::ToggleSearch, window, cx| {
                    this.toggle_search(window, cx)
                }),
            )
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
                    } else if page == PageId::Recording {
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
                            .child(output)
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
                                } else if page == PageId::Diagnostics {
                                    body.child(self.health.clone())
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
                StatusBar::new()
                    .leading(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(StatusDot::new("engine-status").tone(status_tone(status.tone)))
                            .child(
                                StatusBarAction::new("open-health", "Open Health")
                                    .text(status.text)
                                    .tooltip("Open Health", None)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_page(PageId::Diagnostics, window, cx)
                                    })),
                            ),
                    )
                    .child(div().text_color(hsla(t.muted_foreground)).child(connection))
                    .child(
                        videorc_kit::status_bar::StatusBarHint::new(
                            "search",
                            "Search",
                            ShortcutKeys::for_action(&super::menus::ToggleSearch),
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.toggle_search(window, cx)),
                        ),
                    )
                    .child(self.notices.clone()),
            )
            .child(self.palette.clone())
            .child(self.notices.read(cx).toasts())
    }
}
