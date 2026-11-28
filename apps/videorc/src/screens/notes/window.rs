//! The Notes window (`openNotesWindow`): ⇧⌘N, WindowFrame, teleprompter
//! textarea, text size, Keep on top, and the capture-hidden footer.

use gpui::{
    App, AppContext, Context, FocusHandle, Global, Subscription, Window, WindowHandle, div,
    prelude::*, px,
};
use gpui_base::input::InputEvent;
use videorc_app_core::desktop::capture_protection::{ProtectionResult, WindowRole};
use videorc_app_core::notes::{
    self, ARIA_LABEL, CAPTURE_EXPOSED_BODY, CAPTURE_EXPOSED_TITLE, FontScale, HIDDEN_FROM_CAPTURE,
    LOAD_FAILED, PLACEHOLDER, PinError, RETRY, SAVE_FAILED, SaveState, TEXT_SIZE, WINDOW_NAME,
};
use videorc_kit::{
    alert::{Alert, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    pin_window_button::PinWindowButton,
    segmented_control::{Segment, SegmentedControl},
    status_bar::StatusBar,
    textarea::{Textarea, TextareaState},
    theme::{self, FONT, hsla},
    window,
    window_frame::{WindowFrame, WindowHeader},
};

use super::frame::{DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, NotesFrame};
use crate::app::hide::HideFromStream;
use crate::app::menus::ToggleNotes;
use crate::platform;

/// The one window, its frame file, and whether the quit is closing it.
struct Open {
    frame: NotesFrame,
    app_id: &'static str,
    window: Option<WindowHandle<Notes>>,
    quitting: bool,
}

impl Global for Open {}

/// The window's menu command and reopen-at-launch. Call once the main
/// window is up.
pub fn install(cx: &mut App, frame: NotesFrame, app_id: &'static str) {
    let reopens = frame.reopens();
    cx.set_global(Open {
        frame,
        app_id,
        window: None,
        quitting: false,
    });
    cx.on_action(|_: &ToggleNotes, cx| toggle(cx));
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
pub fn view(cx: &App) -> Option<WindowHandle<Notes>> {
    cx.try_global::<Open>().and_then(|open| open.window)
}

/// The open window, for the smoke driver; `None` while it is closed.
pub fn handle(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<Open>()
        .and_then(|open| open.window)
        .map(Into::into)
}

pub fn toggle(cx: &mut App) {
    let open = cx.global::<Open>().window;
    match open {
        Some(window) => {
            let _ = window.update(cx, |this, window, cx| {
                this.flush_save(cx);
                window.remove_window();
            });
        }
        None => show(cx),
    }
}

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
    let (bounds, min_size) = crate::app::frames::clamp_opening_bounds(
        frame.opening(cx),
        (DEFAULT_WIDTH, DEFAULT_HEIGHT),
        (f64::from(MIN_WIDTH), f64::from(MIN_HEIGHT)),
        cx,
    );
    let mut options = window::options(WINDOW_NAME, bounds);
    options.window_min_size = Some(min_size);
    options.app_id = Some(app_id.into());
    let opened = cx.open_window(options, move |window, cx| {
        cx.new(|cx| Notes::new(frame, window, cx))
    });
    match opened {
        Ok(window) => cx.global_mut::<Open>().window = Some(window),
        Err(error) => eprintln!("[videorc-app] Notes did not open: {error:#}"),
    }
    crate::app::remote_keys::report(cx);
}

pub struct Notes {
    frame: NotesFrame,
    text: gpui::Entity<TextareaState>,
    scale: FontScale,
    save: SaveState,
    load_failed: bool,
    capture_protected: bool,
    pinned: bool,
    pin_error: Option<PinError>,
    focus: FocusHandle,
    _bounds: Subscription,
    _text: Subscription,
}

impl Notes {
    fn new(frame: NotesFrame, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let prefs = frame.prefs();
        let (loaded_text, scale) =
            notes::load(&prefs).unwrap_or_else(|_| (String::new(), FontScale::default()));
        let load_failed = false;
        let pinned = frame.always_on_top();
        let pin_error = match platform::current().set_keep_on_top(window, pinned) {
            Ok(()) => None,
            Err(_) if pinned => Some(pin_error_for_platform()),
            Err(_) => None,
        };
        let text = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(PLACEHOLDER)
                .default_value(loaded_text)
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        frame.moved(window);
        let bounds = cx.observe_window_bounds(window, {
            let frame = frame.clone();
            move |_, window, _| frame.moved(window)
        });
        let text_sub = cx.subscribe(&text, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let value = notes::clamp_text(&state.read(cx).value());
                this.queue_save(value, cx);
            }
            if matches!(event, InputEvent::Blur) {
                this.flush_save(cx);
            }
        });
        let capture = HideFromStream::apply(window, WindowRole::Notes, true, cx);
        let capture_protected = matches!(
            capture,
            ProtectionResult::Protected | ProtectionResult::AlreadyProtected
        );
        Self {
            frame,
            text,
            scale,
            save: SaveState::Saved,
            load_failed,
            capture_protected,
            pinned,
            pin_error,
            focus,
            _bounds: bounds,
            _text: text_sub,
        }
    }

    fn queue_save(&mut self, value: String, cx: &mut Context<Self>) {
        if self.load_failed {
            return;
        }
        let value = notes::clamp_text(&value);
        self.save = SaveState::Saving;
        cx.notify();
        match notes::save(&self.frame.prefs(), &value, self.scale) {
            Ok(()) => self.save = SaveState::Saved,
            Err(_) => self.save = SaveState::Failed,
        }
        cx.notify();
    }

    fn flush_save(&mut self, cx: &mut Context<Self>) {
        if self.load_failed {
            return;
        }
        let value = notes::clamp_text(&self.text.read(cx).value());
        self.queue_save(value, cx);
    }

    fn retry_load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match notes::load(&self.frame.prefs()) {
            Ok((text, scale)) => {
                self.scale = scale;
                self.load_failed = false;
                self.save = SaveState::Saved;
                self.text.update(cx, |state, cx| {
                    state.set_disabled(false, cx);
                    state.set_value(text, window, cx);
                });
            }
            Err(_) => {
                self.load_failed = true;
                self.save = SaveState::Failed;
            }
        }
        cx.notify();
    }

    fn retry_save(&mut self, cx: &mut Context<Self>) {
        self.flush_save(cx);
    }

    fn set_scale(&mut self, scale: FontScale, cx: &mut Context<Self>) {
        self.scale = scale;
        let value = notes::clamp_text(&self.text.read(cx).value());
        self.queue_save(value, cx);
    }

    /// `notes-window-state`'s view half (Electron's `notesWindowState`).
    pub fn smoke_state(&self, window: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({
            "alwaysOnTop": self.pinned,
            "protected": self.capture_protected,
            "fontScale": self.scale.id(),
            "text": self.text.read(cx).value().to_string(),
            "windowId": platform::current().capture_window_id(window),
        })
    }

    /// `notes-window-save-document {text?, fontScale?}`: the text and size
    /// set in the window as typing and the size control would, then saved.
    /// A failed save is the answer's error, as Electron's throws.
    pub fn smoke_save_document(
        &mut self,
        text: Option<String>,
        scale: Option<FontScale>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.load_failed {
            return Err("notes-window-save-document: Notes did not load.".to_string());
        }
        if let Some(scale) = scale {
            self.scale = scale;
        }
        if let Some(text) = text {
            let text = notes::clamp_text(&text);
            self.text
                .update(cx, |state, cx| state.set_value(text, window, cx));
        }
        self.flush_save(cx);
        match self.save {
            SaveState::Failed => Err("notes-window-save-document: the save failed.".to_string()),
            _ => Ok(()),
        }
    }

    fn set_pinned(&mut self, pinned: bool, window: &Window, cx: &mut Context<Self>) {
        let previous = self.pinned;
        self.pinned = pinned;
        self.pin_error = None;
        match platform::current().set_keep_on_top(window, pinned) {
            Ok(()) => {
                self.frame.set_always_on_top(pinned);
            }
            Err(_) => {
                self.pinned = previous;
                self.pin_error = Some(pin_error_for_platform());
            }
        }
        cx.notify();
    }
}

/// Electron's unavailable vs failed: platforms without Keep on top are
/// unavailable; a platform that tried and failed is failed.
fn pin_error_for_platform() -> PinError {
    if cfg!(target_os = "macos") {
        PinError::Failed
    } else {
        PinError::Unavailable
    }
}

impl Render for Notes {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let mac = cfg!(target_os = "macos");
        let scale = self.scale;
        let words = notes::words_label(notes::word_count(&self.text.read(cx).value()));
        let save_words = self.save.words();
        let pinned = self.pinned;
        let pin_error = self.pin_error;
        let this = cx.entity().downgrade();
        let text_size = scale.px();

        let mut status = StatusBar::new().leading(div().child(words));
        if !self.load_failed {
            status = status.leading(div().child(save_words));
        }
        if self.capture_protected {
            status = status.leading(
                div()
                    .min_w(px(0.))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(HIDDEN_FROM_CAPTURE),
            );
        }
        status = status
            .child(
                SegmentedControl::new("notes-text-size")
                    .small(true)
                    .manual(true)
                    .accessibility_label(TEXT_SIZE)
                    .value(Some(scale.id()))
                    .option(
                        Segment::new(FontScale::Sm.id(), FontScale::Sm.label())
                            .tooltip(FontScale::Sm.aria_label()),
                    )
                    .option(
                        Segment::new(FontScale::Md.id(), FontScale::Md.label())
                            .tooltip(FontScale::Md.aria_label()),
                    )
                    .option(
                        Segment::new(FontScale::Lg.id(), FontScale::Lg.label())
                            .tooltip(FontScale::Lg.aria_label()),
                    )
                    .on_change({
                        let this = this.clone();
                        move |value, _, app| {
                            if let Some(scale) = FontScale::parse(value.as_ref()) {
                                let _ = this.update(app, |this, cx| {
                                    this.set_scale(scale, cx);
                                });
                            }
                        }
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .children(pin_error.map(|error| {
                        div()
                            .text_size(px(11.))
                            .text_color(hsla(t.foreground))
                            .child(error.words())
                    }))
                    .child(
                        PinWindowButton::new("notes-keep-on-top")
                            .status_bar()
                            .pinned(pinned)
                            .on_pinned_change({
                                let this = this.clone();
                                move |next, _, window, app| {
                                    let _ = this.update(app, |this, cx| {
                                        this.set_pinned(next, window, cx);
                                    });
                                }
                            }),
                    ),
            );

        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .font_family(FONT)
            .child(WindowHeader::new(WINDOW_NAME).mac(mac))
            .child(
                div().flex_1().min_h(px(0.)).px(px(22.)).py(px(20.)).child(
                    Textarea::new("notes-body", &self.text)
                        .plain(true)
                        .disabled(self.load_failed)
                        .text_size(px(text_size))
                        .accessibility_label(ARIA_LABEL)
                        .ground(t.glass_solid),
                ),
            );

        if !self.capture_protected {
            root = root.child(
                div()
                    .flex_none()
                    .w_full()
                    .p(px(8.))
                    .border_t_1()
                    .border_color(hsla(t.border))
                    .child(
                        Alert::new("notes-capture-exposed")
                            .variant(AlertVariant::Destructive)
                            .title(CAPTURE_EXPOSED_TITLE)
                            .description(CAPTURE_EXPOSED_BODY),
                    ),
            );
        }
        if self.load_failed {
            root = root.child(
                div()
                    .flex_none()
                    .w_full()
                    .px(px(12.))
                    .py(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(hsla(t.border))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(12.))
                            .child(LOAD_FAILED),
                    )
                    .child(
                        Button::new("notes-load-retry")
                            .label(RETRY)
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.retry_load(window, cx)),
                            ),
                    ),
            );
        }
        if self.save == SaveState::Failed && !self.load_failed {
            root = root.child(
                div()
                    .flex_none()
                    .w_full()
                    .px(px(12.))
                    .py(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(hsla(t.border))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(12.))
                            .child(SAVE_FAILED),
                    )
                    .child(
                        Button::new("notes-save-retry")
                            .label(RETRY)
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .on_click(cx.listener(|this, _, _, cx| this.retry_save(cx))),
                    ),
            );
        }

        WindowFrame::new().child(root.child(status))
    }
}
