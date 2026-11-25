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
    /// `open-tab`: the main window shows `page`, as its sidebar row would.
    fn open_page(&self, page: PageId, cx: &mut App) -> Result<(), String>;
}

/// `open-tab {tab, waitFor?}` on the main window. `tab` is Electron's
/// trigger id (`studio`, `sources`, `layout`, `streaming`, …) or a page's own
/// id. `waitFor` is a CSS selector on Electron; the GPUI page is drawn in the
/// same frame, so it is not needed here and is ignored.
pub struct ShellCommands {
    ui: UiThread,
}

impl SmokeCommandHandler for ShellCommands {
    fn handles(&self, command: &str) -> bool {
        command == "open-tab"
    }

    fn run<'a>(
        &'a self,
        _command: &'a str,
        params: serde_json::Map<String, Value>,
    ) -> videorc_app_core::smoke::CommandFuture<'a> {
        Box::pin(async move {
            let tab = params
                .get("tab")
                .and_then(Value::as_str)
                .unwrap_or("studio")
                .to_string();
            let page = PageId::from_tab_param(&tab)
                .ok_or_else(|| format!("open-tab: no page is called {tab:?}."))?;
            self.ui
                .run(move |cx| shell(cx)?.open_page(page, cx))
                .await??;
            Ok(serde_json::json!({ "activeTab": tab }))
        })
    }
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
