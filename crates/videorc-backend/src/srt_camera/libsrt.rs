//! libsrt (Haivision SRT 1.5, MPL-2.0), loaded at run time (plan 250). The
//! packaged app ships it next to FFmpeg and main names it in
//! `VIDEORC_BUNDLED_LIBSRT_PATH`; a dev build also tries the staged
//! `vendor/libsrt/current` and Homebrew's copy. Only the calls the listener
//! makes are bound.

use std::ffi::{CStr, c_char, c_int, c_void};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

pub const LIBSRT_PATH_ENV: &str = "VIDEORC_BUNDLED_LIBSRT_PATH";

pub type SrtSocket = c_int;
pub const SRT_INVALID_SOCK: SrtSocket = -1;
pub const SRT_ERROR: c_int = -1;

/// `SRT_EASYNCRCV`: nothing to read or accept before the timeout.
pub const SRT_EASYNCRCV: c_int = 6002;
/// `SRT_ETIMEOUT`: a blocking receive's `SRTO_RCVTIMEO` ran out.
pub const SRT_ETIMEOUT: c_int = 6003;
/// `SRT_REJX_OVERLOAD` (libsrt `access_control.h`): "busy", the reason a
/// second sender is given (D14, D18).
pub const SRT_REJX_OVERLOAD: c_int = 1402;

pub const SRTO_RCVSYN: c_int = 2;
pub const SRTO_RCVTIMEO: c_int = 14;
pub const SRTO_PASSPHRASE: c_int = 26;
pub const SRTO_RCVLATENCY: c_int = 43;
pub const SRTO_PEERLATENCY: c_int = 44;
pub const SRTO_TRANSTYPE: c_int = 50;
pub const SRTO_ENFORCEDENCRYPTION: c_int = 53;
pub const SRTO_MINVERSION: c_int = 45;
/// SRT 1.3.0, the first with the v5 handshake (`SRT_VERSION_FEAT_HSv5`).
pub const SRT_VERSION_HSV5: c_int = 0x01_03_00;
pub const SRTT_LIVE: c_int = 0;
/// `SRT_SOCKSTATUS` values `srt_getsockstate` returns.
pub const SRTS_LISTENING: c_int = 3;
#[cfg(test)]
pub const SRTS_CONNECTED: c_int = 5;
pub const SRTS_BROKEN: c_int = 6;
pub const SRTS_CLOSING: c_int = 7;
pub const SRTS_CLOSED: c_int = 8;
pub const SRTS_NONEXIST: c_int = 9;
/// syslog's LOG_WARNING, as `srt_setloglevel` takes it.
const LOG_WARNING: c_int = 4;

pub type LogHandler = unsafe extern "C" fn(
    opaque: *mut c_void,
    level: c_int,
    file: *const c_char,
    line: c_int,
    area: *const c_char,
    message: *const c_char,
);

/// Callers libsrt turned away for the passphrase since start (D17).
static PASSPHRASE_REFUSALS: AtomicU64 = AtomicU64::new(0);

pub fn passphrase_refusals() -> u64 {
    PASSPHRASE_REFUSALS.load(Ordering::Acquire)
}

/// libsrt's answer to a caller with the wrong passphrase (1010, BADSECRET)
/// or with none (1011, UNSECURE), as its listener logs it.
pub fn is_passphrase_refusal(message: &str) -> bool {
    message.contains("rsp(REJECT): 1010") || message.contains("rsp(REJECT): 1011")
}

unsafe extern "C" fn on_log(
    _opaque: *mut c_void,
    _level: c_int,
    _file: *const c_char,
    _line: c_int,
    _area: *const c_char,
    message: *const c_char,
) {
    if message.is_null() {
        return;
    }
    // SAFETY: libsrt passes a NUL-terminated message valid for the call.
    let message = unsafe { CStr::from_ptr(message) }.to_string_lossy();
    if is_passphrase_refusal(&message) {
        PASSPHRASE_REFUSALS.fetch_add(1, Ordering::AcqRel);
    }
    tracing::debug!("[srt-camera] libsrt: {}", message.trim_end());
}

pub type ListenCallback = unsafe extern "C" fn(
    opaque: *mut c_void,
    socket: SrtSocket,
    hs_version: c_int,
    peer: *const c_void,
    stream_id: *const c_char,
) -> c_int;

#[allow(dead_code)] // every field is a bound call; not all run on every path
pub struct Api {
    pub startup: unsafe extern "C" fn() -> c_int,
    pub create_socket: unsafe extern "C" fn() -> SrtSocket,
    pub setsockflag: unsafe extern "C" fn(SrtSocket, c_int, *const c_void, c_int) -> c_int,
    pub bind: unsafe extern "C" fn(SrtSocket, *const c_void, c_int) -> c_int,
    pub listen: unsafe extern "C" fn(SrtSocket, c_int) -> c_int,
    pub listen_callback: unsafe extern "C" fn(SrtSocket, ListenCallback, *mut c_void) -> c_int,
    pub accept: unsafe extern "C" fn(SrtSocket, *mut c_void, *mut c_int) -> SrtSocket,
    pub recvmsg: unsafe extern "C" fn(SrtSocket, *mut c_char, c_int) -> c_int,
    pub close: unsafe extern "C" fn(SrtSocket) -> c_int,
    pub getlasterror: unsafe extern "C" fn(*mut c_int) -> c_int,
    pub getlasterror_str: unsafe extern "C" fn() -> *const c_char,
    pub setrejectreason: unsafe extern "C" fn(SrtSocket, c_int) -> c_int,
    pub setloglevel: unsafe extern "C" fn(c_int),
    pub setloghandler: unsafe extern "C" fn(*mut c_void, LogHandler),
    pub getsockstate: unsafe extern "C" fn(SrtSocket) -> c_int,
    /// A caller's calls, for the tests that dial a real listener.
    #[cfg(test)]
    pub connect: unsafe extern "C" fn(SrtSocket, *const c_void, c_int) -> c_int,
    #[cfg(test)]
    pub sendmsg2: unsafe extern "C" fn(SrtSocket, *const c_char, c_int, *mut c_void) -> c_int,
    #[cfg(test)]
    pub getrejectreason: unsafe extern "C" fn(SrtSocket) -> c_int,
}

// SAFETY: the table holds plain C function pointers into a library that is
// never unloaded; libsrt's calls are thread-safe.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
    pub fn last_error(&self) -> (c_int, String) {
        // SAFETY: both calls read libsrt's thread-local error state.
        unsafe {
            let code = (self.getlasterror)(std::ptr::null_mut());
            let text = (self.getlasterror_str)();
            let text = if text.is_null() {
                String::new()
            } else {
                CStr::from_ptr(text).to_string_lossy().into_owned()
            };
            (code, text)
        }
    }
}

/// The library paths to try, in order.
pub fn candidate_paths(bundled: Option<&str>, debug_build: bool) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(bundled) = bundled.map(str::trim).filter(|path| !path.is_empty()) {
        paths.push(bundled.to_string());
    }
    if debug_build {
        paths.push(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../vendor/libsrt/current/lib/libsrt.dylib"
            )
            .to_string(),
        );
        paths.push("/opt/homebrew/opt/srt/lib/libsrt.dylib".to_string());
        paths.push("/usr/local/opt/srt/lib/libsrt.dylib".to_string());
    }
    paths
}

/// Every load error starts with this, so the log names the library.
pub const LOAD_FAILED: &str = "The SRT library didn't load";

static API: OnceLock<Api> = OnceLock::new();
static LOADING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// libsrt, loaded and started once. A failed load is tried again on the next
/// call (the listener's retry), so a library put in place later is found.
pub fn api() -> Result<&'static Api, String> {
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let _loading = LOADING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(api) = API.get() {
        return Ok(api);
    }
    let api = load().map_err(|error| format!("{LOAD_FAILED}: {error}"))?;
    Ok(API.get_or_init(|| api))
}

#[cfg(unix)]
fn load() -> Result<Api, String> {
    let bundled = std::env::var(LIBSRT_PATH_ENV).ok();
    let mut tried = Vec::new();
    for path in candidate_paths(bundled.as_deref(), cfg!(debug_assertions)) {
        let Ok(c_path) = std::ffi::CString::new(path.clone()) else {
            continue;
        };
        // SAFETY: dlopen with a valid C string; the handle is kept for the
        // life of the process.
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            // SAFETY: dlerror right after the failed dlopen, on this thread.
            let reason = unsafe { libc::dlerror() };
            if reason.is_null() {
                tried.push(path);
            } else {
                // SAFETY: dlerror gives a NUL-terminated string.
                let reason = unsafe { std::ffi::CStr::from_ptr(reason) }.to_string_lossy();
                tried.push(format!("{path} ({reason})"));
            }
            continue;
        }
        let api = bind(handle).map_err(|missing| format!("{path} has no {missing}"))?;
        // SAFETY: plain libsrt calls; the handler is a plain function. Its
        // log is the only place libsrt says a caller had the wrong
        // passphrase: libsrt checks it after the listen callback has run.
        unsafe {
            (api.setloghandler)(std::ptr::null_mut(), on_log);
            (api.setloglevel)(LOG_WARNING);
        }
        // SAFETY: srt_startup may be called more than once; it counts.
        if unsafe { (api.startup)() } < 0 {
            return Err(format!("srt_startup failed: {}", api.last_error().1));
        }
        tracing::info!("[srt-camera] loaded libsrt from {path}");
        return Ok(api);
    }
    Err(format!("tried {}", tried.join(", ")))
}

#[cfg(not(unix))]
fn load() -> Result<Api, String> {
    Err("The SRT Camera is not available on this computer.".to_string())
}

#[cfg(unix)]
// Each transmute's target is the `Api` field it fills, declared once there.
#[allow(clippy::missing_transmute_annotations)]
fn bind(handle: *mut c_void) -> Result<Api, &'static str> {
    macro_rules! symbol {
        ($name:literal) => {{
            // SAFETY: the name is NUL-terminated; a found symbol is a C
            // function with the signature srt.h gives it.
            let pointer = unsafe { libc::dlsym(handle, concat!($name, "\0").as_ptr().cast()) };
            if pointer.is_null() {
                return Err($name);
            }
            // SAFETY: see above; the target type matches srt.h.
            unsafe { std::mem::transmute::<*mut c_void, _>(pointer) }
        }};
    }
    Ok(Api {
        startup: symbol!("srt_startup"),
        create_socket: symbol!("srt_create_socket"),
        setsockflag: symbol!("srt_setsockflag"),
        bind: symbol!("srt_bind"),
        listen: symbol!("srt_listen"),
        listen_callback: symbol!("srt_listen_callback"),
        accept: symbol!("srt_accept"),
        recvmsg: symbol!("srt_recvmsg"),
        close: symbol!("srt_close"),
        getlasterror: symbol!("srt_getlasterror"),
        getlasterror_str: symbol!("srt_getlasterror_str"),
        setrejectreason: symbol!("srt_setrejectreason"),
        setloglevel: symbol!("srt_setloglevel"),
        setloghandler: symbol!("srt_setloghandler"),
        getsockstate: symbol!("srt_getsockstate"),
        #[cfg(test)]
        connect: symbol!("srt_connect"),
        #[cfg(test)]
        sendmsg2: symbol!("srt_sendmsg2"),
        #[cfg(test)]
        getrejectreason: symbol!("srt_getrejectreason"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_library_log_names_a_wrong_or_missing_passphrase() {
        assert!(is_passphrase_refusal(
            "14:50:30.245049/!W:SRT.cn: processConnectRequest: rsp(REJECT): 1010 - Incorrect passphrase"
        ));
        assert!(is_passphrase_refusal(
            "processConnectRequest: rsp(REJECT): 1011 - Password required or unexpected"
        ));
        assert!(!is_passphrase_refusal(
            "srt_accept: no pending connection available at the moment"
        ));
        assert!(!is_passphrase_refusal(
            "processConnectRequest: rsp(REJECT): 1402 - overload"
        ));
    }

    #[test]
    fn srt_library_bundled_path_comes_first_and_release_tries_only_it() {
        let release = candidate_paths(Some("/Applications/Videorc.app/libsrt.dylib"), false);
        assert_eq!(release, vec!["/Applications/Videorc.app/libsrt.dylib"]);
        assert!(candidate_paths(None, false).is_empty());
        assert!(candidate_paths(Some("  "), false).is_empty());
        let debug = candidate_paths(Some("/bundled.dylib"), true);
        assert_eq!(debug[0], "/bundled.dylib");
        assert!(debug[1].ends_with("vendor/libsrt/current/lib/libsrt.dylib"));
        assert_eq!(debug[2], "/opt/homebrew/opt/srt/lib/libsrt.dylib");
    }
}
