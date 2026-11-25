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
//! Plan 260 S2.4 (lane L7): the Studio driver runs on the client, and the
//! Studio page records, shows the clock, stops, and goes live to the saved
//! destinations through it.
//!
//! ```text
//! cargo run -p videorc-app -- --profile /tmp/videorc-profile
//! ```
//!
//! Without `--profile` (or `VIDEORC_USER_DATA_DIR` / `VIDEORC_APP_DATA_DIR`)
//! the app uses the owner's real Videorc data directory, as the shipped app
//! will.

/// `secondary-` for a static key binding: ⌘ on macOS, Ctrl elsewhere.
/// gpui-pre 0.3.14's `KeyBinding::new` parses only explicit modifiers (its
/// `secondary-` needs the host OS, `KeyBinding::load`), and panics on
/// anything else, so `KeyBinding::new("secondary-k", …)` aborted the app at
/// launch. `secondary!("k")` is `"cmd-k"` or `"ctrl-k"`, decided where it
/// was compiled, which is where it runs.
#[cfg(target_os = "macos")]
macro_rules! secondary {
    ($keys:literal) => {
        concat!("cmd-", $keys)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! secondary {
    ($keys:literal) => {
        concat!("ctrl-", $keys)
    };
}

mod app;
mod lcd;
mod platform;
mod preview;
mod screens;
// Plan 260 S2.5 (L6): the smoke command server and the UI driver, started
// once the main window is up when a smoke asks for it. Some of the driver's
// parts wait for GPUI gaps (docs/gpui/ui-driver.md) and are not called yet.
#[allow(dead_code)]
mod smoke;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use gpui::{App, AppContext, Bounds, WindowOptions, px, size};
use videorc_app_core::StopOrigin;
use videorc_app_core::desktop::deep_link::{DeepLinks, LinkSource};
use videorc_app_core::desktop::exit_guard::AppExitKind;
use videorc_app_core::desktop::global_shortcuts::GlobalShortcutsConfig;
use videorc_app_core::desktop::single_instance::{
    self, Acquired, HANDOFF_WAIT, RELAUNCH_LOCK_WAIT,
};
use videorc_app_core::nav::{self, PageId};
use videorc_app_core::studio::STUDIO_EVENTS;
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{
    BackendClient, BackendLaunch, ClientConfig, ConnectionState, EventFilter, Isolation, Level,
    LogFileLimits, Logger, RotatingLogFile, Studio, StudioConfig, Supervisor, SupervisorConfig,
};

use app::args;
use app::bridge;
use app::exit::ExitGuard;
use app::hide::HideFromStream;
use app::permissions::Permissions;
use app::shell::{Shell, StatusLine, connection_text};
use app::{camera, capture, hotkeys, links, menus, sleep};
use screens::destinations::DestinationsPanel;
use screens::first_run::FirstRunScreen;
use screens::go_live::GoLiveDialog;
use screens::guests::GuestsPanel;
use screens::images_sounds::{ImagesPanel, SoundsPanel};
use screens::notes::frame::NotesFrame;
use screens::output::OutputPanel;
use screens::sources::SourcesPanel;
use screens::stream_manager::frame::StreamManagerFrame;
use screens::studio::{
    self as studio_screen, StudioPage,
    scenes::ScenesSection,
    session::SessionSection,
    takeover::{TakeoverLink, TakeoverSection},
    transport::{SessionControls, Transport},
};

/// Electron's app id (`electron-builder.yml`), kept on every platform: the
/// macOS bundle id, Videorc Camera's host, Linux's desktop entry and the
/// portal app id. A new id would lose the TCC grants, the portal's
/// permissions and shortcuts, and the `videorc://` handler at the crossover
/// (S5.0 keeps every grant). Coordinator decision, 2026-11-24.
const APP_ID: &str = "dev.theorcdev.videorc";

fn main() -> Result<()> {
    let args = args::parse()?;
    // A package's resources (Electron's `process.resourcesPath`), when the
    // app runs from one: the bundled pictures, pet packs and starter sounds
    // load from there, and the run needs no checkout.
    let exe = std::env::current_exe().context("this app's executable")?;
    let resources =
        videorc_app_core::bundled::packaged_resources_dir(&exe, |name| std::env::var(name).ok());
    // A package never adopts a checkout it merely finds (it would share a
    // dev app's owned-process ledger); see `bundled::run_root`.
    let root = videorc_app_core::bundled::run_root(
        args::explicit_workspace_root(args.workspace.clone()),
        resources.as_deref(),
        &exe,
        args::discovered_workspace_root,
    )
    .ok_or_else(|| anyhow::anyhow!("could not find the workspace root; pass --workspace"))?;
    let paths = args::app_paths(&args);
    std::fs::create_dir_all(&paths.user_data_dir)
        .with_context(|| format!("could not create {}", paths.user_data_dir.display()))?;

    // One instance per data directory, before any window: a second launch
    // hands its links to the first (which brings its window up) and exits,
    // as Electron's `second-instance`. A launch Reopen Videorc started waits
    // for the old instance to let go instead.
    let acquired = if args.relaunched {
        single_instance::acquire_after_relaunch(&paths.user_data_dir, RELAUNCH_LOCK_WAIT)
    } else {
        single_instance::acquire(&paths.user_data_dir)
    };
    let mut instance = match acquired {
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

    // Connect an agent's bridge (`videorc-mcp`) ships beside the backend.
    let mut bridge_dir = root.join("target").join(args::build_profile_dir());
    let mut launch = if args.cargo_run {
        BackendLaunch::cargo_run(&root, paths.user_data_dir.clone())
    } else {
        let backend = args
            .backend
            .clone()
            .or_else(|| {
                // Published sentinel pairs and packaged apps keep their
                // backend beside the app, independent of the build checkout.
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| {
                        exe.parent()
                            .map(|dir| dir.join(videorc_app_core::process::backend_binary_name()))
                    })
                    .filter(|path| path.is_file())
            })
            .unwrap_or_else(|| {
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
        if let Some(dir) = backend.parent() {
            bridge_dir = dir.to_path_buf();
        }
        BackendLaunch::binary(backend, &root, paths.user_data_dir.clone())
    };
    launch.isolation = paths.isolation;
    launch.app_version = Some(env!("CARGO_PKG_VERSION").to_string());
    // Electron's `extraResources` (preset pictures and live posters, pet
    // packs, starter sounds): this checkout's in a dev build, the package's
    // resources once there is one. The backend gets the managed roots
    // Electron's main sets, so bundled and imported pictures resolve.
    let bundled = videorc_app_core::bundled::init(
        videorc_app_core::bundled::BundledAssets::locate(&root, resources.as_deref()),
    );
    launch
        .extra_env
        .extend(bundled.backend_env(&paths.user_data_dir));
    launch.path_prepend = vec![videorc_app_core::paths::cargo_bin_dir()];
    let stderr_logger = logger.clone();
    launch.stderr_sink = Some(std::sync::Arc::new(move |line: &str| {
        stderr_logger.log(Level::infer(line), line);
    }));

    // The smoke command server's switch (Electron's
    // `smokeCommandServerEnabled`), read once here: a smoke run keeps the
    // Studio from picking devices for it.
    let smoke_packaged = smoke::shell::packaged();
    let smoke_run = videorc_app_core::smoke::SmokeSwitch::resolve(
        |name| std::env::var(name).ok(),
        smoke_packaged,
    )
    .is_some();

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
    // the screens land: `backend.ready` always arrives; S2.4 reads the
    // Studio's events; the sleep guard, the permission restarts and the quit
    // while on air read `recording.status` (one of them); the quit also reads
    // the talk show room's `cloud.state`; Videorc Camera's extension follows
    // `virtualCamera.changed`.
    let (client, events) = BackendClient::start(
        supervisor.state(),
        ClientConfig {
            filter: EventFilter::include(
                STUDIO_EVENTS
                    .into_iter()
                    .chain([camera::VIRTUAL_CAMERA_CHANGED, app::exit::CLOUD_STATE])
                    .chain(screens::settings::EVENTS)
                    .chain(screens::captions::EVENTS)
                    .chain(screens::avatar::EVENTS)
                    .chain(screens::sidekick::EVENTS)
                    .chain(screens::studio::chat::EVENTS)
                    .chain(screens::studio::soundboard::EVENTS)
                    .chain(videorc_app_core::library::LIBRARY_EVENTS)
                    .chain([videorc_app_core::library::cloud_markers::CREATED_EVENT])
                    .chain(["session.log"])
                    // The hide state: Follow the app in front, and Studio's
                    // Scenes section (Hide screen).
                    .chain(["screen.privacy.changed"])
                    // The Videorc account and its plan (S1.6f).
                    .chain(videorc_app_core::accounts::EVENTS),
            ),
            logger: logger.clone(),
            ..ClientConfig::default()
        },
    );
    let client = Arc::new(client);
    // The capture state's own receiver, taken before the runtime runs
    // anything, so the Studio keeps the first one (it must see
    // `backend.ready`).
    let capture_events = client.subscribe();
    let library_events = client.subscribe();
    let library_files = screens::library::files::Files::new(supervisor.state());
    let library = Arc::new(screens::library::Core::new(
        client.clone(),
        library_files.clone(),
    ));
    // Subscribe first, then recover Ready if the client connected before
    // the Library was installed. Reconnects are driven by this same receiver.
    if let ConnectionState::Connected { ready, .. } = &*client.state().borrow() {
        library.on_event(videorc_app_core::BackendEvent::Ready(ready.clone()));
    }
    runtime.spawn(library.clone().drive(library_events));

    // S2.4: the Studio driver on the client (the session, the settings, the
    // sources), fed by the client's events on the core's runtime. The views
    // read its snapshot through the store bridge and call it there.
    let studio = Arc::new(Studio::new(
        client.clone(),
        StudioConfig {
            logger: logger.clone(),
            settings_journal: Some(paths.ui_settings_journal_file()),
            app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            // The app picks a first device for a slot nobody chose, as
            // Electron does; a smoke run keeps it off.
            withhold_device_defaults: smoke_run,
            ..StudioConfig::default()
        },
    ));
    // #1874: authorize a user-chosen recordings folder on the ready backend;
    // Clips media grants are set once Permissions is installed below.
    studio.set_output_authorizer(videorc_app_core::resources::output_directory_authorizer(
        supervisor.state(),
    ));
    runtime.spawn(studio.clone().drive(events));

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

    // S2.6a: the display stays awake while a session runs, a permission
    // grant restarts the backend once capture is idle, and links reach the
    // core from the command line, the Apple Event and a second launch.
    let capture_state = capture::follow(runtime.handle(), capture_events);
    let sleep_guard = sleep::follow(runtime.handle(), capture_state.clone(), logger.clone());
    let permissions = Permissions::install(
        runtime.handle(),
        supervisor.restarter(),
        capture_state,
        logger.clone(),
    );
    studio.set_clips_media_access(Some(permissions.snapshot()));
    // The bundled pictures, registered with the backend at every READY.
    app::bundled_backgrounds::install(runtime.handle(), supervisor.state(), logger.clone());
    // Videorc Camera's extension: activated when the backend's switch is on.
    let camera_controller = camera::Camera::install(
        runtime.handle(),
        supervisor.state(),
        client.subscribe(),
        logger.clone(),
    );
    let deep_links: links::Links = Arc::new(DeepLinks::new(client.clone(), logger.clone()));
    // S1.6f (L4): the Videorc account. `videorc://account/callback` goes to
    // the sign-in this app started; any other is refused by name.
    let accounts = app::accounts::start(
        runtime.handle(),
        client.clone(),
        supervisor.state(),
        studio.clone(),
    );
    deep_links.set_account_sink(accounts.clone());
    // The updater (plan 260, L4): no feed until S5.2.
    let updater = app::updater::start();
    // Where Connect an agent's bridge lives; after an update a copy the
    // streamer already has is refreshed (`refreshAgentBridgeCopy`).
    let agent_bridge = videorc_app_core::desktop::agent_bridge::BridgeLocation {
        packaged: smoke::shell::packaged(),
        platform: videorc_app_core::desktop::agent_bridge::BridgePlatform::current(),
        bundled_dir: bridge_dir,
        home_dir: videorc_app_core::paths::home_dir(),
        local_app_data: std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from),
        app_executable: std::env::current_exe().ok(),
    };
    let refresh_bridge = agent_bridge.clone();
    let _ = runtime.spawn_blocking(move || {
        videorc_app_core::desktop::agent_bridge::refresh_copy(&refresh_bridge)
    });
    links::receive(&deep_links, &args.links, LinkSource::CommandLine);

    let backend_state = supervisor.state();
    let connection_state = client.state();
    // The preview (plan 260 S2.3a, L1): started in the main window, stopped
    // before the backend at quit.
    let preview_runtime = runtime.handle().clone();
    let preview_logger = logger.clone();
    let preview_slot: Rc<RefCell<Option<gpui::Entity<preview::Preview>>>> =
        Rc::new(RefCell::new(None));
    let quit_preview = preview_slot.clone();
    let smoke_preview = preview_slot.clone();
    let studio_state = studio.watch();
    // Taken by the quit: the shutdown handshake runs once.
    let supervisor = Rc::new(RefCell::new(Some(supervisor)));
    let quit_supervisor = supervisor.clone();
    let runtime_handle = runtime.handle().clone();
    let core_handle = runtime.handle().clone();
    let quit_after = args.quit_after;
    // The main window's frame, saved in the data directory.
    let stream_manager_frame = StreamManagerFrame::new(&paths.user_data_dir, logger.clone());
    let notes_frame = NotesFrame::new(&paths.user_data_dir, logger.clone());
    #[cfg(target_os = "macos")]
    let preview_frame = preview::frame::PreviewFrame::new(&paths.user_data_dir, logger.clone());
    let captions_frame =
        screens::captions::reader::CaptionsFrame::new(&paths.user_data_dir, logger.clone());
    let quit_guard = sleep_guard.clone();
    let quit_permissions = permissions.clone();
    let focus_permissions = permissions.clone();
    let settings_permissions = permissions.clone();
    // The single-instance lock goes before a relaunch starts the new app.
    let instance = Rc::new(RefCell::new(instance));
    let quit_instance = instance.clone();
    let hotkey_logger = logger.clone();
    let follow_logger = logger.clone();
    let health_logger = logger.clone();
    let handoff_links = deep_links.clone();
    // The quit while on air: the guard follows the backend's events.
    let exit_events = client.subscribe();
    let exit_runtime = runtime.handle().clone();

    let application = gpui_platform::application();
    // Registered before `run`, so a link that starts the app is not lost.
    let apple_links = deep_links.clone();
    application.on_open_urls(move |urls| {
        links::receive(&apple_links, &urls, LinkSource::AppleEvent);
    });
    let permissions_after_run = permissions.clone();
    // The Dock's click with no window showing brings the main window back
    // (macOS keeps the app running when it closes, `app::exit`).
    application.on_reopen(ExitGuard::show_main_window);
    application.run(move |cx: &mut App| {
        // The scene picker's Screen Recording alert reads it (P488).
        cx.set_global(app::permissions::PermissionsGlobal(settings_permissions.clone()));
        videorc_kit::init(cx);
        // The menu bar from the core's template, and the keys it names.
        ExitGuard::install(cx, &exit_runtime, exit_events);
        // The question is the Studio's stop request (Quit or Close Window as
        // its origin), which the shell's End livestream dialog shows; its yes
        // lets the exit through (`screens::dialogs::end_livestream`).
        let answer_studio = studio.clone();
        let answer_runtime = exit_runtime.clone();
        ExitGuard::set_answerer(
            Rc::new(move |kind, _| {
                let origin = match kind {
                    AppExitKind::Quit => StopOrigin::Quit,
                    AppExitKind::Close => StopOrigin::CloseWindow,
                };
                let studio = answer_studio.clone();
                answer_runtime.spawn(async move {
                    let outcome = studio.request_stop(origin).await;
                    eprintln!("[videorc-app] {origin:?} while on air: {outcome:?}");
                });
            }),
            cx,
        );
        menus::install(cx);
        app::updater::install(cx, updater.clone(), studio.clone());
        cx.set_global(screens::settings::connect_agent::AgentBridge(
            agent_bridge.clone(),
        ));
        app::accounts::install(
            cx,
            app::accounts::Shared {
                accounts: accounts.clone(),
                studio: studio.clone(),
                runtime: core_handle.clone(),
                web: app::accounts::web_links(cfg!(debug_assertions)),
                development: cfg!(debug_assertions),
            },
        );
        studio_screen::bind_keys(cx);
        screens::sources::bind_keys(cx);
        screens::scene::bind_keys(cx);
        screens::notifications::install_keys(cx);
        let notices = cx.new(|cx| {
            screens::notifications::Hub::new(
                studio.clone(),
                core_handle.clone(),
                backend_state.clone(),
                cx,
            )
        });
        notices.update(cx, |hub, cx| hub.attach_library(library.notices(), cx));
        cx.set_global(screens::notifications::Shared(notices.clone()));

        // Hide from stream: content protection and the capture filter's
        // list, which the Studio sends with each screen capture start and
        // to a running capture when it changes (Electron's renderer re-send).
        let mut capture_filter_ids = HideFromStream::install(cx);
        {
            let studio = studio.clone();
            core_handle.spawn(async move {
                loop {
                    let ids = capture_filter_ids.borrow_and_update().clone();
                    studio.set_protected_overlay_window_ids(ids).await;
                    if capture_filter_ids.changed().await.is_err() {
                        break;
                    }
                }
            });
        }

        // Only Studio-owned actions register; Settings keeps the bindings current.
        let global_keys = hotkeys::Hotkeys::install(
            cx,
            Rc::new(hotkeys::StudioActions {
                studio: studio.clone(),
                runtime: core_handle.clone(),
            }),
            hotkey_logger,
        );
        global_keys.apply(&GlobalShortcutsConfig::default(), hotkeys::node_platform());
        let quit_keys = global_keys.clone();

        // The backend stops with the shutdown handshake before the app goes.
        // GPUI gives quit observers a short deadline, so the wait happens
        // here, on the main thread, as Electron's `before-quit` holds the
        // quit until the backend confirms.
        cx.on_app_quit(move |cx| {
            // The preview releases its lease and destroys its surface while
            // the backend still answers.
            if let Some(preview) = quit_preview.borrow_mut().take() {
                preview.update(cx, |preview, cx| preview.stop(cx));
            }
            quit_keys.release_all();
            sleep::release(&quit_guard);
            stop_backend(&quit_supervisor, &runtime_handle);
            quit_instance.borrow_mut().take();
            quit_permissions.relaunch_if_requested();
            async {}
        })
        .detach();

        let status = bridge::mirror(cx, backend_state.clone(), StatusLine::of);
        let connection = bridge::mirror(cx, connection_state.clone(), connection_text);
        let controls = bridge::mirror(cx, studio_state.clone(), SessionControls::of);
        let talk_show =
            bridge::mirror(cx, studio.cloud(), screens::studio::transport::talk_show_of);
        let takeover_link = bridge::mirror(cx, studio_state.clone(), TakeoverLink::of);
        let transport = cx.new(|cx| {
            Transport::new(
                studio.clone(),
                core_handle.clone(),
                controls.clone(),
                talk_show.clone(),
                cx,
            )
        });
        let sources = cx.new(|cx| {
            SourcesPanel::new(studio.clone(), permissions.clone(), core_handle.clone(), cx)
        });
        // Captions ⌘4 and the reader share one caption feed (plan 260, L2);
        // Output's quality lock reads its entitlements, so it comes first.
        screens::captions::install(studio.clone(), core_handle.clone(), cx);
        let output = cx.new(|cx| {
            OutputPanel::new(
                studio.clone(),
                core_handle.clone(),
                global_keys.clone(),
                cx,
            )
        });
        let destinations =
            cx.new(|cx| DestinationsPanel::new(studio.clone(), core_handle.clone(), cx));
        let guests = cx.new(|cx| GuestsPanel::new(studio.clone(), core_handle.clone(), cx));
        // One poster cache for the Library and Clean cut (plan 260 L3),
        // before Sidekick, which observes it.
        app::posters::install(library.clone(), core_handle.clone(), cx);
        let sidekick = cx.new(|cx| {
            screens::sidekick::SidekickScreen::new(
                studio.clone(),
                core_handle.clone(),
                paths.user_data_dir.clone(),
                library_files.backend.clone(),
                cx,
            )
        });
        let avatar = cx.new(|cx| {
            screens::avatar::AvatarScreen::new(
                studio.clone(),
                core_handle.clone(),
                paths.user_data_dir.clone(),
                cx,
            )
        });
        let images = cx.new(|cx| {
            ImagesPanel::new(
                studio.clone(),
                core_handle.clone(),
                backend_state.clone(),
                cx,
            )
        });
        let go_live = cx.new(|cx| GoLiveDialog::new(studio.clone(), core_handle.clone(), cx));
        let first_run = cx.new(|cx| {
            FirstRunScreen::new(studio.clone(), permissions.clone(), core_handle.clone(), cx)
        });
        let settings = cx.new(|cx| {
            screens::settings::SettingsScreen::new(
                studio.clone(),
                backend_state.clone(),
                global_keys.clone(),
                core_handle.clone(),
                settings_permissions.clone(),
                paths.user_data_dir.clone(),
                cx,
            )
        });
        let health = cx.new(|cx| {
            screens::health::HealthScreen::new(
                studio.clone(),
                core_handle.clone(),
                health_logger.clone(),
                paths.clone(),
                settings_permissions.clone(),
                camera_controller.clone(),
                cx,
            )
        });
        // Electron's main window (P043, P1553): 1180×780 every launch (its
        // frame is never saved), at least 960×660.
        let window_bounds = Bounds::centered(None, size(px(1180.), px(780.)), cx);
        let opened = cx.open_window(
            WindowOptions {
                app_id: Some(APP_ID.into()),
                window_min_size: Some(size(px(960.), px(660.))),
                ..videorc_kit::window::options(nav::window_title(PageId::Studio), window_bounds)
            },
            |window, cx| {
                let preview = preview::Preview::new(
                    preview::PreviewSetup {
                        runtime: preview_runtime.clone(),
                        backend: backend_state.clone(),
                        logger: preview_logger.clone(),
                        studio: studio.clone(),
                    },
                    window,
                    cx,
                );
                #[cfg(target_os = "macos")]
                preview.update(cx, |preview, _| {
                    preview.remember_window(preview_frame.clone())
                });
                *preview_slot.borrow_mut() = Some(preview.clone());
                let session = cx.new(|cx| {
                    SessionSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        studio.telemetry(),
                        cx,
                    )
                });
                let audio = cx.new(|cx| {
                    screens::studio::audio::AudioSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        studio.mic_levels(),
                        studio.cloud(),
                        cx,
                    )
                });
                let chat = cx.new(|cx| {
                    screens::studio::chat::ChatSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        studio.live_chat(),
                        cx,
                    )
                });
                let quick_settings = cx.new(|cx| {
                    screens::studio::quick_settings::QuickSettingsSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        studio.telemetry(),
                        studio.live_chat(),
                        cx,
                    )
                });
                let takeover = cx.new(|cx| {
                    TakeoverSection::new(
                        studio.backend().clone(),
                        core_handle.clone(),
                        takeover_link.clone(),
                        cx,
                    )
                });
                let scenes = cx.new(|cx| {
                    ScenesSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        talk_show.clone(),
                        global_keys.clone(),
                        permissions.clone(),
                        window,
                        cx,
                    )
                });
                let soundboard = cx.new(|cx| {
                    screens::studio::soundboard::SoundboardSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        talk_show.clone(),
                        cx,
                    )
                });
                let cloud_resume = cx.new(|cx| {
                    screens::studio::alerts::CloudResumeSlot::new(
                        studio.clone(),
                        core_handle.clone(),
                        cx,
                    )
                });
                let vertical_stream = cx.new(|cx| {
                    screens::studio::vertical_stream::VerticalStreamSection::new(
                        studio.clone(),
                        core_handle.clone(),
                        studio_state.clone(),
                        cx,
                    )
                });
                let show_stage = cx.new(|cx| {
                    screens::studio::show_stage::ShowStage::new(
                        studio.clone(),
                        core_handle.clone(),
                        talk_show.clone(),
                        cx,
                    )
                });
                let talk_show_host = cx.new(|cx| {
                    screens::studio::talk_show_host::TalkShowRoomHost::new(
                        studio.clone(),
                        core_handle.clone(),
                        talk_show.clone(),
                        paths.user_data_dir.clone(),
                        cx,
                    )
                });
                let studio_page = cx.new(|cx| {
                    StudioPage::new(
                        transport.clone(),
                        preview.clone(),
                        cloud_resume.clone(),
                        session,
                        chat,
                        audio,
                        quick_settings,
                        takeover,
                        scenes,
                        soundboard,
                        vertical_stream,
                        show_stage,
                        talk_show_host,
                        window,
                        cx,
                    )
                });
                let library_page = cx.new(|cx| {
                    screens::library::LibraryScreen::new(
                        library.clone(),
                        library_files.clone(),
                        studio.clone(),
                        core_handle.clone(),
                        preview_logger.clone(),
                        window,
                        cx,
                    )
                });
                let palette = cx.new(|cx| {
                    screens::command_palette::CommandPalette::new(
                        studio.clone(),
                        core_handle.clone(),
                        window,
                        cx,
                    )
                });
                let dialogs = cx.new(|cx| {
                    screens::dialogs::DialogsHost::new(
                        studio.clone(),
                        core_handle.clone(),
                        controls.clone(),
                        cx,
                    )
                });
                palette.update(cx, |palette, _| palette.bind_dialogs(dialogs.clone()));
                cloud_resume.update(cx, |slot, _| slot.bind_dialogs(dialogs.clone()));
                let sounds = cx.new(|cx| {
                    SoundsPanel::new(
                        studio.clone(),
                        core_handle.clone(),
                        backend_state.clone(),
                        window,
                        cx,
                    )
                });
                // Plan 260 Phase 3 (L1): the Scene page ⌘3.
                let scene = cx.new(|cx| {
                    screens::scene::ScenePage::new(
                        studio.clone(),
                        core_handle.clone(),
                        global_keys.clone(),
                        preview.clone(),
                        paths.user_data_dir.clone(),
                        window,
                        cx,
                    )
                });
                cx.new(|cx| {
                    Shell::new(
                        status.clone(),
                        connection.clone(),
                        studio_page,
                        preview,
                        sources.clone(),
                        output.clone(),
                        destinations.clone(),
                        guests.clone(),
                        avatar.clone(),
                        sidekick.clone(),
                        images.clone(),
                        sounds,
                        go_live.clone(),
                        first_run.clone(),
                        settings.clone(),
                        health.clone(),
                        library_page,
                        palette,
                        dialogs,
                        notices.clone(),
                        scene,
                        window,
                        cx,
                    )
                })
            },
        );
        let main_window = match opened {
            Ok(handle) => handle,
            Err(error) => {
                eprintln!("[videorc-app] the main window did not open: {error:#}");
                ExitGuard::quit_unasked(cx);
                return;
            }
        };
        cx.activate(true);
        // The Stream Manager's menu command and keys, and the window when it
        // was open at the last quit.
        screens::stream_manager::window::install(
            cx,
            stream_manager_frame,
            APP_ID,
            studio.dashboard(),
            studio.clone(),
            core_handle.clone(),
        );
        screens::notes::window::install(cx, notes_frame, APP_ID);

        // Follow the app in front and the password-manager hide (plan 210
        // D10/D11): the core's follower, fed by the platform's front-app
        // watcher (NSWorkspace on macOS; WinEvent / GetForegroundWindow on
        // Windows; _NET_ACTIVE_WINDOW on Linux X11; Wayland named no-op).
        {
            let mut self_ids = vec![APP_ID.to_string()];
            #[cfg(target_os = "macos")]
            self_ids.extend(platform::macos::front_app::self_bundle_id());
            #[cfg(target_os = "windows")]
            self_ids.extend(platform::windows::front_app::self_bundle_id());
            #[cfg(target_os = "linux")]
            self_ids.extend(platform::linux::front_app::self_bundle_id());
            let feed = videorc_app_core::studio::follow_runner::start(
                &core_handle,
                studio.clone(),
                self_ids,
                follow_logger.clone(),
            );
            let started = {
                #[cfg(target_os = "macos")]
                {
                    platform::macos::front_app::start(feed.sender.clone())
                }
                #[cfg(target_os = "windows")]
                {
                    platform::windows::front_app::start(feed.sender.clone())
                }
                #[cfg(target_os = "linux")]
                {
                    platform::linux::front_app::start(feed.sender.clone())
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
                {
                    let _ = &feed;
                    false
                }
            };
            if started {
                let watch = feed.watch_windows.clone();
                cx.spawn(async move |cx| {
                    loop {
                        cx.background_executor()
                            .timer(Duration::from_millis(500))
                            .await;
                        // Always poll on Windows/Linux (event hooks miss
                        // same-app window swaps); on macOS only while Follow
                        // asks for the front-window watch.
                        let want = {
                            #[cfg(target_os = "macos")]
                            {
                                watch.load(std::sync::atomic::Ordering::Relaxed)
                            }
                            #[cfg(not(target_os = "macos"))]
                            {
                                let _ = &watch;
                                true
                            }
                        };
                        if want {
                            cx.update(|_| {
                                #[cfg(target_os = "macos")]
                                platform::macos::front_app::poll();
                                #[cfg(target_os = "windows")]
                                platform::windows::front_app::poll();
                                #[cfg(target_os = "linux")]
                                platform::linux::front_app::poll();
                            });
                        }
                    }
                })
                .detach();
            } else {
                drop(feed);
                #[cfg(target_os = "linux")]
                {
                    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                        follow_logger.info(platform::linux::front_app::WAYLAND_NO_WATCHER);
                    } else {
                        follow_logger.warn(
                            "Follow the app in front: the X11 front-app watcher did not start; Follow and the password-manager hide stay off.",
                        );
                    }
                }
                #[cfg(not(target_os = "linux"))]
                follow_logger.warn(
                    "Follow the app in front: the front-app watcher did not start; Follow and the password-manager hide stay off.",
                );
            }
        }
        // P1549: a Preview left floating floats again once the workspace
        // shows (Electron's `restorePreviewWindowOnLaunch`, held while
        // first-run setup fills the window).
        #[cfg(target_os = "macos")]
        if let Some(preview) = preview_slot.borrow().clone() {
            if first_run.read(cx).is_open() {
                let pending = std::cell::Cell::new(true);
                cx.observe(&first_run, move |first_run, cx| {
                    if !first_run.read(cx).is_open() && pending.replace(false) {
                        preview.update(cx, |preview, cx| preview.restore_at_launch(cx));
                    }
                })
                .detach();
            } else {
                preview.update(cx, |preview, cx| preview.restore_at_launch(cx));
            }
        }
        screens::captions::reader::install(cx, captions_frame, APP_ID);

        // The smoke command server and the UI driver (plan 260 S2.5), when a
        // smoke asked for them; off, this does nothing. `app-quit` reaches
        // the app's own quit on the foreground.
        let (smoke_quit_tx, mut smoke_quit_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        smoke::start(
            cx,
            smoke::SmokeStart {
                runtime: core_handle.clone(),
                backend: backend_state.clone(),
                isolated_backend: (paths.isolation == Isolation::Profile).then(|| {
                    videorc_app_core::process::IsolatedBackendPaths::under(&paths.user_data_dir)
                }),
                packaged: smoke_packaged,
                quit: Arc::new(move || {
                    let _ = smoke_quit_tx.send(());
                }),
                // The Studio's commands: the test pattern, its state, Record
                // and Stop (the rest answer "not supported" by name).
                studio: Some(Arc::new(videorc_app_core::smoke::StudioSmoke::new(
                    studio.clone(),
                ))),
                windows: Vec::new(),
                shell: Rc::new(smoke::shell::ShellWindows::new(
                    main_window,
                    notices.clone(),
                    smoke_preview.clone(),
                )),
            },
        );
        cx.spawn(async move |cx| {
            if smoke_quit_rx.recv().await.is_some() {
                cx.update(ExitGuard::quit_unasked);
            }
        })
        .detach();
        cx.on_action(move |_: &menus::ShowSettings, cx| {
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_settings(None, window, cx)
            });
        });
        cx.on_action(move |_: &menus::ShowShortcuts, cx| {
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_settings(
                    Some(videorc_app_core::settings_page::SettingsTab::Shortcuts),
                    window,
                    cx,
                )
            });
        });
        // About Videorc (P1494): macOS's own About panel, as Electron's
        // `about` role; elsewhere (no menu bar) Settings → About.
        cx.on_action(move |_: &menus::About, cx| {
            #[cfg(target_os = "macos")]
            {
                cx.activate(true);
                platform::macos::show_about_panel();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_settings(
                    Some(videorc_app_core::settings_page::SettingsTab::About),
                    window,
                    cx,
                )
            });
        });
        // Window → Preview and ⌘P (P1506, P052): an open Preview closes, a
        // closed one opens where it was; the main window comes up for it.
        // Every platform: without a floating window (Windows today) it still
        // toggles the closed state, and `toggle_open` docks it.
        let toggle_preview = preview_slot.clone();
        cx.on_action(move |_: &menus::TogglePreview, cx| {
            let Some(preview) = toggle_preview.borrow().clone() else {
                return;
            };
            let _ = main_window.update(cx, |_, window, _| window.activate_window());
            preview.update(cx, |preview, cx| preview.toggle_open(cx));
        });
        cx.on_action(move |_: &menus::ShowImages, cx| {
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_page(PageId::Assets, window, cx);
                window.activate_window();
            });
        });
        cx.on_action(move |_: &menus::ShowSounds, cx| {
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_page(PageId::Sounds, window, cx);
                window.activate_window();
            });
        });
        // View → the pages and ⌘1–⌘0 (P1499–P1503, P1559): the page as its
        // sidebar row opens it, from any window; the main window comes up.
        let show_page = move |key: videorc_app_core::desktop::menu::PageKey, cx: &mut App| {
            let Some(page) = PageId::from_menu_key(key) else {
                return;
            };
            let _ = main_window.update(cx, |shell, window, cx| {
                shell.open_page(page, window, cx);
                window.activate_window();
            });
        };
        {
            use videorc_app_core::desktop::menu::PageKey::Digit;
            cx.on_action(move |_: &menus::ShowPage1, cx| show_page(Digit(1), cx));
            cx.on_action(move |_: &menus::ShowPage2, cx| show_page(Digit(2), cx));
            cx.on_action(move |_: &menus::ShowPage3, cx| show_page(Digit(3), cx));
            cx.on_action(move |_: &menus::ShowPage4, cx| show_page(Digit(4), cx));
            cx.on_action(move |_: &menus::ShowPage5, cx| show_page(Digit(5), cx));
            cx.on_action(move |_: &menus::ShowPage6, cx| show_page(Digit(6), cx));
            cx.on_action(move |_: &menus::ShowPage7, cx| show_page(Digit(7), cx));
            cx.on_action(move |_: &menus::ShowPage8, cx| show_page(Digit(8), cx));
            cx.on_action(move |_: &menus::ShowPage9, cx| show_page(Digit(9), cx));
            cx.on_action(move |_: &menus::ShowPage0, cx| show_page(Digit(0), cx));
        }

        // The main window coming to the front re-checks a grant System
        // Settings may have made meanwhile.
        let focus_studio = studio.clone();
        let _ = main_window.update(cx, |_shell, window, cx| {
            let shell_weak = cx.weak_entity();
            sources.update(cx, |panel, _| panel.bind_shell(shell_weak.clone()));
            output.update(cx, |panel, _| panel.bind_shell(shell_weak.clone()));
            images.update(cx, |panel, _| panel.bind_shell(shell_weak));
            ExitGuard::watch_main_window(window, cx);
            cx.observe_window_activation(window, move |_, window, cx| {
                if window.is_window_active() {
                    focus_permissions.recheck();
                    focus_studio.set_clips_media_access(Some(focus_permissions.snapshot()));
                    settings.update(cx, |settings, cx| settings.refresh(cx));
                } else {
                    settings.update(cx, |settings, cx| settings.disarm_shortcut(cx));
                }
            })
            .detach();
        });

        // Closing the last window quits, as Electron does on Windows and
        // Linux. On macOS the main window hides instead of closing, so the
        // app stays in the Dock (`ExitGuard::close_main`).
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
                while let Ok(handed_links) = handoff_rx.try_recv() {
                    eprintln!(
                        "[videorc-app] a second launch handed over {} link(s)",
                        handed_links.len()
                    );
                    links::receive(&handoff_links, &handed_links, LinkSource::SecondInstance);
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
                cx.update(ExitGuard::quit_unasked);
            })
            .detach();
        }
    });

    // Where the platform's run loop returns (not on macOS, which exits from
    // `terminate:`), stop the backend if the quit hook didn't.
    sleep::release(&sleep_guard);
    stop_backend(&supervisor, runtime.handle());
    instance.borrow_mut().take();
    permissions_after_run.relaunch_if_requested();
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
