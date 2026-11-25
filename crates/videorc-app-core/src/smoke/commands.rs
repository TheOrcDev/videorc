//! The smoke commands the GPUI app runs (plan 260 S2.5, from plan 220
//! S2.5a), as Electron main runs them in `runSmokePreviewMotionCommand`.
//!
//! The core runs the ones that need only the backend's admin credential and
//! the app's quit, with Electron's rules and answers:
//!
//! - `app-quit`: the app quits (the harness's quit never waits on a
//!   question). Answers `{"quitting":true}` before it goes.
//! - `authorize-smoke-resource`: a single-use backend resource capability
//!   for a file or directory inside `VIDEORC_SMOKE_STATE_DIR`, as
//!   `{capabilityId, kind, displayName}`.
//! - `backend-debug-rpc`: one allowlisted debug RPC on the admin credential.
//! - `inspect-backend-state-isolation`: whether the backend's sqlite,
//!   secrets and recordings live inside the smoke state directory, and the
//!   backend reports that database.
//! - The preview lifecycle probe's quit guard (`SmokeAppQuitGuard`):
//!   `preview-lifecycle-attempt-app-quit` (an unrelated quit, prevented
//!   while `VIDEORC_PREVIEW_LIFECYCLE_PROBE=1` and not yet allowed) and
//!   `preview-lifecycle-allow-app-quit`.
//!
//! Everything else belongs to a part of the app the core does not hold. The
//! app hands each one in as a [`SmokeCommandHandler`] when it exists:
//!
//! - [`STUDIO_COMMANDS`]: the Studio's intents and state (`studio-*`, the
//!   capture source picks, the scenes, Upcoming), on S1.6a's Studio (L7).
//! - [`APP_WINDOW_COMMANDS`]: what needs a window, on the UI thread: the UI
//!   driver (`ui-*`, `capture-page`, `resize-window`: `apps/videorc/src/smoke`,
//!   L6), the shell's (`open-tab`, `main-window-*`: L4), the preview's (L1)
//!   and each window's as its screen lands.
//!
//! A known command nobody runs yet answers, by name, that it is not
//! supported ([`not_supported_message`]); none ever succeeds silently.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::admin::{ADMIN_TIMEOUT, AdminRpc};
use super::security::{
    resource_capability_id_valid, validate_smoke_backend_rpc_request,
    validate_smoke_resource_authorization,
};
use super::server::{CommandFuture, SmokeCommandRunner};
use super::vars;
use crate::process::IsolatedBackendPaths;

/// The commands the core runs; the handlers run the rest.
pub const IMPLEMENTED_COMMANDS: &[&str] = &[
    "app-quit",
    "authorize-smoke-resource",
    "backend-debug-rpc",
    "import-smoke-background",
    "inspect-backend-state-isolation",
    "preview-lifecycle-allow-app-quit",
    "preview-lifecycle-attempt-app-quit",
];

/// The Studio's commands (the Rust app's own names, plan 220 S3.1c to
/// S3.6a): what Electron's smokes reach through the renderer (`eval-js`,
/// `window.__videorcSmoke*`). The app's Studio handler takes exactly these.
pub const STUDIO_COMMANDS: &[&str] = &[
    "enable-synthetic-source",
    "preview-surface-scene-state",
    "scheduled-mutate",
    "scheduled-state",
    "select-camera-device",
    "select-layout-preset",
    "select-screen-device",
    "studio-capture-configure",
    "studio-live-audio-hold",
    "studio-privacy-add-app",
    "studio-privacy-state",
    "studio-put-setting",
    "studio-record",
    "studio-replay-buffer",
    "studio-scene-apply",
    "studio-scene-background",
    "studio-scene-delete",
    "studio-scene-edit",
    "studio-scene-insert",
    "studio-scene-layout",
    "studio-scene-move",
    "studio-scene-save",
    "studio-scenes-state",
    "studio-screen-privacy",
    "studio-shortcut",
    "studio-state",
    "studio-stop",
];

/// Every command the app's window handlers take, Electron's names and the
/// Rust app's, kept sorted; the app's tests check its handlers take only
/// these.
pub const APP_WINDOW_COMMANDS: &[&str] = &[
    "account-sign-in",
    "account-sign-out",
    "account-state",
    "app-menu",
    "app-menu-activate",
    "app-menu-key",
    "apply-native-preview-host-commands",
    "camera-extension-request",
    "captions-state",
    "captions-window-close",
    "captions-window-open",
    "captions-window-set-bounds",
    "captions-window-state",
    "capture-page",
    "capture-page-alpha",
    "comments-window-authority-probe",
    "comments-window-capture-page",
    "comments-window-click-message",
    "comments-window-close",
    "comments-window-command-trace",
    "comments-window-context-click-link",
    "comments-window-layout-metrics",
    "comments-window-open",
    "comments-window-push-delta",
    "comments-window-push-snapshot",
    "comments-window-reader-state",
    "comments-window-route-send-result",
    "comments-window-seed-cohost",
    "comments-window-seed-dashboard",
    "comments-window-seed-viewers",
    "comments-window-set-auto-show-activity",
    "comments-window-set-bounds",
    "comments-window-set-command-fixture",
    "comments-window-set-hidden-from-stream",
    "comments-window-set-highlight-anchor",
    "comments-window-set-smoke-marker",
    "comments-window-set-theme",
    "comments-window-set-view-mode",
    "comments-window-state",
    "comments-window-submit-message",
    "comments-window-toggle",
    "deep-link-apple-event",
    "deep-links-state",
    "destroy-native-preview-surface",
    "dispatch-preview-shortcut",
    "drain-native-preview-host-commands",
    "exercise-native-preview-scene",
    "exercise-native-preview-scene-after-surface-loss",
    "exercise-preview-click-focus",
    "global-shortcuts-fire",
    "global-shortcuts-recorder",
    "global-shortcuts-state",
    "import-smoke-scheduled-thumbnail",
    "import-takeover-image",
    "inspect-native-preview-bootstrap",
    "inspect-native-preview-live-background",
    "inspect-native-preview-runtime",
    "inspect-preview-stage-badges",
    "main-window-focus",
    "main-window-id",
    "main-window-set-bounds",
    "main-window-set-hidden-from-stream",
    "main-window-set-smoke-marker",
    "main-window-state",
    "managed-asset-read",
    "measure-native-preview-surface",
    "measure-preview-motion",
    "minimize-window",
    "move-window",
    "native-preview-surface-status",
    "notes-window-close",
    "notes-window-open",
    "notes-window-save-document",
    "notes-window-set-bounds",
    "notes-window-state",
    "open-layout-tab",
    "open-tab",
    "permissions-recheck",
    "permissions-relaunch",
    "permissions-request",
    "permissions-state",
    "preview-route-set",
    "preview-route-state",
    "preview-window-close",
    "preview-window-open",
    "preview-window-os-close",
    "preview-window-report-dock-slot",
    "preview-window-report-permission-required",
    "preview-window-set-always-on-top",
    "preview-window-set-bounds",
    "preview-window-set-dock-overlay",
    "preview-window-set-mode",
    "preview-window-state",
    "preview-window-toggle",
    "raise-window",
    "resize-window",
    "restore-window",
    "resume-native-preview-surface",
    "scene-stage-gesture",
    "scene-stage-key",
    "scene-stage-reveal",
    "scene-stage-select",
    "scene-stage-state",
    "scroll-studio",
    "select-camera-shape",
    "studio-dock-slot",
    "suspend-native-preview-surface",
    "ui-appearance",
    "ui-click",
    "ui-find",
    "ui-key",
    "ui-scroll",
    "ui-set-value",
    "ui-toast",
    "ui-tree",
    "ui-type",
];

/// A part of the app that runs some smoke commands: the Studio's, or a
/// window's on the UI thread.
pub trait SmokeCommandHandler: Send + Sync + 'static {
    /// Whether this handler takes `command`.
    fn handles(&self, command: &str) -> bool;
    /// Runs it; the answer is the command's result or its error sentence.
    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a>;
}

/// `SmokeAppQuitGuard`: while the lifecycle probe runs, a quit it did not
/// ask for is prevented until it allows one.
#[derive(Debug, Default)]
pub struct QuitGuard {
    enabled: bool,
    allowed: AtomicBool,
}

impl QuitGuard {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            allowed: AtomicBool::new(false),
        }
    }

    pub fn should_prevent_quit(&self) -> bool {
        self.enabled && !self.allowed.load(Ordering::SeqCst)
    }

    pub fn allow_quit(&self) {
        self.allowed.store(true, Ordering::SeqCst);
    }
}

/// The answer for a known command the GPUI app cannot run yet.
pub fn not_supported_message(command: &str) -> String {
    format!(
        "Smoke command {command} is not supported by the GPUI app yet (plan 260: it comes \
         with the part of the app that runs it)."
    )
}

/// The quit the app performs for `app-quit`.
pub type QuitHook = Arc<dyn Fn() + Send + Sync>;

/// What the commands need to know about the app.
#[derive(Debug, Clone, Default)]
pub struct AppSmokeConfig {
    /// A packaged app refuses the resource, debug and inspection commands
    /// even inside its harness's subset, as Electron's do.
    pub packaged: bool,
    /// `VIDEORC_SMOKE_STATE_DIR`: the only place smoke resources come from.
    pub state_directory: Option<String>,
    /// `VIDEORC_SMOKE_OUTPUT_DIR`: the isolation root when no state
    /// directory is set.
    pub output_directory: Option<String>,
    /// Where the backend keeps its sqlite, secrets and recordings when it is
    /// isolated; `None` for the owner's real data.
    pub isolated_backend: Option<IsolatedBackendPaths>,
    /// `VIDEORC_PREVIEW_LIFECYCLE_PROBE=1`: the quit guard is armed.
    pub lifecycle_probe: bool,
}

impl AppSmokeConfig {
    /// The smoke directories from the environment.
    pub fn from_env(
        env: impl Fn(&str) -> Option<String>,
        packaged: bool,
        isolated_backend: Option<IsolatedBackendPaths>,
    ) -> Self {
        let non_empty = |name: &str| env(name).filter(|value| !value.trim().is_empty());
        Self {
            packaged,
            state_directory: non_empty(vars::STATE_DIR),
            output_directory: non_empty(vars::OUTPUT_DIR),
            isolated_backend,
            lifecycle_probe: env(vars::PREVIEW_LIFECYCLE_PROBE).as_deref() == Some("1"),
        }
    }
}

/// The app's runner: the core's commands, then each handler's.
pub struct AppSmokeCommands {
    admin: Arc<dyn AdminRpc>,
    config: AppSmokeConfig,
    quit: QuitHook,
    quit_guard: QuitGuard,
    handlers: Vec<Arc<dyn SmokeCommandHandler>>,
}

impl AppSmokeCommands {
    pub fn new(admin: Arc<dyn AdminRpc>, config: AppSmokeConfig, quit: QuitHook) -> Self {
        let quit_guard = QuitGuard::new(config.lifecycle_probe);
        Self {
            admin,
            config,
            quit,
            quit_guard,
            handlers: Vec::new(),
        }
    }

    /// A part of the app that runs some commands (the Studio, a window).
    /// The first handler that takes a command runs it.
    pub fn with_handler(mut self, handler: Arc<dyn SmokeCommandHandler>) -> Self {
        self.handlers.push(handler);
        self
    }

    /// `app.quit()` as the probe's guard sees it: prevented while the
    /// lifecycle probe has not allowed a quit, otherwise the hook runs after
    /// the answer (`setImmediate(() => app.quit())`).
    fn request_quit(&self) -> bool {
        if self.quit_guard.should_prevent_quit() {
            return true;
        }
        let quit = self.quit.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            quit();
        });
        false
    }

    async fn dispatch(&self, command: &str, params: Map<String, Value>) -> Result<Value, String> {
        if let Some(handler) = self.handlers.iter().find(|each| each.handles(command)) {
            return handler.run(command, params).await;
        }
        match command {
            "app-quit" => {
                if self.request_quit() {
                    Ok(json!({ "quitting": false, "prevented": true }))
                } else {
                    Ok(json!({ "quitting": true }))
                }
            }
            "preview-lifecycle-allow-app-quit" => {
                no_params(command, &params)?;
                self.quit_guard.allow_quit();
                Ok(json!({ "allowed": true }))
            }
            "preview-lifecycle-attempt-app-quit" => {
                no_params(command, &params)?;
                let prevented = self.request_quit();
                Ok(json!({ "prevented": prevented }))
            }
            "authorize-smoke-resource" => self.authorize_resource(&params).await,
            "backend-debug-rpc" => self.backend_debug_rpc(&params).await,
            "import-smoke-background" => self.import_background(&params).await,
            "inspect-backend-state-isolation" => self.inspect_isolation(&params).await,
            other => Err(not_supported_message(other)),
        }
    }

    /// `authorizeSmokeResource`: the pickers' own issue
    /// (`issueResourceCapability`, five minutes and one use) on the admin
    /// credential, checked as main checks it.
    async fn authorize_resource(&self, params: &Map<String, Value>) -> Result<Value, String> {
        if self.config.packaged {
            return Err("Smoke resource authorization is unavailable in this app mode.".into());
        }
        let grant =
            validate_smoke_resource_authorization(params, self.config.state_directory.as_deref())?;
        let kind = grant.kind.as_str();
        let answer = self
            .admin
            .request(
                "resource.capability.issue",
                json!({
                    "path": grant.path.to_string_lossy(),
                    "kind": kind,
                    "ttlMs": RESOURCE_TTL_MS,
                    "useCount": RESOURCE_USES,
                }),
                ADMIN_TIMEOUT,
            )
            .await?;
        if answer.get("kind").and_then(Value::as_str) != Some(kind) {
            return Err(
                "Backend resource capability kind did not match the picker request.".into(),
            );
        }
        let capability_id = answer
            .get("capabilityId")
            .and_then(Value::as_str)
            .filter(|id| resource_capability_id_valid(id))
            .ok_or("Backend returned an invalid resource capability id.")?;
        Ok(json!({
            "capabilityId": capability_id,
            "kind": kind,
            "displayName": display_name(&grant.path),
        }))
    }

    /// `import-smoke-background {path}`: a background image inside the smoke's
    /// state directory, imported as the Images page imports one (the
    /// backend's `backgrounds.import` copies it into app storage), answered
    /// as Electron's main answers it.
    async fn import_background(&self, params: &Map<String, Value>) -> Result<Value, String> {
        const UNAVAILABLE: &str =
            "Smoke background import is unavailable or invalid in this app mode.";
        if self.config.packaged || params.len() != 1 {
            return Err(UNAVAILABLE.into());
        }
        let path = params.get("path").cloned().ok_or(UNAVAILABLE)?;
        let mut check = Map::new();
        check.insert("path".into(), path);
        check.insert("kind".into(), json!("input-file"));
        let grant =
            validate_smoke_resource_authorization(&check, self.config.state_directory.as_deref())?;
        let imported = self
            .admin
            .request(
                "backgrounds.import",
                json!({ "path": grant.path.to_string_lossy() }),
                IMAGE_IMPORT_TIMEOUT,
            )
            .await?;
        background_import_answer(&grant.path, &imported)
    }

    async fn backend_debug_rpc(&self, params: &Map<String, Value>) -> Result<Value, String> {
        // The bearer is only the first boundary: the backend also needs the
        // admin credential, a debug build and VIDEORC_ENABLE_SMOKE_RPC=1.
        if self.config.packaged {
            return Err("Backend debug RPC bridge is unavailable in this app mode.".into());
        }
        let request = validate_smoke_backend_rpc_request(params)
            .ok_or("Invalid or unallowlisted backend debug RPC request.")?;
        self.admin
            .request(
                &request.method,
                Value::Object(request.params),
                Duration::from_millis(request.timeout_ms),
            )
            .await
    }

    async fn inspect_isolation(&self, params: &Map<String, Value>) -> Result<Value, String> {
        if self.config.packaged || !params.is_empty() {
            return Err(
                "Backend state isolation inspection is unavailable in this app mode.".into(),
            );
        }
        let root = self
            .config
            .state_directory
            .as_deref()
            .or(self.config.output_directory.as_deref());
        let (Some(root), Some(isolated)) = (root, self.config.isolated_backend.as_ref()) else {
            return Ok(json!({
                "isolated": false,
                "databaseInsideSmokeState": false,
                "secretsInsideSmokeState": false,
                "recordingsInsideSmokeState": false,
                "backendUsesConfiguredDatabase": false,
            }));
        };
        let root = lexical_absolute(Path::new(root));
        let expected_database = lexical_absolute(&isolated.database);
        let database_inside = path_inside(&expected_database, &root);
        let secrets_inside = path_inside(&lexical_absolute(&isolated.secrets), &root);
        let recordings_inside = path_inside(&lexical_absolute(&isolated.recordings), &root);
        let health = self
            .admin
            .request("health.ping", json!({}), ADMIN_TIMEOUT)
            .await?;
        let uses_database = health
            .get("databasePath")
            .and_then(Value::as_str)
            .is_some_and(|path| lexical_absolute(Path::new(path)) == expected_database);
        Ok(json!({
            "isolated": database_inside && secrets_inside && recordings_inside && uses_database,
            "databaseInsideSmokeState": database_inside,
            "secretsInsideSmokeState": secrets_inside,
            "recordingsInsideSmokeState": recordings_inside,
            "backendUsesConfiguredDatabase": uses_database,
        }))
    }
}

impl SmokeCommandRunner for AppSmokeCommands {
    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(self.dispatch(command, params))
    }
}

/// Electron's capability: five minutes, one use.
const RESOURCE_TTL_MS: u64 = 5 * 60_000;
const RESOURCE_USES: u32 = 1;

/// `path.basename`, or the whole path when it has none.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

fn no_params(command: &str, params: &Map<String, Value>) -> Result<(), String> {
    if params.is_empty() {
        Ok(())
    } else {
        Err(format!("{command} takes no parameters."))
    }
}

/// `path.resolve`: absolute, with `.` and `..` folded, no links followed.
fn lexical_absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// `isPathInsideRoot`: a strict child.
fn path_inside(candidate: &Path, root: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

/// Whether the core runs `command` (anything else Electron knows is a
/// handler's or "not supported"; anything Electron does not know never
/// reaches the runner).
pub fn implemented(command: &str) -> bool {
    IMPLEMENTED_COMMANDS.contains(&command)
}

/// How long the backend may take to copy and tile an imported image.
const IMAGE_IMPORT_TIMEOUT: Duration = Duration::from_secs(60);

/// A managed background's URL (`managedBackgroundAssetUrl`).
pub fn managed_background_asset_url(file_name: &str) -> String {
    let mut encoded = String::new();
    for byte in file_name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("videorc-asset://background/{encoded}")
}

/// `importBackgroundImageFromPath`'s answer from `backgrounds.import`'s.
fn background_import_answer(source: &std::path::Path, imported: &Value) -> Result<Value, String> {
    let id = imported
        .get("id")
        .and_then(Value::as_str)
        .ok_or("The backend's background import gave no id.")?;
    let asset = imported
        .get("assetFileName")
        .and_then(Value::as_str)
        .ok_or("The backend's background import gave no file.")?;
    let thumbnail = imported
        .get("thumbnailFileName")
        .and_then(Value::as_str)
        .unwrap_or(asset);
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = source
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.clone());
    Ok(json!({
        "id": id,
        "name": name,
        "assetPath": managed_background_asset_url(asset),
        "thumbnailPath": managed_background_asset_url(thumbnail),
        "fileName": file_name,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::smoke::admin::AdminFuture;
    use crate::smoke::security;

    #[test]
    fn every_command_has_one_home_or_is_named_as_not_supported() {
        for name in IMPLEMENTED_COMMANDS.iter().chain(STUDIO_COMMANDS) {
            assert!(security::is_smoke_command(name), "{name}");
        }
        // The Rust app's own names run in the core, the Studio or a window.
        for name in security::RUST_SMOKE_COMMAND_NAMES {
            assert!(
                implemented(name)
                    || STUDIO_COMMANDS.contains(name)
                    || APP_WINDOW_COMMANDS.contains(name),
                "{name}"
            );
        }
        for name in APP_WINDOW_COMMANDS {
            assert!(security::is_smoke_command(name), "{name}");
            assert!(!implemented(name), "{name}");
            assert!(!STUDIO_COMMANDS.contains(name), "{name}");
        }
        for name in STUDIO_COMMANDS {
            assert!(!implemented(name), "{name}");
        }
        for list in [APP_WINDOW_COMMANDS, STUDIO_COMMANDS, IMPLEMENTED_COMMANDS] {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            assert_eq!(sorted, list, "kept sorted");
        }
        // The UI driver's commands are a window's.
        for driven in security::UI_DRIVER_COMMAND_NAMES.iter().chain(&[
            "capture-page",
            "capture-page-alpha",
            "resize-window",
        ]) {
            assert!(APP_WINDOW_COMMANDS.contains(driven), "{driven}");
        }
        let message = not_supported_message("eval-js");
        assert!(message.contains("eval-js"), "{message}");
        // The renderer's commands stay not supported.
        for not_yet in ["eval-js", "set-page-zoom"] {
            assert!(!implemented(not_yet), "{not_yet}");
            assert!(!APP_WINDOW_COMMANDS.contains(&not_yet), "{not_yet}");
            assert!(!STUDIO_COMMANDS.contains(&not_yet), "{not_yet}");
        }
    }

    #[test]
    fn an_imported_background_answers_as_electron_main_does() {
        let answer = background_import_answer(
            std::path::Path::new("/tmp/smoke/solid background.png"),
            &json!({"id": "bg-1", "assetFileName": "a b.png", "thumbnailFileName": null}),
        )
        .unwrap();
        assert_eq!(answer["id"], "bg-1");
        assert_eq!(answer["name"], "solid background");
        assert_eq!(answer["assetPath"], "videorc-asset://background/a%20b.png");
        assert_eq!(
            answer["thumbnailPath"],
            "videorc-asset://background/a%20b.png"
        );
        assert_eq!(answer["fileName"], "solid background.png");
        assert!(background_import_answer(std::path::Path::new("/x.png"), &json!({})).is_err());
    }

    #[test]
    fn the_quit_guard_prevents_only_while_the_probe_has_not_allowed_a_quit() {
        let armed = QuitGuard::new(true);
        assert!(armed.should_prevent_quit());
        armed.allow_quit();
        assert!(!armed.should_prevent_quit());
        assert!(!QuitGuard::new(false).should_prevent_quit());
        let config = AppSmokeConfig::from_env(
            |name| (name == vars::PREVIEW_LIFECYCLE_PROBE).then(|| "1".to_string()),
            false,
            None,
        );
        assert!(config.lifecycle_probe);
        assert!(!AppSmokeConfig::from_env(|_| None, false, None).lifecycle_probe);
    }

    #[test]
    fn isolation_paths_resolve_like_node() {
        assert_eq!(
            lexical_absolute(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert!(path_inside(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(!path_inside(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!path_inside(Path::new("/a/bc"), Path::new("/a/b")));
        assert!(!path_inside(Path::new("/a"), Path::new("/a/b")));
        assert_eq!(display_name(Path::new("/tmp/clip.mp4")), "clip.mp4");
    }

    /// A backend that answers from a table and records each request.
    #[derive(Default)]
    struct FakeAdmin {
        calls: Mutex<Vec<(String, Value)>>,
        answers: Vec<(&'static str, Value)>,
    }

    impl AdminRpc for FakeAdmin {
        fn request<'a>(
            &'a self,
            method: &'a str,
            params: Value,
            _timeout: Duration,
        ) -> AdminFuture<'a> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let answer = self
                .answers
                .iter()
                .find(|(name, _)| *name == method)
                .map(|(_, answer)| answer.clone());
            Box::pin(async move { answer.ok_or_else(|| format!("no answer for {method}")) })
        }
    }

    struct Echo;

    impl SmokeCommandHandler for Echo {
        fn handles(&self, command: &str) -> bool {
            command == "ui-tree"
        }
        fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
            Box::pin(async move { Ok(json!({ "ran": command, "params": params })) })
        }
    }

    fn runner(admin: Arc<FakeAdmin>, config: AppSmokeConfig) -> AppSmokeCommands {
        AppSmokeCommands::new(admin, config, Arc::new(|| {}))
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[tokio::test]
    async fn a_handler_runs_its_commands_and_the_rest_say_not_supported() {
        let commands =
            runner(Arc::default(), AppSmokeConfig::default()).with_handler(Arc::new(Echo));
        assert_eq!(
            commands.dispatch("ui-tree", Map::new()).await.unwrap()["ran"],
            "ui-tree"
        );
        assert_eq!(
            commands.dispatch("studio-state", Map::new()).await,
            Err(not_supported_message("studio-state"))
        );
        assert_eq!(
            commands
                .dispatch("preview-lifecycle-allow-app-quit", Map::new())
                .await
                .unwrap(),
            json!({ "allowed": true })
        );
    }

    #[tokio::test]
    async fn the_debug_bridge_takes_only_allowlisted_rpcs_and_never_in_a_packaged_app() {
        let admin = Arc::new(FakeAdmin {
            answers: vec![("diagnostics.stats", json!({ "frames": 3 }))],
            ..FakeAdmin::default()
        });
        let commands = runner(admin.clone(), AppSmokeConfig::default());
        let asked = object(json!({ "method": "diagnostics.stats", "params": {} }));
        assert_eq!(
            commands
                .dispatch("backend-debug-rpc", asked.clone())
                .await
                .unwrap(),
            json!({ "frames": 3 })
        );
        assert!(
            commands
                .dispatch(
                    "backend-debug-rpc",
                    object(json!({ "method": "recording.stop", "params": {} }))
                )
                .await
                .is_err()
        );
        assert_eq!(admin.calls.lock().unwrap().len(), 1);
        let packaged = runner(
            admin.clone(),
            AppSmokeConfig {
                packaged: true,
                ..AppSmokeConfig::default()
            },
        );
        assert!(packaged.dispatch("backend-debug-rpc", asked).await.is_err());
        assert_eq!(admin.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn isolation_without_a_state_directory_says_not_isolated() {
        let commands = runner(Arc::default(), AppSmokeConfig::default());
        let answer = commands
            .dispatch("inspect-backend-state-isolation", Map::new())
            .await
            .unwrap();
        assert_eq!(answer["isolated"], false);
        assert!(
            commands
                .dispatch("inspect-backend-state-isolation", object(json!({ "x": 1 })))
                .await
                .is_err()
        );
    }
}
