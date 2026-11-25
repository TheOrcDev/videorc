//! The smoke command server's policy (plan 220 S2.5a), ported from
//! `apps/desktop/src/main/smoke-command-security.ts`: which commands exist,
//! who may send them, how big and how deep their parameters may be, which
//! files a smoke may hand the backend, and which debug RPCs it may reach.
//!
//! Every rule here is the Electron rule; the tests in this file and in
//! `tests/smoke_server.rs` mirror `smoke-command-security.test.ts`, and one
//! test reads the TypeScript file to keep the three name lists in step.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// `MAX_PARAM_DEPTH`.
pub const MAX_PARAM_DEPTH: usize = 8;
/// `MAX_PARAM_KEYS`: array entries and object keys, together.
pub const MAX_PARAM_KEYS: i64 = 2_000;
/// `MAX_COMMENTS_FIXTURE_KEYS`: the Comments snapshot fixture's budget.
pub const MAX_COMMENTS_FIXTURE_KEYS: i64 = 100_000;
/// `MAX_REQUEST_BODY_BYTES`.
pub const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
/// `MAX_SMOKE_RESOURCE_PATH_LENGTH`.
pub const MAX_SMOKE_RESOURCE_PATH_LENGTH: usize = 4_096;
/// `eval-js`'s code limit, in UTF-16 units as JavaScript counts them.
pub const MAX_EVAL_JS_CODE_UNITS: usize = 256 * 1024;
/// A capability is 32 random bytes in unpadded base64url.
pub const CAPABILITY_LENGTH: usize = 43;
/// `validateSmokeBackendRpcRequest`'s default and ceiling.
pub const DEFAULT_BACKEND_RPC_TIMEOUT_MS: u64 = 15_000;
pub const MAX_BACKEND_RPC_TIMEOUT_MS: f64 = 5.0 * 60_000.0;

/// The 401 body's message, and the others the HTTP layer answers with.
pub mod messages {
    pub const INVALID_CAPABILITY: &str = "Invalid smoke command capability.";
    pub const UNKNOWN_ENDPOINT: &str = "Unknown smoke endpoint.";
    pub const INVALID_COMMAND: &str = "Invalid smoke command or parameters.";
    pub const UNAVAILABLE_IN_MODE: &str = "Smoke command is unavailable in this mode.";
    pub const BODY_TOO_LARGE: &str = "Smoke request body is too large.";
}

/// `SMOKE_COMMAND_NAMES`: every command Electron main accepts, in its order.
/// The Rust app accepts the same names; the ones it cannot run yet answer
/// "not supported" by name (`commands.rs`), never a silent success.
pub const ELECTRON_SMOKE_COMMAND_NAMES: &[&str] = &[
    "app-quit",
    "apply-native-preview-host-commands",
    "authorize-smoke-resource",
    // Plan 232: the frame counters of the HTML overlay host.
    "html-overlay-stats",
    "import-takeover-image",
    "backend-debug-rpc",
    "blank-main-window",
    "capture-page",
    "set-page-zoom",
    "capture-page-alpha",
    "close-backdrop-window",
    "comments-window-authority-probe",
    "comments-window-capture-page",
    "comments-window-click-message",
    "comments-window-context-click-link",
    "comments-window-close",
    "comments-window-command-trace",
    // Plan 225 C4: the person card fixture and its geometry.
    "comments-window-community-fixture",
    "comments-window-person-card",
    "comments-window-layout-metrics",
    "comments-window-open",
    "comments-window-push-delta",
    "comments-window-push-snapshot",
    "comments-window-reader-state",
    "comments-window-route-send-result",
    "comments-window-seed-cohost",
    "comments-window-seed-dashboard",
    "comments-window-seed-viewers",
    "comments-window-set-bounds",
    "comments-window-set-command-fixture",
    "comments-window-set-theme",
    "comments-window-set-highlight-anchor",
    "comments-window-set-auto-show-activity",
    "comments-window-set-hidden-from-stream",
    "comments-window-set-smoke-marker",
    "comments-window-set-view-mode",
    "comments-window-state",
    "comments-window-submit-message",
    "comments-window-toggle",
    "captions-window-close",
    "captions-window-open",
    "captions-window-set-bounds",
    "captions-window-state",
    "destroy-native-preview-surface",
    "drain-native-preview-host-commands",
    "dispatch-preview-shortcut",
    "enable-synthetic-source",
    "eval-js",
    "exercise-main-present-pump-reconnect",
    "exercise-main-present-scene-mismatch",
    "exercise-native-preview-proof-fallback",
    "exercise-native-preview-scene",
    "exercise-native-preview-scene-after-surface-loss",
    "exercise-native-preview-scene-background",
    "exercise-preview-click-focus",
    "focused-window",
    "heal-main-window",
    "inspect-native-preview-bootstrap",
    "inspect-native-preview-live-background",
    "inspect-backend-state-isolation",
    "inspect-packaged-bundled-background",
    "inspect-native-preview-runtime",
    "inspect-preview-stage-badges",
    "import-smoke-background",
    "import-smoke-scheduled-thumbnail",
    "ipc-send-counts",
    "main-present-pump-diagnostics",
    "main-window-blur",
    "main-window-focus",
    "main-window-id",
    "main-window-set-bounds",
    "main-window-simple-fullscreen",
    "main-window-state",
    "measure-native-preview-surface",
    "measure-preview-motion",
    "memory-infra-dump",
    "minimize-window",
    "move-window",
    "native-preview-surface-status",
    "notes-window-close",
    "notes-window-open",
    "notes-window-save-document",
    "notes-window-set-bounds",
    "notes-window-state",
    "open-backdrop-window",
    "open-layout-tab",
    "open-tab",
    "preview-lifecycle-allow-app-quit",
    "preview-lifecycle-attempt-app-quit",
    "preview-surface-sample",
    "preview-surface-scene-state",
    "preview-window-close",
    "preview-window-open",
    "preview-window-os-close",
    "preview-window-report-dock-slot",
    "preview-window-report-permission-required",
    "preview-window-set-bounds",
    "preview-window-set-dock-overlay",
    "preview-window-set-mode",
    "preview-window-state",
    "preview-window-toggle",
    "proof-window-state",
    "raise-window",
    "resize-window",
    "restore-native-preview-driver",
    "restore-window",
    "resume-native-preview-surface",
    "scroll-studio",
    "select-camera-device",
    "select-camera-shape",
    "select-layout-preset",
    "send-input-to-proof-surface",
    "select-screen-device",
    "set-vibrancy",
    "suspend-native-preview-surface",
    "window-bounds-storm",
    "window-glass-state",
    "windows-preview-os-input-probe",
    "windows-d3d11-preview-harness",
    "windows-live-audio-harness",
];

/// Commands only the Rust app has: the Studio's intents and state, which
/// Electron's smokes reach through the renderer (`eval-js`, the remote
/// surface) instead.
pub const RUST_SMOKE_COMMAND_NAMES: &[&str] = &[
    // S3.0j: the account: what it did (names, plan, the sign-in that
    // waits, each link's outcome; never a code, a verifier or an email),
    // the sign-in as the menu starts it (a smoke run opens no browser; the
    // page is answered), and Sign out.
    "account-sign-in",
    "account-sign-out",
    "account-state",
    // S3.9a: the captions as the Captions page and the reader read them
    // (the platform's answer, the status, the lines, the page's strip, the
    // capture config's captions), what Electron's smokes read with `eval-js`.
    "captions-state",
    // S2.6a: the macOS menu bar read back from AppKit, an item picked as a
    // click picks it, a key equivalent offered as a key press is.
    "app-menu",
    "app-menu-activate",
    "app-menu-key",
    // S2.6a: an open-URL Apple Event sent to the app's own pid, and what the
    // links did (kinds, ids and outcomes, never a link's code).
    "deep-link-apple-event",
    "deep-links-state",
    // S2.6a: the global shortcuts' state, a registered key's Carbon event
    // through `global-hotkey`'s handler (nothing posted to the OS), and the
    // shortcut recorder's suspend.
    "global-shortcuts-fire",
    "global-shortcuts-recorder",
    "global-shortcuts-state",
    // S2.6b: the permissions (the grants, the rows, the sleep guard and
    // Videorc Camera's extension), a request that never shows a prompt
    // unless asked, the grant re-check, Reopen Videorc and the extension
    // request.
    "camera-extension-request",
    "permissions-recheck",
    "permissions-relaunch",
    "permissions-request",
    "permissions-state",
    // S2.3b: Keep on top is a menu item Electron's probes never flip; the
    // Rust app's menu lands with S2.6a, so the smokes set it here.
    "preview-window-set-always-on-top",
    // S2.6c: the main window's Hide from stream switch and an edge-to-edge
    // marker colour, so a recording proves the backend's capture filter
    // leaves a Rust app window out (Electron proves it with the Stream
    // Manager's `comments-window-set-hidden-from-stream` and
    // `comments-window-set-smoke-marker`).
    "main-window-set-hidden-from-stream",
    "main-window-set-smoke-marker",
    // S3.8b: a managed picture as the app reads it (`videorc-asset://<host>/
    // <file>` resolved through the backend's folders, by bare file name),
    // answered by its size only; Electron's smokes `fetch` the URL in the
    // renderer.
    "managed-asset-read",
    // S2.3c: the preview's route (`layer` or `texture`), which the Phase 3
    // scene editor will flip; the smokes and the measurement flip it here.
    "preview-route-set",
    "preview-route-state",
    // S3.3b: the Scene page's canvas editor, what Electron's smokes read and
    // drive in the DOM (`data-videorc-stage-*`, trusted pointer input over
    // CDP): the stage's state, a chip, a drag with real pointer events
    // through the window, a key on the focused canvas.
    "scene-stage-gesture",
    "scene-stage-key",
    "scene-stage-reveal",
    "scene-stage-select",
    "scene-stage-state",
    // S2.3b: the Studio slot's rect, which Electron's probes read from the
    // DOM with `eval-js`.
    "studio-dock-slot",
    "studio-put-setting",
    "studio-record",
    // S3.6a: the Clips ring armed for this run, with a smoke's length
    // (`__videorcSmokeSetReplayBuffer`).
    "studio-replay-buffer",
    "studio-state",
    "studio-stop",
    // S3.1e: the saved scenes through the Studio's actions, what the
    // renderer's smokes reach through `window.__videorcSmokeScenePresets`
    // (`state`, `save`, `apply`, `remove`, `layout`, `background`,
    // `configure`).
    "studio-capture-configure",
    "studio-scene-apply",
    "studio-scene-background",
    "studio-scene-delete",
    "studio-scene-layout",
    "studio-scene-save",
    "studio-scenes-state",
    // Plan 260 Phase 3 (smart-scenes): the library edits the renderer's
    // smokes reach through `add`, `edit` and a row's Alt+Arrow, a scene key
    // (`shortcut`), the password-manager list and Hide screen.
    "studio-privacy-add-app",
    "studio-privacy-state",
    "studio-scene-edit",
    "studio-scene-insert",
    "studio-scene-move",
    "studio-screen-privacy",
    "studio-shortcut",
    // S3.1d: the Studio's live audio sync held off a session a smoke starts
    // on the backend, what `smoke:rnnoise` does to the renderer's socket.
    "studio-live-audio-hold",
    // S3.5d: Upcoming's saved streams through the Studio, what
    // `smoke:scheduled-streams` reaches through
    // `window.__videorcSmokeScheduledStreams` (`state`, `mutate`).
    "scheduled-mutate",
    "scheduled-state",
    // S3.0b: the UI driver, what Electron's smokes do with `eval-js` and the
    // DOM: read a window's accessibility tree, find an element by its
    // accessible name, role or element id, click it, type and press keys into
    // it, scroll, set its value, and force the look a screenshot needs.
    // S3.0f: `ui-toast` raises a toast through the session's toast path,
    // what S0.1a's baseline did with `eval-js` and `lib/toast.ts`.
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

/// S3.0b: the UI driver's commands (`RUST_SMOKE_COMMAND_NAMES`' `ui-*`).
pub const UI_DRIVER_COMMAND_NAMES: &[&str] = &[
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

/// `PACKAGED_SMOKE_COMMAND_NAMES`: the subset a packaged app's harness may
/// send.
pub const PACKAGED_SMOKE_COMMAND_NAMES: &[&str] = &[
    "app-quit",
    "captions-window-open",
    "captions-window-set-bounds",
    "comments-window-open",
    "comments-window-set-bounds",
    "comments-window-set-hidden-from-stream",
    "comments-window-set-smoke-marker",
    "destroy-native-preview-surface",
    "drain-native-preview-host-commands",
    "exercise-main-present-pump-reconnect",
    "exercise-native-preview-scene",
    "exercise-native-preview-scene-after-surface-loss",
    "exercise-native-preview-scene-background",
    "inspect-native-preview-bootstrap",
    "inspect-native-preview-runtime",
    "inspect-preview-stage-badges",
    "inspect-packaged-bundled-background",
    "measure-native-preview-surface",
    "main-window-focus",
    "main-window-set-bounds",
    "minimize-window",
    "move-window",
    "native-preview-surface-status",
    "notes-window-open",
    "notes-window-save-document",
    "notes-window-set-bounds",
    "open-tab",
    "preview-window-state",
    "preview-window-open",
    "resize-window",
    "restore-window",
    "resume-native-preview-surface",
    "suspend-native-preview-surface",
    "windows-d3d11-preview-harness",
    "windows-live-audio-harness",
];

/// `SMOKE_BACKEND_RPC_METHOD_NAMES`: the debug RPCs `backend-debug-rpc` may
/// dispatch with the private admin credential, and nothing else.
pub const SMOKE_BACKEND_RPC_METHOD_NAMES: &[&str] = &[
    "audio.test.disconnect",
    "audio.test.inject-pcm",
    "captions.test.inject-audio",
    "captions.test.snapshot",
    "cohost.pet.import",
    "compositor.scene.update",
    "diagnostics.stats",
    "encoder_bridge.synthetic_record",
    "recording.start_test",
];

/// A name the server accepts at all (anything else is a 400, as in
/// Electron).
pub fn is_smoke_command(name: &str) -> bool {
    ELECTRON_SMOKE_COMMAND_NAMES.contains(&name) || RUST_SMOKE_COMMAND_NAMES.contains(&name)
}

/// `smokeCommandServerAllowed`: a dev app serves when asked; a packaged app
/// only with a capability its harness generated.
pub fn smoke_command_server_allowed(
    enabled: bool,
    packaged: bool,
    packaged_harness_capability: Option<&str>,
) -> bool {
    enabled
        && (!packaged || packaged_harness_capability.is_some_and(smoke_command_capability_valid))
}

/// `createSmokeCommandCapability`: 256 random bits, URL-safe, fresh for each
/// server run.
pub fn create_smoke_command_capability() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source");
    base64url(&bytes)
}

/// `smokeCommandCapabilityValid`: `^[A-Za-z0-9_-]{43}$`.
pub fn smoke_command_capability_valid(value: &str) -> bool {
    value.len() == CAPABILITY_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `smokeRequestAuthorized`: the exact per-run bearer, compared in constant
/// time.
pub fn smoke_request_authorized(authorization_header: Option<&str>, capability: &str) -> bool {
    let Some(supplied) = authorization_header.and_then(|header| header.strip_prefix("Bearer "))
    else {
        return false;
    };
    if capability.is_empty() {
        return false;
    }
    let supplied = supplied.as_bytes();
    let expected = capability.as_bytes();
    if supplied.len() != expected.len() {
        return false;
    }
    supplied
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// A command that passed [`validate_smoke_command_payload`].
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedSmokeCommand {
    pub command: String,
    pub params: Map<String, Value>,
}

/// `validateSmokeCommandPayload`: a known command with bounded JSON params.
/// `None` is the 400.
///
/// The Comments fixture commands keep Electron's larger key budget for the
/// snapshot; their full fixture schema is not checked here because the Rust
/// app answers them "not supported" until the Comments window exists.
pub fn validate_smoke_command_payload(value: &Value) -> Option<ValidatedSmokeCommand> {
    let body = value.as_object()?;
    let command = body.get("command")?.as_str()?;
    if !is_smoke_command(command) {
        return None;
    }
    let params = match body.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params.clone(),
        Some(_) => return None,
    };
    let budget = if command == "comments-window-push-snapshot" {
        MAX_COMMENTS_FIXTURE_KEYS
    } else {
        MAX_PARAM_KEYS
    };
    let wrapped = Value::Object(params);
    if !validate_json_value(&wrapped, 0, &mut { budget }) {
        return None;
    }
    let Value::Object(params) = wrapped else {
        unreachable!("wrapped above")
    };
    if command == "eval-js" {
        let code = params.get("code")?.as_str()?;
        if code.encode_utf16().count() > MAX_EVAL_JS_CODE_UNITS {
            return None;
        }
    }
    Some(ValidatedSmokeCommand {
        command: command.to_string(),
        params,
    })
}

/// `validateJsonValue`: depth at most [`MAX_PARAM_DEPTH`], a shared budget of
/// keys and entries, and none of the prototype keys.
fn validate_json_value(value: &Value, depth: usize, budget: &mut i64) -> bool {
    if depth > MAX_PARAM_DEPTH {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        // serde_json never parses a non-finite number.
        Value::Number(number) => number.as_f64().is_none_or(f64::is_finite),
        Value::Array(entries) => {
            *budget -= entries.len() as i64;
            *budget >= 0
                && entries
                    .iter()
                    .all(|entry| validate_json_value(entry, depth + 1, budget))
        }
        Value::Object(entries) => {
            *budget -= entries.len() as i64;
            *budget >= 0
                && entries.iter().all(|(key, entry)| {
                    !matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                        && validate_json_value(entry, depth + 1, budget)
                })
        }
    }
}

/// A request `backend-debug-rpc` may forward.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedSmokeBackendRpcRequest {
    pub method: String,
    pub params: Map<String, Value>,
    pub timeout_ms: u64,
}

/// `validateSmokeBackendRpcRequest`: an allowlisted method, object params,
/// and a timeout from 1 ms to five minutes (15 s when absent).
pub fn validate_smoke_backend_rpc_request(
    value: &Map<String, Value>,
) -> Option<ValidatedSmokeBackendRpcRequest> {
    let method = value.get("method")?.as_str()?;
    if !SMOKE_BACKEND_RPC_METHOD_NAMES.contains(&method) {
        return None;
    }
    let params = value.get("params")?.as_object()?.clone();
    let timeout_ms = match value.get("timeoutMs") {
        None => DEFAULT_BACKEND_RPC_TIMEOUT_MS,
        Some(timeout) => {
            let timeout = timeout.as_f64()?;
            if !timeout.is_finite() || !(1.0..=MAX_BACKEND_RPC_TIMEOUT_MS).contains(&timeout) {
                return None;
            }
            timeout.ceil() as u64
        }
    };
    Some(ValidatedSmokeBackendRpcRequest {
        method: method.to_string(),
        params,
        timeout_ms,
    })
}

/// The two kinds `authorize-smoke-resource` grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmokeResourceKind {
    InputFile,
    OutputDirectory,
}

impl SmokeResourceKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "input-file" => Some(Self::InputFile),
            "output-directory" => Some(Self::OutputDirectory),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::InputFile => "input-file",
            Self::OutputDirectory => "output-directory",
        }
    }
}

/// A resource inside the smoke state directory, canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmokeResourceAuthorization {
    pub kind: SmokeResourceKind,
    pub path: PathBuf,
}

fn valid_smoke_resource_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SMOKE_RESOURCE_PATH_LENGTH
        && value.trim() == value
        && !value.contains('\0')
        && Path::new(value).is_absolute()
}

/// `validateSmokeResourceAuthorization`: grants a smoke access only to a
/// regular file or a directory inside the per-run smoke state directory,
/// never through a symbolic link, and returns the canonical path so later
/// use is not redirected.
pub fn validate_smoke_resource_authorization(
    params: &Map<String, Value>,
    state_directory: Option<&str>,
) -> Result<SmokeResourceAuthorization, String> {
    const INVALID: &str = "Invalid smoke resource authorization request.";
    let state_directory = state_directory
        .filter(|directory| valid_smoke_resource_path(directory))
        .ok_or(INVALID)?;
    if params.len() != 2 {
        return Err(INVALID.to_string());
    }
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| valid_smoke_resource_path(path))
        .ok_or(INVALID)?;
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .and_then(SmokeResourceKind::parse)
        .ok_or(INVALID)?;

    let inspect = || -> Result<(PathBuf, PathBuf, std::fs::Metadata, std::fs::Metadata), String> {
        const MISSING: &str = "Smoke resource path does not exist or cannot be inspected.";
        let root_link = std::fs::symlink_metadata(state_directory).map_err(|_| MISSING)?;
        if root_link.file_type().is_symlink() {
            return Err("Smoke state directory cannot be a symbolic link.".to_string());
        }
        let path_link = std::fs::symlink_metadata(path).map_err(|_| MISSING)?;
        if path_link.file_type().is_symlink() {
            return Err("Smoke resource cannot be a symbolic link.".to_string());
        }
        let canonical_root = std::fs::canonicalize(state_directory).map_err(|_| MISSING)?;
        let canonical_path = std::fs::canonicalize(path).map_err(|_| MISSING)?;
        let root_stats = std::fs::metadata(&canonical_root).map_err(|_| MISSING)?;
        let path_stats = std::fs::metadata(&canonical_path).map_err(|_| MISSING)?;
        Ok((canonical_root, canonical_path, root_stats, path_stats))
    };
    let (canonical_root, canonical_path, root_stats, path_stats) = inspect()?;

    if !root_stats.is_dir() {
        return Err("Smoke state path must be a directory.".to_string());
    }
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Smoke resource must be inside the smoke state directory.".to_string());
    }
    match kind {
        SmokeResourceKind::InputFile if !path_stats.is_file() => {
            Err("Smoke input resource must be a regular file.".to_string())
        }
        SmokeResourceKind::OutputDirectory if !path_stats.is_dir() => {
            Err("Smoke output resource must be a directory.".to_string())
        }
        _ => Ok(SmokeResourceAuthorization {
            kind,
            path: canonical_path,
        }),
    }
}

/// `resource-capabilities.ts`' id check: `resource:` and a v1 to v5 UUID.
pub fn resource_capability_id_valid(value: &str) -> bool {
    let Some(id) = value.strip_prefix("resource:") else {
        return false;
    };
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        if hyphen != (*byte == b'-') || (!hyphen && !byte.is_ascii_hexdigit()) {
            return false;
        }
    }
    matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

// --- S3.0b: the UI driver's parameters ---

/// Electron's `waitFor` default.
pub const DEFAULT_UI_WAIT_MS: u64 = 8_000;
/// The longest a `ui-*` command waits for its element.
pub const MAX_UI_WAIT_MS: u64 = 120_000;
/// The most `ui-type` types in one command.
pub const MAX_UI_TYPE_CHARS: usize = 10_000;
/// The largest scroll step, in logical points.
pub const MAX_UI_SCROLL: f64 = 100_000.0;

/// Which window a `ui-*` or capture command reads or drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiWindow {
    Main,
    Preview,
    /// S3.2a: the Stream Manager (`comments` in Electron's code).
    StreamManager,
    /// S3.9a: the Captions reader.
    Captions,
    /// S3.9b: the Notes window.
    Notes,
}

impl UiWindow {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Preview => "preview",
            Self::StreamManager => "stream-manager",
            Self::Captions => "captions",
            Self::Notes => "notes",
        }
    }
}

/// How `ui-click` clicks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiClickVia {
    /// A pointer press and release at the element's centre, through the
    /// window's own event dispatch (what a mouse does; a covered element is
    /// not reached).
    Pointer,
    /// The element's default accessible action (what VoiceOver's "press"
    /// does).
    Action,
}

/// A key `ui-key` presses: a DOM `KeyboardEvent.key` name or one character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiKeyName {
    Escape,
    Enter,
    Tab,
    Space,
    Backspace,
    Delete,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
    /// F1 to F12.
    Function(u8),
    Char(char),
}

impl UiKeyName {
    /// `Escape`, `Enter` (or `Return`), `Tab`, `Space` (or " "),
    /// `Backspace`, `Delete`, the arrows, `Home`, `End`, `PageUp`,
    /// `PageDown`, `F1`–`F12`, or a single character.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "Escape" | "Esc" => Self::Escape,
            "Enter" | "Return" => Self::Enter,
            "Tab" => Self::Tab,
            "Space" | " " => Self::Space,
            "Backspace" => Self::Backspace,
            "Delete" => Self::Delete,
            "ArrowUp" => Self::ArrowUp,
            "ArrowDown" => Self::ArrowDown,
            "ArrowLeft" => Self::ArrowLeft,
            "ArrowRight" => Self::ArrowRight,
            "Home" => Self::Home,
            "End" => Self::End,
            "PageUp" => Self::PageUp,
            "PageDown" => Self::PageDown,
            _ => {
                if let Some(number) = text.strip_prefix('F')
                    && let Ok(number) = number.parse::<u8>()
                    && (1..=12).contains(&number)
                {
                    return Some(Self::Function(number));
                }
                let mut chars = text.chars();
                let only = chars.next()?;
                if chars.next().is_some() || only.is_control() {
                    return None;
                }
                Self::Char(only)
            }
        })
    }
}

/// A modifier held while `ui-key` presses its key. `Meta` is ⌘ on macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UiModifier {
    Shift,
    Control,
    Alt,
    Meta,
}

impl UiModifier {
    /// Electron's accelerator words: `shift`, `control` (`ctrl`), `alt`
    /// (`option`), `meta` (`command`, `cmd`).
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text.to_ascii_lowercase().as_str() {
            "shift" => Self::Shift,
            "control" | "ctrl" => Self::Control,
            "alt" | "option" => Self::Alt,
            "meta" | "command" | "cmd" | "super" => Self::Meta,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shift => "shift",
            Self::Control => "control",
            Self::Alt => "alt",
            Self::Meta => "meta",
        }
    }
}

/// A forced look for `ui-appearance`: `Some(None)` returns that part to the
/// app's own (the theme) or the OS's (contrast, motion); `None` leaves it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UiAppearanceRequest {
    /// `Some(Some(true))` forces dark.
    pub dark: Option<Option<bool>>,
    pub increase_contrast: Option<Option<bool>>,
    pub reduce_motion: Option<Option<bool>>,
}

/// S3.0f: `ui-toast`'s toast, as `lib/toast.ts` takes one: its type
/// (`message`, `success`, `info`, `warning`, `error`, `loading`), its
/// words, the id a newer one replaces in place (`ui-toast` by default), and
/// an explicit duration (a screenshot run outlives the default 8 s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiToastRequest {
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    pub id: String,
    pub duration_ms: Option<u64>,
}

/// The types `ui-toast` takes.
pub const UI_TOAST_KINDS: &[&str] = &["message", "success", "info", "warning", "error", "loading"];

/// One validated `ui-*` command.
#[derive(Debug, Clone, PartialEq)]
pub enum UiDriverRequest {
    Tree {
        window: UiWindow,
        within: Option<super::ui_tree::UiSelector>,
        depth: Option<usize>,
    },
    Find {
        window: UiWindow,
        selector: super::ui_tree::UiSelector,
        timeout_ms: u64,
        reveal: bool,
    },
    Click {
        window: UiWindow,
        selector: super::ui_tree::UiSelector,
        timeout_ms: u64,
        via: UiClickVia,
    },
    Type {
        window: UiWindow,
        selector: Option<super::ui_tree::UiSelector>,
        text: String,
        clear: bool,
        timeout_ms: u64,
    },
    Key {
        window: UiWindow,
        selector: Option<super::ui_tree::UiSelector>,
        key: UiKeyName,
        modifiers: Vec<UiModifier>,
        timeout_ms: u64,
    },
    Scroll {
        window: UiWindow,
        selector: Option<super::ui_tree::UiSelector>,
        dx: f64,
        dy: f64,
        timeout_ms: u64,
    },
    SetValue {
        window: UiWindow,
        selector: super::ui_tree::UiSelector,
        value: String,
        timeout_ms: u64,
    },
    Appearance(UiAppearanceRequest),
    Toast(UiToastRequest),
}

impl UiDriverRequest {
    /// How long the command may wait for its element.
    pub fn timeout_ms(&self) -> u64 {
        match self {
            Self::Find { timeout_ms, .. }
            | Self::Click { timeout_ms, .. }
            | Self::Type { timeout_ms, .. }
            | Self::Key { timeout_ms, .. }
            | Self::Scroll { timeout_ms, .. }
            | Self::SetValue { timeout_ms, .. } => *timeout_ms,
            Self::Tree { .. } | Self::Appearance(_) | Self::Toast(_) => 0,
        }
    }
}

/// `capture-page`'s file name, as Electron makes it: `videorc-ui-<name>.png`
/// with every character but letters, digits and `-` dropped, `page` when no
/// name is given.
pub fn capture_page_file_name(params: &Map<String, Value>) -> String {
    let name = match params.get("name") {
        Some(Value::String(name)) => name
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
            .collect(),
        _ => "page".to_string(),
    };
    format!("videorc-ui-{name}.png")
}

/// The window a command names (`window`: `main`, the default, or `preview`).
pub fn ui_window(params: &Map<String, Value>) -> Result<UiWindow, String> {
    match params.get("window") {
        None | Some(Value::Null) => Ok(UiWindow::Main),
        Some(Value::String(window)) if window == "main" => Ok(UiWindow::Main),
        Some(Value::String(window)) if window == "preview" => Ok(UiWindow::Preview),
        Some(Value::String(window)) if window == "stream-manager" => Ok(UiWindow::StreamManager),
        Some(Value::String(window)) if window == "captions" => Ok(UiWindow::Captions),
        Some(Value::String(window)) if window == "notes" => Ok(UiWindow::Notes),
        Some(_) => Err(
            "window is \"main\", \"preview\", \"stream-manager\", \"captions\" or \"notes\"."
                .to_string(),
        ),
    }
}

/// `validate` for the `ui-*` commands: each parameter typed and bounded, and
/// an unknown key refused by name (a typo never silently does less).
pub fn validate_ui_driver_request(
    command: &str,
    params: &Map<String, Value>,
) -> Result<UiDriverRequest, String> {
    use super::ui_tree::{SELECTOR_KEYS, UiSelector};

    let allow = |extra: &[&str], selector: bool| -> Result<(), String> {
        for key in params.keys() {
            let known = key == "window"
                || extra.contains(&key.as_str())
                || (selector && SELECTOR_KEYS.contains(&key.as_str()));
            if !known {
                return Err(format!("{command} does not take {key}."));
            }
        }
        Ok(())
    };
    let timeout = || -> Result<u64, String> {
        match params.get("timeoutMs") {
            None | Some(Value::Null) => Ok(DEFAULT_UI_WAIT_MS),
            Some(value) => value
                .as_f64()
                .filter(|ms| ms.is_finite() && (0.0..=MAX_UI_WAIT_MS as f64).contains(ms))
                .map(|ms| ms.ceil() as u64)
                .ok_or_else(|| format!("timeoutMs is 0 to {MAX_UI_WAIT_MS} ms.")),
        }
    };
    let flag = |key: &str| -> Result<bool, String> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(on)) => Ok(*on),
            Some(_) => Err(format!("{key} is true or false.")),
        }
    };
    let required = |selector: Option<UiSelector>| {
        selector.ok_or_else(|| format!("{command} needs a label, id, role or value to find."))
    };
    let window = ui_window(params)?;
    match command {
        "ui-tree" => {
            for key in params.keys() {
                if !matches!(key.as_str(), "window" | "within" | "depth") {
                    return Err(format!("ui-tree does not take {key}."));
                }
            }
            let within = match params.get("within") {
                None | Some(Value::Null) => None,
                Some(Value::Object(within)) => Some(
                    UiSelector::parse(within)?
                        .ok_or("ui-tree's within names a label, id, role or value.")?,
                ),
                Some(_) => return Err("ui-tree's within is a selector object.".into()),
            };
            let depth = match params.get("depth") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_u64()
                        .filter(|depth| *depth <= 64)
                        .ok_or("ui-tree's depth is a whole number from 0 to 64.")?
                        as usize,
                ),
            };
            Ok(UiDriverRequest::Tree {
                window,
                within,
                depth,
            })
        }
        "ui-find" => {
            allow(&["timeoutMs", "reveal"], true)?;
            Ok(UiDriverRequest::Find {
                window,
                selector: required(UiSelector::parse(params)?)?,
                timeout_ms: timeout()?,
                reveal: flag("reveal")?,
            })
        }
        "ui-click" => {
            allow(&["timeoutMs", "via"], true)?;
            let via = match params.get("via") {
                None | Some(Value::Null) => UiClickVia::Pointer,
                Some(Value::String(via)) if via == "pointer" => UiClickVia::Pointer,
                Some(Value::String(via)) if via == "action" => UiClickVia::Action,
                Some(_) => return Err("ui-click's via is \"pointer\" or \"action\".".into()),
            };
            Ok(UiDriverRequest::Click {
                window,
                selector: required(UiSelector::parse(params)?)?,
                timeout_ms: timeout()?,
                via,
            })
        }
        "ui-type" => {
            allow(&["timeoutMs", "text", "clear"], true)?;
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| text.chars().count() <= MAX_UI_TYPE_CHARS)
                .ok_or_else(|| {
                    format!("ui-type needs text, at most {MAX_UI_TYPE_CHARS} characters.")
                })?;
            if text
                .chars()
                .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
            {
                return Err("ui-type types printable text; press keys with ui-key.".into());
            }
            Ok(UiDriverRequest::Type {
                window,
                selector: UiSelector::parse(params)?,
                text: text.to_string(),
                clear: flag("clear")?,
                timeout_ms: timeout()?,
            })
        }
        "ui-key" => {
            allow(&["timeoutMs", "key", "modifiers"], true)?;
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .and_then(UiKeyName::parse)
                .ok_or(
                    "ui-key's key is a key name (Escape, Enter, Tab, Space, Backspace, Delete, \
                     the arrows, Home, End, PageUp, PageDown, F1-F12) or one character.",
                )?;
            let mut modifiers = match params.get("modifiers") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(modifiers)) if modifiers.len() <= 4 => modifiers
                    .iter()
                    .map(|modifier| modifier.as_str().and_then(UiModifier::parse))
                    .collect::<Option<Vec<_>>>()
                    .ok_or("ui-key's modifiers are shift, control, alt and meta.")?,
                Some(_) => return Err("ui-key's modifiers is a list of at most four.".into()),
            };
            modifiers.sort();
            modifiers.dedup();
            Ok(UiDriverRequest::Key {
                window,
                selector: UiSelector::parse(params)?,
                key,
                modifiers,
                timeout_ms: timeout()?,
            })
        }
        "ui-scroll" => {
            allow(&["timeoutMs", "dx", "dy"], true)?;
            let delta = |key: &str| -> Result<f64, String> {
                match params.get(key) {
                    None | Some(Value::Null) => Ok(0.0),
                    Some(value) => value
                        .as_f64()
                        .filter(|delta| delta.is_finite() && delta.abs() <= MAX_UI_SCROLL)
                        .ok_or_else(|| format!("ui-scroll's {key} is a number of points.")),
                }
            };
            let (dx, dy) = (delta("dx")?, delta("dy")?);
            if dx == 0.0 && dy == 0.0 {
                return Err("ui-scroll needs a dx or dy.".into());
            }
            Ok(UiDriverRequest::Scroll {
                window,
                selector: UiSelector::parse(params)?,
                dx,
                dy,
                timeout_ms: timeout()?,
            })
        }
        "ui-set-value" => {
            // `value` is the new value here, never a selector field.
            for key in params.keys() {
                let known = matches!(key.as_str(), "window" | "timeoutMs" | "value")
                    || (SELECTOR_KEYS.contains(&key.as_str()) && key != "value");
                if !known {
                    return Err(format!("ui-set-value does not take {key}."));
                }
            }
            let value = match params.get("value") {
                Some(Value::String(value)) if value.chars().count() <= MAX_UI_TYPE_CHARS => {
                    value.clone()
                }
                Some(Value::Number(number)) => number.to_string(),
                Some(Value::Bool(on)) => on.to_string(),
                _ => return Err("ui-set-value needs a value (a string, number or bool).".into()),
            };
            let mut selector_params = params.clone();
            selector_params.remove("value");
            Ok(UiDriverRequest::SetValue {
                window,
                selector: required(UiSelector::parse(&selector_params)?)?,
                value,
                timeout_ms: timeout()?,
            })
        }
        "ui-appearance" => {
            for key in params.keys() {
                if !matches!(key.as_str(), "theme" | "increaseContrast" | "reduceMotion") {
                    return Err(format!("ui-appearance does not take {key}."));
                }
            }
            let dark = match params.get("theme") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(Value::String(theme)) if theme == "dark" => Some(Some(true)),
                Some(Value::String(theme)) if theme == "light" => Some(Some(false)),
                Some(_) => {
                    return Err(
                        "ui-appearance's theme is \"dark\", \"light\" or null (the app's own)."
                            .into(),
                    );
                }
            };
            let forced = |key: &str| -> Result<Option<Option<bool>>, String> {
                match params.get(key) {
                    None => Ok(None),
                    Some(Value::Null) => Ok(Some(None)),
                    Some(Value::Bool(on)) => Ok(Some(Some(*on))),
                    Some(_) => Err(format!(
                        "ui-appearance's {key} is true, false or null (the OS's)."
                    )),
                }
            };
            Ok(UiDriverRequest::Appearance(UiAppearanceRequest {
                dark,
                increase_contrast: forced("increaseContrast")?,
                reduce_motion: forced("reduceMotion")?,
            }))
        }
        "ui-toast" => {
            for key in params.keys() {
                if !matches!(
                    key.as_str(),
                    "kind" | "title" | "description" | "id" | "durationMs"
                ) {
                    return Err(format!("ui-toast does not take {key}."));
                }
            }
            let words = |key: &str, required: bool| -> Result<Option<String>, String> {
                match params.get(key) {
                    None | Some(Value::Null) if !required => Ok(None),
                    Some(Value::String(text))
                        if !text.trim().is_empty() && text.chars().count() <= MAX_UI_TYPE_CHARS =>
                    {
                        Ok(Some(text.clone()))
                    }
                    _ => Err(format!(
                        "ui-toast's {key} is words (1 to {MAX_UI_TYPE_CHARS} characters)."
                    )),
                }
            };
            let kind = match params.get("kind") {
                Some(Value::String(kind)) if UI_TOAST_KINDS.contains(&kind.as_str()) => {
                    kind.clone()
                }
                _ => {
                    return Err(format!(
                        "ui-toast's kind is one of {}.",
                        UI_TOAST_KINDS.join(", ")
                    ));
                }
            };
            let duration_ms = match params.get("durationMs") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_u64()
                        .filter(|ms| (1..=600_000).contains(ms))
                        .ok_or_else(|| "ui-toast's durationMs is 1 to 600000.".to_string())?,
                ),
            };
            Ok(UiDriverRequest::Toast(UiToastRequest {
                kind,
                title: words("title", true)?.unwrap_or_default(),
                description: words("description", false)?,
                id: words("id", false)?.unwrap_or_else(|| "ui-toast".to_string()),
                duration_ms,
            }))
        }
        other => Err(format!("{other} is not a UI driver command.")),
    }
}

pub(crate) fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..symbols {
            out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    #[test]
    fn keeps_normal_packaged_apps_disabled_and_requires_a_harness_capability() {
        assert!(smoke_command_server_allowed(true, false, None));
        assert!(!smoke_command_server_allowed(true, true, None));
        assert!(!smoke_command_server_allowed(true, true, Some("short")));
        assert!(smoke_command_server_allowed(
            true,
            true,
            Some(&"x".repeat(43))
        ));
        assert!(!smoke_command_server_allowed(false, false, None));
    }

    #[test]
    fn requires_the_exact_per_run_bearer_capability() {
        assert!(smoke_request_authorized(Some("Bearer secret"), "secret"));
        assert!(!smoke_request_authorized(Some("Bearer wrong"), "secret"));
        assert!(!smoke_request_authorized(Some("Bearer secret2"), "secret"));
        assert!(!smoke_request_authorized(Some("bearer secret"), "secret"));
        assert!(!smoke_request_authorized(Some("secret"), "secret"));
        assert!(!smoke_request_authorized(None, "secret"));
        assert!(!smoke_request_authorized(Some("Bearer "), ""));
    }

    #[test]
    fn creates_a_fresh_256_bit_url_safe_capability_for_each_server_run() {
        let first = create_smoke_command_capability();
        let second = create_smoke_command_capability();
        assert!(smoke_command_capability_valid(&first), "{first}");
        assert!(smoke_command_capability_valid(&second), "{second}");
        assert_ne!(first, second);
        assert!(!smoke_command_capability_valid(&"x".repeat(42)));
        assert!(!smoke_command_capability_valid(&"x".repeat(44)));
        assert!(!smoke_command_capability_valid(&format!(
            "{}=",
            "x".repeat(42)
        )));
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url(b"Man"), "TWFu");
    }

    #[test]
    fn accepts_only_known_commands_with_bounded_json_params() {
        assert_eq!(
            validate_smoke_command_payload(
                &json!({"command": "open-tab", "params": {"tab": "settings"}})
            ),
            Some(ValidatedSmokeCommand {
                command: "open-tab".to_string(),
                params: object(json!({"tab": "settings"}))
            })
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "totally-unknown", "params": {}})),
            None
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": []})),
            None
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": false})),
            None
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "eval-js", "params": {}})),
            None
        );
        assert_eq!(validate_smoke_command_payload(&json!(["open-tab"])), None);
        assert_eq!(validate_smoke_command_payload(&json!({})), None);
        // Absent or null params are an empty object, as `body.params ?? {}`.
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "studio-state"}))
                .map(|command| command.params),
            Some(Map::new())
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({"command": "app-quit", "params": null}))
                .map(|command| command.command),
            Some("app-quit".to_string())
        );
        assert!(
            validate_smoke_command_payload(&json!({
                "command": "authorize-smoke-resource",
                "params": {"kind": "input-file", "path": "/tmp/fixture.png"}
            }))
            .is_some()
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({
                "command": "open-tab",
                "params": {"nested": {"constructor": "blocked"}}
            })),
            None
        );
        assert_eq!(
            validate_smoke_command_payload(&json!({
                "command": "open-tab",
                "params": {"__proto__": 1}
            })),
            None
        );
    }

    #[test]
    fn bounds_param_depth_and_the_shared_key_budget() {
        let mut deep = json!(1);
        for _ in 0..MAX_PARAM_DEPTH {
            deep = json!({ "a": deep });
        }
        // params is depth 0: a value nine levels down is refused, eight is not.
        assert!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": {"a": deep}}))
                .is_none()
        );
        let mut fits = json!(1);
        for _ in 0..(MAX_PARAM_DEPTH - 1) {
            fits = json!({ "a": fits });
        }
        assert!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": {"a": fits}}))
                .is_some()
        );
        let wide: Vec<Value> = (0..MAX_PARAM_KEYS).map(|index| json!(index)).collect();
        assert!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": {"w": wide}}))
                .is_none(),
            "2000 entries plus the params key exceed the budget"
        );
        let wide: Vec<Value> = (0..MAX_PARAM_KEYS - 1).map(|index| json!(index)).collect();
        assert!(
            validate_smoke_command_payload(&json!({"command": "open-tab", "params": {"w": wide}}))
                .is_some()
        );
        let long_code = "x".repeat(MAX_EVAL_JS_CODE_UNITS + 1);
        assert!(
            validate_smoke_command_payload(
                &json!({"command": "eval-js", "params": {"code": long_code}})
            )
            .is_none()
        );
    }

    #[test]
    fn authorizes_only_regular_resources_canonically_contained_by_the_state_directory() {
        let parent = tempfile::Builder::new()
            .prefix("videorc-smoke-resource-")
            .tempdir()
            .unwrap();
        let state = parent.path().join("state");
        let output = state.join("recordings");
        let outside = parent.path().join("state-sibling");
        let input = state.join("fixture.png");
        let outside_file = outside.join("outside.png");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(&input, "fixture").unwrap();
        std::fs::write(&outside_file, "outside").unwrap();
        let state_text = state.to_str().unwrap();
        let grant = |kind: &str, path: &Path| {
            validate_smoke_resource_authorization(
                &object(json!({"kind": kind, "path": path.to_str().unwrap()})),
                Some(state_text),
            )
        };

        assert_eq!(
            grant("input-file", &input),
            Ok(SmokeResourceAuthorization {
                kind: SmokeResourceKind::InputFile,
                path: std::fs::canonicalize(&input).unwrap()
            })
        );
        assert_eq!(
            grant("output-directory", &output).map(|grant| grant.path),
            Ok(std::fs::canonicalize(&output).unwrap())
        );
        assert_eq!(
            grant("output-directory", &state).map(|grant| grant.path),
            Ok(std::fs::canonicalize(&state).unwrap())
        );
        assert!(
            grant("input-file", &outside_file)
                .unwrap_err()
                .contains("inside the smoke state directory")
        );
        assert!(
            grant("input-file", &output)
                .unwrap_err()
                .contains("regular file")
        );
        assert!(
            grant("output-directory", &input)
                .unwrap_err()
                .contains("directory")
        );
    }

    #[test]
    fn rejects_missing_malformed_oversized_and_direct_symlink_resources() {
        let parent = tempfile::Builder::new()
            .prefix("videorc-smoke-resource-")
            .tempdir()
            .unwrap();
        let state = parent.path().join("state");
        let target = state.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let state_text = state.to_str().unwrap();
        let target_text = target.to_str().unwrap();
        let check = |params: Value, state_directory: Option<&str>| {
            validate_smoke_resource_authorization(&object(params), state_directory).unwrap_err()
        };

        #[cfg(unix)]
        {
            let linked = state.join("linked");
            std::os::unix::fs::symlink(&target, &linked).unwrap();
            assert!(
                check(
                    json!({"kind": "output-directory", "path": linked.to_str().unwrap()}),
                    Some(state_text)
                )
                .contains("symbolic link")
            );
            let linked_state = parent.path().join("linked-state");
            std::os::unix::fs::symlink(&state, &linked_state).unwrap();
            assert!(
                check(
                    json!({"kind": "output-directory", "path": target_text}),
                    Some(linked_state.to_str().unwrap())
                )
                .contains("symbolic link")
            );
        }
        assert!(
            check(
                json!({"kind": "output-directory", "path": state.join("missing").to_str().unwrap()}),
                Some(state_text)
            )
            .contains("does not exist")
        );
        for params in [
            json!({"kind": "open-path", "path": target_text}),
            json!({"kind": "output-directory", "path": target_text, "extra": true}),
            json!({"kind": "output-directory", "path": "x".repeat(4_097)}),
            json!({"kind": "output-directory", "path": "relative/path"}),
            json!({"kind": "output-directory", "path": format!(" {target_text}")}),
            json!({"kind": "output-directory"}),
        ] {
            assert!(
                check(params.clone(), Some(state_text))
                    .contains("Invalid smoke resource authorization"),
                "{params}"
            );
        }
        assert!(
            check(
                json!({"kind": "output-directory", "path": target_text}),
                None
            )
            .contains("Invalid smoke resource authorization")
        );
    }

    #[test]
    fn keeps_the_protected_backend_bridge_on_a_small_debug_only_allowlist() {
        let names: BTreeSet<&str> = SMOKE_BACKEND_RPC_METHOD_NAMES.iter().copied().collect();
        assert_eq!(
            names,
            BTreeSet::from([
                "audio.test.disconnect",
                "audio.test.inject-pcm",
                "captions.test.inject-audio",
                "captions.test.snapshot",
                "cohost.pet.import",
                "compositor.scene.update",
                "diagnostics.stats",
                "encoder_bridge.synthetic_record",
                "recording.start_test",
            ])
        );
        assert_eq!(
            validate_smoke_backend_rpc_request(&object(
                json!({"method": "diagnostics.stats", "params": {}, "timeoutMs": 30_000})
            )),
            Some(ValidatedSmokeBackendRpcRequest {
                method: "diagnostics.stats".to_string(),
                params: Map::new(),
                timeout_ms: 30_000
            })
        );
        assert_eq!(
            validate_smoke_backend_rpc_request(&object(
                json!({"method": "audio.test.disconnect", "params": {"sessionId": "session-1"}})
            ))
            .map(|request| (request.params, request.timeout_ms)),
            Some((object(json!({"sessionId": "session-1"})), 15_000))
        );
        for refused in [
            json!({"method": "resource.capability.issue", "params": {}}),
            json!({"method": "captions.test.snapshot", "params": []}),
            json!({"method": "captions.test.snapshot"}),
            json!({"method": "captions.test.snapshot", "params": {}, "timeoutMs": 300_001}),
            json!({"method": "captions.test.snapshot", "params": {}, "timeoutMs": 0}),
            json!({"method": "captions.test.snapshot", "params": {}, "timeoutMs": "5"}),
        ] {
            assert_eq!(
                validate_smoke_backend_rpc_request(&object(refused.clone())),
                None,
                "{refused}"
            );
        }
    }

    #[test]
    fn restricts_a_packaged_harness_to_the_preview_gate_subset() {
        for name in PACKAGED_SMOKE_COMMAND_NAMES {
            assert!(ELECTRON_SMOKE_COMMAND_NAMES.contains(name), "{name}");
        }
        assert!(PACKAGED_SMOKE_COMMAND_NAMES.contains(&"app-quit"));
        for absent in [
            "authorize-smoke-resource",
            "import-takeover-image",
            "import-smoke-background",
            "eval-js",
            "backend-debug-rpc",
            "studio-record",
            "studio-put-setting",
        ] {
            assert!(!PACKAGED_SMOKE_COMMAND_NAMES.contains(&absent), "{absent}");
        }
    }

    #[test]
    fn checks_resource_capability_ids_like_main_does() {
        assert!(resource_capability_id_valid(
            "resource:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7"
        ));
        assert!(resource_capability_id_valid(
            "resource:8BC7491D-D5DF-4AAE-BA18-6CF39CCBAAD7"
        ));
        assert!(!resource_capability_id_valid(
            "8bc7491d-d5df-4aae-8a18-6cf39ccbaad7"
        ));
        assert!(!resource_capability_id_valid(
            "resource:8bc7491d-d5df-6aae-8a18-6cf39ccbaad7"
        ));
        assert!(!resource_capability_id_valid(
            "resource:8bc7491d-d5df-4aae-7a18-6cf39ccbaad7"
        ));
        assert!(!resource_capability_id_valid("resource:"));
    }

    #[test]
    fn capture_page_names_its_file_as_electron_does() {
        assert_eq!(
            capture_page_file_name(&object(json!({"name": "studio-1280x800-dark"}))),
            "videorc-ui-studio-1280x800-dark.png"
        );
        assert_eq!(
            capture_page_file_name(&object(json!({"name": "../etc/pass wd_x"}))),
            "videorc-ui-etcpasswdx.png"
        );
        assert_eq!(
            capture_page_file_name(&object(json!({}))),
            "videorc-ui-page.png"
        );
        assert_eq!(
            capture_page_file_name(&object(json!({"name": 3}))),
            "videorc-ui-page.png"
        );
        assert_eq!(ui_window(&object(json!({}))), Ok(UiWindow::Main));
        assert_eq!(
            ui_window(&object(json!({"window": "preview"}))),
            Ok(UiWindow::Preview)
        );
        assert!(ui_window(&object(json!({"window": "comments"}))).is_err());
    }

    #[test]
    fn ui_driver_requests_are_typed_and_bounded() {
        use super::super::ui_tree::UiSelector;
        let ok = |command: &str, params: Value| {
            validate_ui_driver_request(command, &object(params)).unwrap()
        };
        let refused = |command: &str, params: Value| {
            validate_ui_driver_request(command, &object(params.clone()))
                .expect_err(&format!("{command} {params}"))
        };

        for name in UI_DRIVER_COMMAND_NAMES {
            assert!(RUST_SMOKE_COMMAND_NAMES.contains(name), "{name}");
            assert!(is_smoke_command(name), "{name}");
            assert!(!PACKAGED_SMOKE_COMMAND_NAMES.contains(name), "{name}");
        }

        assert_eq!(
            ok("ui-find", json!({"label": "Record", "role": "button"})),
            UiDriverRequest::Find {
                window: UiWindow::Main,
                selector: UiSelector {
                    label: Some("Record".into()),
                    role: Some("button".into()),
                    ..UiSelector::default()
                },
                timeout_ms: DEFAULT_UI_WAIT_MS,
                reveal: false,
            }
        );
        assert!(refused("ui-find", json!({})).contains("needs a label"));
        assert!(refused("ui-find", json!({"label": "x", "lable": "y"})).contains("lable"));
        assert!(refused("ui-find", json!({"label": "x", "timeoutMs": 120_001})).contains("0 to"));
        assert_eq!(
            ok("ui-find", json!({"label": "x", "timeoutMs": 0})).timeout_ms(),
            0
        );

        assert!(matches!(
            ok("ui-click", json!({"label": "Record", "via": "action"})),
            UiDriverRequest::Click {
                via: UiClickVia::Action,
                ..
            }
        ));
        assert!(refused("ui-click", json!({"label": "Record", "via": "touch"})).contains("via"));

        assert!(matches!(
            ok(
                "ui-type",
                json!({"text": "rtmp://127.0.0.1/live", "clear": true})
            ),
            UiDriverRequest::Type {
                selector: None,
                clear: true,
                ..
            }
        ));
        assert!(refused("ui-type", json!({})).contains("needs text"));
        assert!(refused("ui-type", json!({"text": "a\u{1b}b"})).contains("ui-key"));

        assert_eq!(
            ok(
                "ui-key",
                json!({"key": "a", "modifiers": ["cmd", "shift", "meta"]})
            ),
            UiDriverRequest::Key {
                window: UiWindow::Main,
                selector: None,
                key: UiKeyName::Char('a'),
                modifiers: vec![UiModifier::Shift, UiModifier::Meta],
                timeout_ms: DEFAULT_UI_WAIT_MS,
            }
        );
        for (text, key) in [
            ("Escape", UiKeyName::Escape),
            ("Return", UiKeyName::Enter),
            (" ", UiKeyName::Space),
            ("F12", UiKeyName::Function(12)),
            ("é", UiKeyName::Char('é')),
        ] {
            assert_eq!(UiKeyName::parse(text), Some(key), "{text}");
        }
        for text in ["", "ab", "F13", "F0", "\u{7}"] {
            assert_eq!(UiKeyName::parse(text), None, "{text:?}");
        }
        assert!(
            refused("ui-key", json!({"key": "Esc", "modifiers": ["hyper"]})).contains("modifiers")
        );

        assert!(matches!(
            ok("ui-scroll", json!({"dy": -120, "label": "Studio"})),
            UiDriverRequest::Scroll { dx, dy, selector: Some(_), .. } if dx == 0.0 && dy == -120.0
        ));
        assert!(refused("ui-scroll", json!({})).contains("dx or dy"));

        // `value` is the new value for ui-set-value, never a selector field.
        assert_eq!(
            ok("ui-set-value", json!({"label": "Volume", "value": 40})),
            UiDriverRequest::SetValue {
                window: UiWindow::Main,
                selector: UiSelector::label("Volume"),
                value: "40".into(),
                timeout_ms: DEFAULT_UI_WAIT_MS,
            }
        );
        assert!(refused("ui-set-value", json!({"value": "x"})).contains("needs a label"));

        assert_eq!(
            ok(
                "ui-appearance",
                json!({"theme": "light", "increaseContrast": true, "reduceMotion": null})
            ),
            UiDriverRequest::Appearance(UiAppearanceRequest {
                dark: Some(Some(false)),
                increase_contrast: Some(Some(true)),
                reduce_motion: Some(None),
            })
        );
        assert!(refused("ui-appearance", json!({"theme": "system"})).contains("theme"));
        assert!(refused("ui-appearance", json!({"contrast": true})).contains("contrast"));

        // S3.0f: a toast through the session's toast path.
        assert_eq!(
            ok(
                "ui-toast",
                json!({"kind": "error", "title": "A error toast", "description": "What happened."})
            ),
            UiDriverRequest::Toast(UiToastRequest {
                kind: "error".into(),
                title: "A error toast".into(),
                description: Some("What happened.".into()),
                id: "ui-toast".into(),
                duration_ms: None,
            })
        );
        assert!(
            refused(
                "ui-toast",
                json!({"kind": "info", "title": "x", "durationMs": 0})
            )
            .contains("durationMs")
        );
        assert!(refused("ui-toast", json!({"kind": "loud", "title": "x"})).contains("kind"));
        assert!(refused("ui-toast", json!({"kind": "info"})).contains("title"));
        assert!(
            refused(
                "ui-toast",
                json!({"kind": "info", "title": "x", "window": "preview"})
            )
            .contains("window")
        );

        assert!(matches!(
            ok(
                "ui-tree",
                json!({"window": "preview", "depth": 2, "within": {"role": "image"}})
            ),
            UiDriverRequest::Tree {
                window: UiWindow::Preview,
                depth: Some(2),
                within: Some(_),
            }
        ));
        assert!(refused("ui-tree", json!({"label": "x"})).contains("label"));
        assert!(refused("ui-other", json!({})).contains("not a UI driver command"));
    }

    /// The name lists stay Electron's: read them from the TypeScript file
    /// (skipped once Electron's sources are gone).
    #[test]
    fn the_name_lists_match_smoke_command_security_ts() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/main/smoke-command-security.ts");
        let Ok(text) = std::fs::read_to_string(&source) else {
            eprintln!("{} is absent; skipping", source.display());
            return;
        };
        let set = |name: &str| -> BTreeSet<String> {
            let start = text
                .find(&format!("export const {name} = new Set(["))
                .unwrap_or_else(|| panic!("{name} in the TypeScript file"));
            let end = start + text[start..].find("])").expect("the set closes");
            text[start..end]
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .flat_map(|line| line.split('\'').skip(1).step_by(2))
                .filter(|name| !name.is_empty() && !name.contains(' '))
                .map(str::to_string)
                .collect()
        };
        let rust = |names: &[&str]| -> BTreeSet<String> {
            names.iter().map(|name| name.to_string()).collect()
        };
        assert_eq!(
            rust(ELECTRON_SMOKE_COMMAND_NAMES),
            set("SMOKE_COMMAND_NAMES")
        );
        assert_eq!(
            rust(PACKAGED_SMOKE_COMMAND_NAMES),
            set("PACKAGED_SMOKE_COMMAND_NAMES")
        );
        assert_eq!(
            rust(SMOKE_BACKEND_RPC_METHOD_NAMES),
            set("SMOKE_BACKEND_RPC_METHOD_NAMES")
        );
        for name in RUST_SMOKE_COMMAND_NAMES {
            assert!(
                !ELECTRON_SMOKE_COMMAND_NAMES.contains(name),
                "{name} is Electron's now: drop it from RUST_SMOKE_COMMAND_NAMES"
            );
        }
    }
}
