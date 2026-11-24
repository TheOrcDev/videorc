//! The Stream Manager window (`openCommentsWindow`): one window, opened,
//! shown and toggled from the Window menu (⇧⌘J), back at launch when it was
//! open at the last quit, at least 320 × 360, at its saved frame.
//!
//! The view holds the tier layout and the window's keys (⌘J Sidekick, ⌘F
//! search chat, ⌘L write in chat, in the `StreamManager` key context). The
//! header, tabs, stats bar, panes and status bar are the kit's
//! (`videorc-kit`) and fill these regions when it lands; until then the
//! regions are plain, so no kit item is copied here.

use gpui::{
    App, AppContext, Bounds, Context, FocusHandle, FontWeight, Global, KeyBinding, Subscription,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, actions, div, point,
    prelude::*, px, rgb, size,
};

use super::frame::{DEFAULT_HEIGHT, DEFAULT_WIDTH, StreamManagerFrame};
use super::layout::{MIN_HEIGHT, MIN_WIDTH, Pane, Slot, Tier, right_pane_width, slot};
use super::panes::{PaneKey, Panes, composer_available, key_runs};
use crate::app::menus::ToggleStreamManager;

actions!(stream_manager, [ShowSidekick, SearchChat, WriteInChat]);

pub const KEY_CONTEXT: &str = "StreamManager";
/// `WINDOW_NAMES.streamManager`.
pub const TITLE: &str = "Stream Manager";

// Plain colours until the kit's tokens land (the shell's).
const GROUND: u32 = 0x161618;
const HAIRLINE: u32 = 0x2c2c30;
const TEXT: u32 = 0xe8e8ea;

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
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(TITLE.into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(14.), px(13.))),
            }),
            window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
            app_id: Some(app_id.into()),
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| StreamManager::new(frame, window, cx)),
    );
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
    panes: Panes,
    facts: Facts,
    focus: FocusHandle,
    _bounds: Subscription,
}

impl StreamManager {
    fn new(frame: StreamManagerFrame, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        frame.moved(window);
        let bounds = cx.observe_window_bounds(window, move |_, window, _| frame.moved(window));
        Self {
            panes: Panes::default(),
            facts: Facts::default(),
            focus,
            _bounds: bounds,
        }
    }

    fn run(&mut self, key: PaneKey, cx: &mut Context<Self>) {
        if !key_runs(
            key,
            self.facts.sidekick_present,
            self.facts.composer_available(),
        ) {
            cx.propagate();
            return;
        }
        // The pane is shown now; its search field, composer and Sidekick's
        // expand take the focus once the kit's panes are in it.
        let _focus = self.panes.key(key);
        cx.notify();
    }

    fn region(&self, pane: Pane, tier: Tier, width: f32) -> Option<gpui::AnyElement> {
        let region = div().h_full().flex().flex_col().min_w(px(0.));
        let region = match slot(pane, tier, self.panes.narrow(), self.panes.right()) {
            Slot::Hidden => return None,
            Slot::Whole | Slot::Left => region.flex_1(),
            Slot::Right => region
                .flex_none()
                .w(px(right_pane_width(width)))
                .border_l_1()
                .border_color(rgb(HAIRLINE)),
        };
        Some(region.into_any_element())
    }
}

impl Render for StreamManager {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let width = f32::from(window.viewport_size().width);
        let tier = Tier::of(width);
        let regions = [Pane::Chat, Pane::Activity, Pane::Sidekick]
            .into_iter()
            .filter_map(|pane| self.region(pane, tier, width));
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(GROUND))
            .text_color(rgb(TEXT))
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .on_action(
                cx.listener(|this, _: &ShowSidekick, _, cx| this.run(PaneKey::ShowSidekick, cx)),
            )
            .on_action(cx.listener(|this, _: &SearchChat, _, cx| this.run(PaneKey::SearchChat, cx)))
            .on_action(
                cx.listener(|this, _: &WriteInChat, _, cx| this.run(PaneKey::WriteInChat, cx)),
            )
            .child(
                div()
                    .flex_none()
                    .h(px(40.))
                    .flex()
                    .items_center()
                    .pl(px(84.))
                    .border_b_1()
                    .border_color(rgb(HAIRLINE))
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(TITLE),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .flex_row()
                    .children(regions),
            )
    }
}
