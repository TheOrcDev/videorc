//! `videorc-mcp` (plan 209 S4): the stdio bridge agent apps run.
//!
//! Every MCP client speaks stdio, so this small binary ships inside the app
//! and turns stdio JSON-RPC into calls on the backend's Agents listener
//! (`http://127.0.0.1:<port>/mcp`, Bearer `VIDEORC_AGENT_TOKEN`). It answers
//! `initialize`, `ping` and `prompts/get` itself. `tools/list` and
//! `prompts/list` are the running app's own when its listener is up and
//! takes the token (review fix 22: a copy of the bridge outside the app, the
//! Claude Desktop extension or the Linux copy, may be older than the app);
//! otherwise they come from the compiled-in catalog and fixture (D7), so an
//! agent app never marks the server as failed and opening the agent app
//! never opens Videorc. The first `tools/call` with no listener
//! opens Videorc and waits up to 30 s; if Agents is off, the answer is
//! "Turn on Agents in Videorc → Settings → Remote."
//!
//! stdout is the protocol; everything else goes to stderr.

// The bridge needs the catalog and its MCP wire shape only; the validator and
// the notice helpers are the backend's.
#[allow(dead_code)]
#[path = "../agent_tools.rs"]
mod agent_tools;

// S22: the prompts are fixed text, so the bridge serves them itself.
#[allow(dead_code)]
#[path = "../agent_prompts.rs"]
mod agent_prompts;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// Newest first. A client naming one of these gets it back; any other
/// request is answered with the newest, as the spec asks.
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// The version the bridge speaks to the backend. rmcp negotiates any of
/// the list above; this one has stateless Streamable HTTP and JSON answers.
const BACKEND_PROTOCOL_VERSION: &str = "2025-06-18";
const DISCOVERY_PROTOCOL: u32 = 1;
const OPEN_WAIT: Duration = Duration::from_secs(30);
const OPEN_POLL: Duration = Duration::from_millis(500);
/// A call waits a little longer than the backend's longest Studio timeout
/// (`go_live`, 60 s).
const CALL_TIMEOUT: Duration = Duration::from_secs(75);
/// Presence for the Session line: the backend counts an agent as connected
/// for 45 s after its last call or heartbeat.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// A running app whose port refused a connection gets this long to come
/// back (review fix 16).
const REFUSED_WAIT: Duration = Duration::from_secs(5);
/// `tools/list` from the app answers fast or falls back to the catalog.
const LIST_TIMEOUT: Duration = Duration::from_secs(3);
const MACOS_BUNDLE_ID: &str = "dev.theorcdev.videorc";

const TURN_ON_AGENTS: &str = "Turn on Agents in Videorc → Settings → Remote.";
const NO_TOKEN: &str =
    "Set VIDEORC_AGENT_TOKEN to the token Videorc showed in Settings → Remote → Agents.";
const BAD_TOKEN: &str = "That agent token isn't valid anymore. Connect the agent again in Videorc → Settings → Remote → Agents.";
const DID_NOT_OPEN: &str = "Videorc didn't open. Open it yourself, then try again.";
const NO_ANSWER: &str = "Videorc didn't answer in time.";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    protocol: u32,
    pid: u32,
    enabled: bool,
    #[serde(default)]
    port: Option<u16>,
}

/// Where the backend keeps `agents.json`: beside its database, or wherever
/// `VIDEORC_AGENTS_DISCOVERY` points (smokes).
fn discovery_path(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(custom) = env("VIDEORC_AGENTS_DISCOVERY") {
        return PathBuf::from(custom);
    }
    database_path(env, home).with_file_name("agents.json")
}

/// The same resolution as the backend's `default_database_path`.
fn database_path(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(custom) = env("VIDEORC_DATABASE_PATH") {
        return PathBuf::from(custom);
    }
    if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Videorc")
            .join("videorc.sqlite3")
    } else if cfg!(target_os = "windows") {
        env("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Videorc")
            .join("videorc.sqlite3")
    } else {
        home.join(".videorc").join("videorc.sqlite3")
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_discovery(path: &Path) -> Option<Discovery> {
    let raw = std::fs::read(path).ok()?;
    let discovery: Discovery = serde_json::from_slice(&raw).ok()?;
    (discovery.protocol == DISCOVERY_PROTOCOL).then_some(discovery)
}

/// A file left behind by a crash names a pid that is gone.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: kill with signal 0 probes the pid and sends nothing.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    // The backend rewrites the file at every start and removes it at
    // shutdown; only a crash leaves a stale one, and the port check below
    // catches that case for an enabled file.
    true
}

/// Whether something takes connections on this loopback port now.
async fn port_accepts(port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|connected| connected.is_ok())
}

fn log(message: impl AsRef<str>) {
    eprintln!("videorc-mcp: {}", message.as_ref());
}

fn debug(message: impl AsRef<str>) {
    if env_var("VIDEORC_MCP_DEBUG").is_some() {
        eprintln!("videorc-mcp: {}", message.as_ref());
    }
}

// ---------------------------------------------------------------------------
// Answers the bridge gives itself
// ---------------------------------------------------------------------------

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|wanted| {
            SUPPORTED_PROTOCOL_VERSIONS
                .iter()
                .find(|known| **known == wanted)
        })
        .copied()
        .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0])
}

fn initialize_result(params: &Value) -> Value {
    let catalog = agent_tools::catalog();
    json!({
        "protocolVersion": negotiate_protocol_version(params.get("protocolVersion").and_then(Value::as_str)),
        "capabilities": { "tools": {}, "prompts": {} },
        "serverInfo": {
            "name": catalog.server_name,
            "title": catalog.server_title,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": catalog.instructions,
    })
}

fn tools_list_result() -> Value {
    json!({ "tools": agent_tools::catalog().mcp_tools() })
}

fn prompts_list_result() -> Value {
    json!({ "prompts": agent_prompts::prompts().mcp_prompts() })
}

/// A prompt is fixed text: answered here, with Videorc open or closed, and
/// without a token (it reads nothing from Videorc).
fn prompts_get_answer(id: &Value, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    match agent_prompts::prompts().prompt(name) {
        Some(prompt) => response(id, prompt.mcp_get_result()),
        None => error_response(id, -32602, &agent_prompts::unknown_prompt(name)),
    }
}

/// A refusal the agent reads: a tool result with `isError`, never a
/// protocol error (clients render those opaquely).
fn refusal(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The `data:` payloads of an SSE body, for the rare answer rmcp streams.
fn sse_data_lines(body: &str) -> Vec<String> {
    let mut events = Vec::new();
    let mut current = String::new();
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(data.trim_start());
        } else if line.is_empty() && !current.is_empty() {
            events.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        events.push(current);
    }
    events
}

/// The JSON-RPC message answering `id` in a JSON or SSE body.
fn answer_in_body(content_type: &str, body: &str, id: &Value) -> Option<Value> {
    if content_type.starts_with("text/event-stream") {
        sse_data_lines(body)
            .iter()
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|message| message.get("id") == Some(id))
    } else {
        serde_json::from_str::<Value>(body)
            .ok()
            .filter(|message| message.get("id") == Some(id))
    }
}

// ---------------------------------------------------------------------------
// Reaching the backend
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Reach {
    /// The listener is up on this port.
    Port(u16),
    /// Videorc runs with Agents off.
    AgentsOff,
    /// Nothing is running (or the file is stale).
    NotRunning,
}

fn reach(path: &Path) -> Reach {
    match read_discovery(path) {
        Some(discovery) if process_alive(discovery.pid) => {
            match (discovery.enabled, discovery.port) {
                (true, Some(port)) => Reach::Port(port),
                (true, None) | (false, _) => Reach::AgentsOff,
            }
        }
        _ => Reach::NotRunning,
    }
}

/// The file Videorc writes beside its per-user copy of the bridge on
/// Windows (`%LOCALAPPDATA%\\Videorc\\bin\\`, review fix 8): the first line
/// is the Videorc.exe that wrote it, wherever it was installed.
const WINDOWS_APP_POINTER: &str = "videorc-app-path.txt";

/// The Videorc.exe a pointer file names, from its first line.
fn app_pointer_target(text: &str) -> Option<PathBuf> {
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
}

/// Windows: the Videorc.exe named beside this bridge (Videorc's own copy in
/// `%LOCALAPPDATA%\\Videorc\\bin\\`), the install this bridge sits in
/// (`<install>\\resources\\`), else the default per-user install, for a copy
/// outside it (S22: the Claude Desktop extension unpacks the bridge into
/// Claude's own folder).
fn windows_videorc_exe(
    bridge: Option<&Path>,
    local_app_data: Option<&str>,
    exists: &dyn Fn(&Path) -> bool,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Option<PathBuf> {
    let named = bridge
        .and_then(Path::parent)
        .and_then(|folder| read(&folder.join(WINDOWS_APP_POINTER)))
        .and_then(|text| app_pointer_target(&text));
    let beside = bridge
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|install| install.join("Videorc.exe"));
    let installed = local_app_data.map(|folder| {
        PathBuf::from(folder)
            .join("Programs")
            .join("Videorc")
            .join("Videorc.exe")
    });
    [named, beside, installed]
        .into_iter()
        .flatten()
        .find(|exe| exists(exe))
}

/// Open Videorc in the background (D7). macOS by bundle id, Windows the exe
/// beside this bridge's `resources` folder, Linux per D20.
fn open_videorc() -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("open");
        command.args(["-g", "-b", MACOS_BUNDLE_ID]);
        command
    } else if cfg!(target_os = "windows") {
        let exe = windows_videorc_exe(
            std::env::current_exe().ok().as_deref(),
            env_var("LOCALAPPDATA").as_deref(),
            &|path| path.exists(),
            &|path| std::fs::read_to_string(path).ok(),
        )
        .ok_or_else(|| "Videorc.exe isn't beside this bridge.".to_string())?;
        std::process::Command::new(exe)
    } else {
        let launcher = env_var("VIDEORC_APP_PATH")
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .or_else(|| {
                let copy = home_dir()
                    .join(".local")
                    .join("share")
                    .join("videorc")
                    .join("bin")
                    .join("videorc");
                copy.exists().then_some(copy)
            })
            .unwrap_or_else(|| PathBuf::from("videorc"));
        std::process::Command::new(launcher)
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Couldn't open Videorc: {error}"))
}

struct Bridge {
    client: reqwest::Client,
    discovery: PathBuf,
    token: Option<String>,
    /// Started after the first call that reached the listener.
    heartbeat: tokio::sync::Mutex<bool>,
}

impl Bridge {
    /// Find the listener, opening Videorc and waiting when it is not there.
    async fn find_port(&self) -> Result<u16, String> {
        match reach(&self.discovery) {
            Reach::Port(port) => return Ok(port),
            Reach::AgentsOff => return Err(TURN_ON_AGENTS.to_string()),
            Reach::NotRunning => {}
        }
        log("Videorc isn't running; opening it.");
        open_videorc()?;
        let deadline = Instant::now() + OPEN_WAIT;
        while Instant::now() < deadline {
            tokio::time::sleep(OPEN_POLL).await;
            match reach(&self.discovery) {
                Reach::Port(port) => return Ok(port),
                Reach::AgentsOff => return Err(TURN_ON_AGENTS.to_string()),
                Reach::NotRunning => {}
            }
        }
        Err(DID_NOT_OPEN.to_string())
    }

    /// The port refused a connection. The discovery file is the app's, so
    /// it is never deleted (review fix 16): it is read again until it names
    /// another port, or the same port takes connections again. Videorc is
    /// opened only when nothing that wrote it still runs (a crash, or a
    /// Windows host, where the bridge can't tell).
    async fn find_port_after_refusal(&self, refused: u16) -> Result<u16, String> {
        let mut opened = false;
        let mut deadline = Instant::now() + OPEN_WAIT;
        loop {
            match read_discovery(&self.discovery) {
                Some(discovery) if !discovery.enabled => return Err(TURN_ON_AGENTS.to_string()),
                Some(discovery) if process_alive(discovery.pid) => match discovery.port {
                    Some(port) if port != refused => return Ok(port),
                    Some(port) if port_accepts(port).await => return Ok(port),
                    _ if cfg!(unix) && !opened => {
                        // The app runs: its listener is restarting or
                        // closing. Give it a moment, without opening it.
                        deadline = deadline.min(Instant::now() + REFUSED_WAIT);
                    }
                    _ => {}
                },
                _ => {}
            }
            let running_here = cfg!(unix)
                && read_discovery(&self.discovery)
                    .is_some_and(|discovery| process_alive(discovery.pid));
            if !opened && !running_here {
                log("Videorc's listener is gone; opening Videorc.");
                open_videorc()?;
                opened = true;
                deadline = Instant::now() + OPEN_WAIT;
            }
            if Instant::now() >= deadline {
                return Err(if opened {
                    DID_NOT_OPEN.to_string()
                } else {
                    TURN_ON_AGENTS.to_string()
                });
            }
            tokio::time::sleep(OPEN_POLL).await;
        }
    }

    /// Review fix 22: `tools/list` and `prompts/list` from the running app
    /// when its listener is up and takes the token, never opening it; the
    /// compiled-in answer otherwise.
    async fn list_from_app(&self, request: &Value) -> Option<Value> {
        let token = self.token.as_deref()?;
        let Reach::Port(port) = reach(&self.discovery) else {
            return None;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let http = self
            .client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", BACKEND_PROTOCOL_VERSION)
            .bearer_auth(token)
            .timeout(LIST_TIMEOUT)
            .body(request.to_string())
            .send()
            .await
            .ok()?;
        if !http.status().is_success() {
            return None;
        }
        let content_type = http
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = http.text().await.ok()?;
        answer_in_body(&content_type, &body, &id).filter(|message| message.get("result").is_some())
    }

    async fn post(
        &self,
        port: u16,
        token: &str,
        message: &Value,
    ) -> Result<reqwest::Response, String> {
        self.client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", BACKEND_PROTOCOL_VERSION)
            .bearer_auth(token)
            .timeout(CALL_TIMEOUT)
            .body(message.to_string())
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    "connect".to_string()
                } else if error.is_timeout() {
                    NO_ANSWER.to_string()
                } else {
                    format!("Couldn't reach Videorc: {error}")
                }
            })
    }

    /// Forward one request and return the JSON-RPC message to write back.
    async fn forward(self: &Arc<Self>, request: Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let Some(token) = self.token.clone() else {
            return response(&id, refusal(NO_TOKEN));
        };
        let mut port = match self.find_port().await {
            Ok(port) => port,
            Err(sentence) => return response(&id, refusal(&sentence)),
        };
        let mut attempts = 0;
        loop {
            attempts += 1;
            let answer = self.post(port, &token, &request).await;
            match answer {
                Ok(http) => {
                    let status = http.status();
                    if status == reqwest::StatusCode::UNAUTHORIZED {
                        return response(&id, refusal(BAD_TOKEN));
                    }
                    // Agents was turned off while this connection was open.
                    if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                        return response(&id, refusal(TURN_ON_AGENTS));
                    }
                    let content_type = http
                        .headers()
                        .get("content-type")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let body = http.text().await.unwrap_or_default();
                    if !status.is_success() {
                        return response(
                            &id,
                            refusal(&format!("Videorc answered {}.", status.as_u16())),
                        );
                    }
                    self.start_heartbeat(port, token.clone()).await;
                    return match answer_in_body(&content_type, &body, &id) {
                        Some(message) => message,
                        None => response(&id, refusal(NO_ANSWER)),
                    };
                }
                Err(reason) if reason == "connect" && attempts == 1 => {
                    // The port is gone: read the app's file again (never
                    // delete it), opening Videorc only if it isn't running.
                    debug("the listener refused the connection");
                    port = match self.find_port_after_refusal(port).await {
                        Ok(port) => port,
                        Err(sentence) => return response(&id, refusal(&sentence)),
                    };
                }
                Err(reason) if reason == "connect" => {
                    return response(&id, refusal(TURN_ON_AGENTS));
                }
                Err(sentence) => return response(&id, refusal(&sentence)),
            }
        }
    }

    /// Presence for the Session line: a ping every 15 s while the agent app
    /// keeps this bridge alive. Stops quietly when the listener goes away.
    async fn start_heartbeat(self: &Arc<Self>, port: u16, token: String) {
        let mut started = self.heartbeat.lock().await;
        if *started {
            return;
        }
        *started = true;
        let bridge = self.clone();
        tokio::spawn(async move {
            let mut sequence = 0_u64;
            loop {
                tokio::time::sleep(HEARTBEAT).await;
                sequence += 1;
                let ping =
                    json!({ "jsonrpc": "2.0", "id": format!("hb-{sequence}"), "method": "ping" });
                let port = match reach(&bridge.discovery) {
                    Reach::Port(port) => port,
                    _ => port,
                };
                if let Err(reason) = bridge.post(port, &token, &ping).await {
                    debug(format!("heartbeat skipped: {reason}"));
                }
            }
        });
    }
}

async fn handle(bridge: Arc<Bridge>, message: Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match (id, method) {
        // Notifications get no answer.
        (None, _) => None,
        (Some(id), "initialize") => Some(response(&id, initialize_result(&params))),
        (Some(id), "ping") => Some(response(&id, json!({}))),
        (Some(id), "tools/list") => Some(match bridge.list_from_app(&message).await {
            Some(answer) => answer,
            None => response(&id, tools_list_result()),
        }),
        (Some(id), "prompts/list") => Some(match bridge.list_from_app(&message).await {
            Some(answer) => answer,
            None => response(&id, prompts_list_result()),
        }),
        (Some(id), "prompts/get") => Some(prompts_get_answer(&id, &params)),
        (Some(_), "tools/call") => Some(bridge.forward(message).await),
        (Some(id), "") => Some(error_response(&id, -32600, "Invalid request: no method.")),
        (Some(id), other) => Some(error_response(
            &id,
            -32601,
            &format!("Videorc's bridge doesn't know `{other}`."),
        )),
    }
}

#[tokio::main]
async fn main() {
    let bridge = Arc::new(Bridge {
        client: reqwest::Client::new(),
        discovery: discovery_path(&env_var, &home_dir()),
        token: env_var("VIDEORC_AGENT_TOKEN"),
        heartbeat: tokio::sync::Mutex::new(false),
    });
    if bridge.token.is_none() {
        log(NO_TOKEN);
    }
    debug(format!("discovery file: {}", bridge.discovery.display()));

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = out_rx.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => {
                let _ = out_tx.send(error_response(
                    &Value::Null,
                    -32700,
                    &format!("Parse error: {error}"),
                ));
                continue;
            }
        };
        // Each request runs on its own task: a long go_live must not hold a
        // get_status back.
        let bridge = bridge.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            if let Some(answer) = handle(bridge, message).await {
                let _ = out_tx.send(answer);
            }
        });
    }
    drop(out_tx);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_and_tools_list_answer_from_the_catalog() {
        let result = initialize_result(&json!({ "protocolVersion": "2025-06-18" }));
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"]["name"], "videorc");
        assert_eq!(result["capabilities"]["tools"], json!({}));
        assert_eq!(result["capabilities"]["prompts"], json!({}));
        assert_eq!(result["instructions"], agent_tools::catalog().instructions);
        assert_eq!(
            initialize_result(&json!({ "protocolVersion": "2030-01-01" }))["protocolVersion"],
            SUPPORTED_PROTOCOL_VERSIONS[0]
        );
        assert_eq!(
            initialize_result(&json!({}))["protocolVersion"],
            SUPPORTED_PROTOCOL_VERSIONS[0]
        );
        assert_eq!(
            tools_list_result()["tools"],
            Value::Array(agent_tools::catalog().mcp_tools())
        );
    }

    #[test]
    fn discovery_path_follows_the_backend_and_the_override() {
        let home = Path::new("/home/streamer");
        let none = |_: &str| None::<String>;
        let path = discovery_path(&none, home);
        assert!(path.ends_with("agents.json"));
        if cfg!(target_os = "macos") {
            assert_eq!(
                path,
                Path::new("/home/streamer/Library/Application Support/Videorc/agents.json")
            );
        }
        let custom =
            |name: &str| (name == "VIDEORC_DATABASE_PATH").then(|| "/data/db.sqlite3".to_string());
        assert_eq!(
            discovery_path(&custom, home),
            Path::new("/data/agents.json")
        );
        let direct = |name: &str| {
            (name == "VIDEORC_AGENTS_DISCOVERY").then(|| "/tmp/x/agents.json".to_string())
        };
        assert_eq!(
            discovery_path(&direct, home),
            Path::new("/tmp/x/agents.json")
        );
    }

    #[test]
    fn reach_reads_the_discovery_file_and_ignores_a_dead_pid() {
        let dir = std::env::temp_dir().join(format!("videorc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.json");
        assert!(matches!(reach(&path), Reach::NotRunning));
        let me = std::process::id();
        std::fs::write(
            &path,
            json!({ "protocol": 1, "pid": me, "enabled": true, "port": 7441 }).to_string(),
        )
        .unwrap();
        assert!(matches!(reach(&path), Reach::Port(7441)));
        std::fs::write(
            &path,
            json!({ "protocol": 1, "pid": me, "enabled": false }).to_string(),
        )
        .unwrap();
        assert!(matches!(reach(&path), Reach::AgentsOff));
        std::fs::write(
            &path,
            json!({ "protocol": 2, "pid": me, "enabled": true, "port": 7441 }).to_string(),
        )
        .unwrap();
        assert!(
            matches!(reach(&path), Reach::NotRunning),
            "a future protocol is unknown"
        );
        #[cfg(unix)]
        {
            std::fs::write(
                &path,
                json!({ "protocol": 1, "pid": 4_000_000, "enabled": true, "port": 7441 })
                    .to_string(),
            )
            .unwrap();
            assert!(
                matches!(reach(&path), Reach::NotRunning),
                "a crash leaves a dead pid"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_finds_videorc_beside_the_bridge_or_in_the_default_install() {
        let bridge = Path::new("/install/resources/videorc-mcp.exe");
        let beside = Path::new("/install").join("Videorc.exe");
        let default = PathBuf::from("/local")
            .join("Programs")
            .join("Videorc")
            .join("Videorc.exe");
        let only = |wanted: PathBuf| move |path: &Path| path == wanted.as_path();
        let nothing = |_: &Path| None;
        assert_eq!(
            windows_videorc_exe(
                Some(bridge),
                Some("/local"),
                &only(beside.clone()),
                &nothing
            ),
            Some(beside.clone())
        );
        // The extension's copy lives in Claude's folder: the default install.
        let extension = Path::new("/claude/extensions/videorc/server/videorc-mcp.exe");
        assert_eq!(
            windows_videorc_exe(
                Some(extension),
                Some("/local"),
                &only(default.clone()),
                &nothing
            ),
            Some(default.clone())
        );
        assert_eq!(
            windows_videorc_exe(Some(extension), None, &|_| false, &nothing),
            None
        );
        // Review fix 8: Videorc's own copy outside the install names the
        // exe that wrote it, wherever that was installed.
        let copy = Path::new("/local/Videorc/bin/videorc-mcp.exe");
        let custom = PathBuf::from("D:/Apps/Videorc/Videorc.exe");
        let pointer = |path: &Path| {
            (path == Path::new("/local/Videorc/bin").join(WINDOWS_APP_POINTER))
                .then(|| "D:/Apps/Videorc/Videorc.exe\r\n".to_string())
        };
        assert_eq!(
            windows_videorc_exe(Some(copy), Some("/local"), &only(custom.clone()), &pointer),
            Some(custom)
        );
        // A pointer to an exe that is gone falls back to the default install.
        assert_eq!(
            windows_videorc_exe(Some(copy), Some("/local"), &only(default.clone()), &pointer),
            Some(default)
        );
        assert_eq!(app_pointer_target("  \n"), None);
    }

    #[test]
    fn answers_are_read_from_json_and_sse_bodies() {
        let id = json!(7);
        let body = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        assert_eq!(
            answer_in_body("application/json", body, &id).unwrap()["result"]["ok"],
            true
        );
        assert!(answer_in_body("application/json", body, &json!(8)).is_none());
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":1}}\n\n";
        assert_eq!(
            answer_in_body("text/event-stream; charset=utf-8", sse, &id).unwrap()["result"]["ok"],
            1
        );
        assert_eq!(
            sse_data_lines("data: a\ndata: b\n\ndata: c"),
            vec!["a\nb", "c"]
        );
        let refused = refusal(TURN_ON_AGENTS);
        assert_eq!(refused["isError"], true);
        assert_eq!(refused["content"][0]["text"], TURN_ON_AGENTS);
    }

    #[tokio::test]
    async fn the_bridge_answers_offline_and_forwards_calls() {
        let bridge = Arc::new(Bridge {
            client: reqwest::Client::new(),
            discovery: PathBuf::from("/nonexistent/agents.json"),
            token: None,
            heartbeat: tokio::sync::Mutex::new(false),
        });
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-03-26");
        assert!(
            handle(
                bridge.clone(),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .await
            .is_none()
        );
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await
        .unwrap();
        assert_eq!(
            answer["result"]["tools"].as_array().unwrap().len(),
            agent_tools::catalog().tools.len()
        );
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }),
        )
        .await
        .unwrap();
        assert_eq!(answer["error"]["code"], -32601);
        // S22: the prompts answer offline and without a token.
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 30, "method": "prompts/list" }),
        )
        .await
        .unwrap();
        assert_eq!(
            answer["result"]["prompts"],
            Value::Array(agent_prompts::prompts().mcp_prompts())
        );
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 31, "method": "prompts/get", "params": { "name": "go_live_checklist" } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["id"], 31);
        assert_eq!(
            answer["result"],
            agent_prompts::prompts()
                .prompt("go_live_checklist")
                .unwrap()
                .mcp_get_result()
        );
        let answer = handle(
            bridge.clone(),
            json!({ "jsonrpc": "2.0", "id": 32, "method": "prompts/get", "params": { "name": "nope" } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["error"]["code"], -32602);
        assert_eq!(
            answer["error"]["message"],
            agent_prompts::unknown_prompt("nope")
        );
        // No token: the call is refused in the agent's words, without
        // opening anything.
        let answer = handle(
            bridge,
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "notify", "arguments": { "message": "hi" } } }),
        )
        .await
        .unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], NO_TOKEN);

        // A fake listener: the call is forwarded with the Bearer token and
        // the answer comes back as is; 401 becomes the token sentence.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/mcp",
            axum::routing::post(
                |headers: axum::http::HeaderMap, body: String| async move {
                    let request: Value = serde_json::from_str(&body).unwrap();
                    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
                    if auth != "Bearer vrc_agent_good" {
                        return (axum::http::StatusCode::UNAUTHORIZED, String::new());
                    }
                    assert_eq!(headers["mcp-protocol-version"], BACKEND_PROTOCOL_VERSION);
                    (
                        axum::http::StatusCode::OK,
                        json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "content": [{ "type": "text", "text": "Done." }], "isError": false } })
                            .to_string(),
                    )
                },
            ),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let dir = std::env::temp_dir().join(format!("videorc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let discovery = dir.join("agents.json");
        std::fs::write(
            &discovery,
            json!({ "protocol": 1, "pid": std::process::id(), "enabled": true, "port": port })
                .to_string(),
        )
        .unwrap();
        let call = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "notify", "arguments": { "message": "hi" } } });
        let good = Arc::new(Bridge {
            client: reqwest::Client::new(),
            discovery: discovery.clone(),
            token: Some("vrc_agent_good".to_string()),
            heartbeat: tokio::sync::Mutex::new(true),
        });
        let answer = handle(good.clone(), call.clone()).await.unwrap();
        assert_eq!(answer["id"], 5);
        assert_eq!(answer["result"]["content"][0]["text"], "Done.");
        // Review fix 22: with the app up and the token taken, the lists are
        // the app's own (the fake answers every request with its result).
        let listed = handle(
            good,
            json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }),
        )
        .await
        .unwrap();
        assert_eq!(listed["id"], 6);
        assert_eq!(listed["result"]["content"][0]["text"], "Done.");
        let bad = Arc::new(Bridge {
            client: reqwest::Client::new(),
            discovery: discovery.clone(),
            token: Some("vrc_agent_bad".to_string()),
            heartbeat: tokio::sync::Mutex::new(true),
        });
        let answer = handle(bad.clone(), call.clone()).await.unwrap();
        assert_eq!(answer["result"]["content"][0]["text"], BAD_TOKEN);
        // A token the app refuses: the compiled catalog, as offline.
        let listed = handle(
            bad,
            json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }),
        )
        .await
        .unwrap();
        assert_eq!(
            listed["result"]["tools"].as_array().unwrap().len(),
            agent_tools::catalog().tools.len()
        );
        // Agents off: the sentence, at once.
        std::fs::write(
            &discovery,
            json!({ "protocol": 1, "pid": std::process::id(), "enabled": false }).to_string(),
        )
        .unwrap();
        let off = Arc::new(Bridge {
            client: reqwest::Client::new(),
            discovery: discovery.clone(),
            token: Some("vrc_agent_good".to_string()),
            heartbeat: tokio::sync::Mutex::new(true),
        });
        let answer = handle(off, call.clone()).await.unwrap();
        assert_eq!(answer["result"]["content"][0]["text"], TURN_ON_AGENTS);

        // Review fix 16: a port that refuses never deletes the app's file.
        // The app (this test's pid) still runs, so the bridge reads the file
        // again instead of opening Videorc, and answers once it gives up.
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        std::fs::write(
            &discovery,
            json!({ "protocol": 1, "pid": std::process::id(), "enabled": true, "port": closed })
                .to_string(),
        )
        .unwrap();
        let refused = Arc::new(Bridge {
            client: reqwest::Client::new(),
            discovery: discovery.clone(),
            token: Some("vrc_agent_good".to_string()),
            heartbeat: tokio::sync::Mutex::new(true),
        });
        // Agents goes off while the bridge waits: that sentence, and the
        // file is still the app's.
        let writer = {
            let discovery = discovery.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                std::fs::write(
                    &discovery,
                    json!({ "protocol": 1, "pid": std::process::id(), "enabled": false })
                        .to_string(),
                )
                .unwrap();
            })
        };
        let answer = handle(refused, call).await.unwrap();
        writer.await.unwrap();
        assert_eq!(answer["result"]["content"][0]["text"], TURN_ON_AGENTS);
        assert!(discovery.exists(), "the app's discovery file stays");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
