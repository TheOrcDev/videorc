//! The main window's shell (plan 260 S2.1): the sidebar from the core's
//! navigation model (`videorc_app_core::nav`, Electron's `sidebar-pages.ts`),
//! an empty page for the one chosen, and the status bar with the backend's
//! line. The screens fill the pages in Phase 3; the kit (`videorc-kit`)
//! replaces these plain elements when it lands.

use crate::screens::avatar::{AvatarScreen, OpenPage as AvatarOpenPage, OpenSidekickTab};
use crate::screens::command_palette::{Command, CommandPalette};
use crate::screens::dialogs::{DialogsHost, OpenPage as DialogOpenPage};
use crate::screens::error_panels::ErrorPanels;
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
use crate::screens::captions::page::{CaptionsPanel, OpenPage as CaptionsOpenPage};
use crate::screens::destinations::DestinationsPanel;
use crate::screens::first_run::{FirstRunScreen, OpenPage as FirstRunOpenPage};
use crate::screens::go_live::GoLiveDialog;
use crate::screens::guests::GuestsPanel;
use crate::screens::images_sounds::{ImagesPanel, SoundsPanel};
use crate::screens::output::OutputPanel;
use crate::screens::scene::{SceneNavigate, ScenePage};
use crate::screens::settings::OpenSetup;
use crate::screens::sidekick::SidekickScreen;
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
    /// Phase 3: Captions ⌘4 (L2), built with its feed by
    /// `screens::captions::install`.
    captions: Option<Entity<CaptionsPanel>>,
    /// Phase 3: Destinations ⌘6.
    destinations: Entity<DestinationsPanel>,
    /// Phase 3: Guests ⌘7.
    guests: Entity<GuestsPanel>,
    /// Phase 3: Avatar ⌘8.
    avatar: Entity<AvatarScreen>,
    /// Phase 3: Sidekick ⌘9.
    sidekick: Entity<SidekickScreen>,
    /// Phase 3: Images ⇧⌘G.
    images: Entity<ImagesPanel>,
    /// Phase 3: Sounds ⇧⌘S.
    sounds: Entity<SoundsPanel>,
    /// Phase 3: Go Live confirmation (over any page).
    go_live: Entity<GoLiveDialog>,
    /// Phase 3: First-run / "Run setup again…" full-window overlay.
    first_run: Entity<FirstRunScreen>,
    settings: Entity<SettingsScreen>,
    health: Entity<crate::screens::health::HealthScreen>,
    library: Entity<crate::screens::library::LibraryScreen>,
    palette: Entity<CommandPalette>,
    /// Shell dialogs (End livestream, Confirm, start-blocked). Go Live is Destinations'.
    dialogs: Entity<DialogsHost>,
    /// Root / page crash panels (P1445–P1446).
    errors: Entity<ErrorPanels>,
    notices: Entity<Centre>,
    notice_hub: Entity<Hub>,
    /// Phase 3 (L1): Scene ⌘3.
    scene: Entity<ScenePage>,
}

impl Shell {
    pub fn new(
        backend: Entity<Mirror<StatusLine>>,
        connection: Entity<Mirror<String>>,
        studio: Entity<StudioPage>,
        preview: Entity<Preview>,
        sources: Entity<SourcesPanel>,
        output: Entity<OutputPanel>,
        destinations: Entity<DestinationsPanel>,
        guests: Entity<GuestsPanel>,
        avatar: Entity<AvatarScreen>,
        sidekick: Entity<SidekickScreen>,
        images: Entity<ImagesPanel>,
        sounds: Entity<SoundsPanel>,
        go_live: Entity<GoLiveDialog>,
        first_run: Entity<FirstRunScreen>,
        settings: Entity<SettingsScreen>,
        health: Entity<crate::screens::health::HealthScreen>,
        library: Entity<crate::screens::library::LibraryScreen>,
        palette: Entity<CommandPalette>,
        dialogs: Entity<DialogsHost>,
        notice_hub: Entity<Hub>,
        scene: Entity<ScenePage>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let notices = cx.new(|cx| Centre::new(notice_hub.clone(), "main", window, cx));
        let errors = cx.new(ErrorPanels::new);
        cx.observe(&errors, |_, _, cx| cx.notify()).detach();
        palette.update(cx, |palette, _| palette.set_notifications_available());
        let captions = crate::screens::captions::page(cx);
        if let Some(captions) = &captions {
            cx.observe(captions, |_, _, cx| cx.notify()).detach();
            cx.subscribe_in(
                captions,
                window,
                |this, _, open: &CaptionsOpenPage, window, cx| this.open_page(open.0, window, cx),
            )
            .detach();
        }
        cx.subscribe_in(
            &dialogs,
            window,
            |this, _, open: &DialogOpenPage, window, cx| {
                this.open_page(open.0, window, cx);
                window.activate_window();
            },
        )
        .detach();
        cx.subscribe_in(
            &notice_hub,
            window,
            |this, _, navigation: &NoticeNavigate, window, cx| match navigation {
                NoticeNavigate::Settings(tab) => this.open_settings(Some(*tab), window, cx),
                NoticeNavigate::Action(NoticeAction::OpenLibrary { session_id }) => {
                    this.open_page(PageId::Library, window, cx);
                    this.library.update(cx, |library, cx| {
                        library.focus_session(session_id.as_deref(), window, cx)
                    });
                    window.activate_window();
                }
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
        cx.subscribe_in(
            &library,
            window,
            |this, _, navigation: &crate::screens::library::Navigate, window, cx| {
                this.open_page(navigation.0, window, cx)
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
        cx.observe(&destinations, |_, _, cx| cx.notify()).detach();
        cx.observe(&guests, |_, _, cx| cx.notify()).detach();
        cx.observe(&avatar, |_, _, cx| cx.notify()).detach();
        cx.subscribe_in(
            &avatar,
            window,
            |this, _, open: &AvatarOpenPage, window, cx| this.open_page(open.0, window, cx),
        )
        .detach();
        cx.subscribe_in(
            &avatar,
            window,
            |this, _, open: &OpenSidekickTab, window, cx| {
                let tab = open.0;
                this.sidekick
                    .update(cx, |sidekick, cx| sidekick.select_tab(tab, cx));
                this.open_page(PageId::Ai, window, cx);
            },
        )
        .detach();
        cx.observe(&sidekick, |_, _, cx| cx.notify()).detach();
        cx.observe(&images, |_, _, cx| cx.notify()).detach();
        cx.observe(&sounds, |_, _, cx| cx.notify()).detach();
        cx.observe(&go_live, |_, _, cx| cx.notify()).detach();
        cx.observe(&first_run, |_, _, cx| cx.notify()).detach();
        cx.subscribe_in(
            &scene,
            window,
            |this, _, to: &SceneNavigate, window, cx| match to {
                SceneNavigate::Page(page) => this.open_page(*page, window, cx),
                SceneNavigate::Settings(tab) => this.open_settings(Some(*tab), window, cx),
            },
        )
        .detach();
        // Both routes use the same lifecycle, title and focus updates.
        cx.subscribe_in(&studio, window, |this, _, open: &OpenPage, window, cx| {
            if let Some(tab) = open.settings_tab {
                this.open_settings(Some(tab), window, cx);
            } else {
                this.open_page(open.page, window, cx);
            }
        })
        .detach();
        cx.subscribe_in(&settings, window, |this, _, Navigate(page), window, cx| {
            this.open_page(*page, window, cx);
        })
        .detach();
        cx.subscribe_in(&settings, window, |this, _, _: &OpenSetup, _, cx| {
            let return_to = this.page;
            this.first_run
                .update(cx, |setup, cx| setup.open_replay(return_to, cx));
        })
        .detach();
        cx.subscribe_in(
            &first_run,
            window,
            |this, _, open: &FirstRunOpenPage, window, cx| {
                this.open_page(open.0, window, cx);
            },
        )
        .detach();
        cx.subscribe_in(
            &palette,
            window,
            |this, _, command: &Command, window, cx| match command {
                Command::Notifications => this.notices.update(cx, |centre, cx| centre.toggle(cx)),
                Command::Page(page) => this.open_page(*page, window, cx),
                Command::Settings(tab) => this.open_settings(Some(*tab), window, cx),
                Command::Setup => {
                    let return_to = this.page;
                    this.first_run
                        .update(cx, |setup, cx| setup.open_replay(return_to, cx));
                }
                // Open/Close Preview (macOS only, as the row is).
                #[cfg(target_os = "macos")]
                Command::Preview => this
                    .preview
                    .update(cx, |preview, cx| preview.toggle_open(cx)),
                #[cfg(not(target_os = "macos"))]
                Command::Preview => this
                    .preview
                    .update(cx, |preview, cx| preview.toggle_floating(cx)),
                Command::StreamManager => {
                    window.dispatch_action(Box::new(super::menus::ToggleStreamManager), cx)
                }
                Command::Notes => window.dispatch_action(Box::new(super::menus::ToggleNotes), cx),
                Command::CaptionsReader => {
                    window.dispatch_action(Box::new(super::menus::ToggleCaptions), cx)
                }
                // P283: Studio is the home of scenes; its Scenes section
                // opens the picker.
                Command::AddScene => {
                    this.open_page(PageId::Studio, window, cx);
                    this.studio
                        .update(cx, |studio, cx| studio.open_add_scene(window, cx));
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
            captions,
            destinations,
            guests,
            avatar,
            sidekick,
            images,
            sounds,
            go_live,
            first_run,
            settings,
            health,
            library,
            palette,
            dialogs,
            errors,
            notices,
            notice_hub,
            scene,
        }
    }

    pub fn dialogs(&self) -> Entity<DialogsHost> {
        self.dialogs.clone()
    }

    pub fn errors(&self) -> Entity<ErrorPanels> {
        self.errors.clone()
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

    /// The smokes' `open-tab` ([`crate::smoke::OpenTab`], the screen
    /// gallery): `page` as its sidebar row opens it, on `sub_tab`, with
    /// `dialog` over it.
    pub fn smoke_open(
        &mut self,
        page: PageId,
        open: crate::smoke::OpenTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        use crate::smoke::SmokeDialog;
        use videorc_app_core::nav::sub_tabs::{AVATAR_TABS, BUDDY_TABS};
        use videorc_app_core::settings_page::SettingsTab;

        self.open_page(page, window, cx);
        if let Some(sub) = open.sub_tab.as_deref() {
            let unknown = || format!("open-tab: {} has no tab {sub:?}.", page.label());
            match page {
                PageId::Settings => {
                    let tab = SettingsTab::parse(sub).ok_or_else(unknown)?;
                    self.settings
                        .update(cx, |settings, cx| settings.select(tab, cx));
                }
                PageId::Ai => {
                    let index = BUDDY_TABS
                        .iter()
                        .position(|id| *id == sub)
                        .ok_or_else(unknown)?;
                    self.sidekick
                        .update(cx, |sidekick, cx| sidekick.select_tab(index, cx));
                }
                PageId::Avatar => {
                    let index = AVATAR_TABS
                        .iter()
                        .position(|id| *id == sub)
                        .ok_or_else(unknown)?;
                    self.avatar
                        .update(cx, |avatar, cx| avatar.select_tab(index, cx));
                }
                _ => {
                    return Err(format!(
                        "open-tab: the GPUI app has no sub-tabs on {}.",
                        page.label()
                    ));
                }
            }
        }
        match open.dialog {
            None => {}
            Some(SmokeDialog::GoLive) => self.go_live.read(cx).open(),
            Some(SmokeDialog::Palette) => self.toggle_search(window, cx),
            Some(SmokeDialog::FirstRun { step, goal }) => self
                .first_run
                .update(cx, |first_run, cx| first_run.open_first_run(step, goal, cx)),
        }
        cx.notify();
        Ok(())
    }

    pub fn open_page(&mut self, page: PageId, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != page {
            self.settings
                .update(cx, |settings, cx| settings.disarm_shortcut(cx));
            self.page = page;
            self.library.update(cx, |library, cx| {
                library.set_active(page == PageId::Library, window, cx)
            });
            self.health.update(cx, |health, cx| {
                health.set_active(page == PageId::Diagnostics, cx)
            });
            self.output.update(cx, |output, cx| {
                output.set_active(page == PageId::Recording, cx)
            });
            self.avatar.update(cx, |avatar, cx| {
                avatar.set_active(page == PageId::Avatar, cx)
            });
            if let Some(captions) = &self.captions {
                captions.update(cx, |captions, cx| {
                    captions.set_active(page == PageId::Captions, cx)
                });
            }
            if page == PageId::Library {
                self.library
                    .update(cx, |library, cx| library.focus_session(None, window, cx));
            }
            if page == PageId::Settings {
                self.settings
                    .update(cx, |settings, cx| settings.refresh(cx));
            }
            window.set_window_title(&nav::window_title(page));
            // A docked slot that is not on screen presents nothing. The
            // Scene page's canvas is the other docked slot (X5).
            self.preview.update(cx, |preview, _| {
                preview.set_docked_shown(
                    page == PageId::Studio
                        || (crate::preview::SCENE_HOSTS_DOCKED && page == PageId::Layouts),
                )
            });
            // Space records only while the Studio page holds focus.
            if page == PageId::Studio {
                let focus = self.studio.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
            }
            // P532: the Scene canvas opens a closed Preview docked (one in
            // its own window stays there).
            if crate::preview::SCENE_HOSTS_DOCKED && page == PageId::Layouts {
                self.preview
                    .update(cx, |preview, cx| preview.open_docked_if_closed(cx));
            }
            // ⌘Z undoes a layout change while the Scene page holds focus.
            if page == PageId::Layouts {
                let focus = self.scene.read(cx).focus_handle();
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
        let root_error = self.errors.read(cx).is_root();
        let status = self.backend.read(cx).value().clone();
        let connection = self.connection.read(cx).value().clone();
        let page = self.page;
        let page_error = self.errors.read(cx).is_page();
        if root_error {
            return div()
                .size_full()
                .font_family(FONT)
                .bg(hsla(t.glass_solid))
                .text_color(hsla(t.foreground))
                .child(self.errors.clone());
        }
        let sources = self.sources.clone();
        let output = self.output.clone();
        let captions = self.captions.clone();
        let destinations = self.destinations.clone();
        let guests = self.guests.clone();
        let avatar = self.avatar.clone();
        let sidekick = self.sidekick.clone();
        let images = self.images.clone();
        let sounds = self.sounds.clone();
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
                    .child(if page_error {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(self.errors.clone())
                    } else if page == PageId::Studio {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(self.studio.clone())
                    } else if page == PageId::Layouts {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .gap(px(8.))
                            .child(
                                div()
                                    .px(px(24.))
                                    .type_scale(text::SECTION)
                                    .child(page.label()),
                            )
                            .child(self.scene.clone())
                    } else if page == PageId::Library {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .pt(px(40.))
                            .child(self.library.clone())
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
                    } else if let (PageId::Captions, Some(captions)) = (page, captions) {
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
                            .child(captions)
                    } else if page == PageId::Live {
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
                            .child(destinations)
                    } else if page == PageId::Guests {
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
                            .child(guests)
                    } else if page == PageId::Avatar {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(avatar)
                    } else if page == PageId::Ai {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(sidekick)
                    } else if page == PageId::Assets {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(images)
                    } else if page == PageId::Sounds {
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .pt(px(40.))
                            .child(sounds)
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
                                if page == PageId::Library {
                                    self.library.update(cx, |library, cx| {
                                        library.focus_session(None, window, cx)
                                    });
                                }
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
            .child(self.go_live.clone())
            .child(self.first_run.clone())
            .child(self.dialogs.clone())
            .child(self.notices.read(cx).toasts())
    }
}
