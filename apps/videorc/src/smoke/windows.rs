//! The Notes and Stream Manager windows' smoke commands (plan 260 Phase 3,
//! L6): Electron's `notes-window-*` and `comments-window-*` that the
//! invisibility smokes (`smoke:screen-recording-real`,
//! `smoke:notes-window-invisible`) and the Stream Manager smokes drive, plus
//! `raise-window`. Each runs the window's own path: the menu's toggle, the
//! status bar's Hide from stream switch, the text size control.
//!
//! The answers keep Electron's shapes (`notesWindowState`,
//! `commentsWindowState`). `visible` is `open`: GPUI does not say whether a
//! window is minimized. The chat's are the pane's own paths too:
//! `-click-message` is a row's click, `-set-highlight-anchor` the status
//! bar's corner pick, `-reader-state` the rows' words and highlight phases,
//! `-command-trace` the clicks in flight. The fixture commands
//! (`comments-window-push-*`, `-seed-*`) stay "not supported".

use gpui::{AnyWindowHandle, App, Hsla, Window, rgb};
use serde_json::{Map, Value, json};
use videorc_app_core::notes::FontScale;
use videorc_app_core::smoke::{CommandFuture, SmokeCommandHandler};

use super::UiThread;
use crate::platform::{self, ScreenFrame, SmokeWindowLevel};
use crate::screens::{notes, stream_manager};

/// The commands this handler takes, sorted.
pub const WINDOW_COMMANDS: &[&str] = &[
    "comments-window-click-message",
    "comments-window-close",
    "comments-window-command-trace",
    "comments-window-open",
    "comments-window-reader-state",
    "comments-window-set-bounds",
    "comments-window-set-hidden-from-stream",
    "comments-window-set-highlight-anchor",
    "comments-window-set-smoke-marker",
    "comments-window-state",
    "comments-window-toggle",
    "notes-window-close",
    "notes-window-open",
    "notes-window-save-document",
    "notes-window-set-bounds",
    "notes-window-state",
    "raise-window",
];

const NOTES_CLOSED: &str = "Notes window is not open.";
const CHAT_CLOSED: &str = "Chat window is not open.";

pub struct WindowCommands {
    ui: UiThread,
}

impl WindowCommands {
    pub fn new(ui: UiThread) -> Self {
        Self { ui }
    }
}

impl SmokeCommandHandler for WindowCommands {
    fn handles(&self, command: &str) -> bool {
        WINDOW_COMMANDS.contains(&command)
    }

    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(async move {
            let command = command.to_string();
            self.ui.run(move |cx| run(&command, &params, cx)).await?
        })
    }
}

fn run(command: &str, params: &Map<String, Value>, cx: &mut App) -> Result<Value, String> {
    match command {
        "notes-window-open" => {
            notes::window::show(cx);
            Ok(notes_state(None, cx))
        }
        "notes-window-close" => {
            if notes::window::view(cx).is_some() {
                notes::window::toggle(cx);
            }
            Ok(notes_state(None, cx))
        }
        "notes-window-state" => Ok(notes_state(None, cx)),
        "notes-window-set-bounds" => {
            let Some(handle) = notes::window::handle(cx) else {
                return Ok(notes_state(Some(NOTES_CLOSED), cx));
            };
            place(handle, params, cx)?;
            Ok(notes_state(None, cx))
        }
        "notes-window-save-document" => {
            let text = match params.get("text") {
                None | Some(Value::Null) => None,
                Some(Value::String(text)) => Some(text.clone()),
                Some(_) => return Err("notes-window-save-document's text is a string.".into()),
            };
            // Electron ignores a size it does not know, so this does too.
            let scale = params
                .get("fontScale")
                .and_then(Value::as_str)
                .and_then(FontScale::parse);
            let view = notes::window::view(cx).ok_or(NOTES_CLOSED)?;
            let saved = view
                .update(cx, |notes, window, cx| {
                    notes.smoke_save_document(text, scale, window, cx)?;
                    Ok::<_, String>(notes.smoke_state(window, cx))
                })
                .map_err(|_| NOTES_CLOSED.to_string())??;
            Ok(json!({ "text": saved["text"], "fontScale": saved["fontScale"] }))
        }
        "comments-window-open" => {
            stream_manager::window::show(cx);
            Ok(chat_state(None, cx))
        }
        "comments-window-close" => {
            if stream_manager::window::view(cx).is_some() {
                stream_manager::window::toggle(cx);
            }
            Ok(chat_state(None, cx))
        }
        "comments-window-toggle" => {
            stream_manager::window::toggle(cx);
            Ok(chat_state(None, cx))
        }
        "comments-window-state" => Ok(chat_state(None, cx)),
        "comments-window-set-bounds" => {
            let Some(handle) = stream_manager::window::handle(cx) else {
                return Ok(chat_state(Some(CHAT_CLOSED), cx));
            };
            place(handle, params, cx)?;
            Ok(chat_state(None, cx))
        }
        "comments-window-set-hidden-from-stream" => {
            let hidden = params.get("hidden") == Some(&Value::Bool(true));
            let view = stream_manager::window::view(cx).ok_or(CHAT_CLOSED)?;
            view.update(cx, |sm, window, cx| sm.smoke_set_hidden(hidden, window, cx))
                .map_err(|_| CHAT_CLOSED.to_string())?;
            Ok(chat_state(None, cx))
        }
        "comments-window-set-smoke-marker" => {
            let Some(view) = stream_manager::window::view(cx) else {
                return Ok(chat_state(Some(CHAT_CLOSED), cx));
            };
            let (color, words) = marker_color(params.get("color"))?;
            view.update(cx, |sm, _, cx| sm.smoke_set_marker(color, cx))
                .map_err(|_| CHAT_CLOSED.to_string())?;
            let mut state = chat_state(None, cx);
            state["markerInstalled"] = json!(true);
            state["markerColor"] = json!(words);
            Ok(state)
        }
        "comments-window-set-highlight-anchor" => {
            let anchor = params
                .get("anchor")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let view = stream_manager::window::view(cx).ok_or(CHAT_CLOSED)?;
            view.update(cx, |sm, _, cx| sm.smoke_set_anchor(&anchor, cx))
                .map_err(|_| CHAT_CLOSED.to_string())?;
            Ok(chat_state(None, cx))
        }
        "comments-window-click-message" => {
            let id = params
                .get("messageId")
                .and_then(Value::as_str)
                .ok_or("comments-window-click-message takes a messageId.")?
                .to_string();
            let view = stream_manager::window::view(cx).ok_or(CHAT_CLOSED)?;
            let clicked = view
                .update(cx, |sm, _, cx| sm.smoke_click_message(&id, cx))
                .map_err(|_| CHAT_CLOSED.to_string())?;
            Ok(json!({ "clicked": clicked, "messageId": id }))
        }
        "comments-window-reader-state" => {
            let view = stream_manager::window::view(cx).ok_or(CHAT_CLOSED)?;
            view.update(cx, |sm, _, cx| sm.smoke_reader_state(cx))
                .map_err(|_| CHAT_CLOSED.to_string())
        }
        "comments-window-command-trace" => {
            let view = stream_manager::window::view(cx).ok_or(CHAT_CLOSED)?;
            view.update(cx, |sm, _, cx| sm.smoke_command_trace(cx))
                .map_err(|_| CHAT_CLOSED.to_string())
        }
        "raise-window" => raise(params, cx),
        other => Err(format!("{other} is not a Notes or Stream Manager command.")),
    }
}

/// The marker's `color`, `#rrggbb`. The smoke names it: the colour is the
/// one its recording gate looks for, never a theme colour, so the app keeps
/// no default (Electron's was red, which the one caller sends).
fn marker_color(value: Option<&Value>) -> Result<(Hsla, String), String> {
    let words = value
        .and_then(Value::as_str)
        .filter(|words| {
            words.len() == 7
                && words.starts_with('#')
                && words[1..].chars().all(|c| c.is_ascii_hexdigit())
        })
        .ok_or("comments-window-set-smoke-marker's color is a #rrggbb colour.")?
        .to_ascii_lowercase();
    let value = u32::from_str_radix(&words[1..], 16).map_err(|error| error.to_string())?;
    Ok((rgb(value).into(), words))
}

/// The frame a set-bounds asks for, each side missing kept from `current`.
fn requested_frame(params: &Map<String, Value>, current: ScreenFrame) -> ScreenFrame {
    let side =
        |key: &str, fallback: f64| params.get(key).and_then(Value::as_f64).unwrap_or(fallback);
    ScreenFrame {
        x: side("x", current.x),
        y: side("y", current.y),
        width: side("width", current.width),
        height: side("height", current.height),
    }
}

fn frame_of(window: &Window) -> ScreenFrame {
    let bounds = window.bounds();
    ScreenFrame {
        x: f64::from(f32::from(bounds.origin.x)),
        y: f64::from(f32::from(bounds.origin.y)),
        width: f64::from(f32::from(bounds.size.width)),
        height: f64::from(f32::from(bounds.size.height)),
    }
}

fn bounds_json(frame: ScreenFrame) -> Value {
    json!({ "x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height })
}

/// Electron's `setBounds` then `moveTop`, without taking focus.
fn place(handle: AnyWindowHandle, params: &Map<String, Value>, cx: &mut App) -> Result<(), String> {
    handle
        .update(cx, |_, window, _| {
            let frame = requested_frame(params, frame_of(window));
            platform::current().set_window_frame(window, frame)
        })
        .map_err(|_| "The window closed.".to_string())?
}

/// What both windows' states share: open, bounds, the feature switch.
fn window_state(handle: Option<AnyWindowHandle>, message: Option<&str>, cx: &mut App) -> Value {
    let frame = handle.and_then(|handle| {
        handle
            .update(cx, |_, window, _| {
                let size = window.viewport_size();
                (
                    frame_of(window),
                    json!({
                        "width": f32::from(size.width),
                        "height": f32::from(size.height),
                    }),
                )
            })
            .ok()
    });
    let open = frame.is_some();
    json!({
        "open": open,
        "visible": open,
        "bounds": frame.as_ref().map(|(frame, _)| bounds_json(*frame)),
        "contentBounds": frame.map(|(_, content)| content),
        // The GPUI app has no switch that turns these windows off.
        "enabled": true,
        "message": message,
    })
}

fn merge(state: &mut Value, extra: Value) {
    if let (Some(state), Value::Object(extra)) = (state.as_object_mut(), extra) {
        state.extend(extra);
    }
}

fn notes_state(message: Option<&str>, cx: &mut App) -> Value {
    let mut state = window_state(notes::window::handle(cx), message, cx);
    let view = notes::window::view(cx).and_then(|view| {
        view.update(cx, |notes, window, cx| notes.smoke_state(window, cx))
            .ok()
    });
    merge(
        &mut state,
        view.unwrap_or_else(|| json!({ "protected": false, "windowId": null })),
    );
    state
}

fn chat_state(message: Option<&str>, cx: &mut App) -> Value {
    let mut state = window_state(stream_manager::window::handle(cx), message, cx);
    let view = stream_manager::window::view(cx).and_then(|view| {
        view.update(cx, |sm, window, cx| sm.smoke_state(window, cx))
            .ok()
    });
    merge(
        &mut state,
        view.unwrap_or_else(|| json!({ "protected": false, "windowId": null })),
    );
    state
}

/// `raise-window {role, level?, focus?}`: Electron's roles for these
/// windows (`notes`, `chat`) and the main window. Focus is never taken here
/// (the smokes that raise ask for `focus: false`).
fn raise(params: &Map<String, Value>, cx: &mut App) -> Result<Value, String> {
    let role = params.get("role").and_then(Value::as_str).unwrap_or("");
    let level = SmokeWindowLevel::parse(params.get("level").and_then(Value::as_str))?;
    if params.get("focus") == Some(&Value::Bool(true)) {
        return Err("raise-window: focus: true is not supported on the GPUI app yet.".into());
    }
    let handle = match role {
        "notes" => notes::window::handle(cx),
        "chat" | "comments" | "stream-manager" => stream_manager::window::handle(cx),
        "main" => super::shell(cx)?.window(videorc_app_core::smoke::security::UiWindow::Main, cx),
        _ => None,
    }
    .ok_or_else(|| format!("No open window for role: {role}"))?;
    handle
        .update(cx, |_, window, _| {
            platform::current().raise_window(window, level)?;
            Ok::<_, String>(json!({
                "role": role,
                "level": level.id(),
                "bounds": bounds_json(frame_of(window)),
                "windowId": platform::current().capture_window_id(window),
                "focused": window.is_window_active(),
            }))
        })
        .map_err(|_| "The window closed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::smoke::APP_WINDOW_COMMANDS;
    use videorc_app_core::smoke::security::is_smoke_command;

    #[test]
    fn every_command_is_an_app_window_command_the_server_admits() {
        let mut sorted = WINDOW_COMMANDS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, WINDOW_COMMANDS);
        for name in WINDOW_COMMANDS {
            assert!(APP_WINDOW_COMMANDS.contains(name), "{name}");
            assert!(is_smoke_command(name), "{name}");
        }
    }

    #[test]
    fn a_marker_is_a_hex_colour_the_smoke_names() {
        assert_eq!(
            marker_color(Some(&json!("#00FF00"))).map(|(_, words)| words),
            Ok("#00ff00".to_string())
        );
        assert!(marker_color(Some(&json!("green"))).is_err());
        assert!(marker_color(None).is_err());
    }

    #[test]
    fn set_bounds_keeps_each_side_it_is_not_given() {
        let current = ScreenFrame {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 400.0,
        };
        let params = json!({ "x": 5, "width": 640 });
        let next = requested_frame(params.as_object().unwrap(), current);
        assert_eq!(
            next,
            ScreenFrame {
                x: 5.0,
                y: 20.0,
                width: 640.0,
                height: 400.0
            }
        );
    }
}
