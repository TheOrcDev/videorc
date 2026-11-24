//! Plan 209 S22, in the backend since plan 260 S1.5c: "Add to …" in the
//! Connect dialog writes the `videorc` entry into Claude Desktop's, Cursor's,
//! VS Code's or Codex's own config file, or runs `claude mcp add` for Claude
//! Code, so the streamer doesn't paste anything. Electron main only finds its
//! own `videorc-mcp` bridge and hands its path over the admin socket.
//!
//! The rules, because these files belong to other apps:
//! - parse first, and add or replace only the `videorc` entry; every other
//!   server and setting stays as it was;
//! - never create the app's folder: no folder means the app isn't set up on
//!   this computer, and the dialog's line is the way;
//! - any file Videorc can't read with certainty (not plain JSON, an unknown
//!   shape, TOML the scanner refuses) is left alone, and the answer says to
//!   copy the line instead;
//! - a timestamped backup beside the file before every change, and the new
//!   file written beside it and renamed over it (a crash leaves the old file
//!   or the new one, never half of one);
//! - on macOS and Linux the file is owner-only (0600) once it holds a token,
//!   and so are its backups, which may hold an earlier one (review #13); only
//!   the newest 3 of Videorc's backups beside a file are kept;
//! - a symlinked config (dotfiles) is written through to its target.
//!
//! The entry, the Codex table and the `claude` arguments mirror
//! `apps/desktop/src/shared/agent-config-entry.ts`, which builds the line the
//! dialog shows; both are pinned to `protocol-fixtures/agent-config-entry.json`.

mod codex_toml;
mod ordered_json;

use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use codex_toml::{CodexTomlMerge, merge_codex_toml};
use ordered_json::Json;

/// The server name agent apps show (`mcp__videorc__…`), D21.
pub(crate) const AGENT_SERVER_NAME: &str = "videorc";
/// The variable the bridge reads its token from (S4).
pub(crate) const AGENT_TOKEN_ENV: &str = "VIDEORC_AGENT_TOKEN";
/// Review #19: what "Add to …" answers when Videorc runs from a disk image or
/// macOS's temporary copy of it.
pub(crate) const AGENT_BRIDGE_MOVE_FIRST: &str = "Move Videorc to Applications first.";
/// `claude mcp add` gets this long; the CLI answers in well under a second.
const CLAUDE_CLI_ADD_TIMEOUT: Duration = Duration::from_secs(20);
/// The `remove` before it is the usual no-op; both fit the RPC's 30 s.
const CLAUDE_CLI_REMOVE_TIMEOUT: Duration = Duration::from_secs(8);
/// Videorc's backups kept beside each config file (review #13).
pub(crate) const AGENT_CONFIG_BACKUPS_KEPT: usize = 3;
#[cfg(unix)]
const OWNER_ONLY: u32 = 0o600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentAddApp {
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
    Codex,
    VsCode,
}

impl AgentAddApp {
    fn name(self) -> &'static str {
        match self {
            Self::ClaudeDesktop => "Claude Desktop",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
            Self::Codex => "Codex",
            Self::VsCode => "VS Code",
        }
    }

    /// What to do next in each app, after "Added."
    fn added_message(self) -> &'static str {
        match self {
            Self::ClaudeDesktop => "Added. Restart Claude Desktop to see Videorc.",
            Self::ClaudeCode => "Added. Start a new Claude Code session to see Videorc.",
            Self::Cursor => "Added. Turn on videorc in Cursor Settings → MCP to see Videorc.",
            Self::Codex => "Added. Restart Codex to see Videorc.",
            Self::VsCode => {
                "Added. In VS Code, start videorc from MCP: List Servers to see Videorc."
            }
        }
    }
}

/// `agents.config.add`: admin only, since it writes a path into another
/// app's config; the token's shape is checked by main's IPC contract.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentConfigAddParams {
    pub app: AgentAddApp,
    pub bridge_path: String,
    pub token: String,
}

/// What "Add to …" did, in the dialog's own sentence. `added` false means
/// the app's file was left alone and the line is the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AgentAddResult {
    pub added: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }

    fn separator(self) -> char {
        if self == Self::Windows { '\\' } else { '/' }
    }

    /// `path.join` for well-formed absolute parts, under this platform's rules.
    fn join(self, parts: &[&str]) -> String {
        let separator = self.separator();
        let trim = |part: &str| -> String {
            part.trim_matches(|char| char == '/' || (self == Self::Windows && char == '\\'))
                .to_string()
        };
        let mut out = parts[0]
            .trim_end_matches(|char| char == '/' || (self == Self::Windows && char == '\\'))
            .to_string();
        if out.is_empty() {
            out.push(separator);
        }
        for part in &parts[1..] {
            let part = trim(part);
            if part.is_empty() {
                continue;
            }
            if !out.ends_with(separator) {
                out.push(separator);
            }
            out.push_str(&part);
        }
        out
    }

    fn basename(self, path: &str) -> String {
        path.rsplit(|char| char == '/' || (self == Self::Windows && char == '\\'))
            .next()
            .unwrap_or(path)
            .to_string()
    }
}

/// Where the apps keep their settings, from this process's environment.
#[derive(Debug, Clone)]
pub(crate) struct AgentEnvironment {
    pub platform: Platform,
    pub home_dir: String,
    /// `%APPDATA%` (Windows).
    pub app_data: Option<String>,
    /// `%LOCALAPPDATA%` (Windows), where Store apps keep their packages.
    pub local_app_data: Option<String>,
    /// `$XDG_CONFIG_HOME` (Linux).
    pub xdg_config_home: Option<String>,
    /// `$CODEX_HOME`, where Codex keeps config.toml when it is set.
    pub codex_home: Option<String>,
    /// `PATH` (`Path` on Windows).
    pub path_variable: Option<String>,
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl AgentEnvironment {
    pub(crate) fn from_process() -> Self {
        let platform = Platform::current();
        let home_dir = if platform == Platform::Windows {
            env_value("USERPROFILE").or_else(|| env_value("HOME"))
        } else {
            env_value("HOME")
        }
        .unwrap_or_default();
        Self {
            platform,
            home_dir,
            app_data: env_value("APPDATA"),
            local_app_data: env_value("LOCALAPPDATA"),
            xdg_config_home: env_value("XDG_CONFIG_HOME"),
            codex_home: env_value("CODEX_HOME"),
            path_variable: env_value("PATH").or_else(|| env_value("Path")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigFormat {
    Json,
    Toml,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentConfigTarget {
    pub app: AgentAddApp,
    pub file: String,
    pub format: ConfigFormat,
}

/// Where each config app keeps its user-wide MCP servers on this platform.
/// Claude Code has no file: it goes through its CLI.
pub(crate) fn agent_config_target(
    app: AgentAddApp,
    environment: &AgentEnvironment,
) -> Option<AgentConfigTarget> {
    let platform = environment.platform;
    let home = environment.home_dir.as_str();
    let roaming = environment
        .app_data
        .clone()
        .unwrap_or_else(|| platform.join(&[home, "AppData", "Roaming"]));
    let xdg = environment
        .xdg_config_home
        .clone()
        .unwrap_or_else(|| platform.join(&[home, ".config"]));
    // The folder each app keeps its settings in: macOS Application Support,
    // Windows %APPDATA%, Linux $XDG_CONFIG_HOME.
    let settings_root = match platform {
        Platform::Mac => platform.join(&[home, "Library", "Application Support"]),
        Platform::Windows => roaming,
        Platform::Linux => xdg,
    };
    let (format, file) = match app {
        AgentAddApp::ClaudeCode => return None,
        AgentAddApp::ClaudeDesktop => (
            ConfigFormat::Json,
            platform.join(&[&settings_root, "Claude", "claude_desktop_config.json"]),
        ),
        AgentAddApp::Cursor => (
            ConfigFormat::Json,
            platform.join(&[home, ".cursor", "mcp.json"]),
        ),
        AgentAddApp::VsCode => (
            ConfigFormat::Json,
            platform.join(&[&settings_root, "Code", "User", "mcp.json"]),
        ),
        AgentAddApp::Codex => {
            let codex_home = environment
                .codex_home
                .clone()
                .unwrap_or_else(|| platform.join(&[home, ".codex"]));
            (
                ConfigFormat::Toml,
                platform.join(&[&codex_home, "config.toml"]),
            )
        }
    };
    Some(AgentConfigTarget { app, file, format })
}

/// Review #21: Claude Desktop from the Microsoft Store (MSIX) reads its
/// config from its package's private AppData,
/// `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\`, not
/// `%APPDATA%\Claude\`. With such a package on this computer its file wins
/// (the first package by name, should there be two).
pub(crate) fn claude_desktop_msix_config_file(
    environment: &AgentEnvironment,
    read_dir: &dyn Fn(&str) -> io::Result<Vec<String>>,
) -> Option<String> {
    if environment.platform != Platform::Windows {
        return None;
    }
    let windows = Platform::Windows;
    let local = environment
        .local_app_data
        .clone()
        .unwrap_or_else(|| windows.join(&[&environment.home_dir, "AppData", "Local"]));
    let packages = windows.join(&[&local, "Packages"]);
    let mut names: Vec<String> = read_dir(&packages)
        .unwrap_or_default()
        .into_iter()
        .filter(|name| {
            name.get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Claude_"))
        })
        .collect();
    names.sort();
    names.into_iter().next().map(|claude| {
        windows.join(&[
            &packages,
            &claude,
            "LocalCache",
            "Roaming",
            "Claude",
            "claude_desktop_config.json",
        ])
    })
}

fn read_dir_names(path: &str) -> io::Result<Vec<String>> {
    Ok(fs::read_dir(path)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect())
}

/// `agent_config_target`, looking on disk for what the path alone can't say.
fn resolve_agent_config_target(
    app: AgentAddApp,
    environment: &AgentEnvironment,
    read_dir: &dyn Fn(&str) -> io::Result<Vec<String>>,
) -> Option<AgentConfigTarget> {
    let mut target = agent_config_target(app, environment)?;
    if app == AgentAddApp::ClaudeDesktop
        && let Some(msix) = claude_desktop_msix_config_file(environment, read_dir)
    {
        target.file = msix;
    }
    Some(target)
}

// ---------------------------------------------------------------------------
// The entry (mirrors shared/agent-config-entry.ts)
// ---------------------------------------------------------------------------

/// macOS runs this Videorc from somewhere that goes away: an app opened from
/// Downloads without being moved runs from a per-launch `AppTranslocation`
/// copy, and an app opened inside its disk image sits at the volume's root
/// (`/Volumes/Videorc/Videorc.app`). A config line naming either path breaks
/// at the next launch or eject. An app on an external drive's own folder
/// (`/Volumes/SSD/Applications/Videorc.app`) stays put and is fine.
pub(crate) fn agent_bridge_runs_from_temporary_copy(path: &str) -> bool {
    if path.contains("/AppTranslocation/") {
        return true;
    }
    let Some(rest) = path.strip_prefix("/Volumes/") else {
        return false;
    };
    let mut parts = rest.splitn(3, '/');
    let (Some(volume), Some(app), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !volume.is_empty() && app.len() > ".app".len() && app.ends_with(".app")
}

/// Claude Desktop and Cursor keep servers under `mcpServers`; VS Code's
/// `mcp.json` keeps them under `servers`, with a `type`.
fn agent_json_root_key(app: AgentAddApp) -> &'static str {
    if app == AgentAddApp::VsCode {
        "servers"
    } else {
        "mcpServers"
    }
}

/// The `videorc` entry for a JSON config.
pub(crate) fn agent_json_server_entry(app: AgentAddApp, bridge_path: &str, token: &str) -> Json {
    let mut entries = Vec::new();
    if app == AgentAddApp::VsCode {
        entries.push(("type".to_string(), Json::string("stdio")));
    }
    entries.push(("command".to_string(), Json::string(bridge_path)));
    entries.push(("args".to_string(), Json::Array(Vec::new())));
    entries.push((
        "env".to_string(),
        Json::object([(AGENT_TOKEN_ENV, Json::string(token))]),
    ));
    Json::Object(entries)
}

/// A TOML basic string: backslashes, quotes and control characters escaped.
pub(crate) fn toml_string(value: &str) -> String {
    let mut out = String::from("\"");
    for char in value.chars() {
        match char {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            char if (char as u32) < 0x20 || char as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04x}", char as u32));
            }
            char => out.push(char),
        }
    }
    out.push('"');
    out
}

/// Codex's `[mcp_servers.videorc]` table, one line per item.
pub(crate) fn agent_codex_toml_lines(bridge_path: &str, token: &str) -> Vec<String> {
    vec![
        format!("[mcp_servers.{AGENT_SERVER_NAME}]"),
        format!("command = {}", toml_string(bridge_path)),
        "args = []".to_string(),
        format!("env = {{ {AGENT_TOKEN_ENV} = {} }}", toml_string(token)),
    ]
}

/// `claude` CLI arguments that add Videorc for every project (user scope).
pub(crate) fn agent_claude_code_add_args(bridge_path: &str, token: &str) -> Vec<String> {
    [
        "mcp",
        "add",
        "--scope",
        "user",
        AGENT_SERVER_NAME,
        "--env",
        &format!("{AGENT_TOKEN_ENV}={token}"),
        "--",
        bridge_path,
    ]
    .map(str::to_string)
    .to_vec()
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    NoApp,
    NotJson,
    NotObject,
    ServersNotObject,
    UnsafeToml,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JsonConfigMerge {
    Merged { text: String, changed: bool },
    Refused(Refusal),
}

/// The file's own indent (two spaces when it has none), as `JSON.stringify`
/// takes it: at most 10 characters.
fn detect_indent(text: &str) -> String {
    for (index, _) in text.match_indices('\n') {
        let rest = &text[index + 1..];
        let indent: String = rest
            .chars()
            .take_while(|char| *char == ' ' || *char == '\t')
            .collect();
        if !indent.is_empty()
            && rest[indent.len()..]
                .chars()
                .next()
                .is_some_and(|char| !char.is_whitespace())
        {
            return indent.chars().take(10).collect();
        }
    }
    "  ".to_string()
}

/// Put `entry` under `root_key.videorc` in `existing` (None: no file yet).
/// Other keys keep their order and values; `videorc` keeps its place when it
/// was already there.
pub(crate) fn merge_json_config(
    existing: Option<&str>,
    root_key: &str,
    entry: &Json,
) -> JsonConfigMerge {
    let body = existing.map(|text| text.strip_prefix('\u{feff}').unwrap_or(text));
    let Some(body) = body.filter(|body| !body.trim().is_empty()) else {
        let fresh = Json::Object(vec![(
            root_key.to_string(),
            Json::Object(vec![(AGENT_SERVER_NAME.to_string(), entry.clone())]),
        )]);
        return JsonConfigMerge::Merged {
            text: format!("{}\n", fresh.pretty("  ")),
            changed: true,
        };
    };
    // Comments and trailing commas (JSONC) too: rewriting would drop them.
    let Ok(root) = serde_json::from_str::<Json>(body) else {
        return JsonConfigMerge::Refused(Refusal::NotJson);
    };
    let Json::Object(mut entries) = root else {
        return JsonConfigMerge::Refused(Refusal::NotObject);
    };
    // `root[rootKey] ?? {}`: a null servers key is no servers yet.
    let servers = match Json::Object(entries.clone()).get(root_key) {
        None | Some(Json::Null) => Json::Object(Vec::new()),
        Some(servers) => servers.clone(),
    };
    let Json::Object(mut servers) = servers else {
        return JsonConfigMerge::Refused(Refusal::ServersNotObject);
    };
    if Json::Object(servers.clone()).get(AGENT_SERVER_NAME) == Some(entry) {
        return JsonConfigMerge::Merged {
            text: existing.unwrap_or_default().to_string(),
            changed: false,
        };
    }
    Json::set(&mut servers, AGENT_SERVER_NAME, entry.clone());
    Json::set(&mut entries, root_key, Json::Object(servers));
    JsonConfigMerge::Merged {
        text: format!("{}\n", Json::Object(entries).pretty(&detect_indent(body))),
        changed: true,
    }
}

// ---------------------------------------------------------------------------
// Writing another app's file
// ---------------------------------------------------------------------------

/// `20261027-221530`, in UTC, for the backup's name.
pub(crate) fn backup_stamp(now: DateTime<Utc>) -> String {
    now.format("%Y%m%d-%H%M%S").to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentConfigWrite {
    Added {
        file: String,
        backup: Option<String>,
    },
    Unchanged {
        file: String,
    },
    Refused {
        file: String,
        reason: Refusal,
    },
    Failed {
        file: String,
    },
}

impl AgentConfigWrite {
    fn file(&self) -> &str {
        match self {
            Self::Added { file, .. }
            | Self::Unchanged { file }
            | Self::Refused { file, .. }
            | Self::Failed { file } => file,
        }
    }
}

/// What a config write may need from outside, so tests can fail one.
pub(crate) struct WriteDeps<'a> {
    pub now: DateTime<Utc>,
    pub rename: &'a dyn Fn(&Path, &Path) -> io::Result<()>,
    /// Raw causes go to the backend log, never to the dialog.
    pub log: &'a dyn Fn(&str),
}

fn real_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(unix)]
fn file_mode(path: &Path) -> io::Result<u32> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::metadata(path)?.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> io::Result<u32> {
    Ok(0o600)
}

#[cfg(unix)]
fn make_owner_only(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(OWNER_ONLY))
}

#[cfg(not(unix))]
fn make_owner_only(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// A copy of `file` beside it, never over an earlier backup; owner-only
/// where modes exist, since it may hold an earlier agent's token.
fn back_up(file: &Path, now: DateTime<Utc>) -> io::Result<PathBuf> {
    let base = format!("{}.videorc-backup-{}", file.display(), backup_stamp(now));
    for attempt in 0..20 {
        let candidate = if attempt == 0 {
            PathBuf::from(&base)
        } else {
            PathBuf::from(format!("{base}-{}", attempt + 1))
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut copy) => {
                io::copy(&mut fs::File::open(file)?, &mut copy)?;
                make_owner_only(&candidate)?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other(format!(
        "Too many backups of {} this second.",
        file.display()
    )))
}

/// `<stamp>` or `<stamp>-<n>` after `.videorc-backup-`: the stamp and the
/// copy number (1 for the first copy of that second).
fn backup_suffix(suffix: &str) -> Option<(&str, u64)> {
    let stamp = suffix.get(..15).filter(|stamp| stamp.is_ascii())?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if !(digits(&stamp[..8]) && stamp.as_bytes()[8] == b'-' && digits(&stamp[9..])) {
        return None;
    }
    match &suffix[15..] {
        "" => Some((stamp, 1)),
        rest => {
            let copy = rest.strip_prefix('-').filter(|copy| digits(copy))?;
            Some((stamp, copy.parse().ok()?))
        }
    }
}

/// Only the newest `AGENT_CONFIG_BACKUPS_KEPT` of Videorc's own backups
/// beside `file` stay, owner-only; older ones go. Names Videorc didn't make
/// are never touched.
pub(crate) fn prune_agent_config_backups(file: &Path) -> io::Result<()> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let prefix = format!(
        "{}.videorc-backup-",
        file.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
    );
    let mut backups: Vec<(String, String, u64)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Some(name) = entry?.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some((stamp, copy)) = name.strip_prefix(&prefix).and_then(backup_suffix) {
            backups.push((name.clone(), stamp.to_string(), copy));
        }
    }
    // Newest first: by the stamp, then by the copy number within a second.
    backups.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    for (index, (name, _, _)) in backups.iter().enumerate() {
        let path = dir.join(name);
        if index >= AGENT_CONFIG_BACKUPS_KEPT {
            fs::remove_file(path)?;
        } else {
            make_owner_only(&path)?;
        }
    }
    Ok(())
}

/// Write `text` beside `file`, then rename it over `file`.
fn replace_atomically(file: &Path, text: &str, mode: u32, deps: &WriteDeps) -> io::Result<()> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let staging = dir.join(format!(
        ".{name}.videorc-{}.tmp",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let written = (|| {
        let mut handle = options.open(&staging)?;
        handle.write_all(text.as_bytes())?;
        // The umask may have narrowed the mode; the file keeps the old one's.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            handle.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        handle.sync_all()?;
        (deps.rename)(&staging, file)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&staging);
    }
    written
}

/// Add or replace the `videorc` entry in `target`'s file.
pub(crate) fn write_agent_config(
    target: &AgentConfigTarget,
    bridge_path: &str,
    token: &str,
    platform: Platform,
    deps: &WriteDeps,
) -> AgentConfigWrite {
    match try_write_agent_config(target, bridge_path, token, platform, deps) {
        Ok(write) => write,
        Err(error) => {
            (deps.log)(&format!("Couldn't add Videorc to {}: {error}", target.file));
            AgentConfigWrite::Failed {
                file: target.file.clone(),
            }
        }
    }
}

fn try_write_agent_config(
    target: &AgentConfigTarget,
    bridge_path: &str,
    token: &str,
    platform: Platform,
    deps: &WriteDeps,
) -> io::Result<AgentConfigWrite> {
    let target_path = Path::new(&target.file);
    let folder_exists = target_path
        .parent()
        .and_then(|folder| fs::metadata(folder).ok())
        .is_some_and(|metadata| metadata.is_dir());
    if !folder_exists {
        return Ok(AgentConfigWrite::Refused {
            file: target.file.clone(),
            reason: Refusal::NoApp,
        });
    }

    // A symlinked config is written through to the file it points at.
    let (file, existing, mode) = match fs::canonicalize(target_path) {
        Ok(real) => {
            let bytes = fs::read(&real)?;
            let mode = file_mode(&real)?;
            (
                real,
                Some(String::from_utf8_lossy(&bytes).into_owned()),
                mode,
            )
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            (target_path.to_path_buf(), None, 0o600)
        }
        Err(error) => return Err(error),
    };
    let file_text = file.to_string_lossy().into_owned();

    let merged = match target.format {
        ConfigFormat::Json => match merge_json_config(
            existing.as_deref(),
            agent_json_root_key(target.app),
            &agent_json_server_entry(target.app, bridge_path, token),
        ) {
            JsonConfigMerge::Merged { text, changed } => (text, changed),
            JsonConfigMerge::Refused(reason) => {
                return Ok(AgentConfigWrite::Refused {
                    file: file_text,
                    reason,
                });
            }
        },
        ConfigFormat::Toml => match merge_codex_toml(
            existing.as_deref(),
            &agent_codex_toml_lines(bridge_path, token),
            AGENT_SERVER_NAME,
        ) {
            CodexTomlMerge::Merged { text, changed } => (text, changed),
            CodexTomlMerge::Refused { reason } => {
                (deps.log)(&format!("Left {file_text} alone: it has {reason}."));
                return Ok(AgentConfigWrite::Refused {
                    file: file_text,
                    reason: Refusal::UnsafeToml,
                });
            }
        },
    };
    let (text, changed) = merged;
    // Review #13: a file holding a token is owner-only where modes exist
    // (another app's 0644 config included); Windows keeps its ACLs.
    let holds_token = platform != Platform::Windows && text.contains(token);
    if !changed {
        if holds_token
            && (mode & 0o077) != 0
            && let Err(error) = make_owner_only(&file)
        {
            (deps.log)(&format!("Couldn't make {file_text} owner-only: {error}"));
        }
        return Ok(AgentConfigWrite::Unchanged { file: file_text });
    }

    let backup = match existing {
        Some(_) => Some(back_up(&file, deps.now)?),
        None => None,
    };
    replace_atomically(&file, &text, if holds_token { 0o600 } else { mode }, deps)?;
    if backup.is_some()
        && let Err(error) = prune_agent_config_backups(&file)
    {
        (deps.log)(&format!(
            "Couldn't tidy the backups of {file_text}: {error}"
        ));
    }
    Ok(AgentConfigWrite::Added {
        file: file_text,
        backup: backup.map(|path| path.to_string_lossy().into_owned()),
    })
}

/// The dialog's sentence for a config write.
pub(crate) fn agent_config_write_message(app: AgentAddApp, write: &AgentConfigWrite) -> String {
    let name = app.name();
    let file = if write.file().contains('\\') {
        Platform::Windows.basename(write.file())
    } else {
        Platform::Linux.basename(write.file())
    };
    match write {
        AgentConfigWrite::Added { .. } | AgentConfigWrite::Unchanged { .. } => {
            app.added_message().to_string()
        }
        AgentConfigWrite::Failed { .. } => {
            format!("Couldn't add Videorc to {name}. Copy the line instead.")
        }
        AgentConfigWrite::Refused { reason, .. } => match reason {
            Refusal::NoApp => format!(
                "Videorc can't find {name}'s settings folder on this computer. Open {name} once, or copy the line instead."
            ),
            Refusal::NotJson => format!(
                "{name}'s {file} isn't plain JSON, so Videorc left it alone. Copy the line instead."
            ),
            Refusal::NotObject | Refusal::ServersNotObject => format!(
                "{name}'s {file} has a shape Videorc doesn't know, so Videorc left it alone. Copy the line instead."
            ),
            Refusal::UnsafeToml => format!(
                "Videorc couldn't safely edit {name}'s {file}, so it left it alone. Copy the line instead."
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// Claude Code: the `claude` CLI
// ---------------------------------------------------------------------------

/// Why a `claude` run didn't finish: the stderr it wrote, never the args
/// (they hold the token).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CliFailure {
    pub timed_out: bool,
    pub stderr: String,
}

pub(crate) type CliFuture = Pin<Box<dyn Future<Output = Result<(), CliFailure>> + Send>>;

/// Runs `cli args…` with `PATH` set, no shell, stdin closed, and a timeout.
pub(crate) type RunCli = dyn Fn(PathBuf, Vec<String>, String, Duration) -> CliFuture + Send + Sync;

fn run_cli(cli: PathBuf, args: Vec<String>, path: String, timeout: Duration) -> CliFuture {
    Box::pin(async move {
        let mut command = tokio::process::Command::new(&cli);
        command
            .args(&args)
            .env("PATH", &path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let child = command.spawn().map_err(|error| CliFailure {
            timed_out: false,
            stderr: error.to_string(),
        })?;
        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Err(_) => Err(CliFailure {
                timed_out: true,
                stderr: String::new(),
            }),
            Ok(Err(error)) => Err(CliFailure {
                timed_out: false,
                stderr: error.to_string(),
            }),
            Ok(Ok(output)) if output.status.success() => Ok(()),
            Ok(Ok(output)) => Err(CliFailure {
                timed_out: false,
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            }),
        }
    })
}

/// Where `claude` may be: the PATH the app was started with, then the
/// installers' own folders, which a Finder-launched app's PATH lacks (the
/// native installer's `~/.local/bin`, Homebrew, npm in `/usr/local`). On
/// Windows only `claude.exe` counts: a `.cmd` runs only through a shell.
pub(crate) fn claude_cli_candidates(environment: &AgentEnvironment) -> Vec<String> {
    let platform = environment.platform;
    let home = environment.home_dir.as_str();
    let separator = if platform == Platform::Windows {
        ';'
    } else {
        ':'
    };
    let is_absolute = |entry: &str| match platform {
        Platform::Windows => {
            let bytes = entry.as_bytes();
            entry.starts_with('\\')
                || entry.starts_with('/')
                || (bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'\\' | b'/'))
        }
        _ => entry.starts_with('/'),
    };
    let mut folders: Vec<String> = environment
        .path_variable
        .as_deref()
        .unwrap_or("")
        .split(separator)
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && is_absolute(entry))
        .map(str::to_string)
        .collect();
    if platform == Platform::Windows {
        folders.push(platform.join(&[home, ".local", "bin"]));
    } else {
        folders.extend([
            platform.join(&[home, ".local", "bin"]),
            platform.join(&[home, ".claude", "local"]),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ]);
    }
    let name = if platform == Platform::Windows {
        "claude.exe"
    } else {
        "claude"
    };
    let mut seen = std::collections::HashSet::new();
    folders
        .into_iter()
        .filter(|folder| seen.insert(folder.clone()))
        .map(|folder| platform.join(&[&folder, name]))
        .collect()
}

fn dirname(platform: Platform, path: &str) -> String {
    let index = path.rfind(|char| char == '/' || (platform == Platform::Windows && char == '\\'));
    match index {
        Some(0) => platform.separator().to_string(),
        Some(index) => path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// The PATH `claude` runs with: its own folder and the installers' first, so
/// its `node` resolves.
pub(crate) fn claude_cli_path(cli: &str, environment: &AgentEnvironment) -> String {
    let platform = environment.platform;
    let separator = if platform == Platform::Windows {
        ";"
    } else {
        ":"
    };
    let mut seen = std::collections::HashSet::new();
    std::iter::once(dirname(platform, cli))
        .chain(
            claude_cli_candidates(environment)
                .iter()
                .map(|candidate| dirname(platform, candidate)),
        )
        .filter(|folder| seen.insert(folder.clone()))
        .collect::<Vec<_>>()
        .join(separator)
}

fn runnable(path: &str, platform: Platform) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    if platform != Platform::Windows {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    let _ = platform;
    true
}

pub(crate) fn find_claude_cli(
    environment: &AgentEnvironment,
    can_run: &dyn Fn(&str) -> bool,
) -> Option<String> {
    claude_cli_candidates(environment)
        .into_iter()
        .find(|candidate| can_run(candidate))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaudeCodeInstall {
    Added { cli: String },
    NoCli,
    Failed { cli: String },
}

/// `claude mcp remove` (an earlier videorc, which `add` would refuse), then
/// `claude mcp add --scope user videorc …`: the same command the dialog shows.
pub(crate) async fn add_to_claude_code(
    bridge_path: &str,
    token: &str,
    environment: &AgentEnvironment,
    can_run: &dyn Fn(&str) -> bool,
    run: &RunCli,
    log: &(dyn Fn(&str) + Sync),
) -> ClaudeCodeInstall {
    let Some(cli) = find_claude_cli(environment, can_run) else {
        return ClaudeCodeInstall::NoCli;
    };
    let path = claude_cli_path(&cli, environment);
    // Nothing to remove is the usual case.
    let _ = run(
        PathBuf::from(&cli),
        ["mcp", "remove", "--scope", "user", AGENT_SERVER_NAME]
            .map(str::to_string)
            .to_vec(),
        path.clone(),
        CLAUDE_CLI_REMOVE_TIMEOUT,
    )
    .await;
    match run(
        PathBuf::from(&cli),
        agent_claude_code_add_args(bridge_path, token),
        path,
        CLAUDE_CLI_ADD_TIMEOUT,
    )
    .await
    {
        Ok(()) => ClaudeCodeInstall::Added { cli },
        Err(failure) => {
            let stderr: String = failure.stderr.trim().chars().take(400).collect();
            log(&format!(
                "claude mcp add didn't finish{}{}",
                if failure.timed_out {
                    " (timed out)"
                } else {
                    ""
                },
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            ));
            ClaudeCodeInstall::Failed { cli }
        }
    }
}

pub(crate) fn claude_code_install_message(install: &ClaudeCodeInstall) -> &'static str {
    match install {
        ClaudeCodeInstall::Added { .. } => AgentAddApp::ClaudeCode.added_message(),
        ClaudeCodeInstall::NoCli => {
            "Videorc can't find Claude Code's claude command on this computer. Run the line in a terminal instead."
        }
        ClaudeCodeInstall::Failed { .. } => {
            "Claude Code didn't add Videorc. Run the line in a terminal instead."
        }
    }
}

// ---------------------------------------------------------------------------
// The RPC's one entry point
// ---------------------------------------------------------------------------

/// Everything `add_agent_to_app` reaches outside itself.
pub(crate) struct AddDeps<'a> {
    pub environment: AgentEnvironment,
    pub now: DateTime<Utc>,
    pub read_dir: &'a (dyn Fn(&str) -> io::Result<Vec<String>> + Sync),
    pub can_run: &'a (dyn Fn(&str) -> bool + Sync),
    pub run: &'a RunCli,
    pub log: &'a (dyn Fn(&str) + Sync),
}

/// Review #19: a line naming a disk image or macOS's temporary copy breaks
/// at the next launch, so nothing is written.
fn bridge_refusal(params: &AgentConfigAddParams) -> Option<AgentAddResult> {
    agent_bridge_runs_from_temporary_copy(&params.bridge_path).then(|| AgentAddResult {
        added: false,
        message: AGENT_BRIDGE_MOVE_FIRST.to_string(),
    })
}

/// A config app's file write, synchronous; None for Claude Code, which has
/// no file.
fn add_to_config_app(
    params: &AgentConfigAddParams,
    environment: &AgentEnvironment,
    now: DateTime<Utc>,
    read_dir: &dyn Fn(&str) -> io::Result<Vec<String>>,
    log: &dyn Fn(&str),
) -> Option<AgentAddResult> {
    if let Some(refusal) = bridge_refusal(params) {
        return Some(refusal);
    }
    let target = resolve_agent_config_target(params.app, environment, read_dir)?;
    let write = write_agent_config(
        &target,
        &params.bridge_path,
        &params.token,
        environment.platform,
        &WriteDeps {
            now,
            rename: &real_rename,
            log,
        },
    );
    Some(AgentAddResult {
        added: matches!(
            write,
            AgentConfigWrite::Added { .. } | AgentConfigWrite::Unchanged { .. }
        ),
        message: agent_config_write_message(params.app, &write),
    })
}

/// "Add to …": write the app's config (or run the CLI), and say what happened.
pub(crate) async fn add_agent_to_app(
    params: &AgentConfigAddParams,
    deps: &AddDeps<'_>,
) -> AgentAddResult {
    if let Some(refusal) = bridge_refusal(params) {
        return refusal;
    }
    if let Some(result) =
        add_to_config_app(params, &deps.environment, deps.now, deps.read_dir, deps.log)
    {
        return result;
    }
    let install = add_to_claude_code(
        &params.bridge_path,
        &params.token,
        &deps.environment,
        deps.can_run,
        deps.run,
        deps.log,
    )
    .await;
    AgentAddResult {
        added: matches!(install, ClaudeCodeInstall::Added { .. }),
        message: claude_code_install_message(&install).to_string(),
    }
}

fn log_agent_config(message: &str) {
    tracing::warn!("[agents] {message}");
}

/// `agents.config.add` with this process's environment, clock, file system
/// and `claude`. A config app's file work runs off the async workers.
pub(crate) async fn add_agent_to_app_for_rpc(params: AgentConfigAddParams) -> AgentAddResult {
    let platform = Platform::current();
    if params.app != AgentAddApp::ClaudeCode {
        let app = params.app;
        return tokio::task::spawn_blocking(move || {
            add_to_config_app(
                &params,
                &AgentEnvironment::from_process(),
                Utc::now(),
                &read_dir_names,
                &log_agent_config,
            )
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| AgentAddResult {
            added: false,
            message: format!(
                "Couldn't add Videorc to {}. Copy the line instead.",
                app.name()
            ),
        });
    }
    let can_run = move |path: &str| runnable(path, platform);
    add_agent_to_app(
        &params,
        &AddDeps {
            environment: AgentEnvironment::from_process(),
            now: Utc::now(),
            read_dir: &read_dir_names,
            can_run: &can_run,
            run: &run_cli,
            log: &log_agent_config,
        },
    )
    .await
}

#[cfg(test)]
mod tests;
