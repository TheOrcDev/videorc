//! The Captions reader window (`components/captions-reader.tsx`,
//! `openCaptionsWindow`): ⇧⌘C, big-text captions for a second monitor. The
//! window header has its name, one status dot and Keep on top; the newest
//! line is the large one, and the body says what is happening while there
//! is nothing to read. The window is part of the show, so it is never
//! hidden from capture. Its frame and Keep on top live in
//! `captions-window.json`, as Electron keeps them.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use gpui::{
    App, AppContext, Bounds, Context, Entity, Global, Pixels, ScrollHandle, Subscription, Window,
    WindowBounds, WindowHandle, div, prelude::*, px, size,
};
use serde_json::{Map, Value};
use videorc_app_core::captions::{self as c, Tone};
use videorc_app_core::desktop::capture_protection::WindowRole;
use videorc_app_core::desktop::window_frames::{
    Rect, WindowPrefsFile, clamp_frame_to_work_area, close_prefs, persistence_enabled,
};
use videorc_app_core::{Level, Logger};
use videorc_kit::{
    icon::{IconName, icon},
    pin_window_button::PinWindowButton,
    status_dot::{StatusDot, StatusTone},
    theme::{self, FONT, TypeScale, hsla},
    tokens::text,
    window,
    window_frame::{WindowFrame, WindowHeader},
};

use super::feed::{self, CaptionsFeed};
use crate::app::frames::{bounds_of, displays, rect_of};
use crate::app::hide::HideFromStream;
use crate::app::menus::ToggleCaptions;
use crate::platform;

/// Electron's `captions-window.json`.
pub const PREFS_FILE: &str = "captions-window.json";
const DEFAULT_WIDTH: f32 = 640.;
const DEFAULT_HEIGHT: f32 = 320.;
const MIN_WIDTH: f32 = 360.;
const MIN_HEIGHT: f32 = 200.;
/// `alwaysOnTopPreferenceVersion` for the Captions window.
const PIN_PREFERENCE_VERSION: u64 = 1;

/// The window's frame file and the last windowed frame it had.
#[derive(Clone)]
pub struct CaptionsFrame {
    inner: Rc<RefCell<FrameInner>>,
}

struct FrameInner {
    prefs: WindowPrefsFile,
    logger: Logger,
    last: Option<Rect>,
}

impl CaptionsFrame {
    pub fn new(user_data_dir: &Path, logger: Logger) -> Self {
        let enabled = persistence_enabled(|name| std::env::var(name).ok());
        Self {
            inner: Rc::new(RefCell::new(FrameInner {
                prefs: WindowPrefsFile::new(user_data_dir, PREFS_FILE, enabled),
                logger,
                last: None,
            })),
        }
    }

    fn reopens(&self) -> bool {
        self.inner.borrow().prefs.load().get("open") == Some(&Value::Bool(true))
    }

    fn always_on_top(&self) -> bool {
        let prefs = self.inner.borrow().prefs.load();
        prefs
            .get("alwaysOnTopPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(PIN_PREFERENCE_VERSION)
            && prefs.get("alwaysOnTop") == Some(&Value::Bool(true))
    }

    fn set_always_on_top(&self, on: bool) {
        let mut patch = Map::new();
        patch.insert("alwaysOnTop".into(), Value::Bool(on));
        patch.insert(
            "alwaysOnTopPreferenceVersion".into(),
            Value::from(PIN_PREFERENCE_VERSION),
        );
        self.write(patch);
    }

    fn opening(&self, cx: &App) -> Option<Bounds<Pixels>> {
        let saved = self
            .inner
            .borrow()
            .prefs
            .load()
            .get("frame")
            .and_then(Rect::from_json);
        let mut patch = Map::new();
        patch.insert("open".into(), Value::Bool(true));
        self.write(patch);
        let remembered = self.inner.borrow().last.or(saved)?;
        Some(bounds_of(clamp_frame_to_work_area(
            remembered,
            &displays(cx),
        )))
    }

    fn moved(&self, window: &Window) {
        let WindowBounds::Windowed(bounds) = window.window_bounds() else {
            return;
        };
        let frame = rect_of(bounds);
        if frame.width > 0.0 && frame.height > 0.0 {
            self.inner.borrow_mut().last = Some(frame);
        }
    }

    fn closed(&self, app_quitting: bool) {
        let last = self.inner.borrow().last;
        self.write(close_prefs(last, app_quitting));
    }

    fn write(&self, patch: Map<String, Value>) {
        let inner = self.inner.borrow();
        if let Err(error) = inner.prefs.save(patch) {
            inner.logger.log(
                Level::Warn,
                &format!(
                    "[windows] the captions frame was not saved to {}: {error}",
                    inner.prefs.path().display()
                ),
            );
        }
    }
}

struct Open {
    frame: CaptionsFrame,
    app_id: &'static str,
    window: Option<WindowHandle<CaptionsReader>>,
    quitting: bool,
}

impl Global for Open {}

/// The open reader's window, for the smoke commands (bounds, raise).
pub fn handle(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<Open>()
        .and_then(|open| open.window)
        .map(Into::into)
}

/// Closes the reader if it is open (the smoke's `captions-window-close`).
pub fn close(cx: &mut App) {
    if let Some(window) = cx.try_global::<Open>().and_then(|open| open.window) {
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
}

/// Whether the reader is open, for the page's Open/Close button.
pub fn is_open(cx: &App) -> bool {
    cx.try_global::<Open>()
        .is_some_and(|open| open.window.is_some())
}

/// The window's menu command (⇧⌘C) and reopen-at-launch. Call once the main
/// window is up and the feed is installed.
pub fn install(cx: &mut App, frame: CaptionsFrame, app_id: &'static str) {
    let reopens = frame.reopens();
    cx.set_global(Open {
        frame,
        app_id,
        window: None,
        quitting: false,
    });
    cx.on_action(|_: &ToggleCaptions, cx| toggle(cx));
    cx.on_window_closed(|cx, id| {
        let open = cx.global_mut::<Open>();
        if open.window.is_some_and(|window| window.window_id() == id) {
            open.window = None;
            open.frame.closed(open.quitting);
            // The page's button says Open again.
            if let Some(feed) = feed::feed(cx) {
                feed.update(cx, |_, cx| cx.notify());
            }
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

pub fn toggle(cx: &mut App) {
    match cx.global::<Open>().window {
        Some(window) => {
            let _ = window.update(cx, |_, window, _| window.remove_window());
        }
        None => show(cx),
    }
}

pub fn show(cx: &mut App) {
    if let Some(window) = cx.global::<Open>().window {
        let _ = window.update(cx, |_, window, _| window.activate_window());
        return;
    }
    let Some(feed) = feed::feed(cx) else {
        eprintln!("[videorc-app] the Captions reader has no caption feed");
        return;
    };
    let (frame, app_id) = {
        let open = cx.global::<Open>();
        (open.frame.clone(), open.app_id)
    };
    let bounds = frame
        .opening(cx)
        .unwrap_or_else(|| Bounds::centered(None, size(px(DEFAULT_WIDTH), px(DEFAULT_HEIGHT)), cx));
    let mut options = window::options(c::READER_NAME, bounds);
    options.window_min_size = Some(size(px(MIN_WIDTH), px(MIN_HEIGHT)));
    options.app_id = Some(app_id.into());
    let opened = cx.open_window(options, move |window, cx| {
        cx.new(|cx| CaptionsReader::new(frame, feed, window, cx))
    });
    match opened {
        Ok(handle) => {
            cx.global_mut::<Open>().window = Some(handle);
            if let Some(feed) = feed::feed(cx) {
                feed.update(cx, |_, cx| cx.notify());
            }
        }
        Err(error) => eprintln!("[videorc-app] the Captions reader did not open: {error:#}"),
    }
}

pub struct CaptionsReader {
    frame: CaptionsFrame,
    feed: Entity<CaptionsFeed>,
    pinned: bool,
    scroll: ScrollHandle,
    last_line: Option<String>,
    _bounds: Subscription,
    _feed: Subscription,
}

impl CaptionsReader {
    fn new(
        frame: CaptionsFrame,
        feed: Entity<CaptionsFeed>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let pinned =
            frame.always_on_top() && platform::current().set_keep_on_top(window, true).is_ok();
        frame.moved(window);
        let bounds = cx.observe_window_bounds(window, {
            let frame = frame.clone();
            move |_, window, _| frame.moved(window)
        });
        let feed_sub = cx.observe(&feed, |_, _, cx| cx.notify());
        // Part of the show: the stream may capture it.
        let _ = HideFromStream::apply(window, WindowRole::Captions, false, cx);
        Self {
            frame,
            feed,
            pinned,
            scroll: ScrollHandle::new(),
            last_line: None,
            _bounds: bounds,
            _feed: feed_sub,
        }
    }

    fn set_pinned(&mut self, pinned: bool, window: &Window, cx: &mut Context<Self>) {
        if platform::current().set_keep_on_top(window, pinned).is_ok() {
            self.pinned = pinned;
            self.frame.set_always_on_top(pinned);
        }
        cx.notify();
    }
}

fn status_tone(tone: Tone) -> StatusTone {
    match tone {
        Tone::Good => StatusTone::Good,
        Tone::Warn => StatusTone::Warn,
        Tone::Error => StatusTone::Error,
        Tone::Neutral => StatusTone::Neutral,
    }
}

/// The newest line's size: the reader's Small, Medium and Large.
fn latest_size(text_size: &str) -> f32 {
    match text_size {
        "s" => 20.,
        "l" => 36.,
        _ => 30.,
    }
}

impl Render for CaptionsReader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let mac = cfg!(target_os = "macos");
        let feed = self.feed.read(cx);
        let status = feed.status();
        let recent: Vec<c::CaptionLine> = feed.lines().tail(c::READER_LINES).to_vec();
        let latest_final = feed.lines().latest_final().map(str::to_string);
        let snapshot = feed.studio().snapshot();
        let captions = &snapshot.settings.capture_doc["captions"];
        let top = captions["position"].as_str() == Some("top");
        let size = latest_size(captions["textSize"].as_str().unwrap_or("m"));
        let style = c::style(captions["styleId"].as_str().unwrap_or("classic"));
        let notice = c::reader_notice(&status, recent.len());

        // Captions follow the latest speech: no unread state.
        let newest = recent.last().map(c::CaptionLine::identity);
        if newest != self.last_line {
            self.last_line = newest;
            self.scroll.scroll_to_bottom();
        }

        let mut body = div()
            .id("captions-reader-feed")
            .flex_1()
            .min_h(px(0.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .px(px(20.))
            .py(px(16.))
            .overflow_y_scroll()
            .track_scroll(&self.scroll);
        body = if top {
            body.justify_start()
        } else {
            body.justify_end()
        };
        if let Some(notice) = notice {
            let mut line = div()
                .id("captions-reader-notice")
                .flex()
                .items_start()
                .gap(px(8.))
                // `text-lg`: 18 px on a 28 px line, normal weight (the root's
                // label scale would make it semibold on a 16 px line).
                .text_size(px(18.))
                .line_height(px(28.))
                .font_weight(gpui::FontWeight::NORMAL)
                .text_color(hsla(if notice.failed {
                    t.foreground
                } else {
                    t.muted_foreground
                }));
            if notice.failed {
                // `mt-1 size-4`: on the 28 px line.
                line =
                    line.child(icon(IconName::WarningCircle, 16., hsla(t.destructive)).mt(px(4.)));
            }
            body = body.child(line.child(notice.text));
        }
        let count = recent.len();
        for (index, line) in recent.into_iter().enumerate() {
            let latest = index + 1 == count;
            let mut row = div()
                .id(gpui::SharedString::from(format!(
                    "reader-{}",
                    line.identity()
                )))
                // `leading-snug`.
                .line_height(gpui::relative(1.375));
            row = if latest {
                row.text_size(px(size))
                    .font_weight(if style.id == "high-contrast" {
                        gpui::FontWeight::BOLD
                    } else {
                        gpui::FontWeight::SEMIBOLD
                    })
                    .text_color(hsla(if line.is_partial() {
                        t.muted_foreground
                    } else {
                        t.foreground
                    }))
                    .when(style.id == "lower-third", |row| row.w_full())
            } else {
                // `text-xl text-muted-foreground`, normal weight.
                row.text_size(px(20.))
                    .font_weight(gpui::FontWeight::NORMAL)
                    .text_color(hsla(t.muted_foreground))
            };
            body = body.child(row.child(line.text));
        }

        let pinned = self.pinned;
        let this = cx.entity().downgrade();
        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .type_scale(text::LABEL)
            .text_color(hsla(t.foreground))
            .child(
                WindowHeader::new(c::READER_NAME)
                    .mac(mac)
                    .meta(
                        StatusDot::new("captions-reader-status")
                            .tone(status_tone(status.tone(None)))
                            .label(status.label(None, false)),
                    )
                    .child(
                        PinWindowButton::new("captions-reader-keep-on-top")
                            .pinned(pinned)
                            .on_pinned_change(move |next, _, window, app| {
                                let _ =
                                    this.update(app, |this, cx| this.set_pinned(next, window, cx));
                            }),
                    ),
            )
            .child(body)
            // Screen readers hear settled lines only.
            .children(latest_final.map(|text| {
                div()
                    .id("captions-reader-announcement")
                    .absolute()
                    .w(px(1.))
                    .h(px(1.))
                    .overflow_hidden()
                    .child(format!("Final caption: {text}"))
            }));
        WindowFrame::new().child(root)
    }
}
