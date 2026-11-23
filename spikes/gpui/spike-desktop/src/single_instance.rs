//! One instance: the first start owns a loopback port; a second start sends
//! its arguments there and exits, and the first focuses its window and acts
//! on them (a `videorc-spike://` link among them opens like a deep link).
//!
//! macOS's LaunchServices already keeps one instance of an app bundle and
//! delivers links to it; this covers a second start of the binary itself
//! (and is the shape Windows and Linux need, where nothing else does it).
//! The real app keeps the backend's registry lock as the owner and uses the
//! same hand-off (plan 260, "Windows, menus and the shell").

use std::{
    io::{BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::mpsc::Sender,
    time::Duration,
};

/// Fixed for the spike; the real app writes its port next to the registry lock.
pub const PORT: u16 = 47_931;
const HELLO: &str = "videorc-spike-desktop/1";

pub enum Role {
    /// This process is the first: hand-offs arrive on the sender's channel.
    First,
    /// Another instance took the arguments; this process should exit.
    HandedOver,
}

pub fn claim(args: &[String], on_handoff: Sender<Vec<String>>) -> Result<Role, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, PORT));
    match TcpListener::bind(addr) {
        Ok(listener) => {
            std::thread::Builder::new()
                .name("single-instance".into())
                .spawn(move || {
                    for stream in listener.incoming().flatten() {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut reader = BufReader::new(stream);
                        let mut line = String::new();
                        if reader.read_line(&mut line).is_err() {
                            continue;
                        }
                        let Ok(serde_json::Value::Object(msg)) =
                            serde_json::from_str::<serde_json::Value>(&line)
                        else {
                            continue;
                        };
                        if msg.get("hello").and_then(|v| v.as_str()) != Some(HELLO) {
                            continue;
                        }
                        let args = msg
                            .get("args")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|v| v.as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let _ = reader.get_mut().write_all(b"ok\n");
                        if on_handoff.send(args).is_err() {
                            break;
                        }
                    }
                })
                .map_err(|e| format!("cannot start the hand-off thread: {e}"))?;
            Ok(Role::First)
        }
        Err(_) => {
            let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
                .map_err(|e| format!("port {PORT} is taken but nothing answers: {e}"))?;
            let msg = serde_json::json!({ "hello": HELLO, "args": args });
            stream
                .write_all(format!("{msg}\n").as_bytes())
                .map_err(|e| format!("hand-off write failed: {e}"))?;
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reply = String::new();
            BufReader::new(stream)
                .read_line(&mut reply)
                .map_err(|e| format!("no reply from the first instance: {e}"))?;
            if reply.trim() == "ok" {
                Ok(Role::HandedOver)
            } else {
                Err(format!("unexpected reply {reply:?}"))
            }
        }
    }
}
