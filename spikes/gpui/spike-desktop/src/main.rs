//! Plan 260 spike S0.7: desktop integration under GPUI.
//!
//! Question: does GPUI (with a few raw-handle calls) cover every desktop job
//! Electron's main process does for Videorc today? Each row of the S0.7
//! table is one control here, reachable from a button and from the menu bar
//! (so a driver can run it through the accessibility tree):
//!
//! 1. Menus: `cx.set_menus` with the app, File, Edit and Window menus.
//! 2. The title bar: the traffic lights over a 40 px custom header that
//!    drags the window and zooms on a double-click.
//! 3. A global shortcut: Ctrl+Option+Shift+R (Ctrl+Alt+Shift+R) through the
//!    `global-hotkey` crate, with another app in front.
//! 4. A deep link on a cold start: `videorc-spike://…` through
//!    `on_open_urls` (macOS needs the bundle from `bundle-macos.sh`).
//! 5. One instance: a second start hands its arguments to the first.
//! 6. Window order: a "Keep on top" window above other apps' windows.
//! 7. Hide from stream: a window marked hidden is absent from captures.
//! 8. The sleep guard: "Keep awake" holds the display awake.
//! 9. A system notification through GPUI.
//! 10. Files: the open dialog, Show in Finder, Move to Trash, drag and drop.
//!
//! The spike logs each event as `[spike] <event>`, closes itself after
//! `--seconds` (or on Quit), and writes summary.json with what happened.

mod os;
mod single_instance;

use gpui::{
    App, AppContext, Bounds, Context, ExternalPaths, KeyBinding, Menu, MenuItem, MouseButton,
    MouseDownEvent, OsAction, PathPromptOptions, SharedString, SystemMenuType, SystemNotification,
    TitlebarOptions, Window, WindowBounds, WindowControlArea, WindowHandle, WindowKind,
    WindowOptions, actions, div, point, prelude::*, px, rgb, size,
};
use serde_json::{Value, json};
use spike_summary::{Run, round};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

const SPIKE: &str = "spike-desktop";
const SCHEME: &str = "videorc-spike";
const HOTKEY_LABEL: &str = "Ctrl+Option+Shift+R";

actions!(
    spike_desktop,
    [
        About,
        HideApp,
        HideOthers,
        ShowAll,
        Quit,
        OpenFiles,
        RevealSample,
        TrashSample,
        Undo,
        Redo,
        Cut,
        Copy,
        Paste,
        SelectAll,
        Minimize,
        Zoom,
        ToggleOnTop,
        ToggleHidden,
        ToggleKeepAwake,
        PostNotification,
        RaiseTestWindows,
    ]
);

static RENDERS: AtomicU64 = AtomicU64::new(0);
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);
static HOTKEY_PRESSES: AtomicU64 = AtomicU64::new(0);
static MAIN_WINDOW_OPEN: AtomicBool = AtomicBool::new(false);
/// Links the platform delivered, with the time they arrived (ms since start)
/// and whether the main window existed yet.
static OPENED_URLS: Mutex<Vec<(String, f64, bool)>> = Mutex::new(Vec::new());

/// Everything that happened, for the window's log and the summary.
#[derive(Default)]
struct Facts {
    log: Vec<String>,
    menu_actions: Vec<String>,
    open_urls: Vec<Value>,
    handoffs: Vec<Vec<String>>,
    hidden_window: Value,
    on_top_window: Value,
    keep_awake_assertions: u64,
    notifications_posted: u64,
    notification_responses: Vec<Value>,
    picked_paths: Vec<String>,
    revealed_paths: Vec<String>,
    trashed_paths: Vec<String>,
    dropped_paths: Vec<String>,
    header_double_clicks: u64,
    header_drags: u64,
    reopens: u64,
}

static FACTS: Mutex<Option<Facts>> = Mutex::new(None);

fn with_facts<R>(f: impl FnOnce(&mut Facts) -> R) -> R {
    let mut guard = FACTS.lock().expect("facts");
    f(guard.get_or_insert_with(Facts::default))
}

/// Prints `[spike] <event>` and keeps it for the window's log.
fn event(text: impl Into<String>) {
    let text = text.into();
    println!("[spike] {text}");
    let ms = spike_summary::elapsed_ms();
    with_facts(|f| f.log.push(format!("{:>7.0} ms  {text}", ms)));
}

fn fail(text: impl Into<String>) {
    let text = text.into();
    spike_summary::error(text.clone());
    with_facts(|f| f.log.push(format!("ERROR {text}")));
}

/// The file Show in Finder and Move to Trash act on.
fn sample_path() -> PathBuf {
    std::env::temp_dir().join(SPIKE).join("sample.txt")
}

struct Toggles {
    on_top: bool,
    hidden: bool,
    keep_awake: Option<u32>,
}

/// The main window and the two test windows, reachable from App-level actions.
struct Shell {
    main: WindowHandle<Desktop>,
    hidden: Option<WindowHandle<Swatch>>,
    on_top: Option<WindowHandle<Swatch>>,
    toggles: Arc<Mutex<Toggles>>,
    run: Arc<Mutex<Run>>,
}

impl gpui::Global for Shell {}

// ---------------------------------------------------------------- the views

struct Desktop {
    dropping: bool,
}

/// A plain window of one colour, so a capture shows at a glance whether it
/// is there: magenta is hidden from capture, cyan is kept on top.
struct Swatch {
    label: SharedString,
    color: u32,
}

impl Render for Swatch {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(rgb(self.color))
            .flex()
            .items_center()
            .justify_center()
            .text_color(rgb(0x000000))
            .text_size(px(20.))
            .child(self.label.clone())
    }
}

const GROUND: u32 = 0x070707;
const PANE: u32 = 0x101010;
const HAIRLINE: u32 = 0x262626;
const INK: u32 = 0xededed;
const INK_2: u32 = 0xa1a1a1;

fn button(
    id: &'static str,
    label: impl Into<SharedString>,
    on: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .h(px(28.))
        .px_3()
        .flex()
        .items_center()
        .rounded(px(6.))
        .bg(rgb(0x1c1c1c))
        .border_1()
        .border_color(rgb(HAIRLINE))
        .text_size(px(13.))
        .text_color(rgb(INK))
        .hover(|s| s.bg(rgb(0x262626)))
        .active(|s| s.bg(rgb(0x2e2e2e)))
        .cursor_pointer()
        .on_click(move |_, window, cx| on(window, cx))
        .child(label.into())
}

fn row(title: &'static str, detail: String, control: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .py_2()
        .border_b_1()
        .border_color(rgb(HAIRLINE))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .child(div().text_size(px(14.)).text_color(rgb(INK)).child(title))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(INK_2))
                        .child(detail),
                ),
        )
        .child(control)
}

impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let n = RENDERS.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 {
            window.on_next_frame(|_, _| {
                let us = (spike_summary::elapsed_ms() * 1000.0) as u64;
                FIRST_PAINT_US.store(us.max(1), Ordering::Relaxed);
            });
        }
        let (on_top, hidden, awake) = cx
            .try_global::<Shell>()
            .map(|s| {
                let t = s.toggles.lock().expect("toggles");
                (t.on_top, t.hidden, t.keep_awake.is_some())
            })
            .unwrap_or_default();
        let (log, urls, handoffs, dropped) = with_facts(|f| {
            (
                f.log.iter().rev().take(18).cloned().collect::<Vec<_>>(),
                f.open_urls.len(),
                f.handoffs.len(),
                f.dropped_paths.len(),
            )
        });
        let on_off = |b: bool| if b { "on" } else { "off" };

        // The header: traffic lights sit in its 88 px gutter; it drags the
        // window and zooms (or minimises, per the user's setting) on a double-click.
        let header = div()
            .id("header")
            .h(px(40.))
            .flex_none()
            .w_full()
            .pl(px(88.))
            .pr_3()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(rgb(HAIRLINE))
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, |e: &MouseDownEvent, window, _| {
                if e.click_count == 2 {
                    with_facts(|f| f.header_double_clicks += 1);
                    event("header double-click (titlebar_double_click)");
                    window.titlebar_double_click();
                } else {
                    with_facts(|f| f.header_drags += 1);
                    window.start_window_move();
                }
            })
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(INK))
                    .child("spike-desktop"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(INK_2))
                    .child(format!("renders {n}")),
            );

        let checks = div()
            .flex_1()
            .p_4()
            .flex()
            .flex_col()
            .child(row(
                "Global shortcut",
                format!(
                    "{HOTKEY_LABEL} pressed {} times",
                    HOTKEY_PRESSES.load(Ordering::Relaxed)
                ),
                div(),
            ))
            .child(row(
                "Deep links and one instance",
                format!("{SCHEME}:// links {urls}; second starts handed over {handoffs}"),
                div(),
            ))
            .child(row(
                "Keep on top",
                format!("The cyan window: {}", on_off(on_top)),
                button("on-top", "Toggle keep on top", |w, cx| {
                    w.dispatch_action(Box::new(ToggleOnTop), cx)
                }),
            ))
            .child(row(
                "Hide from stream",
                format!("The magenta window: {}", on_off(hidden)),
                button("hidden", "Toggle hide from stream", |w, cx| {
                    w.dispatch_action(Box::new(ToggleHidden), cx)
                }),
            ))
            .child(row(
                "Keep awake",
                format!("Display sleep held: {}", on_off(awake)),
                button("awake", "Toggle keep awake", |w, cx| {
                    w.dispatch_action(Box::new(ToggleKeepAwake), cx)
                }),
            ))
            .child(row(
                "System notification",
                "Posts \"spike-desktop\" to the notification centre".into(),
                button("notify", "Post notification", |w, cx| {
                    w.dispatch_action(Box::new(PostNotification), cx)
                }),
            ))
            .child(row(
                "Open a file",
                "The system open dialog".into(),
                button("open", "Open…", |w, cx| {
                    w.dispatch_action(Box::new(OpenFiles), cx)
                }),
            ))
            .child(row(
                "Show in Finder",
                sample_path().display().to_string(),
                button("reveal", "Show in Finder", |w, cx| {
                    w.dispatch_action(Box::new(RevealSample), cx)
                }),
            ))
            .child(row(
                "Move to Trash",
                "Moves the sample file to the Trash".into(),
                button("trash", "Move to Trash", |w, cx| {
                    w.dispatch_action(Box::new(TrashSample), cx)
                }),
            ))
            .child(
                div()
                    .id("drop")
                    .mt_4()
                    .h(px(96.))
                    .rounded(px(8.))
                    .border_1()
                    .border_dashed()
                    .border_color(rgb(if self.dropping { 0xededed } else { 0x3a3a3a }))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(rgb(INK_2))
                    .drag_over::<ExternalPaths>(|s, _, _, _| s.bg(rgb(0x1c1c1c)))
                    .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                        this.dropping = false;
                        let list: Vec<String> = paths
                            .paths()
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect();
                        event(format!("dropped {list:?}"));
                        with_facts(|f| f.dropped_paths.extend(list));
                        cx.notify();
                    }))
                    .child(format!("Drop files here (dropped so far: {dropped})")),
            );

        let log_pane = div()
            .w(px(620.))
            .h_full()
            .p_4()
            .border_l_1()
            .border_color(rgb(HAIRLINE))
            .bg(rgb(PANE))
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(INK_2))
                    .child("EVENTS, NEWEST FIRST"),
            )
            .children(log.into_iter().map(|line| {
                div()
                    .text_size(px(12.))
                    .font_family("Menlo")
                    .text_color(rgb(INK))
                    .child(line)
            }));

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(GROUND))
            .child(header)
            .child(div().flex_1().flex().child(checks).child(log_pane))
    }
}

// ---------------------------------------------------------------- menus

fn menus(t: &Toggles) -> Vec<Menu> {
    vec![
        Menu::new(SPIKE).items([
            MenuItem::action("About spike-desktop", About),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide spike-desktop", HideApp),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit spike-desktop", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("Open…", OpenFiles),
            MenuItem::action("Show Sample in Finder", RevealSample),
            MenuItem::action("Move Sample to Trash", TrashSample),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Keep on Top", ToggleOnTop).checked(t.on_top),
            MenuItem::action("Hide from Stream", ToggleHidden).checked(t.hidden),
            MenuItem::action("Keep Awake", ToggleKeepAwake).checked(t.keep_awake.is_some()),
            MenuItem::separator(),
            MenuItem::action("Post Notification", PostNotification),
            MenuItem::action("Bring Test Windows to Front", RaiseTestWindows),
        ]),
    ]
}

fn refresh_menus(cx: &mut App) {
    let toggles = cx.global::<Shell>().toggles.clone();
    let t = toggles.lock().expect("toggles");
    cx.set_menus(menus(&t));
}

fn notify_main(cx: &mut App) {
    let main = cx.global::<Shell>().main;
    let _ = main.update(cx, |_, _, cx| cx.notify());
}

fn menu_action(name: &str) {
    with_facts(|f| f.menu_actions.push(name.to_owned()));
    event(format!("action {name}"));
}

fn register_actions(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", HideApp, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-o", OpenFiles, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-z", Undo, None),
        KeyBinding::new("shift-cmd-z", Redo, None),
        KeyBinding::new("cmd-x", Cut, None),
        KeyBinding::new("cmd-c", Copy, None),
        KeyBinding::new("cmd-v", Paste, None),
        KeyBinding::new("cmd-a", SelectAll, None),
    ]);

    cx.on_action(|_: &About, _| menu_action("About"));
    cx.on_action(|_: &HideApp, cx| {
        menu_action("Hide");
        cx.hide();
    });
    cx.on_action(|_: &HideOthers, cx| {
        menu_action("Hide Others");
        cx.hide_other_apps();
    });
    cx.on_action(|_: &ShowAll, cx| {
        menu_action("Show All");
        cx.unhide_other_apps();
    });
    cx.on_action(|_: &Quit, cx| {
        menu_action("Quit");
        finish(cx);
    });
    cx.on_action(|_: &Undo, _| menu_action("Undo"));
    cx.on_action(|_: &Redo, _| menu_action("Redo"));
    cx.on_action(|_: &Cut, _| menu_action("Cut"));
    cx.on_action(|_: &Copy, _| menu_action("Copy"));
    cx.on_action(|_: &Paste, _| menu_action("Paste"));
    cx.on_action(|_: &SelectAll, _| menu_action("Select All"));
    cx.on_action(|_: &Minimize, cx| {
        menu_action("Minimize");
        let main = cx.global::<Shell>().main;
        let _ = main.update(cx, |_, window, _| window.minimize_window());
    });
    cx.on_action(|_: &Zoom, cx| {
        menu_action("Zoom");
        let main = cx.global::<Shell>().main;
        let _ = main.update(cx, |_, window, _| window.zoom_window());
    });

    // Puts the magenta and cyan windows above the main window, so a capture
    // shows the hidden one would be visible if it were not excluded.
    cx.on_action(|_: &RaiseTestWindows, cx| {
        menu_action("Bring Test Windows to Front");
        let (hidden, on_top) = {
            let s = cx.global::<Shell>();
            (s.hidden, s.on_top)
        };
        if let Some(h) = hidden {
            let _ = h.update(cx, |_, window, _| window.activate_window());
        }
        if let Some(h) = on_top {
            let _ = h.update(cx, |_, window, _| window.activate_window());
        }
    });

    cx.on_action(|_: &ToggleOnTop, cx| {
        menu_action("Keep on Top");
        let (handle, toggles) = {
            let s = cx.global::<Shell>();
            (s.on_top, s.toggles.clone())
        };
        let want = !toggles.lock().expect("toggles").on_top;
        if let Some(h) = handle {
            let _ = h.update(cx, |_, window, _| match os::set_keep_on_top(window, want) {
                Ok(level) => {
                    toggles.lock().expect("toggles").on_top = want;
                    event(format!("keep on top {want}: window level {level}"));
                }
                Err(e) => fail(format!("keep on top: {e}")),
            });
        }
        refresh_menus(cx);
        notify_main(cx);
    });

    cx.on_action(|_: &ToggleHidden, cx| {
        menu_action("Hide from Stream");
        let (handle, toggles) = {
            let s = cx.global::<Shell>();
            (s.hidden, s.toggles.clone())
        };
        let want = !toggles.lock().expect("toggles").hidden;
        if let Some(h) = handle {
            let _ = h.update(cx, |_, window, _| {
                match os::set_hidden_from_capture(window, want) {
                    Ok(id) => {
                        toggles.lock().expect("toggles").hidden = want;
                        event(format!("hide from stream {want}: window {id}"));
                    }
                    Err(e) => fail(format!("hide from stream: {e}")),
                }
            });
        }
        refresh_menus(cx);
        notify_main(cx);
    });

    cx.on_action(|_: &ToggleKeepAwake, cx| {
        menu_action("Keep Awake");
        let toggles = cx.global::<Shell>().toggles.clone();
        let mut t = toggles.lock().expect("toggles");
        match t.keep_awake.take() {
            Some(id) => match os::keep_awake_stop(id) {
                Ok(()) => event(format!("keep awake off (released assertion {id})")),
                Err(e) => fail(format!("keep awake off: {e}")),
            },
            None => match os::keep_awake_start("spike-desktop is keeping the display awake") {
                Ok(id) => {
                    t.keep_awake = Some(id);
                    with_facts(|f| f.keep_awake_assertions += 1);
                    event(format!("keep awake on (assertion {id})"));
                }
                Err(e) => fail(format!("keep awake on: {e}")),
            },
        }
        drop(t);
        refresh_menus(cx);
        notify_main(cx);
    });

    cx.on_action(|_: &PostNotification, cx| {
        menu_action("Post Notification");
        if let Err(e) = os::can_notify() {
            fail(format!("notification: {e}"));
            return;
        }
        let n = with_facts(|f| {
            f.notifications_posted += 1;
            f.notifications_posted
        });
        cx.show_system_notification(SystemNotification {
            tag: format!("spike-{n}").into(),
            title: "spike-desktop".into(),
            body: format!("Notification {n} from GPUI").into(),
            actions: vec![],
        });
        event(format!("notification {n} posted"));
        notify_main(cx);
    });

    cx.on_action(|_: &OpenFiles, cx| {
        menu_action("Open…");
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Open".into()),
        });
        cx.spawn(async move |cx| {
            match rx.await {
                Ok(Ok(Some(paths))) => {
                    let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                    event(format!("picked {list:?}"));
                    with_facts(|f| f.picked_paths.extend(list));
                }
                Ok(Ok(None)) => event("open dialog cancelled"),
                Ok(Err(e)) => fail(format!("open dialog: {e:#}")),
                Err(_) => fail("open dialog: no answer"),
            }
            cx.update(notify_main);
        })
        .detach();
    });

    cx.on_action(|_: &RevealSample, cx| {
        menu_action("Show in Finder");
        let path = sample_path();
        if !path.exists() {
            let _ = write_sample();
        }
        cx.reveal_path(&path);
        event(format!("revealed {}", path.display()));
        with_facts(|f| f.revealed_paths.push(path.display().to_string()));
        notify_main(cx);
    });

    cx.on_action(|_: &TrashSample, cx| {
        menu_action("Move to Trash");
        let path = sample_path();
        if !path.exists() {
            let _ = write_sample();
        }
        match trash_file(&path) {
            Ok(()) if !path.exists() => {
                event(format!("moved to trash {}", path.display()));
                with_facts(|f| f.trashed_paths.push(path.display().to_string()));
            }
            Ok(()) => fail("trash said yes but the file is still there"),
            Err(e) => fail(format!("trash: {e}")),
        }
        notify_main(cx);
    });
}

fn trash_file(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Finder's AppleScript route (the crate's default) asks for
        // Automation consent; NSFileManager needs nothing.
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

fn write_sample() -> std::io::Result<()> {
    let path = sample_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, "plan 260 S0.7 sample file\n")
}

// ---------------------------------------------------------------- summary

fn finish(cx: &mut App) -> ! {
    // Release the sleep guard before leaving, as the app must on quit.
    if let Some(shell) = cx.try_global::<Shell>()
        && let Some(id) = shell.toggles.lock().expect("toggles").keep_awake.take()
    {
        let _ = os::keep_awake_stop(id);
    }
    let run = cx.global::<Shell>().run.clone();
    let mut run = run.lock().expect("run");
    let elapsed_s = spike_summary::elapsed_ms() / 1000.0;
    let renders = RENDERS.load(Ordering::Relaxed);
    run.set("renders", renders);
    run.set(
        "ui_redraws_per_second_idle",
        round(renders as f64 / elapsed_s.max(0.001), 2),
    );
    let fp = FIRST_PAINT_US.load(Ordering::Relaxed);
    if fp > 0 {
        run.set("startup_to_first_paint_ms", round(fp as f64 / 1000.0, 1));
    }
    run.set(
        "bundle_id",
        os::bundle_id().map(Value::from).unwrap_or(Value::Null),
    );
    run.set("hotkey", HOTKEY_LABEL);
    run.set("hotkey_presses", HOTKEY_PRESSES.load(Ordering::Relaxed));
    with_facts(|f| {
        run.set("menu_actions", json!(f.menu_actions));
        run.set("open_urls", json!(f.open_urls));
        run.set("single_instance_handoffs", json!(f.handoffs));
        run.set("hidden_window", f.hidden_window.clone());
        run.set("on_top_window", f.on_top_window.clone());
        run.set("keep_awake_assertions", f.keep_awake_assertions);
        run.set("notifications_posted", f.notifications_posted);
        run.set("notification_responses", json!(f.notification_responses));
        run.set("picked_paths", json!(f.picked_paths));
        run.set("revealed_paths", json!(f.revealed_paths));
        run.set("trashed_paths", json!(f.trashed_paths));
        run.set("dropped_paths", json!(f.dropped_paths));
        run.set("header_double_clicks", f.header_double_clicks);
        run.set("header_drags", f.header_drags);
        run.set("reopens", f.reopens);
    });
    run.finish()
}

// ---------------------------------------------------------------- start-up

fn record_window_facts(window: &Window, kind: &str) -> Value {
    match os::window_facts(window) {
        Ok((level, hides_on_deactivate, id)) => json!({
            "kind": kind,
            "window_id": id,
            "level": level,
            "hides_on_deactivate": hides_on_deactivate,
        }),
        Err(e) => json!({ "kind": kind, "gap": e }),
    }
}

fn main() {
    let mut run = Run::start(SPIKE);
    // LaunchServices starts (a link, `open`) carry no arguments and run in `/`:
    // `open --env SPIKE_SECONDS=… --env SPIKE_OUT=…` sets them instead.
    if let Some(s) = std::env::var("SPIKE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        run.args.seconds = s;
    }
    if let Ok(out) = std::env::var("SPIKE_OUT") {
        run.args.out = PathBuf::from(out);
    } else if run.args.out.is_relative()
        && std::env::current_dir().is_ok_and(|d| d == std::path::Path::new("/"))
    {
        run.args.out = std::env::temp_dir().join(SPIKE).join("summary.json");
    }
    let seconds = run.args.seconds;
    let gpui_floating = run.args.flag("--gpui-floating");
    let keep_panel_default = run.args.flag("--keep-panel-default");

    // One instance, before any window: a second start hands over and exits.
    let (handoff_tx, handoff_rx) = mpsc::channel::<Vec<String>>();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match single_instance::claim(&argv, handoff_tx) {
        Ok(single_instance::Role::HandedOver) => {
            println!("[spike] handed over to the running instance; exiting");
            std::process::exit(0);
        }
        Ok(single_instance::Role::First) => {}
        Err(e) => spike_summary::error(format!("single instance: {e}")),
    }
    if let Err(e) = write_sample() {
        spike_summary::error(format!("cannot write the sample file: {e}"));
    }
    // A link passed on the command line (how Windows and Linux deliver one).
    for a in &argv {
        if a.starts_with(&format!("{SCHEME}://")) {
            OPENED_URLS
                .lock()
                .expect("urls")
                .push((a.clone(), spike_summary::elapsed_ms(), false));
        }
    }

    let run = Arc::new(Mutex::new(run));
    let app = gpui_platform::application();
    // Registered before `run`, so a link that starts the app is not lost.
    app.on_open_urls(|urls| {
        let ms = spike_summary::elapsed_ms();
        let window_open = MAIN_WINDOW_OPEN.load(Ordering::Relaxed);
        let mut list = OPENED_URLS.lock().expect("urls");
        for u in urls {
            println!("[spike] open-url {u} at {ms:.0} ms (main window open: {window_open})");
            list.push((u, ms, window_open));
        }
    });
    app.on_reopen(|_| {
        with_facts(|f| f.reopens += 1);
        event("reopen (Dock icon or a second `open`)");
    });

    app.run(move |cx: &mut App| {
        register_actions(cx);
        cx.on_system_notification_response(|r, cx| {
            event(format!(
                "notification response tag={} action={:?}",
                r.tag, r.action_id
            ));
            with_facts(|f| {
                f.notification_responses
                    .push(json!({ "tag": r.tag.to_string(), "action": r.action_id.as_ref().map(|a| a.to_string()) }))
            });
            notify_main(cx);
        });

        // The main window: the traffic lights over the custom header (the
        // design skill: 40 px header, lights at x 14, centred: y 13).
        // Side by side, so no test window overlaps the main one and a capture
        // shows each without depending on window order: the main window
        // (1650 x 962 where the display allows) on the left, the two test
        // windows in a 380 pt column on the right.
        let display = cx
            .primary_display()
            .map(|d| d.visible_bounds())
            .unwrap_or_else(|| Bounds::new(point(px(0.), px(0.)), size(px(2048.), px(1100.))));
        let column = px(380.);
        let main_w = (display.size.width - column - px(16.)).min(px(1650.));
        let main_h = display.size.height.min(px(962.));
        let bounds = Bounds::new(display.origin, size(main_w, main_h));
        let main = match cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SPIKE.into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.), px(13.))),
                }),
                app_owns_titlebar_drag: true,
                app_id: Some(SPIKE.into()),
                ..Default::default()
            },
            |_, cx| cx.new(|_| Desktop { dropping: false }),
        ) {
            Ok(h) => h,
            Err(e) => {
                spike_summary::error(format!("open_window failed: {e:#}"));
                run.lock().expect("run").finish();
            }
        };
        MAIN_WINDOW_OPEN.store(true, Ordering::Relaxed);

        let col_x = display.origin.x + main_w + px(16.);
        let o = display.origin;
        let swatch_size = size(column - px(16.), px(220.));
        // Hidden from capture: magenta, over the main window's right side.
        let hidden = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(col_x, o.y + px(40.)),
                        swatch_size,
                    ))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("Hidden from stream".into()),
                        ..Default::default()
                    }),
                    focus: false,
                    ..Default::default()
                },
                |window, cx| {
                    match os::set_hidden_from_capture(window, true) {
                        Ok(id) => {
                            event(format!("hide from stream true: window {id}"));
                            with_facts(|f| {
                                f.hidden_window = json!({ "window_id": id, "sharing_none": true })
                            });
                        }
                        Err(e) => {
                            fail(format!("hide from stream: {e}"));
                            with_facts(|f| f.hidden_window = json!({ "gap": e }));
                        }
                    }
                    cx.new(|_| Swatch {
                        label: "Hidden from stream".into(),
                        color: 0xff00ff,
                    })
                },
            )
            .map_err(|e| fail(format!("hidden window: {e:#}")))
            .ok();

        // Kept on top: cyan. By default a normal window raised to the
        // floating level (Electron's route, and toggleable at run time);
        // `--gpui-floating` uses GPUI's WindowKind::Floating panel instead.
        let on_top = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(col_x, o.y + px(320.)),
                        swatch_size,
                    ))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("Keep on top".into()),
                        ..Default::default()
                    }),
                    focus: false,
                    kind: if gpui_floating {
                        WindowKind::Floating
                    } else {
                        WindowKind::Normal
                    },
                    ..Default::default()
                },
                move |window, cx| {
                    let kind = if gpui_floating {
                        "gpui-floating-panel"
                    } else {
                        "normal-raised"
                    };
                    if gpui_floating {
                        let before = record_window_facts(window, kind);
                        event(format!("GPUI floating panel as created: {before}"));
                        if !keep_panel_default {
                            let _ = os::set_hides_on_deactivate(window, false);
                        }
                    } else if let Err(e) = os::set_keep_on_top(window, true) {
                        fail(format!("keep on top: {e}"));
                    }
                    let facts = record_window_facts(window, kind);
                    event(format!("keep on top window: {facts}"));
                    with_facts(|f| f.on_top_window = facts);
                    cx.new(|_| Swatch {
                        label: "Keep on top".into(),
                        color: 0x00ffff,
                    })
                },
            )
            .map_err(|e| fail(format!("on-top window: {e:#}")))
            .ok();

        let toggles = Arc::new(Mutex::new(Toggles {
            on_top: on_top.is_some(),
            hidden: hidden.is_some(),
            keep_awake: None,
        }));
        cx.set_global(Shell {
            main,
            hidden,
            on_top,
            toggles,
            run: run.clone(),
        });
        refresh_menus(cx);
        let _ = main.update(cx, |_, window, _| window.activate_window());
        cx.activate(true);

        // The global shortcut. The manager lives as long as the app.
        match global_hotkey::GlobalHotKeyManager::new() {
            Ok(manager) => {
                use global_hotkey::hotkey::{Code, HotKey, Modifiers};
                let hk = HotKey::new(
                    Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                    Code::KeyR,
                );
                match manager.register(hk) {
                    Ok(()) => event(format!("global shortcut {HOTKEY_LABEL} registered")),
                    Err(e) => fail(format!("global shortcut: {e}")),
                }
                global_hotkey::GlobalHotKeyEvent::set_event_handler(Some(
                    |e: global_hotkey::GlobalHotKeyEvent| {
                        if e.state == global_hotkey::HotKeyState::Pressed {
                            HOTKEY_PRESSES.fetch_add(1, Ordering::Relaxed);
                        }
                    },
                ));
                Box::leak(Box::new(manager));
            }
            Err(e) => fail(format!("global shortcut manager: {e}")),
        }

        // One foreground poll: links, hand-offs and hotkey presses. It only
        // redraws when something changed.
        cx.spawn(async move |cx| {
            let mut seen_urls = 0usize;
            let mut seen_hotkeys = 0u64;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                let mut changed = false;
                let urls: Vec<(String, f64, bool)> = {
                    let list = OPENED_URLS.lock().expect("urls");
                    list[seen_urls..].to_vec()
                };
                for (u, ms, window_open) in urls {
                    seen_urls += 1;
                    event(format!(
                        "deep link {u} (arrived {ms:.0} ms after start, main window open: {window_open})"
                    ));
                    with_facts(|f| {
                        f.open_urls.push(json!({
                            "url": u,
                            "ms_after_start": round(ms, 1),
                            "before_main_window": !window_open,
                        }))
                    });
                    changed = true;
                }
                while let Ok(args) = handoff_rx.try_recv() {
                    event(format!("second start handed over {args:?}"));
                    for a in &args {
                        if a.starts_with(&format!("{SCHEME}://")) {
                            OPENED_URLS.lock().expect("urls").push((
                                a.clone(),
                                spike_summary::elapsed_ms(),
                                true,
                            ));
                        }
                    }
                    with_facts(|f| f.handoffs.push(args));
                    cx.update(|cx| {
                        let main = cx.global::<Shell>().main;
                        let _ = main.update(cx, |_, window, _| window.activate_window());
                        cx.activate(true);
                    });
                    changed = true;
                }
                let presses = HOTKEY_PRESSES.load(Ordering::Relaxed);
                if presses != seen_hotkeys {
                    for _ in seen_hotkeys..presses {
                        event("hotkey");
                    }
                    seen_hotkeys = presses;
                    changed = true;
                }
                if changed {
                    cx.update(notify_main);
                }
            }
        })
        .detach();

        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(seconds))
                .await;
            cx.update(|cx| finish(cx));
        })
        .detach();
    });
}
