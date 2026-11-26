//! The app in front on Linux, for Follow the app in front
//! (`videorc_app_core::studio::follow_runner`). X11 reads `_NET_ACTIVE_WINDOW`
//! (and `WM_CLASS` / `_NET_WM_PID`). Wayland has no portable equivalent, so
//! [`start`] is a named no-op there.

use std::cell::RefCell;
use std::sync::Mutex;

use tokio::sync::mpsc::UnboundedSender;
use videorc_app_core::scenes::follow::FrontApp;

thread_local! {
    static SENDER: RefCell<Option<UnboundedSender<FrontApp>>> = const { RefCell::new(None) };
    static LAST: RefCell<Option<FrontApp>> = const { RefCell::new(None) };
}

static X11: Mutex<Option<X11State>> = Mutex::new(None);

struct X11State {
    conn: x11rb::rust_connection::RustConnection,
    root: u32,
    net_active_window: u32,
    net_wm_pid: u32,
    net_wm_name: u32,
    utf8_string: u32,
}

fn wayland() -> bool {
    // Same rule as `linux/mod.rs` Keep on top: any Wayland session is a
    // named no-op, even when XWayland also exports DISPLAY.
    std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn publish(app: FrontApp) {
    let fresh = LAST.with_borrow_mut(|last| {
        if last.as_ref() == Some(&app) {
            return false;
        }
        *last = Some(app.clone());
        true
    });
    if fresh {
        SENDER.with_borrow(|sender| {
            if let Some(sender) = sender {
                let _ = sender.send(app);
            }
        });
    }
}

fn open_x11() -> Result<X11State, String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;

    let (conn, screen_num) =
        x11rb::connect(None).map_err(|error| format!("the X connection: {error}"))?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;
    let intern = |name: &str| -> Result<u32, String> {
        let cookie = conn
            .intern_atom(false, name.as_bytes())
            .map_err(|error| format!("intern_atom({name}): {error}"))?;
        let reply = cookie
            .reply()
            .map_err(|error| format!("intern_atom({name}) reply: {error}"))?;
        Ok(reply.atom)
    };
    Ok(X11State {
        net_active_window: intern("_NET_ACTIVE_WINDOW")?,
        net_wm_pid: intern("_NET_WM_PID")?,
        net_wm_name: intern("_NET_WM_NAME")?,
        utf8_string: intern("UTF8_STRING")?,
        root,
        conn,
    })
}

fn read_front(state: &X11State) -> Option<FrontApp> {
    use x11rb::properties::WmClass;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};

    let reply = state
        .conn
        .get_property(
            false,
            state.root,
            state.net_active_window,
            AtomEnum::WINDOW,
            0,
            1,
        )
        .ok()?
        .reply()
        .ok()?;
    if reply.value_len == 0 || reply.format != 32 {
        return None;
    }
    let window = u32::from_ne_bytes(reply.value.get(..4)?.try_into().ok()?);
    if window == 0 {
        return None;
    }
    let window: Window = window;

    let class = WmClass::get(&state.conn, window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .flatten();
    let class_name = class
        .as_ref()
        .and_then(|wm| std::str::from_utf8(wm.class()).ok())
        .unwrap_or("")
        .to_string();
    let instance = class
        .as_ref()
        .and_then(|wm| std::str::from_utf8(wm.instance()).ok())
        .unwrap_or("")
        .to_string();
    // Prefer WM_CLASS class as the Follow key (stable across windows of one
    // app). Fall back to the instance, then the X window id.
    let bundle_id = if !class_name.is_empty() {
        class_name.to_lowercase()
    } else if !instance.is_empty() {
        instance.to_lowercase()
    } else {
        format!("x11:{window}")
    };

    let pid = state
        .conn
        .get_property(false, window, state.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| {
            if reply.format == 32 && reply.value.len() >= 4 {
                Some(i32::from_ne_bytes(reply.value[..4].try_into().ok()?))
            } else {
                None
            }
        })
        .unwrap_or(0);

    let name = state
        .conn
        .get_property(false, window, state.net_wm_name, state.utf8_string, 0, 1024)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| String::from_utf8(reply.value).ok())
        .filter(|s| !s.is_empty())
        .or({
            if !instance.is_empty() {
                Some(instance)
            } else if !class_name.is_empty() {
                Some(class_name)
            } else {
                None
            }
        })
        .unwrap_or_else(|| bundle_id.clone());

    Some(FrontApp {
        bundle_id,
        name,
        pid,
        front_window_id: Some(format!("window:x11:{window}")),
    })
}

/// The app in front now (X11 only).
pub fn frontmost() -> Option<FrontApp> {
    let guard = X11.lock().ok()?;
    let state = guard.as_ref()?;
    read_front(state)
}

/// This run's app id when packaged as an AppImage.
pub fn self_bundle_id() -> Option<String> {
    std::env::var_os("APPIMAGE").map(|_| super::APP_ID.to_string())
}

/// Starts watching the active window on X11. On Wayland (no `DISPLAY`),
/// returns false so the caller can log the named no-op.
pub fn start(sender: UnboundedSender<FrontApp>) -> bool {
    if wayland() {
        return false;
    }
    if std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    let state = match open_x11() {
        Ok(state) => state,
        Err(_) => return false,
    };
    SENDER.with_borrow_mut(|slot| *slot = Some(sender));
    if let Ok(mut slot) = X11.lock() {
        *slot = Some(state);
    } else {
        return false;
    }
    if let Some(app) = frontmost() {
        publish(app);
    }
    true
}

/// The 500 ms window watch on X11.
pub fn poll() {
    if let Some(app) = frontmost() {
        publish(app);
    }
}

/// Why Wayland (or a missing DISPLAY) cannot watch the front app.
pub const WAYLAND_NO_WATCHER: &str = "Follow the app in front: Wayland has no portable active-window API; Follow and the password-manager hide stay off.";
