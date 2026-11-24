//! The Notes window (`openNotesWindow`): ⇧⌘N, WindowFrame, teleprompter
//! textarea, text size, Keep on top, and the capture-hidden footer.

use gpui::{
    App, AppContext, Bounds, Context, FocusHandle, Global, Subscription, Window, WindowHandle, div,
    prelude::*, px, size,
};
use gpui_base::input::{InputEvent, Textarea, TextareaState};
use videorc_app_core::desktop::capture_protection::{ProtectionResult, WindowRole};
use videorc_kit::{
    alert::{Alert, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    pin_window_button::PinWindowButton,
    segmented_control::{Segment, SegmentedControl},
    status_bar::StatusBar,
    theme::{self, FONT, hsla, with_alpha},
    window,
    window_frame::{WindowFrame, WindowHeader},
};

use super::document::{
    self, CAPTURE_EXPOSED_BODY, CAPTURE_EXPOSED_TITLE, FontScale, HIDDEN_FROM_CAPTURE, LOAD_FAILED,
    PLACEHOLDER, RETRY, SAVE_FAILED, SaveState, TEXT_SIZE, WINDOW_NAME,
};
use super::frame::{DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, NotesFrame};
use crate::app::hide::HideFromStream;
use crate::app::menus::ToggleNotes;

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
    let bounds = frame.opening(cx).unwrap_or_else(|| {
        Bounds::centered(
            None,
            size(px(DEFAULT_WIDTH as f32), px(DEFAULT_HEIGHT as f32)),
            cx,
        )
    });
    let mut options = window::options(WINDOW_NAME, bounds);
    options.window_min_size = Some(size(px(MIN_WIDTH), px(MIN_HEIGHT)));
    options.app_id = Some(app_id.into());
    let opened = cx.open_window(options, move |window, cx| {
        cx.new(|cx| Notes::new(frame, window, cx))
    });
    match opened {
        Ok(window) => cx.global_mut::<Open>().window = Some(window),
        Err(error) => eprintln!("[videorc-app] Notes did not open: {error:#}"),
    }
}

pub struct Notes {
    frame: NotesFrame,
    text: gpui::Entity<TextareaState>,
    scale: FontScale,
    save: SaveState,
    load_failed: bool,
    capture_protected: bool,
    pinned: bool,
    focus: FocusHandle,
    _bounds: Subscription,
    _text: Subscription,
}

impl Notes {
    fn new(frame: NotesFrame, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let prefs = frame.prefs();
        let (loaded_text, scale) =
            document::load(&prefs).unwrap_or_else(|_| (String::new(), FontScale::default()));
        let load_failed = false;
        let pinned = frame.always_on_top();
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
                this.queue_save(state.read(cx).value().to_string(), cx);
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
            focus,
            _bounds: bounds,
            _text: text_sub,
        }
    }

    fn queue_save(&mut self, value: String, cx: &mut Context<Self>) {
        if self.load_failed {
            return;
        }
        self.save = SaveState::Saving;
        cx.notify();
        match document::save(&self.frame.prefs(), &value, self.scale) {
            Ok(()) => self.save = SaveState::Saved,
            Err(_) => self.save = SaveState::Failed,
        }
        cx.notify();
    }

    fn flush_save(&mut self, cx: &mut Context<Self>) {
        if self.load_failed {
            return;
        }
        let value = self.text.read(cx).value().to_string();
        self.queue_save(value, cx);
    }

    fn retry_load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match document::load(&self.frame.prefs()) {
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
        let value = self.text.read(cx).value().to_string();
        self.queue_save(value, cx);
    }

    fn set_pinned(&mut self, pinned: bool, cx: &mut Context<Self>) {
        self.pinned = pinned;
        self.frame.set_always_on_top(pinned);
        cx.notify();
    }
}

impl Render for Notes {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let mac = cfg!(target_os = "macos");
        let scale = self.scale;
        let words = document::words_label(document::word_count(&self.text.read(cx).value()));
        let save_words = self.save.words();
        let pinned = self.pinned;
        let this = cx.entity().downgrade();
        let text_size = scale.px();

        self.text.update(cx, |state, cx| {
            if state.presentation().is_disabled() != self.load_failed {
                state.set_disabled(self.load_failed, cx);
            }
            state.set_editor_style(gpui_base::input::InputEditorStyle {
                foreground: hsla(t.foreground),
                muted_foreground: hsla(t.muted_foreground),
                background: gpui::transparent_black(),
                border: gpui::transparent_black(),
                selection: hsla(with_alpha(t.foreground, 0.2)),
                caret: hsla(t.foreground),
                ..Default::default()
            });
        });

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
                    .small()
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
                PinWindowButton::new("notes-keep-on-top")
                    .status_bar()
                    .pinned(pinned)
                    .on_pinned_change({
                        let this = this.clone();
                        move |next, _, _, app| {
                            let _ = this.update(app, |this, cx| {
                                this.set_pinned(next, cx);
                            });
                        }
                    }),
            );

        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .font_family(FONT)
            .child(WindowHeader::new(WINDOW_NAME).mac(mac))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .px(px(22.))
                    .py(px(20.))
                    .text_size(px(text_size))
                    .line_height(px(text_size * 1.45))
                    .text_color(hsla(t.foreground))
                    .child(div().size_full().child(Textarea::new(&self.text))),
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
