//! Plan 260 S2.5 (from plan 220 S2.5a): the smoke command server's security
//! rules over real loopback HTTP, mirroring `smoke-command-security.test.ts`:
//! it listens on loopback only, authenticates every request before routing
//! it (a missing or wrong bearer is a 401 and the command never runs),
//! answers Electron's status codes and JSON shapes, keeps a packaged harness
//! to its subset, and stays off without the switch.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use videorc_app_core::smoke::security::create_smoke_command_capability;
use videorc_app_core::smoke::{
    CommandFuture, PACKAGED_SMOKE_COMMAND_NAMES, SmokeCommandRunner, SmokeServer,
    SmokeServerOptions, SmokeSwitch,
};

type Calls = Arc<Mutex<Vec<(String, Map<String, Value>)>>>;

/// Records what reached it and accepts everything.
struct Recorder {
    calls: Calls,
}

impl SmokeCommandRunner for Recorder {
    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((command.to_string(), params));
            if command == "studio-record" {
                return Err("The backend refused the start.".to_string());
            }
            Ok(json!({ "accepted": true }))
        })
    }
}

async fn recorder_server(
    capability: &str,
    allowed_commands: Option<&'static [&'static str]>,
) -> (SmokeServer, Calls) {
    let calls: Calls = Arc::default();
    let server = SmokeServer::bind_loopback(
        SmokeServerOptions {
            capability: capability.to_string(),
            allowed_commands,
        },
        Arc::new(Recorder {
            calls: calls.clone(),
        }),
    )
    .await
    .expect("the server listens");
    (server, calls)
}

/// One request on its own connection; the status and the JSON body.
async fn send(address: SocketAddr, request: &[u8]) -> (u16, Value) {
    let mut stream = TcpStream::connect(address).await.expect("connect");
    stream.write_all(request).await.expect("write");
    let mut answer = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut answer))
        .await
        .expect("the server answers")
        .expect("read");
    let text = String::from_utf8(answer).expect("UTF-8");
    let (head, body) = text.split_once("\r\n\r\n").expect("a head and a body");
    let status: u16 = head
        .split(' ')
        .nth(1)
        .and_then(|status| status.parse().ok())
        .expect("a status");
    assert!(
        head.contains("Content-Type: application/json") && head.contains("Cache-Control: no-store"),
        "{head}"
    );
    (status, serde_json::from_str(body).expect("a JSON body"))
}

fn request(method: &str, path: &str, authorization: Option<&str>, body: Option<&str>) -> Vec<u8> {
    let mut text = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(authorization) = authorization {
        text.push_str(&format!("Authorization: {authorization}\r\n"));
    }
    if let Some(body) = body {
        text.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
    } else {
        text.push_str("\r\n");
    }
    text.into_bytes()
}

fn command(command: &str, params: Value) -> String {
    json!({ "command": command, "params": params }).to_string()
}

#[tokio::test]
async fn returns_401_before_routing_an_unauthenticated_request_and_400_for_malformed_json() {
    let capability = "test-capability";
    let bearer = format!("Bearer {capability}");
    let (server, calls) = recorder_server(capability, None).await;
    let address = server.local_addr();
    assert_eq!(address.ip(), Ipv4Addr::LOCALHOST);

    let open_tab = command("open-tab", json!({"tab": "studio"}));
    let (status, body) = send(address, &request("POST", "/command", None, Some(&open_tab))).await;
    assert_eq!(status, 401);
    assert_eq!(
        body,
        json!({"ok": false, "error": "Invalid smoke command capability."})
    );
    assert!(calls.lock().unwrap().is_empty());

    let (status, _) = send(address, &request("GET", "/health", None, None)).await;
    assert_eq!(status, 401);
    let (status, body) = send(address, &request("GET", "/health", Some(&bearer), None)).await;
    assert_eq!((status, body), (200, json!({"ok": true})));

    let (status, body) = send(
        address,
        &request("POST", "/command", Some(&bearer), Some("{")),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["ok"], json!(false));
    assert!(calls.lock().unwrap().is_empty());

    let (status, body) = send(
        address,
        &request("GET", "/preview-frame.png", Some(&bearer), None),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            404,
            json!({"ok": false, "error": "Unknown smoke endpoint."})
        )
    );
    let (status, _) = send(address, &request("GET", "/command", Some(&bearer), None)).await;
    assert_eq!(status, 404);

    let (status, body) = send(
        address,
        &request("POST", "/command", Some(&bearer), Some(&open_tab)),
    )
    .await;
    assert_eq!(
        (status, body),
        (200, json!({"ok": true, "result": {"accepted": true}}))
    );
    assert_eq!(
        calls.lock().unwrap().clone(),
        vec![(
            "open-tab".to_string(),
            json!({"tab": "studio"}).as_object().unwrap().clone()
        )]
    );

    // Unknown commands and malformed params get Electron's 400, never the
    // runner; a failing command is a 500 with its sentence.
    for refused in [
        command("totally-unknown", json!({})),
        command("open-tab", json!([])),
        command("open-tab", json!({"nested": {"constructor": "blocked"}})),
        "[]".to_string(),
    ] {
        let (status, body) = send(
            address,
            &request("POST", "/command", Some(&bearer), Some(&refused)),
        )
        .await;
        assert_eq!(
            (status, body),
            (
                400,
                json!({"ok": false, "error": "Invalid smoke command or parameters."})
            ),
            "{refused}"
        );
    }
    let (status, body) = send(
        address,
        &request(
            "POST",
            "/command",
            Some(&bearer),
            Some(&command("studio-record", json!({}))),
        ),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            500,
            json!({"ok": false, "error": "The backend refused the start."})
        )
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
    server.shutdown().await;
}

#[tokio::test]
async fn refuses_a_bad_or_missing_token_and_never_runs_the_command() {
    let capability = create_smoke_command_capability();
    let (server, calls) = recorder_server(&capability, None).await;
    let address = server.local_addr();
    let body = command("app-quit", json!({}));
    let wrong_same_length = create_smoke_command_capability();
    for authorization in [
        None,
        Some(String::new()),
        Some("Bearer".to_string()),
        Some("Bearer ".to_string()),
        Some(format!("Bearer {wrong_same_length}")),
        Some(format!("Bearer {}", &capability[..42])),
        Some(format!("Bearer {capability}x")),
        Some(format!("bearer {capability}")),
        Some(format!("Basic {capability}")),
        Some(capability.clone()),
    ] {
        let (status, answer) = send(
            address,
            &request("POST", "/command", authorization.as_deref(), Some(&body)),
        )
        .await;
        assert_eq!(status, 401, "{authorization:?}");
        assert_eq!(
            answer,
            json!({"ok": false, "error": "Invalid smoke command capability."})
        );
    }
    // The capability in the query string is not a bearer.
    let (status, _) = send(
        address,
        &request(
            "POST",
            &format!("/command?capability={capability}"),
            None,
            Some(&body),
        ),
    )
    .await;
    assert_eq!(status, 401);
    // Only the first Authorization header counts.
    let mut doubled = format!(
        "POST /command HTTP/1.1\r\nAuthorization: Bearer {wrong_same_length}\r\nAuthorization: Bearer {capability}\r\n"
    );
    doubled.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    let (status, _) = send(address, doubled.as_bytes()).await;
    assert_eq!(status, 401);
    assert!(calls.lock().unwrap().is_empty());

    // The right one runs it.
    let (status, _) = send(
        address,
        &request(
            "POST",
            "/command",
            Some(&format!("Bearer {capability}")),
            Some(&body),
        ),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(calls.lock().unwrap().len(), 1);
    server.shutdown().await;
}

#[tokio::test]
async fn refuses_non_loopback_addresses() {
    let options = SmokeServerOptions {
        capability: create_smoke_command_capability(),
        allowed_commands: None,
    };
    let runner = || -> Arc<dyn SmokeCommandRunner> {
        Arc::new(Recorder {
            calls: Arc::default(),
        })
    };
    for address in [
        SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)),
        SocketAddr::from((Ipv4Addr::new(192, 168, 1, 20), 0)),
        "[::]:0".parse().unwrap(),
    ] {
        let refused = SmokeServer::bind(address, options.clone(), runner()).await;
        let error = refused.err().expect("a non-loopback address is refused");
        assert!(error.to_string().contains("loopback only"), "{error}");
    }
    // And never without a capability.
    assert!(
        SmokeServer::bind_loopback(
            SmokeServerOptions {
                capability: String::new(),
                allowed_commands: None,
            },
            runner(),
        )
        .await
        .is_err()
    );
    let server = SmokeServer::bind_loopback(options, runner()).await.unwrap();
    assert_eq!(server.local_addr().ip(), Ipv4Addr::LOCALHOST);
    server.shutdown().await;
}

#[tokio::test]
async fn refuses_when_disabled() {
    // No switch, or a packaged app without its harness's capability: no
    // server at all.
    let none = |_: &str| None::<String>;
    assert_eq!(SmokeSwitch::resolve(none, false), None);
    assert_eq!(SmokeSwitch::resolve(none, true), None);
    assert_eq!(
        SmokeSwitch::resolve(
            |name| (name == "VIDEORC_SMOKE_COMMAND_SERVER").then(|| "1".to_string()),
            true
        ),
        None
    );

    // A stopped server takes no more connections.
    let capability = create_smoke_command_capability();
    let (server, calls) = recorder_server(&capability, None).await;
    let address = server.local_addr();
    server.shutdown().await;
    assert!(TcpStream::connect(address).await.is_err());
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn restricts_a_packaged_harness_to_the_preview_gate_subset() {
    let capability = "x".repeat(43);
    let bearer = format!("Bearer {capability}");
    let (server, calls) = recorder_server(&capability, Some(PACKAGED_SMOKE_COMMAND_NAMES)).await;
    let address = server.local_addr();
    for outside in [
        command(
            "authorize-smoke-resource",
            json!({"kind": "input-file", "path": "/tmp/fixture.png"}),
        ),
        command("studio-record", json!({})),
        command(
            "backend-debug-rpc",
            json!({"method": "diagnostics.stats", "params": {}}),
        ),
    ] {
        let (status, body) = send(
            address,
            &request("POST", "/command", Some(&bearer), Some(&outside)),
        )
        .await;
        assert_eq!(
            (status, body),
            (
                403,
                json!({"ok": false, "error": "Smoke command is unavailable in this mode."})
            ),
            "{outside}"
        );
    }
    assert!(calls.lock().unwrap().is_empty());
    let (status, _) = send(
        address,
        &request(
            "POST",
            "/command",
            Some(&bearer),
            Some(&command("app-quit", json!({}))),
        ),
    )
    .await;
    assert_eq!(status, 200);
    server.shutdown().await;
}

#[tokio::test]
async fn refuses_oversized_bodies_and_reads_chunked_ones() {
    let capability = create_smoke_command_capability();
    let bearer = format!("Bearer {capability}");
    let (server, calls) = recorder_server(&capability, None).await;
    let address = server.local_addr();

    let huge = format!(
        "{{\"command\":\"open-tab\",\"params\":{{\"pad\":\"{}\"}}}}",
        "x".repeat(1024 * 1024)
    );
    let (status, body) = send(
        address,
        &request("POST", "/command", Some(&bearer), Some(&huge)),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            413,
            json!({"ok": false, "error": "Smoke request body is too large."})
        )
    );

    let payload = command("open-tab", json!({"tab": "layout"}));
    let (first, second) = payload.split_at(10);
    let chunked = format!(
        "POST /command HTTP/1.1\r\nAuthorization: {bearer}\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{first}\r\n{:x}\r\n{second}\r\n0\r\n\r\n",
        first.len(),
        second.len()
    );
    let (status, _) = send(address, chunked.as_bytes()).await;
    assert_eq!(status, 200);
    // An empty body is `{}`, which names no command.
    let (status, _) = send(
        address,
        &request("POST", "/command", Some(&bearer), Some("")),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(calls.lock().unwrap().len(), 1);
    server.shutdown().await;
}
