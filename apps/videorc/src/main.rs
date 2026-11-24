//! The `Videorc` binary on GPUI: windows, screens, the preview element's GPUI
//! side, OS integration, the smoke UI driver. It replaces the Electron shell
//! (`apps/desktop`) on macOS, Windows and Linux at the switch (D8).
//!
//! Plan 260 S2.1 (lane L4): the app starts. One instance per data
//! directory, the app log, the backend under the supervisor (its ownership
//! token and the backend's registry lock refuse a second owner; crashes go
//! to the crash log and restart with backoff), the typed client on the
//! backend's socket, and the store bridge into a main window with the
//! sidebar and empty pages. The status bar and stderr say where the backend
//! is (`[videorc-app] backend: …`, `[videorc-app] backend.ready …`) so a
//! script reads what the window says.
//!
//! ```text
//! cargo run -p videorc-app -- --profile /tmp/videorc-profile
//! ```
//!
//! Without `--profile` (or `VIDEORC_USER_DATA_DIR` / `VIDEORC_APP_DATA_DIR`)
//! the app uses the owner's real Videorc data directory, as the shipped app
//! will.

mod app;
// Plan 260 S2.5 (L6): the smoke command server and the UI driver. The shell
// starts it (`smoke::start`) in a later S2 part; until then nothing calls it.
#[allow(dead_code)]
mod smoke;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use gpui::{
    App, AppContext, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, actions,
    point, px, size,
};
use videorc_app_core::desktop::single_instance::{self, Acquired, HANDOFF_WAIT};
use videorc_app_core::nav::{self, PageId};
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{
    BackendClient, BackendLaunch, ClientConfig, ConnectionState, EventFilter, Isolation, Level,
    LogFileLimits, Logger, RotatingLogFile, Supervisor, SupervisorConfig,
};

use app::args;
use app::bridge;
use app::shell::{Shell, StatusLine, connection_text};

actions!(videorc, [Quit]);

/// Electron's app id (`electron-builder.yml`), kept on every platform: the
/// macOS bundle id, Videorc Camera's host, Linux's desktop entry and the
/// portal app id. A new id would lose the TCC grants, the portal's
/// permissions and shortcuts, and the `videorc://` handler at the crossover
/// (S5.0 keeps every grant). Coordinator decision, 2026-11-24.
const APP_ID: &str = "dev.theorcdev.videorc";

fn main() -> Result<()> {
    let args = args::parse()?;
    let root = args::workspace_root(args.workspace.clone())?;
    let paths = args::app_paths(&args);
    std::fs::create_dir_all(&paths.user_data_dir)
        .with_context(|| format!("could not create {}", paths.user_data_dir.display()))?;

    // One instance per data directory, before any window: a second launch
    // hands its links to the first (which brings its window up) and exits,
    // as Electron's `second-instance`.
    let mut instance = match single_instance::acquire(&paths.user_data_dir) {
        Ok(Acquired::Primary(primary)) => Some(primary),
        Ok(Acquired::Secondary(second)) => match second.hand_off(&args.links, HANDOFF_WAIT) {
            Ok(pid) => {
                eprintln!(
                    "[videorc-app] Videorc is already running for {} (pid {pid}); handed it {} link(s), exiting.",
                    paths.user_data_dir.display(),
                    args.links.len()
                );
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!(
                    "[videorc-app] another Videorc holds {} but did not answer ({error}); exiting rather than running twice.",
                    paths.user_data_dir.display()
                );
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!(
                "[videorc-app] the single-instance lock is unavailable ({error}); running without it"
            );
            None
        }
    };
    let (handoff_tx, handoff_rx) = mpsc::channel::<Vec<String>>();
    if let Some(primary) = instance.as_mut()
        && let Err(error) = primary.serve(move |links| {
            let _ = handoff_tx.send(links);
        })
    {
        eprintln!("[videorc-app] second launches can't hand over ({error})");
    }

    // The app log: every backend stderr line and supervisor line, rotated.
    let logger = Logger::new(
        Some(RotatingLogFile::new(
            paths.backend_log_file(),
            LogFileLimits::from_env(|name| std::env::var(name).ok()),
        )),
        !args.quiet,
    );
    eprintln!(
        "[videorc-app] pid {} · data {} ({}) · log {}",
        std::process::id(),
        paths.user_data_dir.display(),
        match paths.isolation {
            Isolation::Profile => "isolated profile",
            Isolation::RealUserData => "real user data",
        },
        paths.backend_log_file().display()
    );

    let mut launch = if args.cargo_run {
        BackendLaunch::cargo_run(&root, paths.user_data_dir.clone())
    } else {
        let backend = args.backend.clone().unwrap_or_else(|| {
            root.join("target")
                .join(args::build_profile_dir())
                .join(videorc_app_core::process::backend_binary_name())
        });
        if !backend.is_file() {
            bail!(
                "backend binary {} is missing; build it with `cargo build -p videorc-backend`, pass --backend, or use --cargo-run",
                backend.display()
            );
        }
        BackendLaunch::binary(backend, &root, paths.user_data_dir.clone())
    };
    launch.isolation = paths.isolation;
    launch.app_version = Some(env!("CARGO_PKG_VERSION").to_string());
    launch.path_prepend = vec![videorc_app_core::paths::cargo_bin_dir()];
    let stderr_logger = logger.clone();
    launch.stderr_sink = Some(std::sync::Arc::new(move |line: &str| {
        stderr_logger.log(Level::infer(line), line);
    }));

    // The core's own runtime: two workers, beside GPUI's executor. The core
    // keeps running with every window closed.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("videorc-core")
        .build()
        .context("tokio runtime")?;
    let _enter = runtime.enter();
    let supervisor = Supervisor::start(SupervisorConfig {
        launch,
        paths: paths.clone(),
        workspace_root: root.clone(),
        logger: logger.clone(),
        stop_grace: STOP_GRACE,
    });

    // The typed client on the backend's socket. Its event filter grows as
    // the screens land; S2.1 needs only `backend.ready`.
    let (client, _events) = BackendClient::start(
        supervisor.state(),
        ClientConfig {
            filter: EventFilter::include(Vec::<String>::new()),
            logger: logger.clone(),
            ..ClientConfig::default()
        },
    );

    // What the window says, on stderr too, for scripts and the build pass.
    let mut backend_lines = supervisor.state();
    runtime.spawn(async move {
        loop {
            let line = backend_lines.borrow_and_update().status_text();
            eprintln!("[videorc-app] backend: {line}");
            if backend_lines.changed().await.is_err() {
                break;
            }
        }
    });
    let mut connection_lines = client.state();
    runtime.spawn(async move {
        loop {
            let ready = match &*connection_lines.borrow_and_update() {
                ConnectionState::Connected { generation, ready } => Some((*generation, ready.pid)),
                _ => None,
            };
            if let Some((generation, pid)) = ready {
                eprintln!("[videorc-app] backend.ready (generation {generation}, pid {pid})");
            }
            if connection_lines.changed().await.is_err() {
                break;
            }
        }
    });

    let backend_state = supervisor.state();
    let connection_state = client.state();
    // Taken by the quit: the shutdown handshake runs once.
    let supervisor = Rc::new(RefCell::new(Some(supervisor)));
    let quit_supervisor = supervisor.clone();
    let runtime_handle = runtime.handle().clone();
    let quit_after = args.quit_after;

    let application = gpui_platform::application();
    application.run(move |cx: &mut App| {
        cx.bind_keys([KeyBinding::new("secondary-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());

        // The backend stops with the shutdown handshake before the app goes.
        // GPUI gives quit observers a short deadline, so the wait happens
        // here, on the main thread, as Electron's `before-quit` holds the
        // quit until the backend confirms.
        cx.on_app_quit(move |_| {
            stop_backend(&quit_supervisor, &runtime_handle);
            async {}
        })
        .detach();

        let status = bridge::mirror(cx, backend_state.clone(), StatusLine::of);
        let connection = bridge::mirror(cx, connection_state.clone(), connection_text);
        let window_bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(window_bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(nav::window_title(PageId::Studio).into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.), px(13.))),
                }),
                app_id: Some(APP_ID.into()),
                ..Default::default()
            },
            |_, cx| cx.new(|cx| Shell::new(status.clone(), connection.clone(), cx)),
        );
        let main_window = match opened {
            Ok(handle) => handle,
            Err(error) => {
                eprintln!("[videorc-app] the main window did not open: {error:#}");
                cx.quit();
                return;
            }
        };
        cx.activate(true);

        // Closing the last window quits, as Electron does on Windows and
        // Linux. (On macOS Electron keeps the app in the Dock; the menu bar
        // and the Dock's reopen land with S2.6a.)
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        // A second launch brings the window up.
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(200))
                    .await;
                let mut handed = false;
                while let Ok(links) = handoff_rx.try_recv() {
                    eprintln!(
                        "[videorc-app] a second launch handed over {} link(s)",
                        links.len()
                    );
                    handed = true;
                }
                if handed {
                    cx.update(|cx| {
                        let _ = main_window.update(cx, |_, window, _| window.activate_window());
                        cx.activate(true);
                    });
                }
            }
        })
        .detach();

        if let Some(seconds) = quit_after {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_secs_f64(seconds))
                    .await;
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
    });

    // Where the platform's run loop returns (not on macOS, which exits from
    // `terminate:`), stop the backend if the quit hook didn't.
    stop_backend(&supervisor, runtime.handle());
    drop(instance);
    Ok(())
}

/// The shutdown handshake, once: waits up to the stop grace (and a margin)
/// for the backend to confirm, and says if an owned process outlived it.
fn stop_backend(supervisor: &Rc<RefCell<Option<Supervisor>>>, runtime: &tokio::runtime::Handle) {
    let Some(supervisor) = supervisor.borrow_mut().take() else {
        return;
    };
    let (done_tx, done_rx) = mpsc::channel();
    runtime.spawn(async move {
        let _ = done_tx.send(supervisor.stop().await);
    });
    match done_rx.recv_timeout(STOP_GRACE + Duration::from_secs(5)) {
        Ok(outcome) if outcome.stray_pids.is_empty() => {
            eprintln!("[videorc-app] backend stopped");
        }
        Ok(outcome) => {
            eprintln!(
                "[videorc-app] backend stopped, but owned pid(s) {:?} are still running",
                outcome.stray_pids
            );
        }
        Err(_) => eprintln!("[videorc-app] the backend did not confirm its stop in time"),
    }
}
