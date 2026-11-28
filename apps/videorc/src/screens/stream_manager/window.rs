//! The Stream Manager window (`openCommentsWindow`): one window, opened,
//! shown and toggled from the Window menu (⇧⌘J), back at launch when it was
//! open at the last quit, at least 320 × 360, at its saved frame.
//!
//! The view holds the tier layout and the window's keys (⌘J Sidekick, ⌘F
//! search chat, ⌘L write in chat, in the `StreamManager` key context). The
//! header, stats bar, panes and status bar are the kit's (`videorc-kit`).

use std::time::Duration;

use gpui::{
    App, AppContext, Context, FocusHandle, Global, KeyBinding, Subscription, Window, WindowHandle,
    actions, div, prelude::*, px, size,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_app_core::desktop::capture_protection::{
    HideMethod, WindowRole, stream_manager_hide_method,
};
use videorc_app_core::desktop::permissions::PermissionPlatform;
use videorc_app_core::protocol::{Banner, ScreenPrivacy, ScreenPrivacyReason, SoundboardState};
use videorc_app_core::stream_manager::copy::WINDOW_NAME;
use videorc_app_core::stream_manager::dashboard::{LiveDashboard, SessionState};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::studio::families::{self, StatsLayout};
use videorc_app_core::studio::remote::RemoteStreamManager;
use videorc_app_core::studio::remote_app::{HoldAction, stream_manager_hold_action};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle};
use videorc_kit::tabs::Tabs;
use videorc_kit::{
    theme::{self, hsla},
    window,
    window_frame::{WindowFrame, WindowHeader},
};

use super::activity::ActivityPane;
use super::chat::ChatPane;
use super::cohost::{self, SidekickEvent};
use super::frame::{DEFAULT_HEIGHT, DEFAULT_WIDTH, StreamManagerFrame};
use super::layout::{MIN_HEIGHT, MIN_WIDTH, Pane, RightPane, Slot, Tier, right_pane_width, slot};
use super::panes::{PaneKey, Panes, composer_available, key_runs};
use super::sidekick::SidekickPane;
use super::stats::{StatsView, stats_bar};
use super::status::{BannerRow, SoundRow, status_bar};
use crate::app::hide::HideFromStream;
use crate::app::menus::ToggleStreamManager;
use crate::platform;
use crate::screens::stream_manager::SharedStudio;

actions!(stream_manager, [ShowSidekick, SearchChat, WriteInChat]);

pub const KEY_CONTEXT: &str = "StreamManager";
/// `WINDOW_NAMES.streamManager`.
pub const TITLE: &str = WINDOW_NAME;

/// The one window, its frame file, dashboard store, and whether the quit
/// is closing it.
struct Open {
    frame: StreamManagerFrame,
    app_id: &'static str,
    dashboard: watch::Receiver<LiveDashboard>,
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
    window: Option<WindowHandle<StreamManager>>,
    quitting: bool,
    /// Viewers really don't see the open window (the remotes' Hidden
    /// title, `streamManagerHiddenFromViewers`).
    hidden_from_viewers: bool,
    place: RemoteStreamManager,
}

impl Global for Open {}

/// The window's keys and menu command, and the window itself when it was
/// open at the last quit. Call once the main window is up.
pub fn install(
    cx: &mut App,
    frame: StreamManagerFrame,
    app_id: &'static str,
    dashboard: watch::Receiver<LiveDashboard>,
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
) {
    cx.bind_keys([
        KeyBinding::new(secondary!("j"), ShowSidekick, Some(KEY_CONTEXT)),
        KeyBinding::new(secondary!("f"), SearchChat, Some(KEY_CONTEXT)),
        KeyBinding::new(secondary!("l"), WriteInChat, Some(KEY_CONTEXT)),
    ]);
    cohost::bind_keys(cx);
    let reopens = frame.reopens();
    cx.set_global(Open {
        frame,
        app_id,
        dashboard,
        studio,
        runtime,
        window: None,
        quitting: false,
        hidden_from_viewers: false,
        place: RemoteStreamManager::default(),
    });
    cx.on_action(|_: &ToggleStreamManager, cx| toggle(cx));
    cx.on_window_closed(|cx, id| {
        let open = cx.global_mut::<Open>();
        if open.window.is_some_and(|window| window.window_id() == id) {
            open.window = None;
            open.frame.closed(open.quitting);
        }
    })
    .detach();
    cx.on_app_quit(|cx| {
        let open = cx.global_mut::<Open>();
        if open.window.is_some() && !open.quitting {
            open.quitting = true;
            open.frame.closed(true);
        }
        async {}
    })
    .detach();
    if reopens {
        show(cx);
    }
}

/// The open window's view, for the smoke window commands.
pub fn view(cx: &App) -> Option<WindowHandle<StreamManager>> {
    cx.try_global::<Open>().and_then(|open| open.window)
}

/// The open window, for the smoke driver; `None` while it is closed.
pub fn handle(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<Open>()
        .and_then(|open| open.window)
        .map(Into::into)
}

/// Closes the window when it is open, opens it otherwise
/// (`toggleCommentsWindow`).
pub fn toggle(cx: &mut App) {
    let open = cx.global::<Open>().window;
    match open {
        Some(window) => {
            let _ = window.update(cx, |_, window, _| window.remove_window());
        }
        None => show(cx),
    }
}

/// Brings the window forward, opening it first when it is closed.
pub fn show(cx: &mut App) {
    show_at(None, true, cx);
}

fn show_at(target: Option<gpui::Bounds<gpui::Pixels>>, focus: bool, cx: &mut App) {
    let open = cx.global::<Open>().window;
    if let Some(window) = open {
        let _ = window.update(cx, |_, window, _| {
            if focus {
                window.activate_window();
            }
        });
        return;
    }
    let (frame, app_id, dashboard, studio, runtime) = {
        let open = cx.global::<Open>();
        (
            open.frame.clone(),
            open.app_id,
            open.dashboard.clone(),
            open.studio.clone(),
            open.runtime.clone(),
        )
    };
    let saved = frame.opening(cx);
    let (bounds, min_size) = crate::app::frames::clamp_opening_bounds(
        target.or(saved),
        (DEFAULT_WIDTH, DEFAULT_HEIGHT),
        (f64::from(MIN_WIDTH), f64::from(MIN_HEIGHT)),
        cx,
    );
    let mut options = window::options(TITLE, bounds);
    options.focus = focus;
    options.show = target.is_none();
    options.window_min_size = Some(min_size);
    options.app_id = Some(app_id.into());
    let opened = cx.open_window(options, move |window, cx| {
        cx.new(|cx| StreamManager::new(frame, dashboard, studio, runtime, window, cx))
    });
    match opened {
        Ok(window) => cx.global_mut::<Open>().window = Some(window),
        Err(error) => eprintln!("[videorc-app] the Stream Manager did not open: {error:#}"),
    }
    refresh_remote_place(cx);
    crate::app::remote_keys::report(cx);
}

/// The Stream Manager Screen key held (`frontOrCloseCommentsWindow`): the
/// window the streamer is using closes, else it comes to the front, opened
/// when it is closed. False when the window isn't installed.
pub fn front_or_close(cx: &mut App) -> bool {
    let Some(window) = cx.try_global::<Open>().map(|open| open.window) else {
        return false;
    };
    // GPUI can't tell a minimized window; a focused one is showing.
    let focused = window
        .and_then(|window| {
            window
                .update(cx, |_, window, _| window.is_window_active())
                .ok()
        })
        .unwrap_or(false);
    let open = window.is_some();
    match stream_manager_hold_action(open, open, focused) {
        HoldAction::Close => toggle(cx),
        HoldAction::Front => show(cx),
    }
    true
}

/// Where the remotes see the Stream Manager. Updated on placement and native
/// window events; geometry and application identifiers never leave the app.
pub fn remote_place(cx: &App) -> RemoteStreamManager {
    let Some(open) = cx.try_global::<Open>() else {
        return RemoteStreamManager::default();
    };
    if open.window.is_none() {
        return RemoteStreamManager::default();
    }
    let mut place = open.place.clone();
    place.hidden_from_stream = place.visible && open.hidden_from_viewers;
    place
}

fn note_place(window: &Window, cx: &mut App) {
    let place = RemoteStreamManager {
        screen_id: platform::current()
            .window_frame(window)
            .ok()
            .and_then(|frame| {
                videorc_app_core::studio::remote_screens::screen_for_frame(
                    frame,
                    &crate::app::frames::remote_displays(cx),
                )
                .map(str::to_owned)
            }),
        visible: platform::current().window_shown(window),
        hidden_from_stream: false,
    };
    cx.global_mut::<Open>().place = place;
    cx.defer(|cx| crate::app::remote_keys::report(cx));
}

fn refresh_remote_place(cx: &mut App) {
    if let Some(handle) = handle(cx) {
        let _ = handle.update(cx, |_, window, cx| note_place(window, cx));
    }
}

/// Electron's tap: revalidate live displays, place before showing, and only
/// acknowledge when the native frame is on the chosen display.
pub fn screen_swap(
    presenting: &str,
    monitor: &str,
    cx: &mut App,
) -> videorc_app_core::studio::remote::IntentOutcome {
    use crate::app::frames::{bounds_of, remote_displays};
    use videorc_app_core::studio::remote::{accepted, copy, refused};
    use videorc_app_core::studio::remote_app::screen_swap_refusal;
    use videorc_app_core::studio::remote_screens::{destination, frame_on_screen, screen_options};
    let displays = remote_displays(cx);
    if let Some(reason) = screen_swap_refusal(
        &json!({"presentingScreen": presenting, "monitorScreen": monitor}),
        &screen_options(&displays),
        crate::app::remote_keys::screen_moves(),
    ) {
        return refused(reason);
    }
    if !cx.has_global::<Open>() {
        return refused(copy::WINDOW_MISSING);
    }
    refresh_remote_place(cx);
    let (id, focus) = destination(&remote_place(cx), presenting, monitor);
    let Some(display) = displays.iter().find(|d| d.id == id) else {
        return refused(copy::SCREEN_MISSING);
    };
    let frame_store = cx.global::<Open>().frame.clone();
    let current = handle(cx)
        .and_then(|handle| {
            handle
                .update(cx, |_, window, _| platform::current().window_frame(window))
                .ok()
                .and_then(Result::ok)
        })
        .or_else(|| frame_store.last_frame())
        .unwrap_or_else(|| {
            videorc_app_core::desktop::window_frames::Rect::new(
                0.,
                0.,
                DEFAULT_WIDTH,
                DEFAULT_HEIGHT,
            )
        });
    if let Some(previous) = remote_place(cx).screen_id {
        frame_store.remember_screen(&previous, current);
    }
    let frame = frame_on_screen(current, frame_store.on_screen(id), display.work_area);
    let existing = handle(cx);
    let own_before = cx
        .active_window()
        .filter(|active| existing.is_some_and(|own| own.window_id() != active.window_id()));
    let restore_focus = existing
        .and_then(|handle| {
            handle
                .update(cx, |_, window, _| {
                    window.is_window_active() || !platform::current().window_shown(window)
                })
                .ok()
        })
        .unwrap_or(false);
    show_at(Some(bounds_of(frame)), false, cx);
    let Some(handle) = handle(cx) else {
        return refused(copy::WINDOW_MISSING);
    };
    let moved = handle.update(cx, |_, window, cx| {
        let scale = if cfg!(target_os = "windows") {
            f64::from(window.scale_factor())
        } else {
            1.
        };
        window.resize(size(
            px((frame.width / scale) as f32),
            px((frame.height / scale) as f32),
        ));
        let target = platform::ScreenFrame {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        };
        platform::current().set_remote_window_frame(window, target)?;
        platform::current().show_window(window, focus)?;
        if focus {
            window.activate_window();
        }
        // Native bounds are synchronous, unlike GPUI's cached display ID.
        let actual = platform::current().window_frame(window)?;
        let center_x = actual.x + actual.width / 2.;
        let center_y = actual.y + actual.height / 2.;
        let bounds = display.bounds;
        if center_x < bounds.x
            || center_x >= bounds.x + bounds.width
            || center_y < bounds.y
            || center_y >= bounds.y + bounds.height
        {
            return Err(copy::STREAM_MANAGER_NOT_MOVED.to_string());
        }
        cx.global_mut::<Open>().place = RemoteStreamManager {
            screen_id: Some(id.to_string()),
            visible: true,
            hidden_from_stream: false,
        };
        frame_store.remember_screen(id, actual);
        Ok(())
    });
    match moved {
        Ok(Ok(())) => {
            if !focus && restore_focus {
                if let Some(own) = own_before {
                    let _ = own.update(cx, |_, window, _| window.activate_window());
                } else {
                    let _ = handle.update(cx, |_, window, _| {
                        platform::current().return_screen_key_focus(window)
                    });
                }
            }
            accepted()
        }
        error => {
            eprintln!("[remote-control] Stream Manager placement failed: {error:?}");
            refused(copy::STREAM_MANAGER_NOT_MOVED)
        }
    }
}

/// Notes whether viewers don't see the window, for the remotes.
fn note_hidden_from_viewers(hidden: bool, method: HideMethod, cx: &mut App) {
    if cx.has_global::<Open>() {
        cx.global_mut::<Open>().hidden_from_viewers = hidden && method != HideMethod::Unsupported;
    }
    crate::app::remote_keys::report(cx);
}

/// What the keys' gates read. The chat driver fills the chat's half and
/// Sidekick's pane its own; until then ⌘L and ⌘J stay off.
#[derive(Debug, Clone, Copy, Default)]
struct Facts {
    sidekick_present: bool,
    in_history: bool,
    can_send: bool,
    live: bool,
    marker: bool,
}

impl Facts {
    fn composer_available(self) -> bool {
        composer_available(self.in_history, self.can_send, self.live, self.marker)
    }
}

pub struct StreamManager {
    frame: StreamManagerFrame,
    studio: SharedStudio,
    runtime: tokio::runtime::Handle,
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    chat: gpui::Entity<ChatPane>,
    activity: gpui::Entity<ActivityPane>,
    sidekick: gpui::Entity<SidekickPane>,
    panes: Panes,
    facts: Facts,
    /// History session title + started-at line while viewing a past session (P943).
    history: Option<(String, String)>,
    stats: StatsView,
    stats_layout: StatsLayout,
    pinned: bool,
    hidden: bool,
    hide_method: HideMethod,
    /// Hide screen (frost) state from `screen.privacy.*`.
    screen_hidden: bool,
    screen_blocked: Option<String>,
    /// `None` while loading; empty when Images has none.
    banners: Option<Vec<BannerRow>>,
    /// `None` while loading; empty when Sounds has none.
    sounds: Option<Vec<SoundRow>>,
    clear: DialogHandle,
    /// The invisibility smoke's marker: the window painted edge to edge in
    /// one colour the artifact gate looks for (`comments-window-set-smoke-marker`).
    smoke_marker: Option<gpui::Hsla>,
    focus: FocusHandle,
    _bounds: Subscription,
    /// Sidekick's Reply, recap, Show on stream and Jump to message.
    _sidekick: Subscription,
}

impl StreamManager {
    fn new(
        frame: StreamManagerFrame,
        mut dashboard: watch::Receiver<LiveDashboard>,
        studio: SharedStudio,
        runtime: tokio::runtime::Handle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let hub = cx
            .global::<crate::screens::notifications::Shared>()
            .0
            .clone();
        let notices = cx.new(|cx| {
            crate::screens::notifications::Centre::new(hub, "stream-manager", window, cx)
        });
        let toaster = notices.read(cx).toasts();
        let live = matches!(dashboard.borrow().session, SessionState::Live);
        let chat = cx.new(|cx| {
            ChatPane::new(
                studio.clone(),
                runtime.clone(),
                studio.live_chat(),
                studio.moderation_operations(),
                toaster,
                live,
                window,
                cx,
            )
        });
        let activity = cx.new(|cx| ActivityPane::new(studio.live_chat(), dashboard.clone(), cx));
        let user_data_dir = frame.user_data_dir();
        let sidekick = cx.new(|cx| {
            SidekickPane::new(studio.clone(), runtime.clone(), user_data_dir, window, cx)
        });
        let sidekick_events = cx.subscribe_in(
            &sidekick,
            window,
            |sm, _, event: &SidekickEvent, window, cx| sm.on_sidekick(event, window, cx),
        );
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        frame.moved(window);
        let bounds = cx.observe_window_bounds(window, {
            let frame = frame.clone();
            move |_, window, cx| {
                frame.moved(window);
                note_place(window, cx);
            }
        });
        window
            .observe_window_visibility(|_, window, cx| note_place(window, cx))
            .detach();
        window
            .observe_window_display(|window, cx| note_place(window, cx))
            .detach();
        let pinned = frame.always_on_top();
        let hidden = frame.hidden_from_stream();
        let hide_method = stream_manager_hide_method(PermissionPlatform::current().as_str());
        let _ = platform::current().set_keep_on_top(window, pinned);
        if hide_method != HideMethod::Unsupported {
            let _ = HideFromStream::apply(window, WindowRole::Comments, hidden, cx);
        }
        note_hidden_from_viewers(hidden, hide_method, cx);
        let now = chrono::Utc::now().timestamp_millis();
        let stats = StatsView::from_dashboard(&dashboard.borrow(), now);
        let stats_layout = studio.read_ui_settings(families::stats_layout);
        cx.spawn(async move |this, cx| {
            loop {
                tokio::select! {
                    changed = dashboard.changed() => {
                        if changed.is_err() {
                            break;
                        }
                    }
                    _ = cx.background_executor().timer(Duration::from_secs(1)) => {}
                }
                let board = dashboard.borrow().clone();
                let now = chrono::Utc::now().timestamp_millis();
                let next = StatsView::from_dashboard(&board, now);
                let live = matches!(board.session, SessionState::Live);
                let alive = this.update(cx, |sm, cx| {
                    let changed = sm.stats != next || sm.facts.live != live;
                    sm.stats = next;
                    sm.facts.live = live;
                    sm.chat.update(cx, |chat, cx| chat.set_live(live, cx));
                    sm.facts.can_send = sm.chat.read(cx).can_send();
                    if changed {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        // Hide screen: seed from `screen.privacy.get`.
        {
            let studio = studio.clone();
            let runtime = runtime.clone();
            cx.spawn(async move |this, cx| {
                let answer = runtime
                    .spawn(async move {
                        studio
                            .backend()
                            .request("screen.privacy.get", Value::Null)
                            .await
                    })
                    .await;
                let Ok(Ok(value)) = answer else {
                    return;
                };
                let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(value) else {
                    return;
                };
                let _ = this.update(cx, |sm, cx| sm.apply_screen_privacy(privacy, cx));
            })
            .detach();
        }
        // Banners menu: seed from `banners.list`.
        {
            let studio = studio.clone();
            let runtime = runtime.clone();
            cx.spawn(async move |this, cx| {
                let answer = runtime.spawn(async move { studio.banners().await }).await;
                let rows = match answer {
                    Ok(Ok(value)) => Some(parse_banner_rows(value)),
                    _ => Some(Vec::new()),
                };
                let _ = this.update(cx, |sm, cx| {
                    sm.banners = rows;
                    cx.notify();
                });
            })
            .detach();
        }
        // Sounds menu: seed from `sounds.list`.
        {
            let studio = studio.clone();
            let runtime = runtime.clone();
            cx.spawn(async move |this, cx| {
                let answer = runtime
                    .spawn(async move { studio.backend().sounds_list().await })
                    .await;
                let rows = match answer {
                    Ok(Ok(board)) => Some(sound_rows(&board)),
                    _ => Some(Vec::new()),
                };
                let _ = this.update(cx, |sm, cx| {
                    sm.sounds = rows;
                    cx.notify();
                });
            })
            .detach();
        }
        Self {
            frame,
            studio,
            runtime,
            notices,
            chat,
            activity,
            sidekick,
            panes: Panes::default(),
            facts: Facts {
                can_send: true,
                marker: false,
                live,
                sidekick_present: true,
                ..Facts::default()
            },
            history: None,
            stats,
            stats_layout,
            pinned,
            hidden,
            hide_method,
            screen_hidden: false,
            screen_blocked: None,
            banners: None,
            sounds: None,
            clear: DialogHandle::new(false),
            smoke_marker: None,
            focus,
            _bounds: bounds,
            _sidekick: sidekick_events,
        }
    }

    /// Sidekick's asks of the chat pane: a draft in the composer (Chat
    /// comes forward), a question's message on stream, a flagged message
    /// in view.
    fn on_sidekick(&mut self, event: &SidekickEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            SidekickEvent::Prefill(text) => {
                self.panes.prefill();
                let text = text.clone();
                self.chat.update(cx, |chat, cx| {
                    chat.prefill(text, cx);
                    chat.focus_composer(window, cx);
                });
            }
            SidekickEvent::ShowOnStream(id) => {
                self.chat.update(cx, |chat, cx| {
                    chat.press_highlight(id, cx);
                });
            }
            SidekickEvent::JumpTo(id) => {
                self.panes.pick(Pane::Chat);
                self.chat.update(cx, |chat, cx| chat.jump_to(id, cx));
            }
            SidekickEvent::RemoveFromChat(id) => {
                self.chat
                    .update(cx, |chat, cx| chat.remove_from_chat(id, window, cx));
            }
        }
        cx.notify();
    }

    /// Leave History and return to the live session (P943).
    fn back_to_live(&mut self, cx: &mut Context<Self>) {
        self.history = None;
        self.facts.in_history = false;
        self.chat.update(cx, |chat, cx| chat.leave_history(cx));
        cx.notify();
    }

    /// Library ⋯ → Open in Stream Manager (`openSessionCommentsWindow`): a
    /// past session's chat in History, with its title and start on the bar.
    pub fn open_history(
        &mut self,
        session_id: String,
        title: String,
        started: String,
        messages: Vec<videorc_app_core::chat::model::LiveChatMessage>,
        cx: &mut Context<Self>,
    ) {
        self.history = Some((title, started));
        self.facts.in_history = true;
        self.panes.pick(Pane::Chat);
        self.chat
            .update(cx, |chat, cx| chat.show_history(session_id, messages, cx));
        cx.notify();
    }

    fn apply_stats_layout(&mut self, layout: StatsLayout, cx: &mut Context<Self>) {
        if self.stats_layout == layout {
            return;
        }
        self.stats_layout = layout.clone();
        let studio = self.studio.clone();
        let write = families::save_stats_layout(&layout);
        self.runtime.spawn(async move {
            let _ = studio.write_settings(vec![write]).await;
        });
        cx.notify();
    }

    fn play_sound(&self, id: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .backend()
                .sounds_request("sounds.play", json!({ "id": id }))
                .await;
        });
    }

    fn stop_all_sounds(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .backend()
                .sounds_request("sounds.stop", json!({}))
                .await;
        });
    }

    fn refresh_banners(&mut self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let answer = runtime.spawn(async move { studio.banners().await }).await;
            let rows = match answer {
                Ok(Ok(value)) => Some(parse_banner_rows(value)),
                _ => Some(Vec::new()),
            };
            let _ = this.update(cx, |sm, cx| {
                sm.banners = rows;
                cx.notify();
            });
        })
        .detach();
    }

    fn set_banner_shown(&mut self, id: String, show: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    if show {
                        studio.show_banner(&id).await
                    } else {
                        studio.hide_banner(&id).await
                    }
                })
                .await;
            let _ = this.update(cx, |sm, cx| sm.refresh_banners(cx));
        })
        .detach();
    }

    fn hide_all_banners(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .banners
            .as_ref()
            .map(|list| {
                list.iter()
                    .filter(|b| b.shown)
                    .map(|b| b.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if ids.is_empty() {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    for id in ids {
                        let _ = studio.hide_banner(&id).await;
                    }
                })
                .await;
            let _ = this.update(cx, |sm, cx| sm.refresh_banners(cx));
        })
        .detach();
    }

    fn request_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear.open(window, cx);
        cx.notify();
    }

    fn confirm_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear.close(window, cx);
        self.chat.update(cx, |chat, cx| chat.clear_view(cx));
        self.activity
            .update(cx, |activity, cx| activity.clear_view(cx));
        cx.notify();
    }

    fn mark_clip(&self, seconds: u32) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio.mark_clip(Some(seconds)).await;
        });
    }

    fn apply_screen_privacy(&mut self, privacy: ScreenPrivacy, cx: &mut Context<Self>) {
        self.screen_hidden = privacy.hidden;
        self.screen_blocked = privacy.unavailable;
        cx.notify();
    }

    fn set_screen_hidden(&mut self, hide: bool, cx: &mut Context<Self>) {
        if self.screen_blocked.is_some() {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let answer = runtime
                .spawn(async move {
                    if hide {
                        studio
                            .backend()
                            .request("screen.hide", json!({ "reason": ScreenPrivacyReason::You }))
                            .await
                    } else {
                        studio.backend().request("screen.show", Value::Null).await
                    }
                })
                .await;
            let Ok(Ok(value)) = answer else {
                return;
            };
            let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(value) else {
                return;
            };
            let _ = this.update(cx, |sm, cx| sm.apply_screen_privacy(privacy, cx));
        })
        .detach();
    }

    fn set_pinned(&mut self, pinned: bool, window: &Window, cx: &mut Context<Self>) {
        self.pinned = pinned;
        self.frame.set_always_on_top(pinned);
        let _ = platform::current().set_keep_on_top(window, pinned);
        cx.notify();
    }

    fn set_hidden(&mut self, hidden: bool, window: &Window, cx: &mut Context<Self>) {
        if self.hide_method == HideMethod::Unsupported {
            return;
        }
        self.hidden = hidden;
        self.frame.set_hidden_from_stream(hidden);
        let _ = HideFromStream::apply(window, WindowRole::Comments, hidden, cx);
        note_hidden_from_viewers(hidden, self.hide_method, cx);
        cx.notify();
    }

    /// `comments-window-state`'s view half (Electron's `commentsWindowState`).
    pub fn smoke_state(&self, window: &Window, cx: &App) -> Value {
        json!({
            "alwaysOnTop": self.pinned,
            "hiddenFromStream": self.hidden,
            "hideFromStreamMethod": self.hide_method.id(),
            // Content protection is the Stream Manager's hide only where that
            // is the method (Windows); macOS keeps it off and filters instead.
            "protected": self.hidden && self.hide_method == HideMethod::ContentProtection,
            "captureProtectionMarkerInstalled": self.smoke_marker.is_some(),
            "windowId": platform::current().capture_window_id(window),
            "highlightAnchor": self.chat.read(cx).anchor().id(),
        })
    }

    /// The status bar's corner pick, kept by the chat pane that sends the
    /// highlight.
    fn pick_anchor(&mut self, corner: super::chat::HighlightAnchor, cx: &mut Context<Self>) {
        self.chat
            .update(cx, |chat, cx| chat.pick_anchor(corner, cx));
        cx.notify();
    }

    /// `comments-window-set-highlight-anchor`: the status bar's pick.
    pub fn smoke_set_anchor(&mut self, anchor: &str, cx: &mut Context<Self>) {
        self.pick_anchor(super::chat::HighlightAnchor::parse(Some(anchor)), cx);
    }

    /// `comments-window-click-message {messageId}`: the row's own click.
    pub fn smoke_click_message(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        self.chat
            .update(cx, |chat, cx| chat.press_highlight(id, cx))
    }

    pub fn smoke_push_snapshot(
        &mut self,
        fixture: &videorc_app_core::smoke::comments::SnapshotFixture,
        cx: &mut Context<Self>,
    ) {
        self.facts.in_history = fixture.history;
        self.history = fixture.history.then(|| {
            (
                fixture.mode["title"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                fixture.mode["startedAt"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        });
        self.panes.pick(Pane::Chat);
        self.chat
            .update(cx, |chat, cx| chat.smoke_push_snapshot(fixture, cx));
        cx.notify();
    }

    /// `comments-window-reader-state`.
    pub fn smoke_reader_state(&self, cx: &App) -> Value {
        self.chat.read(cx).smoke_reader_state()
    }

    /// `comments-window-command-trace`.
    pub fn smoke_command_trace(&self, cx: &App) -> Value {
        self.chat.read(cx).smoke_command_trace()
    }

    /// `comments-window-set-hidden-from-stream`: the status bar's switch.
    pub fn smoke_set_hidden(&mut self, hidden: bool, window: &Window, cx: &mut Context<Self>) {
        self.set_hidden(hidden, window, cx);
    }

    /// `comments-window-set-smoke-marker`: paints the window `color`.
    pub fn smoke_set_marker(&mut self, color: gpui::Hsla, cx: &mut Context<Self>) {
        self.smoke_marker = Some(color);
        cx.notify();
    }

    fn run(&mut self, key: PaneKey, window: &mut Window, cx: &mut Context<Self>) {
        if !key_runs(
            key,
            self.facts.sidekick_present,
            self.facts.composer_available(),
        ) {
            cx.propagate();
            return;
        }
        let _focus = self.panes.key(key);
        match key {
            PaneKey::SearchChat => {
                self.chat
                    .update(cx, |chat, cx| chat.focus_search(window, cx));
            }
            PaneKey::WriteInChat => {
                self.chat
                    .update(cx, |chat, cx| chat.focus_composer(window, cx));
            }
            PaneKey::ShowSidekick => {
                self.sidekick
                    .update(cx, |pane, cx| pane.focus_list(window, cx));
            }
        }
        cx.notify();
    }

    fn region(
        &self,
        pane: Pane,
        tier: Tier,
        width: f32,
        border: gpui::Hsla,
        nudge: Option<gpui::AnyElement>,
        weak: gpui::WeakEntity<Self>,
    ) -> Option<gpui::AnyElement> {
        let body = match pane {
            // Sidekick's nudge sits under the chat composer (`CohostNudge`).
            Pane::Chat => div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .flex_col()
                // A flex column, so the chat fills the space between the stats
                // and the status bar and its list scrolls inside it (the
                // chat's own height pushed the status bar out of the window).
                .child(
                    div()
                        .flex_1()
                        .min_h(px(0.))
                        .flex()
                        .flex_col()
                        .child(self.chat.clone()),
                )
                .children(nudge)
                .into_any_element(),
            Pane::Activity => self.activity.clone().into_any_element(),
            Pane::Sidekick => self.sidekick.clone().into_any_element(),
        };
        let region = div().h_full().flex().flex_col().min_w(px(0.)).child(body);
        let region = match slot(pane, tier, self.panes.narrow(), self.panes.right()) {
            Slot::Hidden => return None,
            Slot::Whole | Slot::Left => region.flex_1(),
            Slot::Right => {
                // The right pane's tabs at Wide (`pane-tabs-wide`): Activity,
                // and Sidekick while it is present.
                let mut tabs = Tabs::new("right-pane-tabs").tab(Pane::Activity.label());
                if self.facts.sidekick_present {
                    tabs = tabs.tab(Pane::Sidekick.label());
                }
                let tabs = tabs
                    .selected(match self.panes.right() {
                        RightPane::Activity => 0,
                        RightPane::Sidekick => 1,
                    })
                    .on_select(move |index, _, app| {
                        let pane = if index == 1 {
                            RightPane::Sidekick
                        } else {
                            RightPane::Activity
                        };
                        let _ = weak.update(app, |sm, cx| {
                            sm.panes.pick_right(pane);
                            cx.notify();
                        });
                    });
                div()
                    .h_full()
                    .flex()
                    .flex_col()
                    .min_w(px(0.))
                    .flex_none()
                    .w(px(right_pane_width(width)))
                    .border_l_1()
                    .border_color(border)
                    // A flex row, so the tabs hug their triggers at the left
                    // (`TabsList` is `inline-flex w-fit`), not the pane width.
                    .child(
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .px(px(8.))
                            .py(px(6.))
                            .border_b_1()
                            .border_color(border)
                            .child(tabs),
                    )
                    .child(region.flex_1().min_h(px(0.)))
            }
        };
        Some(region.into_any_element())
    }
}

impl Render for StreamManager {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = f32::from(window.viewport_size().width);
        let tier = Tier::of(width);
        let t = theme::resolve(None, window, cx);
        let border = hsla(t.border);
        let mac = cfg!(target_os = "macos");
        let mut nudge = self
            .sidekick
            .update(cx, |pane, cx| pane.cohost_nudge(window, cx));
        let weak = cx.entity().downgrade();
        let regions: Vec<gpui::AnyElement> = [Pane::Chat, Pane::Activity, Pane::Sidekick]
            .into_iter()
            .filter_map(|pane| {
                let nudge = if pane == Pane::Chat {
                    nudge.take()
                } else {
                    None
                };
                self.region(pane, tier, width, border, nudge, weak.clone())
            })
            .collect();
        let pinned = self.pinned;
        let hidden = self.hidden;
        let hide_method = self.hide_method;
        let screen_hidden = self.screen_hidden;
        let screen_blocked = self.screen_blocked.clone();
        let banners = self.banners.clone();
        let sounds = self.sounds.clone();
        let this = cx.entity().downgrade();
        let pin = this.clone();
        let hide = this.clone();
        let clear = this.clone();
        let clip = this.clone();
        let screen = this.clone();
        let corner_pick = this.clone();
        let anchor = self.chat.read(cx).anchor();
        let banner = this.clone();
        let banner_all = this.clone();
        let sound = this.clone();
        let sound_stop = this.clone();
        let clear_dialog = Dialog::new("stream-manager-clear", &self.clear, "Clear the view?")
            .description(
                "Chat and Activity in this window are emptied and the messages per minute start over. The Library keeps the history.",
            )
            .close_button(false)
            .footer(
                Button::new("clear-cancel")
                    .variant(ButtonVariant::Ghost)
                    .label("Cancel")
                    .on_click({
                        let this = this.clone();
                        move |_, window, app| {
                            let _ = this.update(app, |sm, cx| {
                                sm.clear.close(window, cx);
                                cx.notify();
                            });
                        }
                    }),
            )
            .footer(
                Button::new("clear-confirm")
                    .variant(ButtonVariant::Destructive)
                    .label("Clear view")
                    .on_click({
                        let this = this;
                        move |_, window, app| {
                            let _ = this.update(app, |sm, cx| sm.confirm_clear(window, cx));
                        }
                    }),
            );
        let marker = self.smoke_marker;
        WindowFrame::new().child(
            div()
                .size_full()
                .relative()
                .flex()
                .flex_col()
                .track_focus(&self.focus)
                .key_context(KEY_CONTEXT)
                .on_action(cx.listener(
                    |this, _: &crate::screens::notifications::ToggleNotifications, _, cx| {
                        this.notices.update(cx, |centre, cx| centre.toggle(cx))
                    },
                ))
                .on_action(cx.listener(|this, _: &ShowSidekick, window, cx| {
                    this.run(PaneKey::ShowSidekick, window, cx)
                }))
                .on_action(cx.listener(|this, _: &SearchChat, window, cx| {
                    this.run(PaneKey::SearchChat, window, cx)
                }))
                .on_action(cx.listener(|this, _: &WriteInChat, window, cx| {
                    this.run(PaneKey::WriteInChat, window, cx)
                }))
                .child(WindowHeader::new(TITLE).mac(mac))
                .children(self.history.as_ref().map(|(title, started)| {
                    let entity = cx.entity();
                    div()
                        .id("history-bar")
                        .flex()
                        .flex_none()
                        .h(px(32.))
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .border_b_1()
                        .border_color(hsla(t.border))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.))
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_size(px(12.))
                                .text_color(hsla(t.muted_foreground))
                                .child(format!("{title} · {started}")),
                        )
                        .child(
                            Button::new("back-to-live")
                                .label("Back to live")
                                .variant(ButtonVariant::Outline)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |sm, cx| sm.back_to_live(cx));
                                }),
                        )
                }))
                .child({
                    let this = cx.entity().downgrade();
                    let layout = self.stats_layout.clone();
                    let hidden = self.screen_hidden;
                    stats_bar(t, &self.stats, &layout, width, hidden, move |next, app| {
                        let _ = this.update(app, |sm, cx| sm.apply_stats_layout(next, cx));
                    })
                })
                .child(
                    div()
                        .flex_1()
                        .min_h(px(0.))
                        .flex()
                        .flex_row()
                        .children(regions),
                )
                .child(status_bar(
                    t,
                    self.notices.clone(),
                    &self.studio.live_chat_now().providers,
                    pinned,
                    hidden,
                    hide_method,
                    screen_hidden,
                    screen_blocked,
                    width,
                    // `clipAvailable` (`stream-manager.tsx`): never in history.
                    !self.facts.in_history && self.studio.clip_available_now(),
                    move |next, _, window, app| {
                        let _ = pin.update(app, |this, cx| this.set_pinned(next, window, cx));
                    },
                    move |next, _, window, app| {
                        let _ = hide.update(app, |this, cx| this.set_hidden(next, window, cx));
                    },
                    move |window, app| {
                        let _ = clear.update(app, |this, cx| this.request_clear(window, cx));
                    },
                    move |seconds, _window, app| {
                        let _ = clip.update(app, |this, _| this.mark_clip(seconds));
                    },
                    move |hide, _window, app| {
                        let _ = screen.update(app, |this, cx| this.set_screen_hidden(hide, cx));
                    },
                    anchor,
                    move |corner, _window, app| {
                        let _ = corner_pick.update(app, |this, cx| this.pick_anchor(corner, cx));
                    },
                    banners,
                    move |id, show, _window, app| {
                        let _ = banner.update(app, |this, cx| this.set_banner_shown(id, show, cx));
                    },
                    move |_window, app| {
                        let _ = banner_all.update(app, |this, cx| this.hide_all_banners(cx));
                    },
                    sounds,
                    move |id, _window, app| {
                        let _ = sound.update(app, |this, _| this.play_sound(id));
                    },
                    move |_window, app| {
                        let _ = sound_stop.update(app, |this, _| this.stop_all_sounds());
                    },
                ))
                .child(clear_dialog)
                .child(self.notices.read(cx).toasts())
                .when_some(marker, |root, color| {
                    root.child(div().absolute().inset_0().bg(color))
                }),
        )
    }
}

fn sound_rows(board: &SoundboardState) -> Vec<SoundRow> {
    board
        .sounds
        .iter()
        .map(|s| SoundRow {
            id: s.id.clone(),
            name: s.name.clone(),
        })
        .collect()
}

fn parse_banner_rows(value: Value) -> Vec<BannerRow> {
    let banners = if let Ok(list) = serde_json::from_value::<Vec<Banner>>(value.clone()) {
        list
    } else if let Some(list) = value
        .get("banners")
        .cloned()
        .and_then(|v| serde_json::from_value::<Vec<Banner>>(v).ok())
    {
        list
    } else {
        return Vec::new();
    };
    banners
        .into_iter()
        .map(|b| BannerRow {
            id: b.id,
            name: b.name,
            shown: b.shown,
        })
        .collect()
}
