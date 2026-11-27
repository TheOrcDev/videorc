//! The smoke command server and the UI driver in the GPUI app (plan 260
//! S2.5, L6). The smokes drive this app the way they drive Electron, with
//! `VIDEORC_APP=gpui` (`scripts/lib/app-launcher.mjs`) and the one driver
//! (`scripts/lib/ui-driver.mjs`).
//!
//! The server, its policy and the core's commands are
//! `videorc_app_core::smoke`'s. This module adds what needs GPUI:
//!
//! - [`UiThread`]: one hop from the server's tokio task to GPUI's
//!   foreground, where every window command runs.
//! - [`driver`]: `ui-tree`, `ui-find`, `ui-click`, `ui-focus`, `ui-type`, `ui-key`,
//!   `ui-scroll`, `ui-set-value`, `ui-appearance`, `ui-toast` and
//!   `resize-window` over each window's AccessKit tree.
//! - [`windows`]: the Notes and Stream Manager windows' commands and
//!   `raise-window`.
//! - [`activate`]: turns GPUI's accessibility on for a smoke run, as a
//!   screen reader would, so the tree exists without one.
//!
//! # The seam with the shell (S2.1, L4)
//!
//! `main.rs` starts the server once the main window exists, and
//! [`shell::ShellWindows`] answers for it. In outline:
//!
//! ```ignore
//! smoke::start(cx, smoke::SmokeStart {
//!     runtime: runtime.handle().clone(),
//!     backend: supervisor.state(),
//!     isolated_backend,
//!     packaged,
//!     quit: Arc::new(move || quit_tx.send(()).ok()),
//!     studio: None, // S1.6a's Studio handler (L7), when it lands
//!     shell: Rc::new(ShellWindows { .. }),
//! });
//! ```
//!
//! and implements [`ShellSmoke`]: which window a command names, the forced
//! look a screenshot needs, and a toast through the app's toast path. More
//! window commands (`open-tab`, `main-window-*`, the preview's) come as
//! further [`SmokeCommandHandler`]s from the slices that own them, handed to
//! [`SmokeStart`] the same way as `studio`.

pub mod activate;
pub mod capture;
pub mod driver;
mod preview_drain;
pub mod shell;
pub mod windows;

use std::rc::Rc;
use std::sync::Arc;

use gpui::{AnyWindowHandle, App, Global};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use videorc_app_core::nav::PageId;
use videorc_app_core::process::IsolatedBackendPaths;
use videorc_app_core::smoke::security::{UiAppearanceRequest, UiToastRequest, UiWindow};
use videorc_app_core::smoke::{
    AppSmokeCommands, AppSmokeConfig, QuitHook, SmokeCommandHandler, SmokeServer, SmokeSwitch,
    SupervisorAdmin, print_backend_ready_requested, spawn_backend_ready_markers,
};
use videorc_app_core::supervisor::BackendState;

/// Electron's `MAIN_WINDOW_NOT_READY`: the smoke client retries on it.
pub const MAIN_WINDOW_NOT_READY: &str = "Main window is not ready for preview motion smoke.";

/// What the shell answers for the driver, on GPUI's foreground.
pub trait ShellSmoke: 'static {
    /// The open window a command names (`main`, `preview`,
    /// `stream-manager`, `captions`, `notes`), or `None` while it is closed.
    fn window(&self, which: UiWindow, cx: &App) -> Option<AnyWindowHandle>;
    /// `ui-appearance`: forces the theme, Increase contrast and Reduce
    /// motion on every window (never the OS's setting); answers what holds.
    fn appearance(&self, request: UiAppearanceRequest, cx: &mut App) -> Result<Value, String>;
    /// `ui-toast`: a toast in the main window through the app's toast path.
    fn toast(&self, request: &UiToastRequest, cx: &mut App) -> Result<Value, String>;
    /// Current bell entries and actually mounted toasts; never marks them read.
    fn notifications(&self, cx: &mut App) -> Result<Value, String>;
    /// `open-tab`: the main window shows `page`, as its sidebar row would,
    /// on `open`'s sub-tab with its dialog over it.
    fn open_page(&self, page: PageId, open: OpenTab, cx: &mut App) -> Result<(), String>;
    /// Gallery: Studio with the Vertical stream panel scrolled into view.
    fn reveal_studio_vertical_stream(&self, cx: &mut App) -> Result<(), String>;
    /// The preview's commands ([`PREVIEW_COMMANDS`]): its state, its own
    /// window opened, closed or toggled, and Retry preview.
    fn preview(&self, command: &str, cx: &mut App) -> Result<Value, String>;
    /// The preview, once the main window started it (`preview-surface-sample`).
    fn preview_entity(&self) -> Option<gpui::Entity<crate::preview::Preview>>;
}

/// The preview's commands on the GPUI app. The preview draws in the main
/// window (docked) or its own (floating, macOS). Host placement stays with
/// the GPUI element; the drain awaits its own feed.
pub const PREVIEW_COMMANDS: &[&str] = &[
    "inspect-native-preview-live-background",
    "inspect-native-preview-runtime",
    // What the element presents (`presentedFrameId`), live.
    "native-preview-surface-status",
    // GPUI only: Retry preview (`Preview::retry`), answered with the state
    // and whether it ran; the phase goes back to starting.
    "preview-retry",
    // GPUI only: Window → Preview / ⌘P, the `TogglePreview` action itself.
    "preview-toggle-open",
    "preview-window-close",
    "preview-window-open",
    // The Preview window closed as its close button closes it (the app's
    // should-close path): the Preview is then closed (P131).
    "preview-window-os-close",
    // The Preview window moved and sized (`{x?, y?, width?, height?}`, top-left
    // screen points), as a window manager or the person would.
    "preview-window-set-bounds",
    "preview-window-state",
    "preview-window-toggle",
];

/// A dialog `open-tab` puts over the page (GPUI only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmokeDialog {
    /// The Go Live confirmation, as the Studio's Go Live button opens it.
    GoLive,
    /// The command palette (⌘K).
    Palette,
    /// First-run setup at `step` (the first step there is for `goal`).
    FirstRun {
        step: videorc_app_core::first_run::Step,
        goal: Option<videorc_app_core::first_run::Goal>,
    },
}

/// `open-tab`'s GPUI extras, for the screen gallery
/// (`scripts/gpui-gallery.mjs`): `subTab` (Settings, Sidekick and Avatar
/// tab ids, `nav::sub_tabs`) and `dialog` (`go-live`, `palette`, or
/// `first-run` with `step` and `goal`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenTab {
    pub sub_tab: Option<String>,
    pub dialog: Option<SmokeDialog>,
}

impl OpenTab {
    pub fn from_params(params: &serde_json::Map<String, Value>) -> Result<Self, String> {
        use videorc_app_core::first_run::{Goal, Step};
        let text = |key: &str| params.get(key).and_then(Value::as_str);
        let dialog = match text("dialog") {
            None => None,
            Some("go-live") => Some(SmokeDialog::GoLive),
            Some("palette") => Some(SmokeDialog::Palette),
            Some("first-run") => {
                let step = match text("step") {
                    None => Step::Permissions,
                    Some(id) => Step::parse(id)
                        .ok_or_else(|| format!("open-tab: no first-run step is called {id:?}."))?,
                };
                let goal =
                    match text("goal") {
                        None => None,
                        Some(id) => Some(Goal::parse(id).ok_or_else(|| {
                            format!("open-tab: no first-run goal is called {id:?}.")
                        })?),
                    };
                Some(SmokeDialog::FirstRun { step, goal })
            }
            Some(other) => return Err(format!("open-tab: no dialog is called {other:?}.")),
        };
        Ok(Self {
            sub_tab: text("subTab").map(str::to_string),
            dialog,
        })
    }
}

/// `open-tab {tab, waitFor?, subTab?, dialog?}` on the main window. `tab` is
/// Electron's trigger id (`studio`, `sources`, `layout`, `streaming`, …) or a
/// page's own id. `waitFor` is a CSS selector on Electron; the GPUI page is
/// drawn in the same frame, so it is not needed here and is ignored.
/// `subTab` and `dialog` are [`OpenTab`]'s.
pub struct ShellCommands {
    ui: UiThread,
}

impl SmokeCommandHandler for ShellCommands {
    fn handles(&self, command: &str) -> bool {
        command == "drain-native-preview-host-commands"
            || command == "notifications-state"
            || command == "open-tab"
            || command == "main-window-id"
            || command == "studio-reveal-vertical-stream"
            || PREVIEW_COMMANDS.contains(&command)
    }

    fn run<'a>(
        &'a self,
        command: &'a str,
        params: serde_json::Map<String, Value>,
    ) -> videorc_app_core::smoke::CommandFuture<'a> {
        Box::pin(async move {
            if command == "preview-window-set-bounds" {
                return self
                    .ui
                    .run(move |cx| set_preview_window_bounds(&params, cx))
                    .await?;
            }
            if command == "drain-native-preview-host-commands" {
                if !params.is_empty() {
                    return Err("drain-native-preview-host-commands takes no parameters.".into());
                }
                let answer = self
                    .ui
                    .run(|cx| {
                        let preview = shell(cx)?.preview_entity().ok_or(MAIN_WINDOW_NOT_READY)?;
                        preview.read(cx).smoke_drain_host_commands()
                    })
                    .await??;
                let count = preview_drain::wait_for_drain(answer).await?;
                return self
                    .ui
                    .run(move |cx| {
                        let mut status = shell(cx)?.preview("native-preview-surface-status", cx)?;
                        status["drainedCommandCount"] = serde_json::json!(count);
                        Ok(status)
                    })
                    .await?;
            }
            if PREVIEW_COMMANDS.contains(&command) {
                let command = command.to_string();
                return self
                    .ui
                    .run(move |cx| shell(cx)?.preview(&command, cx))
                    .await?;
            }
            if command == "notifications-state" {
                if !params.is_empty() {
                    return Err("notifications-state takes no parameters.".into());
                }
                return self.ui.run(|cx| shell(cx)?.notifications(cx)).await?;
            }
            if command == "main-window-id" {
                return self.ui.run(main_window_id).await?;
            }
            if command == "studio-reveal-vertical-stream" {
                return self
                    .ui
                    .run(move |cx| {
                        shell(cx)?.reveal_studio_vertical_stream(cx)?;
                        Ok(serde_json::json!({ "revealed": "vertical-stream" }))
                    })
                    .await?;
            }
            let tab = params
                .get("tab")
                .and_then(Value::as_str)
                .unwrap_or("studio")
                .to_string();
            let page = PageId::from_tab_param(&tab)
                .ok_or_else(|| format!("open-tab: no page is called {tab:?}."))?;
            let open = OpenTab::from_params(&params)?;
            let sub_tab = open.sub_tab.clone();
            self.ui
                .run(move |cx| shell(cx)?.open_page(page, open, cx))
                .await??;
            Ok(serde_json::json!({ "activeTab": tab, "subTab": sub_tab }))
        })
    }
}

/// `main-window-id`: the OS capture id and bounds, as Electron's
/// `getMediaSourceId` / `getBounds` answer them. Bounds are top-left screen
/// points. `capture-page` stays refused (gap 3).
fn main_window_id(cx: &mut App) -> Result<Value, String> {
    use crate::platform::{self, ScreenFrame};
    let handle = shell(cx)?
        .window(videorc_app_core::smoke::security::UiWindow::Main, cx)
        .ok_or_else(|| MAIN_WINDOW_NOT_READY.to_string())?;
    handle
        .update(cx, |_, window, cx| {
            let bounds = window.bounds();
            // The window's display in pixels, as the Output page's "Check this
            // computer" reads it for the performance check's ceiling
            // (Electron's `screen.width * devicePixelRatio`).
            let scale = window.scale_factor();
            let display = window.display(cx).map(|display| {
                let size = display.bounds().size;
                serde_json::json!({
                    "width": (f32::from(size.width) * scale).round() as u32,
                    "height": (f32::from(size.height) * scale).round() as u32,
                })
            });
            let frame = ScreenFrame {
                x: f64::from(f32::from(bounds.origin.x)),
                y: f64::from(f32::from(bounds.origin.y)),
                width: f64::from(f32::from(bounds.size.width)),
                height: f64::from(f32::from(bounds.size.height)),
            };
            Ok(serde_json::json!({
                "windowId": platform::current().capture_window_id(window),
                "bounds": {
                    "x": frame.x,
                    "y": frame.y,
                    "width": frame.width,
                    "height": frame.height,
                },
                "display": display,
            }))
        })
        .map_err(|_| MAIN_WINDOW_NOT_READY.to_string())?
}

/// `preview-window-set-bounds {x?, y?, width?, height?}`: the Preview
/// window's frame in top-left screen points, each side not given kept; its
/// state after (the layer follows at the window's next layout).
fn set_preview_window_bounds(
    params: &serde_json::Map<String, Value>,
    cx: &mut App,
) -> Result<Value, String> {
    use crate::platform::{self, ScreenFrame};
    let preview = shell(cx)?
        .preview_entity()
        .ok_or_else(|| MAIN_WINDOW_NOT_READY.to_string())?;
    let handle = preview
        .read(cx)
        .floating_window()
        .ok_or("preview-window-set-bounds: the Preview window is not open.")?;
    handle
        .update(cx, |_, window, _| {
            let bounds = window.bounds();
            let side = |key: &str, current: gpui::Pixels| {
                params
                    .get(key)
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::from(f32::from(current)))
            };
            platform::current().set_window_frame(
                window,
                ScreenFrame {
                    x: side("x", bounds.origin.x),
                    y: side("y", bounds.origin.y),
                    width: side("width", bounds.size.width),
                    height: side("height", bounds.size.height),
                },
            )
        })
        .map_err(|_| "preview-window-set-bounds: the Preview window closed.".to_string())??;
    let mut state = preview.read(cx).smoke_state();
    let bounds = handle
        .update(cx, |_, window, _| window.bounds())
        .ok()
        .map(|bounds| {
            serde_json::json!({
                "x": f32::from(bounds.origin.x),
                "y": f32::from(bounds.origin.y),
                "width": f32::from(bounds.size.width),
                "height": f32::from(bounds.size.height),
            })
        });
    state["bounds"] = bounds.unwrap_or(Value::Null);
    Ok(state)
}

/// The shell's answers, where the driver's foreground jobs find them.
struct ShellSlot(Rc<dyn ShellSmoke>);

impl Global for ShellSlot {}

/// The shell's [`ShellSmoke`], or the sentence the client retries on.
pub(crate) fn shell(cx: &App) -> Result<Rc<dyn ShellSmoke>, String> {
    cx.try_global::<ShellSlot>()
        .map(|slot| slot.0.clone())
        .ok_or_else(|| MAIN_WINDOW_NOT_READY.to_string())
}

type Job = Box<dyn FnOnce(&mut App) + Send>;

/// A handle the server's tasks use to run work on GPUI's foreground.
#[derive(Clone)]
pub struct UiThread {
    jobs: mpsc::UnboundedSender<Job>,
}

impl UiThread {
    /// Starts the foreground loop that runs each job with the app.
    pub fn install(cx: &mut App) -> Self {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        cx.spawn(async move |cx| {
            while let Some(job) = queue.recv().await {
                cx.update(job);
            }
        })
        .detach();
        Self { jobs }
    }

    /// Runs `work` on the foreground and hands back its answer.
    pub async fn run<R: Send + 'static>(
        &self,
        work: impl FnOnce(&mut App) -> R + Send + 'static,
    ) -> Result<R, String> {
        let (answer, answered) = oneshot::channel();
        self.jobs
            .send(Box::new(move |cx| {
                let _ = answer.send(work(cx));
            }))
            .map_err(|_| "The app's UI thread has stopped.".to_string())?;
        answered
            .await
            .map_err(|_| "The app's UI thread dropped the command.".to_string())
    }
}

/// What [`start`] needs from the shell.
pub struct SmokeStart {
    /// The runtime the backend client and the supervisor run on.
    pub runtime: tokio::runtime::Handle,
    pub backend: watch::Receiver<BackendState>,
    /// Where the isolated backend keeps its data, `None` for real data.
    pub isolated_backend: Option<IsolatedBackendPaths>,
    pub packaged: bool,
    /// The app's quit, as `app-quit` asks for it.
    pub quit: QuitHook,
    /// S1.6a's Studio commands (`STUDIO_COMMANDS`), when the Studio exists.
    pub studio: Option<Arc<dyn SmokeCommandHandler>>,
    /// Further window commands from the slices that own them.
    pub windows: Vec<Arc<dyn SmokeCommandHandler>>,
    pub shell: Rc<dyn ShellSmoke>,
}

/// Starts the server when the switch is on (Electron's
/// `smokeCommandServerEnabled`): binds loopback on the runtime and prints
/// `[smoke] preview-motion-ready …` (and `[smoke] backend-ready …` on each
/// backend generation when asked). Off, it does nothing at all.
pub fn start(cx: &mut App, start: SmokeStart) -> bool {
    let env = |name: &str| std::env::var(name).ok();
    let Some(switch) = SmokeSwitch::resolve(env, start.packaged) else {
        return false;
    };
    cx.set_global(ShellSlot(start.shell));
    let ui = UiThread::install(cx);
    let output_dir = std::env::var_os(videorc_app_core::smoke::vars::OUTPUT_DIR)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let mut commands = AppSmokeCommands::new(
        Arc::new(SupervisorAdmin::new(start.backend.clone())),
        AppSmokeConfig::from_env(env, start.packaged, start.isolated_backend),
        start.quit,
    )
    .with_handler(Arc::new(capture::CaptureCommands::new(
        ui.clone(),
        output_dir.clone(),
    )))
    .with_handler(Arc::new(driver::UiDriver::new(ui.clone(), output_dir)))
    .with_handler(Arc::new(windows::WindowCommands::new(ui.clone())))
    .with_handler(Arc::new(ShellCommands { ui }));
    if let Some(studio) = start.studio {
        commands = commands.with_handler(studio);
    }
    for windows in start.windows {
        commands = commands.with_handler(windows);
    }
    let backend = start.backend;
    start.runtime.spawn(async move {
        match SmokeServer::bind_loopback(switch.options(), Arc::new(commands)).await {
            Ok(server) => {
                println!(
                    "{}",
                    switch.ready_marker(server.local_addr(), std::process::id())
                );
                if print_backend_ready_requested(|name| std::env::var(name).ok()) {
                    spawn_backend_ready_markers(backend, |line| println!("{line}"));
                }
                // The server lives as long as the app (dropping it stops it).
                std::future::pending::<()>().await;
                drop(server);
            }
            Err(error) => eprintln!("[smoke] the command server did not start: {error:#}"),
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::{OpenTab, SmokeDialog};
    use serde_json::{Map, Value, json};
    use videorc_app_core::first_run::{Goal, Step};

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn open_tab_reads_its_sub_tab_and_dialog() {
        assert_eq!(
            OpenTab::from_params(&params(json!({ "tab": "settings" }))),
            Ok(OpenTab::default())
        );
        assert_eq!(
            OpenTab::from_params(&params(json!({ "subTab": "voice", "dialog": "palette" }))),
            Ok(OpenTab {
                sub_tab: Some("voice".into()),
                dialog: Some(SmokeDialog::Palette),
            })
        );
        assert_eq!(
            OpenTab::from_params(&params(
                json!({ "dialog": "first-run", "step": "look", "goal": "stream" })
            ))
            .map(|open| open.dialog),
            Ok(Some(SmokeDialog::FirstRun {
                step: Step::Look,
                goal: Some(Goal::Stream),
            }))
        );
    }

    #[test]
    fn open_tab_names_what_it_does_not_know() {
        for bad in [
            json!({ "dialog": "settings" }),
            json!({ "dialog": "first-run", "step": "welcome" }),
            json!({ "dialog": "first-run", "goal": "podcast" }),
        ] {
            assert!(OpenTab::from_params(&params(bad)).is_err());
        }
    }
}
