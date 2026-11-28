//! The main window's shell (plan 260 S2.1): the sidebar from the core's
//! navigation model (`videorc_app_core::nav`, Electron's `sidebar-pages.ts`),
//! an empty page for the one chosen, and the status bar with the backend's
//! line. The screens fill the pages in Phase 3; the kit (`videorc-kit`)
//! replaces these plain elements when it lands.

use crate::screens::avatar::{AvatarScreen, OpenPage as AvatarOpenPage, OpenSidekickTab};
use crate::screens::command_palette::{Command, CommandPalette, OpenWindows};
use crate::screens::dialogs::{DialogsHost, OpenPage as DialogOpenPage};
use crate::screens::error_panels::ErrorPanels;
use crate::screens::notifications::{Centre, Hub, Navigate as NoticeNavigate, ToggleNotifications};
use crate::screens::settings::{Navigate, SettingsScreen};
use gpui::{
    ColorSpace, Context, Entity, Focusable, FontWeight, ModifiersChangedEvent, SharedString,
    Window, div, linear_color_stop, linear_gradient, prelude::*, px,
};
use videorc_app_core::nav::{self, PageGroup, PageId, ZONES};
use videorc_app_core::notices::NoticeAction;
use videorc_app_core::studio::transport::{self, StatusTone as SessionTone};
use videorc_app_core::studio::{Connection, StudioSnapshot};
use videorc_app_core::{BackendState, ConnectionState, Tone};
use videorc_kit::{
    button::{Button, ButtonSize, ButtonVariant},
    chrome::{self, Direction},
    icon::{IconName, icon},
    plate_shadows,
    shortcut_keys::ShortcutKeys,
    status_bar::{StatusBar, StatusBarHint},
    status_dot::{StatusDot, StatusTone},
    theme::{self, FONT, TypeScale, hsla, with_alpha},
    tokens::{Theme, radius, size, text},
    tooltip::tooltip,
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
use crate::screens::sidekick::{OpenLibrarySession, SidekickScreen};
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

/// Electron's sidebar / ⌘K page glyphs (`workspace-nav.tsx`,
/// `page-row-icons.tsx`): each `PageId` wears the same Phosphor mark the
/// React twin draws, including `UserSound` for Sidekick.
pub(crate) fn page_icon(page: PageId) -> IconName {
    match page {
        PageId::Studio => IconName::VideoCamera,
        PageId::Sources => IconName::Monitor,
        PageId::Layouts => IconName::SquaresFour,
        PageId::Captions => IconName::ClosedCaptioning,
        PageId::Recording => IconName::Record,
        PageId::Live => IconName::Broadcast,
        PageId::Guests => IconName::UserCircle,
        PageId::Avatar => IconName::Smiley,
        PageId::Ai => IconName::UserSound,
        PageId::Assets => IconName::ImageSquare,
        PageId::Sounds => IconName::SpeakerHigh,
        PageId::Library => IconName::FilmReel,
        PageId::Settings => IconName::GearSix,
        PageId::Diagnostics => IconName::Pulse,
    }
}

/// The status bar's state (`status-bar-session.tsx`): the session's own
/// words ("Ready", "Recording", "On air", "Videorc is reconnecting…"),
/// never the backend's line, and "· Rec" on air while the file is written.
#[derive(Debug, Clone, PartialEq)]
struct SessionWords {
    label: &'static str,
    tone: SessionTone,
    pulse: bool,
    also_records: bool,
}

impl SessionWords {
    fn of(snapshot: &StudioSnapshot) -> Self {
        let (label, tone) = transport::session_status(&snapshot.session, &snapshot.connection);
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        Self {
            label,
            tone,
            pulse: transport::session_status_pulses(&snapshot.session, &snapshot.connection),
            also_records: connected && transport::session_also_records(&snapshot.session),
        }
    }
}

fn session_tone(tone: SessionTone) -> StatusTone {
    match tone {
        SessionTone::Neutral => StatusTone::Neutral,
        SessionTone::Good => StatusTone::Good,
        SessionTone::Live => StatusTone::Live,
        SessionTone::Warn => StatusTone::Warn,
        SessionTone::Error => StatusTone::Error,
    }
}

/// `NavRow` and the Studio slab set their words at `text-sm`: 14/20.
const ROW_TEXT: f32 = 14.;
const ROW_LINE: f32 = 20.;

/// The Studio slab's hover group (the chrome's lift shows over the metal).
const SLAB_GROUP: &str = "sidebar-studio-slab";

/// `chrome-plate` (`styles.css`): the page you're on in the sidebar, a
/// faint top-to-bottom plate with a 1 px highlight and a rim.
fn chrome_plate<E: Styled>(element: E, t: &Theme) -> E {
    element
        .bg(linear_gradient(
            180.,
            linear_color_stop(hsla(t.chrome_plate_top), 0.),
            linear_color_stop(hsla(t.chrome_plate_bottom), 1.),
        )
        .color_space(ColorSpace::Oklab))
        .shadow(plate_shadows(t))
}

/// The pane toolbar (`pane.tsx` `Toolbar`): the page title at 14 px / 600
/// on the window's 40 px header band, a hairline under it. On macOS it
/// shares the band with the traffic lights, which sit over the sidebar.
fn toolbar(title: &'static str, t: &Theme) -> gpui::Div {
    div()
        .flex_none()
        .h(px(size::TOOLBAR))
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(size::GUTTER))
        .border_b_1()
        .border_color(hsla(t.border))
        .child(
            div()
                .min_w(px(0.))
                .truncate()
                .text_size(px(ROW_TEXT))
                .line_height(px(ROW_LINE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hsla(t.foreground))
                .child(title),
        )
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
    /// Phase 3: Avatar ⌘7/⌘8.
    avatar: Entity<AvatarScreen>,
    /// Phase 3: Sidekick ⌘8/⌘9.
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
    /// S1.6f (L4): the Videorc account, for the sidebar's account row.
    account: Option<Entity<Mirror<videorc_app_core::accounts::AccountsState>>>,
    /// P025: a chat destination waits on the Videorc sign-in.
    chat_waits: Option<Entity<Mirror<bool>>>,
    /// P017: sidebar shortcut chips while ⌘ / Ctrl is held.
    command_held: bool,
    /// The status bar's state: the session's own words.
    session: Option<Entity<Mirror<SessionWords>>>,
    /// `guestsVisible`: the Guests row shows with talk shows or a room
    /// that isn't closed (L2, plan 224 D16).
    guests_visible: Option<Entity<Mirror<bool>>>,
}

impl Shell {
    #[allow(
        clippy::too_many_arguments,
        reason = "Explicit screen assembly inputs keep independent view state and callbacks visible"
    )]
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
        let account_store = cx
            .try_global::<super::accounts::Shared>()
            .map(|shared| shared.accounts.watch());
        let account = account_store.map(|store| {
            super::bridge::mirror(
                cx,
                store,
                |state: &videorc_app_core::accounts::AccountsState| state.clone(),
            )
        });
        if let Some(account) = &account {
            cx.observe(account, |_, _, cx| cx.notify()).detach();
        }
        let chat_store = cx
            .try_global::<super::accounts::Shared>()
            .map(|shared| shared.studio.live_chat());
        let chat_waits = chat_store.map(|store| {
            super::bridge::mirror(cx, store, |chat: &videorc_app_core::chat::LiveChat| {
                videorc_app_core::accounts::chat_waits_on_sign_in(&chat.providers)
            })
        });
        if let Some(chat_waits) = &chat_waits {
            cx.observe(chat_waits, |_, _, cx| cx.notify()).detach();
        }
        let session_store = cx
            .try_global::<super::accounts::Shared>()
            .map(|shared| shared.studio.watch());
        let session = session_store.map(|store| super::bridge::mirror(cx, store, SessionWords::of));
        if let Some(session) = &session {
            cx.observe(session, |_, _, cx| cx.notify()).detach();
        }
        let cloud_store = cx
            .try_global::<super::accounts::Shared>()
            .map(|shared| shared.studio.cloud());
        let guests_visible = cloud_store.map(|store| {
            super::bridge::mirror(
                cx,
                store,
                |cloud: &videorc_app_core::studio::cloud::CloudState| {
                    videorc_app_core::livestream::cloud_status::guests_visible(
                        cloud.status.as_ref(),
                    )
                },
            )
        });
        if let Some(guests_visible) = &guests_visible {
            super::menus::refresh_page_menu(*guests_visible.read(cx).value(), cx);
            cx.observe(guests_visible, |this, visible, cx| {
                super::menus::refresh_page_menu(*visible.read(cx).value(), cx);
                this.settings.update(cx, |_, cx| cx.notify());
                this.palette
                    .update(cx, |palette, cx| palette.refresh_page_shortcuts(cx));
                cx.notify();
            })
            .detach();
        }
        palette.update(cx, |palette, _| palette.set_notifications_available());
        let command_held = false;
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
                NoticeNavigate::StudioAudio => {
                    this.open_studio_audio(window, cx);
                    window.activate_window();
                }
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
                NoticeNavigate::Action(NoticeAction::SignIn) => super::accounts::sign_in(cx),
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
        cx.subscribe_in(
            &library,
            window,
            |this, _, open: &crate::screens::library::OpenSidekickReport, window, cx| {
                this.sidekick
                    .update(cx, |sidekick, cx| sidekick.open_report(&open.0, cx));
                this.open_page(PageId::Ai, window, cx);
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
        cx.subscribe_in(
            &sidekick,
            window,
            |this, _, open: &OpenLibrarySession, window, cx| {
                this.open_page(PageId::Library, window, cx);
                this.library.update(cx, |library, cx| {
                    library.focus_session(Some(open.0.as_str()), window, cx)
                });
            },
        )
        .detach();
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
            } else if open.scene_background {
                this.open_scene_background(window, cx);
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
                // Open/Close Preview: closes where it is, opens where it was
                // (every platform keeps the closed state, P541).
                Command::Preview => this
                    .preview
                    .update(cx, |preview, cx| preview.toggle_open(cx)),
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
                Command::SceneBackground => this.open_scene_background(window, cx),
                // ⌘K's Avatar and Sidekick tabs: the page, on that tab.
                Command::AvatarTab(index) => {
                    let index = *index;
                    this.open_page(PageId::Avatar, window, cx);
                    this.avatar
                        .update(cx, |avatar, cx| avatar.select_tab(index, cx));
                }
                Command::SidekickTab(index) => {
                    let index = *index;
                    this.open_page(PageId::Ai, window, cx);
                    this.sidekick
                        .update(cx, |sidekick, cx| sidekick.select_tab(index, cx));
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
            account,
            chat_waits,
            command_held,
            session,
            guests_visible,
        }
    }

    /// The Stream Manager's "Use Sign in" (P962): Destinations → Setup with
    /// that destination open, in this window.
    pub fn open_destination(
        &mut self,
        target_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_page(PageId::Live, window, cx);
        let target = target_id.to_string();
        self.destinations.update(cx, |destinations, cx| {
            destinations.open_destination(target, cx)
        });
        window.activate_window();
    }

    pub fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings
            .update(cx, |settings, cx| settings.disarm_shortcut(cx));
        // The Windows rows say Open or Close by what is open now.
        let windows = OpenWindows {
            preview: !self.preview.read(cx).is_closed(),
            notes: crate::screens::notes::window::handle(cx).is_some(),
            stream_manager: crate::screens::stream_manager::window::handle(cx).is_some(),
        };
        self.palette
            .update(cx, |palette, _| palette.set_open_windows(windows));
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

    /// `first-run-state` ([`FirstRunScreen::smoke_state`]).
    pub(crate) fn smoke_first_run_state(
        &self,
        window: &Window,
        cx: &gpui::App,
    ) -> serde_json::Value {
        self.first_run.read(cx).smoke_state(window, cx)
    }

    pub(crate) fn smoke_notifications(&self, cx: &gpui::App) -> serde_json::Value {
        self.notices.read(cx).smoke_snapshot(cx)
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

    /// P575: Scene opens on the camera, its Background in view and the pick
    /// focused (⌘K's Background settings, the Studio popover's Settings).
    fn open_scene_background(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_page(PageId::Layouts, window, cx);
        self.scene
            .update(cx, |scene, cx| scene.reveal_background(window, cx));
    }

    /// P283: Sources' Open Scenes, the Studio with its Scenes section in
    /// view (`scene-presets.tsx:98-105`).
    pub fn open_studio_scenes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_page(PageId::Studio, window, cx);
        self.studio
            .update(cx, |studio, cx| studio.reveal_scenes(cx));
    }

    /// P172 / P180: the bell's Open Audio, the Studio with its Microphone
    /// strip focused and in view (the session's own door, `FocusAudio`).
    pub fn open_studio_audio(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_page(PageId::Studio, window, cx);
        self.studio
            .update(cx, |studio, cx| studio.reveal_audio(window, cx));
    }

    /// `scene-stage-state`: the Scene page's canvas editor as its next render
    /// shows it ([`crate::screens::scene::ScenePage::smoke_stage_state`]).
    pub fn smoke_scene_stage(&mut self, cx: &mut Context<Self>) -> serde_json::Value {
        self.scene.update(cx, |scene, cx| scene.smoke_stage_state(cx))
    }

    /// `scene-stage-select`: the Scene page's chip for `stage_id`, clicked.
    pub fn smoke_scene_select(
        &mut self,
        stage_id: &str,
        cx: &mut Context<Self>,
    ) -> Result<serde_json::Value, String> {
        self.scene
            .update(cx, |scene, cx| scene.smoke_select_stage(stage_id, cx))
    }

    /// Gallery Vertical stream: Studio with the bottom-row Vertical stream
    /// panel scrolled into view (after `gallery-seed-vertical-stream`).
    pub fn reveal_studio_vertical_stream(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_page(PageId::Studio, window, cx);
        self.studio.update(cx, |studio, cx| {
            studio.reveal_section(
                crate::screens::studio::layout::StudioSection::VerticalStream,
                cx,
            )
        });
    }

    pub fn open_page(&mut self, page: PageId, window: &mut Window, cx: &mut Context<Self>) {
        // P017: a fired page shortcut closes the reminder layer.
        if self.command_held {
            self.command_held = false;
        }
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
            // Clean cut's review plays in a native layer: it stops off the page.
            self.sidekick.update(cx, |sidekick, cx| {
                sidekick.set_page_shown(page == PageId::Ai, cx)
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
                let scene_docked = preview.scene_hosts_docked() && page == PageId::Layouts;
                preview.set_docked_shown(page == PageId::Studio || scene_docked);
                // The Scene editor's chrome stays on the Scene page.
                if page != PageId::Layouts {
                    preview.set_stage_chrome(None);
                }
            });
            // Space records only while the Studio page holds focus.
            if page == PageId::Studio {
                let focus = self.studio.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
            }
            // P532: the Scene canvas opens a closed Preview docked (one in
            // its own window stays there).
            if page == PageId::Layouts && self.preview.read(cx).scene_hosts_docked() {
                self.preview
                    .update(cx, |preview, cx| preview.open_docked_if_closed(cx));
            }
            // ⌘Z undoes a layout change while the Scene page holds focus.
            if page == PageId::Layouts {
                let focus = self.scene.read(cx).focus_handle();
                window.focus(&focus, cx);
                self.scene.update(cx, |scene, cx| scene.entered(cx));
            }
            cx.notify();
        }
    }

    /// One page row (`sidebar.tsx` `NavRow`): 28 px, 14 px words in the
    /// secondary tier; the page you're on wears the chrome plate at 500 with
    /// its icon in the primary ink, and hover is the flat sidebar block.
    /// `guestsVisible`, failing closed before the cloud has answered.
    pub fn guests_shown(&self, cx: &gpui::App) -> bool {
        self.guests_visible
            .as_ref()
            .is_some_and(|visible| *visible.read(cx).value())
    }

    fn nav_row(&self, page: PageId, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = page == self.page;
        let ink = if selected {
            t.sidebar_accent_foreground
        } else {
            t.muted_foreground
        };
        let icon_ink = if selected { t.primary } else { ink };
        let hover_bg = hsla(with_alpha(t.sidebar_accent, 0.6));
        let hover_ink = hsla(t.sidebar_foreground);
        // P017: chips stay mounted (width reserved) and fade in while
        // ⌘/Ctrl is held; aria-hidden — the row's click is enough.
        let shortcut = page
            .key(self.guests_shown(cx))
            .and_then(super::menus::page_action)
            .map(|action| {
                div()
                    .flex_none()
                    .opacity(if self.command_held { 1. } else { 0. })
                    .child(ShortcutKeys::for_action(action.as_ref()))
            });
        // A named button node, so the tree (and the UI driver) can find
        // and click the page row.
        let row = div()
            .id(page.id())
            .role(gpui::Role::Button)
            .aria_label(page.label())
            .flex_none()
            .h(px(size::ROW_COMPACT))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .rounded(px(radius::ROW))
            .text_size(px(ROW_TEXT))
            .line_height(px(ROW_LINE))
            .font_weight(if selected {
                FontWeight::MEDIUM
            } else {
                FontWeight::NORMAL
            })
            .text_color(hsla(ink))
            .cursor_pointer();
        let row = if selected {
            chrome_plate(row, t)
        } else {
            row.hover(move |style| style.bg(hover_bg).text_color(hover_ink))
        };
        // The page you're on wears the fill weight (`sidebar.tsx:76-79`).
        let glyph = if selected {
            page_icon(page).filled()
        } else {
            page_icon(page)
        };
        row.child(icon(glyph, 16., hsla(icon_ink)))
            .child(div().flex_1().min_w(px(0.)).truncate().child(page.label()))
            .children(shortcut)
            .on_click(cx.listener(move |this, _, window, cx| this.open_page(page, window, cx)))
    }

    /// The Studio row (`sidebar.tsx` `StudioNavButton`, plan 235 D5): the
    /// way home, a 40 px slab of the chrome primary's metal (`chrome-fill`:
    /// polished silver in dark, black chrome in light) on every page. Its
    /// shortcut chip takes the slab's ink.
    fn studio_slab(&self, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let ink = hsla(t.chrome_fill_ink);
        // Filled while the Studio is open (`sidebar.tsx:140`).
        let slab_glyph = if self.page == PageId::Studio {
            page_icon(PageId::Studio).filled()
        } else {
            page_icon(PageId::Studio)
        };
        let shortcut = PageId::Studio
            .key(self.guests_shown(cx))
            .and_then(super::menus::page_action)
            .map(|action| {
                div()
                    .flex_none()
                    .opacity(if self.command_held { 1. } else { 0. })
                    .child(ShortcutKeys::for_action(action.as_ref()).on_filled(t.chrome_fill_ink))
            });
        div()
            .id("sidebar-studio-slab")
            .role(gpui::Role::Button)
            .aria_label(PageId::Studio.label())
            .group(SLAB_GROUP)
            .relative()
            .flex_none()
            .h(px(40.))
            .rounded(px(radius::ROW))
            .bg(hsla(t.chrome_fill_flat))
            .shadow(chrome::shadows(t.chrome_fill_shadow))
            .text_color(ink)
            .cursor_pointer()
            .child(chrome::metal(
                t.chrome_fill_stops,
                [radius::ROW; 4],
                Direction::Down,
            ))
            .child(
                chrome::layer(t.chrome_fill_lift, radius::ROW)
                    .invisible()
                    .group_hover(SLAB_GROUP, |style| style.visible()),
            )
            .child(
                div()
                    .relative()
                    .size_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(10.))
                    .text_size(px(ROW_TEXT))
                    .line_height(px(ROW_LINE))
                    .font_weight(FontWeight::MEDIUM)
                    .child(icon(slab_glyph, 20., ink))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .truncate()
                            .child(PageId::Studio.label()),
                    )
                    .children(shortcut),
            )
            .on_click(cx.listener(|this, _, window, cx| this.open_page(PageId::Studio, window, cx)))
    }

    fn sidebar(&self, t: &Theme, _window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The top row shares the window's 40 px header band with the
        // traffic lights: Search sits at its end (`sidebar.tsx`).
        let top = div()
            .flex_none()
            .h(px(size::TOOLBAR))
            .flex()
            .items_center()
            .justify_end()
            .pr(px(8.))
            .child(
                Button::new("sidebar-search")
                    .size(ButtonSize::Icon)
                    .variant(ButtonVariant::Ghost)
                    .accessibility_label("Search")
                    .tooltip_with_action("Search", &super::menus::ToggleSearch)
                    .child(icon(
                        IconName::MagnifyingGlass,
                        16.,
                        hsla(t.muted_foreground),
                    ))
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_search(window, cx))),
            );
        // The zones (plan 174 D8, plan 235): the Studio slab leads, then the
        // labelled groups 16 px apart; Library and Settings sit in a bottom
        // block above the footer (owner 2026-11-20). The footer below runs
        // the sidebar's full width, so its rule meets both edges.
        let mut nav = div()
            .id("sidebar-nav")
            .flex_1()
            .min_h(px(0.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(16.))
            .px(px(12.))
            .pt(px(4.))
            .pb(px(8.));
        for (group, pages) in ZONES {
            if group == PageGroup::Stage {
                nav = nav.child(self.studio_slab(t, cx));
                continue;
            }
            let mut zone = div().flex().flex_col().gap(px(2.));
            if group == PageGroup::System {
                zone = zone.mt_auto();
            }
            if let Some(label) = group.label() {
                // `SectionLabel` at `leading-none`, 10 px in from the rows.
                zone = zone.child(
                    div()
                        .px(px(10.))
                        .pb(px(4.))
                        .text_size(px(text::LABEL.size))
                        .line_height(px(text::LABEL.size))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(t.subtle))
                        .child(label),
                );
            }
            for &page in pages {
                // `GuestsNavGate`: the row only while Guests is available.
                if page == PageId::Guests && !self.guests_shown(cx) {
                    continue;
                }
                zone = zone.child(self.nav_row(page, t, cx));
            }
            nav = nav.child(zone);
        }
        // The theme toggle (P022) and the account row (P024), under the
        // update chip (P021).
        // The look the app draws now (its own choice first, as Linux needs).
        let dark = videorc_kit::theme::is_dark(t);
        let update_chip = super::update_chip::chip(cx.entity().downgrade(), t, cx);
        let footer = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .min_h(px(44.))
            .border_t_1()
            .border_color(hsla(t.border))
            .px(px(12.))
            .py(px(6.))
            .child(
                // A flex row, so the trigger keeps its own width and sits at
                // the start: a block wrapper stretched it and the button
                // centred "Sign in" in the whole row.
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .flex()
                    .items_center()
                    .justify_start()
                    .children(self.account.as_ref().map(|account| {
                        let state = account.read(cx).value();
                        let needs_sign_in = videorc_app_core::accounts::needs_sign_in(
                            &state.account,
                            self.chat_waits
                                .as_ref()
                                .is_some_and(|waits| *waits.read(cx).value()),
                            self.sidekick.read(cx).cohost_reason(),
                        );
                        let status = self.backend.read(cx).value();
                        // Electron's account menu (`app-shell.tsx`) shows the
                        // session's words on Health, as the status bar does
                        // ("Ready"), not the supervisor's backend line.
                        let words = self
                            .session
                            .as_ref()
                            .map(|session| session.read(cx).value().clone());
                        let (tone, label, pulse) = match words {
                            Some(words) => (
                                session_tone(words.tone),
                                words.label.to_string(),
                                words.pulse,
                            ),
                            None => (
                                status_tone(status.tone),
                                status.text.clone(),
                                matches!(status.tone, Tone::Busy),
                            ),
                        };
                        super::account_menu::row(
                            state,
                            needs_sign_in,
                            tone,
                            label,
                            pulse,
                            cx.entity().downgrade(),
                            t,
                        )
                    })),
            )
            .child(
                Button::new("sidebar-theme-toggle")
                    .size(ButtonSize::Icon)
                    .variant(ButtonVariant::Ghost)
                    .accessibility_label("Toggle color theme")
                    .tooltip_with_action(
                        if dark {
                            "Switch to light theme"
                        } else {
                            "Switch to dark theme"
                        },
                        &super::menus::ToggleTheme,
                    )
                    // `theme-toggle.tsx:46-48`: the moon in dark, the sun in
                    // light, both at the fill weight.
                    .child(icon(
                        if dark {
                            IconName::MoonFill
                        } else {
                            IconName::SunFill
                        },
                        16.,
                        hsla(t.foreground),
                    ))
                    .on_click(cx.listener(|this, _, window, cx| this.toggle_theme(window, cx))),
            );
        // `w-52`: 208 px.
        div()
            .w(px(208.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(hsla(t.glass_solid))
            .border_r_1()
            .border_color(hsla(t.border))
            .child(top)
            .child(nav)
            .children(update_chip)
            .child(footer)
    }

    /// The page in its pane (`app-shell.tsx`: `<Pane>`, the `Toolbar` with
    /// `workspaceTabLabel`, then `PaneBody`). The band is 40 px on every
    /// platform (on macOS it shares the traffic lights' row, which sit over
    /// the sidebar); the body runs flush under it and each page owns its
    /// own gutter. A page crash stays inside the page, under its band.
    fn page_body(&self, page_error: bool, t: &Theme) -> gpui::Div {
        let page = self.page;
        let pane = div().flex_1().min_w(px(0.)).min_h(px(0.)).flex().flex_col();
        // Every page wears the band, the Studio too: Electron's title row
        // names the page ("Studio") over a rule (owner by-eye on the
        // gallery, 11-26; it replaces the 11-25 order that dropped it).
        // `PaneBody`: `relative min-h-0 flex-1`, the page's own column.
        let body = div()
            .relative()
            .flex_1()
            .min_w(px(0.))
            .min_h(px(0.))
            .flex()
            .flex_col();
        let body = if page_error {
            body.child(self.errors.clone())
        } else {
            match page {
                PageId::Studio => body.child(self.studio.clone()),
                PageId::Sources => body.child(self.sources.clone()),
                PageId::Layouts => body.child(self.scene.clone()),
                PageId::Captions => match &self.captions {
                    Some(captions) => body.child(captions.clone()),
                    None => body.child(
                        div()
                            .p(px(size::GUTTER))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child("This page comes in plan 260's Phase 3."),
                    ),
                },
                PageId::Recording => body.child(self.output.clone()),
                PageId::Live => body.child(self.destinations.clone()),
                PageId::Guests => body.child(self.guests.clone()),
                PageId::Avatar => body.child(self.avatar.clone()),
                PageId::Ai => body.child(self.sidekick.clone()),
                PageId::Assets => body.child(self.images.clone()),
                PageId::Sounds => body.child(self.sounds.clone()),
                PageId::Library => body.child(self.library.clone()),
                PageId::Settings => body.child(self.settings.clone()),
                PageId::Diagnostics => body.child(self.health.clone()),
            }
        };
        pane.child(toolbar(page.label(), t)).child(body)
    }

    /// The status bar's state (`status-bar-session.tsx`): the session's dot
    /// and words, "· Rec" on air while it records too, and the door to
    /// Health. Without the core's Studio it reads the connection.
    fn session_state(
        &self,
        status: &StatusLine,
        connection: String,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let words = self
            .session
            .as_ref()
            .map(|session| session.read(cx).value().clone());
        let (label, tone, pulse, also_records): (SharedString, StatusTone, bool, bool) = match words
        {
            Some(words) => (
                words.label.into(),
                session_tone(words.tone),
                words.pulse,
                words.also_records,
            ),
            None => (connection.into(), status_tone(status.tone), false, false),
        };
        let (accent, foreground) = (hsla(t.accent), hsla(t.foreground));
        gpui_base::Button::new("open-health")
            .accessibility_label(label.clone())
            .tooltip(tooltip("Open Health"))
            .min_w(px(0.))
            .h(px(20.))
            .ml(px(-6.))
            .px(px(6.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(radius::CHIP))
            .hover(move |style| style.bg(accent).text_color(foreground))
            .child(
                StatusDot::new("engine-status")
                    .tone(tone)
                    .label(label)
                    .pulse(pulse),
            )
            .when(also_records, |button| {
                button.child(
                    div()
                        .flex_none()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .child(transport::ALSO_RECORDS_LABEL),
                )
            })
            .on_click(
                cx.listener(|this, _, window, cx| this.open_page(PageId::Diagnostics, window, cx)),
            )
    }

    fn toggle_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings
            .update(cx, |settings, cx| settings.toggle_theme(window, cx));
        cx.notify();
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        window.set_window_title(&nav::window_title(self.page));
        let root_error = self.errors.read(cx).is_root();
        let status = self.backend.read(cx).value().clone();
        let connection = self.connection.read(cx).value().clone();
        let page_error = self.errors.read(cx).is_page();
        if root_error {
            return div()
                .size_full()
                .font_family(FONT)
                .bg(hsla(t.glass_solid))
                .text_color(hsla(t.foreground))
                .child(self.errors.clone());
        }
        div()
            .size_full()
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| this.notice_hub.update(cx, |hub, _| hub.pressed())),
            )
            .on_key_down(
                cx.listener(|this, _, _, cx| this.notice_hub.update(cx, |hub, _| hub.pressed())),
            )
            // P017: chips follow the command modifier (⌘ / Ctrl).
            .on_modifiers_changed(cx.listener(|this, event: &ModifiersChangedEvent, _, cx| {
                let held = event.modifiers.secondary(cx);
                if this.command_held != held {
                    this.command_held = held;
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &ToggleNotifications, _, cx| {
                this.notices.update(cx, |centre, cx| centre.toggle(cx))
            }))
            .on_action(
                cx.listener(|this, _: &super::menus::ToggleSearch, window, cx| {
                    this.toggle_search(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &super::menus::ToggleTheme, window, cx| {
                    this.toggle_theme(window, cx)
                }),
            )
            // ⌘C (Edit ▸ Copy) copies the window's text selection, as
            // gpui_base's `Root` does; with none it goes on to the next taker.
            .on_action(|_: &gpui_base::input::Copy, window, cx| {
                let text = gpui_base::TextSelection::selected_text(window, cx)
                    .trim()
                    .to_string();
                if text.is_empty() {
                    cx.propagate();
                    return;
                }
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            })
            .font_family(FONT)
            .flex()
            .flex_col()
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            // The window's text selection (`SelectableText`, P184): one
            // zero-sized layer, the root's first child (gpui_base's rule).
            .child(gpui_base::TextSelectionLayer)
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .flex_row()
                    .child(self.sidebar(t, window, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .min_h(px(0.))
                            .flex()
                            .flex_col()
                            .child(self.page_body(page_error, t))
                            // State on the left, the shell's shortcuts on the right.
                            .child(
                                StatusBar::new()
                                    .leading(self.session_state(&status, connection, t, cx))
                                    .child(
                                        StatusBarHint::new(
                                            "search",
                                            "Search",
                                            ShortcutKeys::for_action(&super::menus::ToggleSearch),
                                        )
                                        .on_click(
                                            cx.listener(|this, _, window, cx| {
                                                this.toggle_search(window, cx)
                                            }),
                                        ),
                                    )
                                    .child({
                                        let preview_open = !self.preview.read(cx).is_closed();
                                        StatusBarHint::new(
                                            "preview",
                                            "Preview",
                                            ShortcutKeys::for_action(&super::menus::TogglePreview),
                                        )
                                        .pressed(preview_open)
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.preview.update(cx, |preview, cx| {
                                                    preview.toggle_open(cx)
                                                });
                                            }),
                                        )
                                    })
                                    .child(
                                        StatusBarHint::new(
                                            "notes",
                                            "Notes",
                                            ShortcutKeys::for_action(&super::menus::ToggleNotes),
                                        )
                                        .pressed(
                                            crate::screens::notes::window::handle(cx).is_some(),
                                        )
                                        .on_click(
                                            cx.listener(|_, _, window, cx| {
                                                window.dispatch_action(
                                                    Box::new(super::menus::ToggleNotes),
                                                    cx,
                                                )
                                            }),
                                        ),
                                    )
                                    .child(
                                        StatusBarHint::new(
                                            "stream-manager",
                                            "Stream Manager",
                                            ShortcutKeys::for_action(
                                                &super::menus::ToggleStreamManager,
                                            ),
                                        )
                                        .pressed(
                                            crate::screens::stream_manager::window::handle(cx)
                                                .is_some(),
                                        )
                                        .on_click(
                                            cx.listener(|_, _, window, cx| {
                                                window.dispatch_action(
                                                    Box::new(super::menus::ToggleStreamManager),
                                                    cx,
                                                )
                                            }),
                                        ),
                                    )
                                    .child(self.notices.clone()),
                            ),
                    ),
            )
            .child(self.palette.clone())
            .child(self.go_live.clone())
            .child(self.first_run.clone())
            .child(self.dialogs.clone())
            .child(self.notices.read(cx).toasts())
    }
}

/// The Stream Manager's "Use Sign in" (P962), from any window: the main
/// window comes up on Destinations → Setup with the destination open.
pub fn open_destination_in_main(target_id: String, cx: &mut gpui::App) {
    let Some(main) = super::exit::ExitGuard::main_window(cx) else {
        return;
    };
    let Some(main) = main.downcast::<Shell>() else {
        return;
    };
    let _ = main.update(cx, |shell, window, cx| {
        shell.open_destination(&target_id, window, cx)
    });
    cx.activate(true);
}
