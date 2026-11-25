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
//! - [`driver`]: `ui-tree`, `ui-find`, `ui-click`, `ui-type`, `ui-key`,
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
pub mod driver;
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
    /// `open-tab`: the main window shows `page`, as its sidebar row would,
    /// on `open`'s sub-tab with its dialog over it.
    fn open_page(&self, page: PageId, open: OpenTab, cx: &mut App) -> Result<(), String>;
    /// The preview's commands ([`PREVIEW_COMMANDS`]): its state, its own
    /// window opened, closed or toggled, and Retry preview.
    fn preview(&self, command: &str, cx: &mut App) -> Result<Value, String>;
}

/// The preview's commands on the GPUI app. The preview draws in the main
/// window (docked) or its own (floating, macOS); Electron's surface and
/// host commands have no GPUI form and stay "not supported".
pub const PREVIEW_COMMANDS: &[&str] = &[
    "inspect-native-preview-live-background",
    "inspect-native-preview-runtime",
    // GPUI only: Retry preview (`Preview::retry`), answered with the state
    // and whether it ran; the phase goes back to starting.
    "preview-retry",
    "preview-window-close",
    "preview-window-open",
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
        command == "open-tab" || command == "main-window-id" || PREVIEW_COMMANDS.contains(&command)
    }

    fn run<'a>(
        &'a self,
        command: &'a str,
        params: serde_json::Map<String, Value>,
    ) -> videorc_app_core::smoke::CommandFuture<'a> {
        Box::pin(async move {
            if PREVIEW_COMMANDS.contains(&command) {
                let command = command.to_string();
                return self
                    .ui
                    .run(move |cx| shell(cx)?.preview(&command, cx))
                    .await?;
            }
            if command == "main-window-id" {
                return self.ui.run(main_window_id).await?;
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
        .update(cx, |_, window, _| {
            let bounds = window.bounds();
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
            }))
        })
        .map_err(|_| MAIN_WINDOW_NOT_READY.to_string())?
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
