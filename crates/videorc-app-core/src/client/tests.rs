//! The client against a scripted WebSocket server that speaks the backend's
//! envelope: reconnection, the filter on every connection, unknown and
//! unreadable events, and the request failure codes. The real backend is in
//! `tests/typed_client.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use super::methods::HealthPing;
use super::*;
use crate::process::{BackendBootstrap, Credential};
use crate::supervisor::BackendState;

const TOKEN: &str = "11111111-2222-3333-4444-555555555555";
const ADMIN: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WAIT: Duration = Duration::from_secs(5);

enum Action {
    Send(String),
    Close,
}

/// One scripted backend: every connection gets `backend.ready`, then each
/// command is recorded as `(connection, command)` and answered, except
/// `never.answers`.
struct FakeBackend {
    port: u16,
    commands: mpsc::UnboundedReceiver<(usize, Value)>,
    current: Arc<Mutex<Option<mpsc::UnboundedSender<Action>>>>,
}

impl FakeBackend {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let current: Arc<Mutex<Option<mpsc::UnboundedSender<Action>>>> = Arc::default();
        let slot = current.clone();
        tokio::spawn(async move {
            let mut index = 0;
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else {
                    continue;
                };
                index += 1;
                let (actions_tx, actions) = mpsc::unbounded_channel();
                *slot.lock().unwrap() = Some(actions_tx);
                tokio::spawn(serve(socket, index, port, commands_tx.clone(), actions));
            }
        });
        Self {
            port,
            commands,
            current,
        }
    }

    fn bootstrap(&self) -> BackendBootstrap {
        BackendBootstrap {
            host: "127.0.0.1".to_string(),
            port: self.port,
            token: TOKEN.to_string(),
            admin_token: ADMIN.to_string(),
            pid: 4242,
            parent_pid: None,
            managed_asset_roots: None,
        }
    }

    fn act(&self, action: Action) {
        let current = self.current.lock().unwrap();
        current
            .as_ref()
            .expect("a connection is open")
            .send(action)
            .unwrap();
    }

    fn send_event(&self, event: &str, payload: Value) {
        self.act(Action::Send(
            json!({"event": event, "payload": payload}).to_string(),
        ));
    }

    async fn next_command(&mut self) -> (usize, Value) {
        tokio::time::timeout(WAIT, self.commands.recv())
            .await
            .expect("a command within the wait")
            .expect("the server is alive")
    }
}

async fn serve(
    socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    index: usize,
    port: u16,
    commands: mpsc::UnboundedSender<(usize, Value)>,
    mut actions: mpsc::UnboundedReceiver<Action>,
) {
    let (mut sink, mut source) = socket.split();
    let ready = json!({
        "event": "backend.ready",
        "payload": {"host": "127.0.0.1", "port": port, "token": TOKEN, "pid": 4242}
    });
    if sink.send(Message::text(ready.to_string())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            message = source.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let command: Value = serde_json::from_str(text.as_str()).unwrap();
                    let _ = commands.send((index, command.clone()));
                    let method = command["method"].as_str().unwrap_or_default();
                    let mut events: Vec<String> = command["params"]["events"]
                        .as_array()
                        .map(|events| events.iter().filter_map(|e| e.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    events.sort();
                    let payload = match method {
                        "never.answers" => continue,
                        "events.setIncluded" => json!({"included": events}),
                        "events.setExcluded" => json!({"excluded": events}),
                        // The connection's index rides in `version`, so a
                        // test can tell which connection answered.
                        "health.ping" => json!({
                            "status": "ok",
                            "version": format!("connection-{index}"),
                            "platform": "macos",
                            "ffmpeg": {"path": "ffmpeg", "available": true},
                            "databasePath": "/tmp/videorc.sqlite3",
                            "secretStoreBackend": "file"
                        }),
                        "refuse" => {
                            let reply = json!({"id": command["id"], "ok": false, "error": {"code": "forbidden-method", "message": "No."}});
                            let _ = sink.send(Message::text(reply.to_string())).await;
                            continue;
                        }
                        _ => Value::Null,
                    };
                    let reply = json!({"id": command["id"], "ok": true, "payload": payload});
                    if sink.send(Message::text(reply.to_string())).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            action = actions.recv() => match action {
                Some(Action::Send(text)) => {
                    if sink.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Some(Action::Close) | None => {
                    let _ = sink.close().await;
                    break;
                }
            },
        }
    }
}

fn ready_state(fake: &FakeBackend, generation: u32) -> BackendState {
    BackendState::Ready {
        generation,
        bootstrap: fake.bootstrap(),
    }
}

async fn next_event(events: &mut broadcast::Receiver<BackendEvent>) -> BackendEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event within the wait")
        .expect("the client is alive")
}

fn config(filter: EventFilter, logger: Logger) -> ClientConfig {
    ClientConfig {
        filter,
        ready_timeout: WAIT,
        reconnect_delay: Duration::from_millis(50),
        logger,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_socket_reconnects_and_reapplies_the_filter() {
    let mut fake = FakeBackend::start().await;
    let (_backend_tx, backend) = watch::channel(ready_state(&fake, 1));
    let filter = EventFilter::include([names::RECORDING_STATUS, names::SCENE_CHANGED]);
    let (client, mut events) = BackendClient::start(backend, config(filter, Logger::silent()));

    let ready = client.wait_connected(WAIT).await.unwrap();
    assert_eq!(ready.port, fake.port);
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::Ready(_)
    ));
    let (connection, command) = fake.next_command().await;
    assert_eq!(connection, 1);
    assert_eq!(command["method"], "events.setIncluded");
    assert_eq!(
        command["params"]["events"],
        json!(["recording.status", "scene.changed"])
    );

    // The backend closes the socket; the backend itself is still "ready".
    fake.act(Action::Close);
    let BackendEvent::ConnectionClosed { reason } = next_event(&mut events).await else {
        panic!("expected ConnectionClosed");
    };
    assert!(reason.contains("closed"), "{reason}");

    // A new connection, the filter sent again, Ready again.
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::Ready(_)
    ));
    let (connection, command) = fake.next_command().await;
    assert_eq!(connection, 2);
    assert_eq!(command["method"], "events.setIncluded");
    assert!(client.current_state().is_connected());

    let health = client.call::<HealthPing>(&()).await.unwrap();
    assert_eq!(
        health.version, "connection-2",
        "answered by the second connection"
    );
    let (_, command) = fake.next_command().await;
    assert_eq!(command["method"], "health.ping");

    client.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_event_is_logged_never_fatal() {
    let mut fake = FakeBackend::start().await;
    let (_backend_tx, backend) = watch::channel(ready_state(&fake, 1));
    let logger = Logger::silent();
    let (client, mut events) =
        BackendClient::start(backend, config(EventFilter::All, logger.clone()));
    client.wait_connected(WAIT).await.unwrap();
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::Ready(_)
    ));
    // EventFilter::All clears the exclude list on the new socket.
    let (_, command) = fake.next_command().await;
    assert_eq!(command["method"], "events.setExcluded");
    assert_eq!(command["params"]["events"], json!([]));

    fake.send_event("totally.new", json!({"x": 1}));
    fake.send_event(names::RECORDING_STATUS, json!({"state": 42}));
    fake.act(Action::Send("not json".to_string()));
    fake.send_event(names::RECORDING_STATUS, json!({"state": "idle"}));

    match next_event(&mut events).await {
        BackendEvent::Untyped { event, payload } => {
            assert_eq!(event, "totally.new");
            assert_eq!(payload["x"], 1);
        }
        other => panic!("expected Untyped, got {other:?}"),
    }
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::Unreadable { .. }
    ));
    let BackendEvent::RecordingStatus(status) = next_event(&mut events).await else {
        panic!("expected RecordingStatus");
    };
    assert!(matches!(
        status.state,
        videorc_protocol::RecordingState::Idle
    ));

    // Still connected, still answering.
    assert!(client.current_state().is_connected());
    let health = client.call::<HealthPing>(&()).await.unwrap();
    assert_eq!(health.version, "connection-1");

    let messages: Vec<String> = logger
        .recent()
        .into_iter()
        .map(|line| line.message)
        .collect();
    assert!(
        messages
            .iter()
            .any(|line| line.contains("\"totally.new\"") && line.contains("no typed shape")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|line| line.contains("\"recording.status\"") && line.contains("did not match")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|line| line.contains("unreadable message")),
        "{messages:?}"
    );
    client.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_fail_at_once_without_a_backend_and_work_once_it_is_ready() {
    let fake = FakeBackend::start().await;
    let (backend_tx, backend) = watch::channel(BackendState::Starting {
        generation: 1,
        attempt: None,
    });
    let (client, _events) =
        BackendClient::start(backend, config(EventFilter::All, Logger::silent()));
    let error = client.call::<HealthPing>(&()).await.unwrap_err();
    assert_eq!(error.code, codes::NOT_CONNECTED);
    assert_eq!(error.method, "health.ping");
    let error = client.request("anything", Value::Null).await.unwrap_err();
    assert_eq!(error.code, codes::NOT_CONNECTED);

    backend_tx.send(ready_state(&fake, 1)).unwrap();
    client.wait_connected(WAIT).await.unwrap();
    let refused = client.request("refuse", Value::Null).await.unwrap_err();
    assert_eq!(refused.code, "forbidden-method");
    assert_eq!(refused.method, "refuse");
    client.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_generation_is_followed_at_once() {
    let first = FakeBackend::start().await;
    let mut second = FakeBackend::start().await;
    let (backend_tx, backend) = watch::channel(ready_state(&first, 1));
    let mut slow = config(EventFilter::All, Logger::silent());
    // Far longer than the wait: moving to the new generation must not use it.
    slow.reconnect_delay = Duration::from_secs(60);
    let (client, mut events) = BackendClient::start(backend, slow);
    client.wait_connected(WAIT).await.unwrap();
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::Ready(_)
    ));

    backend_tx.send(ready_state(&second, 2)).unwrap();
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::ConnectionClosed { .. }
    ));
    let BackendEvent::Ready(ready) = next_event(&mut events).await else {
        panic!("expected Ready from the new generation");
    };
    assert_eq!(ready.port, second.port);
    let (connection, _) = second.next_command().await;
    assert_eq!(connection, 1);
    assert!(matches!(
        client.current_state(),
        ConnectionState::Connected { generation: 2, .. }
    ));

    // The supervisor stops: the client waits, then closes with it.
    backend_tx
        .send(BackendState::Stopped {
            stray_pids: Vec::new(),
        })
        .unwrap();
    assert!(matches!(
        next_event(&mut events).await,
        BackendEvent::ConnectionClosed { .. }
    ));
    drop(backend_tx);
    let mut state = client.state();
    tokio::time::timeout(
        WAIT,
        state.wait_for(|state| matches!(state, ConnectionState::Closed)),
    )
    .await
    .expect("the client closes with the supervisor")
    .unwrap();
    client.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sent_request_that_never_answers_has_an_unknown_outcome() {
    let fake = FakeBackend::start().await;
    let credential = Credential {
        host: "127.0.0.1".to_string(),
        port: fake.port,
        token: TOKEN.to_string(),
    };
    let socket = BackendSocket::connect_with(&credential, SocketOptions::default())
        .await
        .unwrap();
    assert_eq!(socket.ready_connection().unwrap().port, fake.port);
    let error = socket
        .request_with_timeout("never.answers", Value::Null, Duration::from_millis(100))
        .await
        .unwrap_err();
    assert!(error.is_outcome_unknown(), "{error}");
    assert!(error.message.contains("timed out"), "{error}");

    // A sent request whose socket closes: unknown too.
    let pending = socket.request_with_timeout("never.answers", Value::Null, WAIT);
    let close = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        fake.act(Action::Close);
    };
    let (result, ()) = tokio::join!(pending, close);
    let error = result.unwrap_err();
    assert!(error.is_outcome_unknown(), "{error}");
    let reason = tokio::time::timeout(WAIT, socket.wait_closed())
        .await
        .unwrap();
    assert!(reason.contains("closed"), "{reason}");

    // After the close: not connected, at once.
    let error = socket
        .request("recording.status", Value::Null)
        .await
        .unwrap_err();
    assert_eq!(error.code, codes::NOT_CONNECTED);
}

/// A backend that sends `backend.ready` and then never reads again, so a
/// close frame gets no answer: the reader is still waiting when `close`
/// aborts it, and never records the close itself.
async fn silent_backend() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let ready = json!({
            "event": "backend.ready",
            "payload": {"host": "127.0.0.1", "port": port, "token": TOKEN, "pid": 4242}
        });
        socket.send(Message::text(ready.to_string())).await.unwrap();
        // Holds the connection open without reading: no answer to anything.
        tokio::time::sleep(Duration::from_secs(60)).await;
        drop(socket);
    });
    (port, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_says_closed_even_when_the_reader_never_saw_it() {
    let (port, server) = silent_backend().await;
    let credential = Credential {
        host: "127.0.0.1".to_string(),
        port,
        token: TOKEN.to_string(),
    };
    let socket = BackendSocket::connect_with(&credential, SocketOptions::default())
        .await
        .unwrap();
    assert!(socket.is_open());

    // A request the engine will never answer, waiting when the close lands.
    let pending = socket.request_with_timeout("never.answers", Value::Null, WAIT);
    let close = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        socket.close().await;
    };
    let started = std::time::Instant::now();
    let (result, ()) = tokio::join!(pending, close);

    // Closed at once, in this app's words, and the waiting request failed
    // with the close instead of waiting out its own deadline.
    assert!(!socket.is_open());
    assert_eq!(
        socket.closed_reason().as_deref(),
        Some(super::socket::CLIENT_CLOSED)
    );
    let error = result.unwrap_err();
    assert!(error.is_outcome_unknown(), "{error}");
    assert!(started.elapsed() < WAIT, "{:?}", started.elapsed());
    let reason = tokio::time::timeout(WAIT, socket.wait_closed())
        .await
        .expect("wait_closed returns once closed");
    assert_eq!(reason, super::socket::CLIENT_CLOSED);
    server.abort();
}
