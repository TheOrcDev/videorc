//! The Stream Manager window (`openCommentsWindow`): one window, opened,
//! shown and toggled from the Window menu (⇧⌘J), back at launch when it was
//! open at the last quit, at least 320 × 360, at its saved frame.
//!
//! The view holds the tier layout and the window's keys (⌘J Sidekick, ⌘F
//! search chat, ⌘L write in chat, in the `StreamManager` key context). The
//! header, stats bar, panes and status bar are the kit's (`videorc-kit`).

use gpui::{
    App, AppContext, Bounds, Context, FocusHandle, Global, KeyBinding, Subscription, Window,
    WindowHandle, actions, div, prelude::*, px, size,
};

use super::activity::activity_pane;
use super::chat::ChatPane;
use super::frame::{DEFAULT_HEIGHT, DEFAULT_WIDTH, StreamManagerFrame};
use super::layout::{MIN_HEIGHT, MIN_WIDTH, Pane, Slot, Tier, right_pane_width, slot};
use super::panes::{PaneKey, Panes, composer_available, key_runs};
use super::sidekick::sidekick_pane;
use super::stats::{SessionChip, stats_bar};
use super::status::status_bar;
use crate::app::hide::HideFromStream;
use crate::app::menus::ToggleStreamManager;
use crate::platform;
use videorc_app_core::desktop::capture_protection::{
    HideMethod, WindowRole, stream_manager_hide_method,
};
use videorc_app_core::desktop::permissions::PermissionPlatform;
use videorc_app_core::stream_manager::copy::WINDOW_NAME;
use videorc_kit::{
    theme::{self, hsla},
    window,
    window_frame::{WindowFrame, WindowHeader},
};

actions!(stream_manager, [ShowSidekick, SearchChat, WriteInChat]);

pub const KEY_CONTEXT: &str = "StreamManager";
/// `WINDOW_NAMES.streamManager`.
pub const TITLE: &str = WINDOW_NAME;

/// The one window, its frame file, and whether the quit is closing it.
struct Open {
    frame: StreamManagerFrame,
    app_id: &'static str,
    window: Option<WindowHandle<StreamManager>>,
    quitting: bool,
}

impl Global for Open {}

/// The window's keys and menu command, and the window itself when it was
/// open at the last quit. Call once the main window is up.
pub fn install(cx: &mut App, frame: StreamManagerFrame, app_id: &'static str) {
    cx.bind_keys([
        KeyBinding::new("secondary-j", ShowSidekick, Some(KEY_CONTEXT)),
        KeyBinding::new("secondary-f", SearchChat, Some(KEY_CONTEXT)),
        KeyBinding::new("secondary-l", WriteInChat, Some(KEY_CONTEXT)),
    ]);
    let reopens = frame.reopens();
    cx.set_global(Open {
        frame,
        app_id,
        window: None,
        quitting: false,
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
    let open = cx.global::<Open>().window;
    if let Some(window) = open {
        let _ = window.update(cx, |_, window, _| window.activate_window());
        return;
    }
    let (frame, app_id) = {
        let open = cx.global::<Open>();
        (open.frame.clone(), open.app_id)
    };
    let bounds = frame.opening(cx).unwrap_or_else(|| {
        Bounds::centered(
            None,
            size(px(DEFAULT_WIDTH as f32), px(DEFAULT_HEIGHT as f32)),
            cx,
        )
    });
    let mut options = window::options(TITLE, bounds);
    options.window_min_size = Some(size(px(MIN_WIDTH), px(MIN_HEIGHT)));
    options.app_id = Some(app_id.into());
    let opened = cx.open_window(options, move |window, cx| {
        cx.new(|cx| StreamManager::new(frame, window, cx))
    });
    match opened {
        Ok(window) => cx.global_mut::<Open>().window = Some(window),
        Err(error) => eprintln!("[videorc-app] the Stream Manager did not open: {error:#}"),
    }
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
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    chat: gpui::Entity<ChatPane>,
    panes: Panes,
    facts: Facts,
    chip: SessionChip,
    pinned: bool,
    hidden: bool,
    hide_method: HideMethod,
    focus: FocusHandle,
    _bounds: Subscription,
}

impl StreamManager {
    fn new(frame: StreamManagerFrame, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let hub = cx
            .global::<crate::screens::notifications::Shared>()
            .0
            .clone();
        let notices = cx.new(|cx| {
            crate::screens::notifications::Centre::new(hub, "stream-manager", window, cx)
        });
        let chat = cx.new(|cx| ChatPane::new(window, cx));
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        frame.moved(window);
        let bounds = cx.observe_window_bounds(window, {
            let frame = frame.clone();
            move |_, window, _| frame.moved(window)
        });
        let pinned = frame.always_on_top();
        let hidden = frame.hidden_from_stream();
        let hide_method = stream_manager_hide_method(PermissionPlatform::current().as_str());
        let _ = platform::current().set_keep_on_top(window, pinned);
        if hide_method != HideMethod::Unsupported {
            let _ = HideFromStream::apply(window, WindowRole::Comments, hidden, cx);
        }
        Self {
            frame,
            notices,
            chat,
            panes: Panes::default(),
            // Shell: local commands keep ⌘L alive until the send driver lands.
            facts: Facts {
                can_send: true,
                marker: true,
                ..Facts::default()
            },
            chip: SessionChip::OffAir,
            pinned,
            hidden,
            hide_method,
            focus,
            _bounds: bounds,
        }
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
            PaneKey::ShowSidekick => {}
        }
        cx.notify();
    }

    fn region(
        &self,
        pane: Pane,
        tier: Tier,
        width: f32,
        border: gpui::Hsla,
    ) -> Option<gpui::AnyElement> {
        let body = match pane {
            Pane::Chat => self.chat.clone().into_any_element(),
            Pane::Activity => activity_pane(),
            Pane::Sidekick => sidekick_pane(),
        };
        let region = div().h_full().flex().flex_col().min_w(px(0.)).child(body);
        let region = match slot(pane, tier, self.panes.narrow(), self.panes.right()) {
            Slot::Hidden => return None,
            Slot::Whole | Slot::Left => region.flex_1(),
            Slot::Right => region
                .flex_none()
                .w(px(right_pane_width(width)))
                .border_l_1()
                .border_color(border),
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
        let regions = [Pane::Chat, Pane::Activity, Pane::Sidekick]
            .into_iter()
            .filter_map(|pane| self.region(pane, tier, width, border));
        let pinned = self.pinned;
        let hidden = self.hidden;
        let hide_method = self.hide_method;
        let this = cx.entity().downgrade();
        let pin = this.clone();
        let hide = this;
        WindowFrame::new().child(
            div()
                .size_full()
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
                .child(stats_bar(t, self.chip, width))
                .child(
                    div()
                        .flex_1()
                        .min_h(px(0.))
                        .flex()
                        .flex_row()
                        .children(regions),
                )
                .child(status_bar(
                    self.notices.clone(),
                    pinned,
                    hidden,
                    hide_method,
                    width,
                    move |next, _, window, app| {
                        let _ = pin.update(app, |this, cx| this.set_pinned(next, window, cx));
                    },
                    move |next, _, window, app| {
                        let _ = hide.update(app, |this, cx| this.set_hidden(next, window, cx));
                    },
                ))
                .child(self.notices.read(cx).toasts()),
        )
    }
}
