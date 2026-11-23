//! Plan 260 spike S0.6: accessibility and testing under GPUI.
//!
//! Question: can a screen reader (VoiceOver, Narrator, Orca) read a GPUI
//! list and dialog through AccessKit; can a headless test click Record; and
//! can a UI driver find a control by role and name through the same tree?
//!
//! The window has a Record button, a list of scenes and a "Delete scene…"
//! button that opens a modal dialog. Every control has a role and a name.
//! `--dump-tree <path>` writes GPUI's own view of the accessibility tree
//! (`Window::debug_a11y_tree_json`) after each change. The tests at the
//! bottom click Record headlessly (`cargo test -p spike-a11y`).

use gpui::{
    App, AppContext, Bounds, Context, FocusHandle, Focusable, FontWeight, KeyBinding, Role,
    SharedString, TitlebarOptions, Window, WindowBounds, WindowOptions, actions, div, prelude::*,
    px, rgb, size, text,
};
use serde_json::json;
use spike_summary::{Run, round};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const SPIKE: &str = "spike-a11y";

actions!(spike_a11y, [Tab, TabPrev, Dismiss]);

static RENDERS: AtomicU64 = AtomicU64::new(0);
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn event(text: impl Into<String>) {
    let text = text.into();
    println!("[spike] {text}");
    EVENTS.lock().expect("events").push(text);
}

const GROUND: u32 = 0x070707;
const PANE: u32 = 0x101010;
const HAIRLINE: u32 = 0x262626;
const INK: u32 = 0xededed;
const INK_2: u32 = 0xa1a1a1;
const RED: u32 = 0xe5484d;

pub const SCENES: [&str; 6] = [
    "Camera only",
    "Screen and camera",
    "Screen only",
    "Interview",
    "Be right back",
    "Ending",
];

pub struct Studio {
    focus: FocusHandle,
    pub recording: bool,
    pub selected: usize,
    pub dialog_open: bool,
    pub deleted: Vec<String>,
    dump: Option<PathBuf>,
}

impl Studio {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, dump: Option<PathBuf>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            focus,
            recording: false,
            selected: 0,
            dialog_open: false,
            deleted: Vec::new(),
            dump,
        }
    }

    pub fn toggle_record(&mut self, cx: &mut Context<Self>) {
        self.recording = !self.recording;
        event(if self.recording {
            "record started"
        } else {
            "record stopped"
        });
        cx.notify();
    }

    fn open_dialog(&mut self, cx: &mut Context<Self>) {
        self.dialog_open = true;
        event(format!("dialog opened for {:?}", SCENES[self.selected]));
        cx.notify();
    }

    fn close_dialog(&mut self, delete: bool, cx: &mut Context<Self>) {
        if delete {
            self.deleted.push(SCENES[self.selected].to_owned());
            event(format!("deleted {:?}", SCENES[self.selected]));
        } else {
            event("dialog cancelled");
        }
        self.dialog_open = false;
        cx.notify();
    }
}

impl Focusable for Studio {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn button(id: &'static str, label: &str, primary: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .focusable()
        .tab_stop(true)
        .role(Role::Button)
        .aria_label(SharedString::from(label.to_owned()))
        .h(px(28.))
        .px_3()
        .flex()
        .items_center()
        .rounded(px(6.))
        .bg(rgb(if primary { RED } else { 0x1c1c1c }))
        .border_1()
        .border_color(rgb(HAIRLINE))
        .text_size(px(13.))
        .text_color(rgb(INK))
        .cursor_pointer()
        .focus_visible(|s| s.border_color(rgb(0x3b82f6)))
        .child(text!(label.to_owned()))
}

impl Render for Studio {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let n = RENDERS.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 {
            window.on_next_frame(|_, _| {
                let us = (spike_summary::elapsed_ms() * 1000.0) as u64;
                FIRST_PAINT_US.store(us.max(1), Ordering::Relaxed);
            });
        }
        if let Some(path) = self.dump.clone() {
            // The tree is built during this frame; write it after it is sent.
            window.on_next_frame(move |window, _| {
                if let Some(json) = window.debug_a11y_tree_json() {
                    let _ = std::fs::write(&path, json);
                }
            });
        }

        let record_label = if self.recording {
            "Stop recording"
        } else {
            "Record"
        };
        let header = div()
            .id("header")
            .role(Role::Toolbar)
            .aria_label("Studio")
            .h(px(40.))
            .flex_none()
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .border_b_1()
            .border_color(rgb(HAIRLINE))
            .child(
                div()
                    .id("title")
                    .role(Role::Heading)
                    .aria_level(1)
                    .aria_label("Studio")
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(text!("Studio")),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("status")
                    .role(Role::Status)
                    .aria_label(if self.recording { "Recording" } else { "Ready" })
                    .text_size(px(12.))
                    .text_color(rgb(INK_2))
                    .child(text!(if self.recording {
                        "● Recording"
                    } else {
                        "Ready"
                    })),
            )
            .child(
                button("record", record_label, !self.recording)
                    .debug_selector(|| "record-button".into())
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_record(cx))),
            );

        let list = div()
            .id("scenes")
            .role(Role::List)
            .aria_label("Scenes")
            .flex()
            .flex_col()
            .gap_1()
            .children(SCENES.iter().enumerate().map(|(i, name)| {
                let selected = i == self.selected;
                div()
                    .id(("scene", i))
                    .focusable()
                    .tab_stop(true)
                    .role(Role::ListItem)
                    .aria_label(SharedString::from(*name))
                    .aria_selected(selected)
                    .aria_position_in_set(i + 1)
                    .aria_size_of_set(SCENES.len())
                    .h(px(28.))
                    .px_2()
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .text_size(px(14.))
                    .when(selected, |d| d.bg(rgb(0x262626)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected = i;
                        event(format!("selected {:?}", SCENES[i]));
                        cx.notify();
                    }))
                    .child(text!(name.to_string()))
            }));

        let body = div()
            .flex_1()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .id("scenes-label")
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(INK_2))
                    .child(text!("SCENES")),
            )
            .child(list)
            .child(
                div().flex().child(
                    button("delete", "Delete scene…", false)
                        .on_click(cx.listener(|this, _, _, cx| this.open_dialog(cx))),
                ),
            );

        let mut root = div()
            .id("root")
            .role(Role::Application)
            .aria_label("spike-a11y")
            .key_context("Studio")
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &Tab, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &TabPrev, window, cx| window.focus_prev(cx)))
            .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                if this.dialog_open {
                    this.close_dialog(false, cx);
                }
            }))
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(rgb(GROUND))
            .text_color(rgb(INK))
            .child(header)
            .child(body);

        if self.dialog_open {
            let name = SCENES[self.selected];
            root = root.child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(gpui::rgba(0x000000a0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .id("dialog")
                            .role(Role::AlertDialog)
                            .aria_label(SharedString::from(format!("Delete {name}?")))
                            .aria_description(
                                "The scene and its layout are removed. Recordings are kept.",
                            )
                            .w(px(420.))
                            .p_4()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .rounded(px(10.))
                            .bg(rgb(PANE))
                            .border_1()
                            .border_color(rgb(HAIRLINE))
                            .child(
                                div()
                                    .id("dialog-title")
                                    .role(Role::Heading)
                                    .aria_level(2)
                                    .aria_label(SharedString::from(format!("Delete {name}?")))
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(text!(format!("Delete {name}?"))),
                            )
                            .child(
                                div()
                                    .id("dialog-body")
                                    .text_size(px(13.))
                                    .text_color(rgb(INK_2))
                                    .child(text!(
                                        "The scene and its layout are removed. Recordings are kept."
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .justify_end()
                                    .gap_2()
                                    .child(button("cancel", "Cancel", false).on_click(
                                        cx.listener(|this, _, _, cx| this.close_dialog(false, cx)),
                                    ))
                                    .child(button("confirm", "Delete", true).on_click(
                                        cx.listener(|this, _, _, cx| this.close_dialog(true, cx)),
                                    )),
                            ),
                    ),
            );
        }
        root
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", Tab, None),
        KeyBinding::new("shift-tab", TabPrev, None),
        KeyBinding::new("escape", Dismiss, None),
    ]);
}

fn main() {
    let run = Run::start(SPIKE);
    let seconds = run.args.seconds;
    let dump = run.args.value("--dump-tree").map(PathBuf::from);
    let run = Arc::new(Mutex::new(run));

    gpui_platform::application().run(move |cx: &mut App| {
        bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(900.), px(640.)), cx);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SPIKE.into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| Studio::new(window, cx, dump)),
        );
        let handle = match opened {
            Ok(h) => h,
            Err(e) => {
                spike_summary::error(format!("open_window failed: {e:#}"));
                run.lock().expect("run").finish();
            }
        };
        cx.activate(true);

        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(seconds))
                .await;
            let mut run = run.lock().expect("run");
            let _ = handle.update(cx, |studio, window, _| {
                let tree = window.debug_a11y_tree_json();
                let nodes = tree
                    .as_deref()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
                    .map(|v| count_nodes(&v))
                    .unwrap_or(0);
                run.set("a11y_tree_available", tree.is_some());
                run.set("a11y_nodes", nodes);
                run.set("recording_at_end", studio.recording);
                run.set("deleted_scenes", json!(studio.deleted));
            });
            let renders = RENDERS.load(Ordering::Relaxed);
            run.set("renders", renders);
            let fp = FIRST_PAINT_US.load(Ordering::Relaxed);
            if fp > 0 {
                run.set("startup_to_first_paint_ms", round(fp as f64 / 1000.0, 1));
            }
            run.set("events", json!(*EVENTS.lock().expect("events")));
            run.finish();
        })
        .detach();
    });
}

/// Counts objects with a "role" key anywhere in the debug JSON.
fn count_nodes(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Object(m) => {
            (m.contains_key("role") as u64) + m.values().map(count_nodes).sum::<u64>()
        }
        serde_json::Value::Array(a) => a.iter().map(count_nodes).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Modifiers, TestAppContext};

    /// A headless test clicks Record: no window server, no screen.
    #[gpui::test]
    fn clicking_record_starts_and_stops(cx: &mut TestAppContext) {
        cx.update(bind_keys);
        let (studio, cx) = cx.add_window_view(|window, cx| Studio::new(window, cx, None));
        cx.run_until_parked();
        let bounds = cx
            .debug_bounds("record-button")
            .expect("the Record button is laid out");
        cx.simulate_click(bounds.center(), Modifiers::none());
        assert!(studio.read_with(cx, |s, _| s.recording));
        cx.simulate_click(bounds.center(), Modifiers::none());
        assert!(!studio.read_with(cx, |s, _| s.recording));
    }
}
