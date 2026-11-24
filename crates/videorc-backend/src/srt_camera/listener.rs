//! The SRT listener (plan 255 D2, D4, D14, D16): bound on every interface,
//! encryption enforced, one sender at a time. Videorc only listens; opening
//! the port is the only thing a sender can see.

use std::ffi::{c_char, c_int, c_void};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::ListenConfig;
use super::libsrt::{self, Api, SrtSocket};
use super::signal::{Acceptance, Admission, ListenerTrouble, SenderGate};
use crate::protocol::SrtSenderRefusal;

/// The pause after a read that finds nothing. Reads don't block: libsrt
/// wakes a blocking reader only on its next full ACK, about 10 ms after the
/// last packet of a frame (libsrt 1.5.7 core.cpp `checkACKTimer`).
const READ_POLL: Duration = Duration::from_millis(1);
const ACCEPT_POLL: Duration = Duration::from_millis(50);
/// One SRT live message is at most 1456 bytes; TS senders use 1316.
const MESSAGE_BUFFER: usize = 1500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketOption {
    Int(c_int, c_int),
    Text(c_int, String),
}

/// The options set on the listening socket (accepted sockets inherit them).
pub fn listener_options(config: &ListenConfig) -> Vec<SocketOption> {
    let latency = c_int::try_from(config.latency_ms).unwrap_or(c_int::MAX);
    vec![
        SocketOption::Int(libsrt::SRTO_TRANSTYPE, libsrt::SRTT_LIVE),
        SocketOption::Int(libsrt::SRTO_RCVLATENCY, latency),
        SocketOption::Int(libsrt::SRTO_PEERLATENCY, latency),
        SocketOption::Text(libsrt::SRTO_PASSPHRASE, config.passphrase.clone()),
        SocketOption::Int(libsrt::SRTO_ENFORCEDENCRYPTION, 1),
        // The v4 handshake exchanges keys only after `accept`, so a caller
        // with a wrong passphrase could reach the gate. v5 checks it first.
        SocketOption::Int(libsrt::SRTO_MINVERSION, libsrt::SRT_VERSION_HSV5),
        // The listener never blocks: accept is polled so stop is prompt.
        SocketOption::Int(libsrt::SRTO_RCVSYN, 0),
    ]
}

/// What the listener saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenerEvent {
    Listening,
    /// libsrt's socket for the sender, as the log names it.
    SenderAccepted(SrtSocket),
    Data(Vec<u8>),
    SenderLeft,
    Refused(SrtSenderRefusal),
}

/// What libsrt's listen callback reads and writes. One per listener, freed
/// after its socket closes (see `run`).
struct CallbackContext {
    gate: Mutex<SenderGate>,
    second_senders: Mutex<u32>,
    passphrase_refusals_seen: std::sync::atomic::AtomicU64,
}

/// Times libsrt asked the listen callback about a caller; a test checks the
/// callback is really installed.
#[cfg(test)]
static CALLBACK_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Callback contexts alive now; a test holds it at zero after a listener.
#[cfg(test)]
static LIVE_CONTEXTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl CallbackContext {
    fn new() -> Self {
        #[cfg(test)]
        LIVE_CONTEXTS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self {
            gate: Mutex::new(SenderGate::new()),
            second_senders: Mutex::new(0),
            passphrase_refusals_seen: std::sync::atomic::AtomicU64::new(
                libsrt::passphrase_refusals(),
            ),
        }
    }
}

#[cfg(test)]
impl Drop for CallbackContext {
    fn drop(&mut self) {
        LIVE_CONTEXTS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

unsafe extern "C" fn on_caller(
    opaque: *mut c_void,
    socket: SrtSocket,
    _hs_version: c_int,
    peer: *const c_void,
    _stream_id: *const c_char,
) -> c_int {
    #[cfg(test)]
    CALLBACK_CALLS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let verdict = std::panic::catch_unwind(|| {
        // SAFETY: `opaque` is this listener's `CallbackContext`, freed only
        // after the listener socket is closed (see `run`).
        let context = unsafe { &*(opaque as *const CallbackContext) };
        // SAFETY: libsrt passes the caller's address, valid for the call.
        let peer = unsafe { peer_ip(peer) };
        let admission = context
            .gate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .admit(peer, Instant::now());
        tracing::debug!("[srt-camera] caller {socket} from {peer:?}: {admission:?}");
        if admission == Admission::Refuse {
            *context
                .second_senders
                .lock()
                .unwrap_or_else(PoisonError::into_inner) += 1;
        }
        admission
    });
    let admission = verdict.unwrap_or(Admission::Refuse);
    match reject_reason(admission) {
        None => 0,
        Some(reason) => {
            if let Ok(api) = libsrt::api() {
                // SAFETY: `socket` is the caller libsrt is asking about.
                unsafe { (api.setrejectreason)(socket, reason) };
            }
            -1
        }
    }
}

/// The reason a refused caller is given (D18): busy, never "wrong
/// passphrase", which libsrt gives by itself (`SRT_REJ_BADSECRET`).
fn reject_reason(admission: Admission) -> Option<c_int> {
    match admission {
        Admission::Admit => None,
        Admission::Refuse => Some(libsrt::SRT_REJX_OVERLOAD),
    }
}

/// The caller's IP address from the `sockaddr` libsrt hands the callback.
///
/// # Safety
/// `peer` is null or points at a `sockaddr_in` or `sockaddr_in6`.
#[cfg(unix)]
unsafe fn peer_ip(peer: *const c_void) -> Option<std::net::IpAddr> {
    if peer.is_null() {
        return None;
    }
    // SAFETY: every sockaddr starts with its family; the caller promises
    // the matching full structure behind it.
    unsafe {
        match c_int::from((*(peer as *const libc::sockaddr)).sa_family) {
            libc::AF_INET => {
                let address = &*(peer as *const libc::sockaddr_in);
                Some(std::net::Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr)).into())
            }
            libc::AF_INET6 => {
                let address = &*(peer as *const libc::sockaddr_in6);
                let ip = std::net::Ipv6Addr::from(address.sin6_addr.s6_addr);
                Some(ip.to_ipv4_mapped().map_or(ip.into(), Into::into))
            }
            _ => None,
        }
    }
}

#[cfg(not(unix))]
unsafe fn peer_ip(_peer: *const c_void) -> Option<std::net::IpAddr> {
    None
}

fn set_option(api: &Api, socket: SrtSocket, option: &SocketOption) -> Result<(), String> {
    // SAFETY: each value lives across the call and its length is exact.
    let result = unsafe {
        match option {
            SocketOption::Int(name, value) => (api.setsockflag)(
                socket,
                *name,
                (value as *const c_int).cast(),
                std::mem::size_of::<c_int>() as c_int,
            ),
            SocketOption::Text(name, value) => {
                (api.setsockflag)(socket, *name, value.as_ptr().cast(), value.len() as c_int)
            }
        }
    };
    if result == libsrt::SRT_ERROR {
        let name = match option {
            SocketOption::Int(name, _) | SocketOption::Text(name, _) => name,
        };
        return Err(format!("SRT option {name} refused: {}", api.last_error().1));
    }
    Ok(())
}

#[cfg(unix)]
fn bind_all_interfaces(api: &Api, socket: SrtSocket, port: u16) -> Result<(), String> {
    // SAFETY: a zeroed sockaddr_in is valid; the fields set below make it
    // 0.0.0.0:<port> (D16: every interface, a USB link included).
    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        address.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
    }
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_port = port.to_be();
    address.sin_addr = libc::in_addr {
        s_addr: u32::from(std::net::Ipv4Addr::UNSPECIFIED).to_be(),
    };
    // SAFETY: the address outlives the call and its size is exact.
    let result = unsafe {
        (api.bind)(
            socket,
            (&address as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as c_int,
        )
    };
    if result == libsrt::SRT_ERROR {
        return Err(format!(
            "Port {port} is in use or can't be opened: {}",
            api.last_error().1
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn bind_all_interfaces(_api: &Api, _socket: SrtSocket, _port: u16) -> Result<(), String> {
    Err("The SRT Camera is not available on this computer.".to_string())
}

struct OpenSocket<'a> {
    api: &'a Api,
    socket: SrtSocket,
}

impl Drop for OpenSocket<'_> {
    fn drop(&mut self) {
        // SAFETY: the socket is ours and closed once.
        unsafe { (self.api.close)(self.socket) };
    }
}

/// Why the listener stopped, for the camera's state and the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenError {
    pub trouble: ListenerTrouble,
    pub message: String,
}

impl ListenError {
    /// A `ListenerTrouble::Port` error: socket, options, bind or listen.
    pub fn port(message: String) -> Self {
        Self {
            trouble: ListenerTrouble::Port,
            message,
        }
    }

    /// A `ListenerTrouble::Stopped` error: the listener was up.
    pub fn stopped(message: String) -> Self {
        Self {
            trouble: ListenerTrouble::Stopped,
            message,
        }
    }
}

/// Listens until `keep_running` says stop. An error means it can't listen
/// (no passphrase, libsrt not loaded, the port not opened, the listener
/// gone); the caller retries.
pub fn run(
    config: &ListenConfig,
    keep_running: &dyn Fn() -> bool,
    on_event: &mut dyn FnMut(ListenerEvent),
) -> Result<(), ListenError> {
    // An empty passphrase would turn encryption off: never listen without one.
    if config.passphrase.is_empty() {
        return Err(ListenError {
            trouble: ListenerTrouble::NoPassphrase,
            message: "no passphrase".to_string(),
        });
    }
    let api = libsrt::api().map_err(|message| ListenError {
        trouble: ListenerTrouble::Library,
        message,
    })?;
    tracing::info!("[srt-camera] receive latency {} ms", config.latency_ms);
    // Declared before the socket, so it is dropped after the socket closes:
    // closing a listener removes it from libsrt's receive queue under an
    // exclusive lock that every running listen callback holds shared
    // (libsrt 1.5.7: `CUDT::notListening`, `CRcvQueue::removeListener`,
    // `worker_ProcessConnectionRequest`). Once `srt_close` returns, no
    // callback runs or can start, so the context can go.
    let context = Box::new(CallbackContext::new());
    // SAFETY: plain libsrt call.
    let raw = unsafe { (api.create_socket)() };
    if raw == libsrt::SRT_INVALID_SOCK {
        return Err(ListenError::port(format!(
            "Can't open an SRT socket: {}",
            api.last_error().1
        )));
    }
    let listener = OpenSocket { api, socket: raw };
    for option in listener_options(config) {
        set_option(api, listener.socket, &option).map_err(ListenError::port)?;
    }
    bind_all_interfaces(api, listener.socket, config.port).map_err(ListenError::port)?;
    let context: &CallbackContext = &context;
    // The callback goes on before `srt_listen`: libsrt refuses it on a socket
    // that already listens (`CUDT::installAcceptHook`, MN_ISCONNECTED), and
    // without it no caller is ever judged before its handshake completes.
    // SAFETY: the context outlives the listener socket (see above).
    let installed = unsafe {
        (api.listen_callback)(
            listener.socket,
            on_caller,
            (context as *const CallbackContext).cast_mut().cast(),
        )
    };
    if installed == libsrt::SRT_ERROR {
        return Err(ListenError::port(format!(
            "Can't judge callers on port {}: {}",
            config.port,
            api.last_error().1
        )));
    }
    // SAFETY: plain libsrt call on our socket.
    if unsafe { (api.listen)(listener.socket, 4) } == libsrt::SRT_ERROR {
        return Err(ListenError::port(format!(
            "Can't listen on port {}: {}",
            config.port,
            api.last_error().1
        )));
    }
    on_event(ListenerEvent::Listening);

    let mut sender: Option<OpenSocket<'_>> = None;
    let mut buffer = vec![0_u8; MESSAGE_BUFFER];
    let mut last_check = Instant::now() - ACCEPT_POLL;
    let mut last_data = Instant::now();
    while keep_running() {
        // A stream is thousands of messages a second: callers and refusals
        // are looked at on the poll interval, not on every message.
        if sender.is_none() || last_check.elapsed() >= ACCEPT_POLL {
            last_check = Instant::now();
            report_refusals(context, on_event);
            if let Some(active) = sender.as_ref() {
                // SAFETY: plain libsrt query on our socket.
                let state = unsafe { (api.getsockstate)(active.socket) };
                if socket_gone(state) {
                    let socket = active.socket;
                    tracing::info!("[srt-camera] sender {socket} released: its socket is {state}");
                    sender = None;
                    context
                        .gate
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .left(socket);
                    on_event(ListenerEvent::SenderLeft);
                } else {
                    context
                        .gate
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .heard(active.socket, last_data);
                }
            }
            // SAFETY: plain libsrt query on our socket.
            if unsafe { (api.getsockstate)(listener.socket) } != libsrt::SRTS_LISTENING {
                return Err(ListenError::stopped(
                    "The SRT listener closed by itself.".to_string(),
                ));
            }
            if let Some((caller, peer)) =
                accept_one(api, listener.socket).map_err(ListenError::stopped)?
            {
                // Set up before the gate sees it: a caller gone already (a
                // pairing check) never replaces the sender.
                if let Err(error) = set_option(
                    api,
                    caller.socket,
                    &SocketOption::Int(libsrt::SRTO_RCVSYN, 0),
                ) {
                    tracing::info!(
                        "[srt-camera] sender {} left before it was set up: {error}",
                        caller.socket
                    );
                } else if context
                    .gate
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .accepted(caller.socket, peer, Instant::now())
                    != Acceptance::Refused
                {
                    if let Some(previous) = sender.take() {
                        // The sender before it went quiet or redialed.
                        tracing::info!(
                            "[srt-camera] sender {} replaced by {}",
                            previous.socket,
                            caller.socket
                        );
                        on_event(ListenerEvent::SenderLeft);
                    }
                    let socket = caller.socket;
                    tracing::info!("[srt-camera] sender {socket} accepted");
                    sender = Some(caller);
                    last_data = Instant::now();
                    on_event(ListenerEvent::SenderAccepted(socket));
                } else {
                    tracing::info!(
                        "[srt-camera] sender {} refused: the camera is busy",
                        caller.socket
                    );
                    drop(caller);
                    on_event(ListenerEvent::Refused(SrtSenderRefusal::SecondSender));
                }
            }
        }
        let Some(active) = sender.as_ref() else {
            std::thread::sleep(ACCEPT_POLL);
            continue;
        };
        match receive(api, active.socket, &mut buffer) {
            Received::Data(bytes) => {
                last_data = Instant::now();
                on_event(ListenerEvent::Data(bytes));
            }
            Received::Nothing => std::thread::sleep(READ_POLL),
            Received::Left => {
                let socket = active.socket;
                tracing::info!("[srt-camera] sender {socket} left: {}", api.last_error().1);
                sender = None;
                context
                    .gate
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .left(socket);
                on_event(ListenerEvent::SenderLeft);
            }
        }
    }
    if sender.take().is_some() {
        on_event(ListenerEvent::SenderLeft);
    }
    Ok(())
}

enum Received {
    Data(Vec<u8>),
    Nothing,
    /// The sender left, with or without data (a pairing check): the next one
    /// may come in (D14).
    Left,
}

/// What `srt_recvmsg` returning `read` means, `error` naming libsrt's error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Data(usize),
    Nothing,
    Left,
}

fn receive_outcome(read: c_int, error: impl FnOnce() -> c_int) -> Outcome {
    if read > 0 {
        return Outcome::Data(read as usize);
    }
    if read == libsrt::SRT_ERROR && error() == libsrt::SRT_EASYNCRCV {
        return Outcome::Nothing;
    }
    Outcome::Left
}

fn receive(api: &Api, socket: SrtSocket, buffer: &mut [u8]) -> Received {
    // SAFETY: the buffer outlives the call and its length is exact.
    let read = unsafe { (api.recvmsg)(socket, buffer.as_mut_ptr().cast(), buffer.len() as c_int) };
    match receive_outcome(read, || api.last_error().0) {
        Outcome::Data(length) => Received::Data(buffer[..length].to_vec()),
        Outcome::Nothing => Received::Nothing,
        Outcome::Left => Received::Left,
    }
}

/// Room for any `sockaddr`, aligned for every one of them.
#[repr(C, align(8))]
struct AddressBuffer([u8; 128]);

impl AddressBuffer {
    /// The caller's IP address once `accept` wrote `length` bytes.
    fn peer(&self, length: c_int) -> Option<std::net::IpAddr> {
        if length <= 0 {
            return None;
        }
        // SAFETY: `accept` wrote a `sockaddr` of its family into the
        // aligned, zero-filled buffer, large enough for any of them.
        unsafe { peer_ip(self.0.as_ptr().cast()) }
    }
}

/// A sender `accept` returned, and the address it calls from.
type Accepted<'a> = (OpenSocket<'a>, Option<std::net::IpAddr>);

fn accept_one<'a>(api: &'a Api, listener: SrtSocket) -> Result<Option<Accepted<'a>>, String> {
    let mut address = AddressBuffer([0; 128]);
    let mut length = address.0.len() as c_int;
    // SAFETY: the address buffer outlives the call and its length is exact.
    let socket = unsafe { (api.accept)(listener, address.0.as_mut_ptr().cast(), &mut length) };
    match accept_outcome(socket, || api.last_error().0) {
        AcceptOutcome::Sender => Ok(Some((OpenSocket { api, socket }, address.peer(length)))),
        AcceptOutcome::NoneYet => Ok(None),
        AcceptOutcome::Failed(code) => Err(format!(
            "The SRT listener stopped accepting ({code}): {}",
            api.last_error().1
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcceptOutcome {
    Sender,
    NoneYet,
    /// The listener itself is broken: the receiver opens a new one (D18).
    Failed(c_int),
}

fn accept_outcome(socket: SrtSocket, error: impl FnOnce() -> c_int) -> AcceptOutcome {
    if socket != libsrt::SRT_INVALID_SOCK {
        return AcceptOutcome::Sender;
    }
    match error() {
        libsrt::SRT_EASYNCRCV => AcceptOutcome::NoneYet,
        code => AcceptOutcome::Failed(code),
    }
}

/// libsrt says the socket is broken or closed: its sender is gone (D18).
fn socket_gone(state: c_int) -> bool {
    matches!(
        state,
        libsrt::SRTS_BROKEN | libsrt::SRTS_CLOSING | libsrt::SRTS_CLOSED | libsrt::SRTS_NONEXIST
    )
}

fn report_refusals(context: &CallbackContext, on_event: &mut dyn FnMut(ListenerEvent)) {
    let second = std::mem::take(
        &mut *context
            .second_senders
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
    );
    if second > 0 {
        on_event(ListenerEvent::Refused(SrtSenderRefusal::SecondSender));
    }
    let refusals = libsrt::passphrase_refusals();
    let seen = context
        .passphrase_refusals_seen
        .swap(refusals, std::sync::atomic::Ordering::AcqRel);
    if refusals > seen {
        on_event(ListenerEvent::Refused(SrtSenderRefusal::WrongPassphrase));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_listener_refuses_a_second_sender_as_busy() {
        // libsrt 1.5.7 access_control.h: SRT_REJX_OVERLOAD is 1402.
        assert_eq!(reject_reason(Admission::Refuse), Some(1402));
        assert_eq!(reject_reason(Admission::Admit), None);
    }

    #[test]
    fn srt_listener_releases_a_sender_whose_socket_broke() {
        for gone in [
            libsrt::SRTS_BROKEN,
            libsrt::SRTS_CLOSING,
            libsrt::SRTS_CLOSED,
            libsrt::SRTS_NONEXIST,
        ] {
            assert!(socket_gone(gone), "state {gone}");
        }
        assert!(!socket_gone(libsrt::SRTS_CONNECTED));
    }

    #[test]
    fn srt_listener_sorts_accept_results_into_sender_none_yet_or_failed() {
        assert_eq!(accept_outcome(42, || 0), AcceptOutcome::Sender);
        assert_eq!(
            accept_outcome(libsrt::SRT_INVALID_SOCK, || libsrt::SRT_EASYNCRCV),
            AcceptOutcome::NoneYet
        );
        // SRT_EINVSOCK: the listening socket itself is gone.
        assert_eq!(
            accept_outcome(libsrt::SRT_INVALID_SOCK, || 5004),
            AcceptOutcome::Failed(5004)
        );
    }

    #[cfg(unix)]
    #[test]
    fn srt_listener_reads_the_callers_address() {
        // SAFETY: zeroed sockaddr structures are valid; the fields set below
        // make them a caller's address.
        let mut v4: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        v4.sin_family = libc::AF_INET as libc::sa_family_t;
        v4.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::new(192, 168, 1, 7)).to_be();
        let mut v6: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
        v6.sin6_family = libc::AF_INET6 as libc::sa_family_t;
        v6.sin6_addr.s6_addr = std::net::Ipv4Addr::new(10, 0, 0, 2)
            .to_ipv6_mapped()
            .octets();
        // SAFETY: each pointer is a full structure of its family, or null.
        unsafe {
            assert_eq!(
                peer_ip((&v4 as *const libc::sockaddr_in).cast()),
                Some(std::net::Ipv4Addr::new(192, 168, 1, 7).into())
            );
            assert_eq!(
                peer_ip((&v6 as *const libc::sockaddr_in6).cast()),
                Some(std::net::Ipv4Addr::new(10, 0, 0, 2).into()),
                "an IPv4 caller seen through IPv6 is the same address"
            );
            assert_eq!(peer_ip(std::ptr::null()), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn srt_listener_reads_the_address_accept_returns() {
        // SAFETY: a zeroed sockaddr_in is valid; the fields set below make
        // it a caller's address.
        let mut v4: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        v4.sin_family = libc::AF_INET as libc::sa_family_t;
        v4.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::new(192, 168, 1, 9)).to_be();
        let mut buffer = AddressBuffer([0; 128]);
        let length = std::mem::size_of::<libc::sockaddr_in>();
        // SAFETY: both sides are plain bytes and the buffer is larger.
        unsafe {
            std::ptr::copy_nonoverlapping(
                (&v4 as *const libc::sockaddr_in).cast::<u8>(),
                buffer.0.as_mut_ptr(),
                length,
            );
        }
        assert_eq!(
            buffer.peer(length as c_int),
            Some(std::net::Ipv4Addr::new(192, 168, 1, 9).into())
        );
        assert_eq!(buffer.peer(0), None, "accept wrote no address");
    }

    #[test]
    fn srt_listener_nothing_to_read_keeps_the_sender() {
        // A non-blocking read with nothing to read says SRT_EASYNCRCV: the
        // sender is still there.
        assert_eq!(
            receive_outcome(-1, || libsrt::SRT_EASYNCRCV),
            Outcome::Nothing
        );
        assert_eq!(receive_outcome(1316, || 0), Outcome::Data(1316));
        // SRT_ECONNLOST: the sender is gone.
        assert_eq!(receive_outcome(-1, || 2001), Outcome::Left);
        assert_eq!(receive_outcome(0, || 0), Outcome::Left);
    }

    /// The tests below run a real listener on the shipped libsrt, one at a
    /// time (they count process-wide callbacks and contexts).
    static REAL_LIBSRT: Mutex<()> = Mutex::new(());

    /// A free UDP port the OS picks: never 9000 or 9100.
    fn free_port() -> u16 {
        loop {
            let port = std::net::UdpSocket::bind("0.0.0.0:0")
                .and_then(|socket| socket.local_addr())
                .map(|address| address.port())
                .expect("a free port");
            if port != 9000 && port != 9100 {
                return port;
            }
        }
    }

    /// A local IPv4 address other than loopback and link-local, if any.
    fn second_local_address() -> Option<std::net::Ipv4Addr> {
        if_addrs::get_if_addrs()
            .ok()?
            .into_iter()
            .find_map(|interface| match interface.ip() {
                std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => Some(ip),
                _ => None,
            })
    }

    /// `second_local_address`, or None to skip a test that needs it. With
    /// `VIDEORC_REQUIRE_LIBSRT` set, a missing address fails the test
    /// instead of skipping it unseen.
    fn second_local_address_or_skip() -> Option<std::net::Ipv4Addr> {
        let other = second_local_address();
        if other.is_none() {
            assert!(
                std::env::var_os("VIDEORC_REQUIRE_LIBSRT").is_none(),
                "VIDEORC_REQUIRE_LIBSRT is set, but this machine has no local IPv4 address but loopback"
            );
            eprintln!("this machine has no local IPv4 address but loopback; not checked");
        }
        other
    }

    /// A listener on its own thread until `stop`, once it is listening, and
    /// every event it raises after that.
    fn start_recording_listener(
        config: ListenConfig,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> (
        std::thread::JoinHandle<()>,
        std::sync::mpsc::Receiver<ListenerEvent>,
    ) {
        let (send, events) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let keep_running = || !stop.load(std::sync::atomic::Ordering::Acquire);
            run(&config, &keep_running, &mut |event| {
                let _ = send.send(event);
            })
            .expect("the listener opens");
        });
        let listening = wait_for(&events, |event| *event == ListenerEvent::Listening);
        assert!(listening, "the listener is listening");
        (handle, events)
    }

    /// True once an event `wanted` takes arrives, within 2 s.
    fn wait_for(
        events: &std::sync::mpsc::Receiver<ListenerEvent>,
        wanted: impl Fn(&ListenerEvent) -> bool,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match events.recv_timeout(left) {
                Ok(event) if wanted(&event) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    /// Dials `host:port` as an SRT caller, unencrypted with an empty
    /// passphrase; the reject code when refused.
    #[cfg(unix)]
    fn dial(
        api: &Api,
        host: std::net::Ipv4Addr,
        port: u16,
        passphrase: &str,
    ) -> Result<SrtSocket, c_int> {
        // SAFETY: plain libsrt calls on a socket this test owns; the
        // address and passphrase outlive each call.
        unsafe {
            let socket = (api.create_socket)();
            if !passphrase.is_empty() {
                set_option(
                    api,
                    socket,
                    &SocketOption::Text(libsrt::SRTO_PASSPHRASE, passphrase.to_string()),
                )
                .expect("the passphrase is set");
            }
            let mut address: libc::sockaddr_in = std::mem::zeroed();
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                address.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
            }
            address.sin_family = libc::AF_INET as libc::sa_family_t;
            address.sin_port = port.to_be();
            address.sin_addr.s_addr = u32::from(host).to_be();
            let connected = (api.connect)(
                socket,
                (&address as *const libc::sockaddr_in).cast(),
                std::mem::size_of::<libc::sockaddr_in>() as c_int,
            );
            if connected == libsrt::SRT_ERROR {
                let reason = (api.getrejectreason)(socket);
                (api.close)(socket);
                return Err(reason);
            }
            Ok(socket)
        }
    }

    /// A listener on its own thread until `stop`, once it is listening.
    fn start_listener(
        config: ListenConfig,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> std::thread::JoinHandle<()> {
        let (ready, listening) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let keep_running = || !stop.load(std::sync::atomic::Ordering::Acquire);
            run(&config, &keep_running, &mut |event| {
                if event == ListenerEvent::Listening {
                    let _ = ready.send(());
                }
            })
            .expect("the listener opens");
        });
        listening
            .recv_timeout(Duration::from_secs(5))
            .expect("the listener is listening");
        handle
    }

    #[test]
    fn srt_listener_never_listens_without_a_passphrase() {
        let config = ListenConfig {
            passphrase: String::new(),
            ..test_config(9123)
        };
        let error = run(&config, &|| true, &mut |_| {
            panic!("no event without a passphrase")
        })
        .expect_err("refused");
        assert_eq!(error.trouble, ListenerTrouble::NoPassphrase);
    }

    /// libsrt for the real-listener tests, or None to skip them. With
    /// `VIDEORC_REQUIRE_LIBSRT` set (macOS CI installs libsrt), a missing
    /// library fails the test instead of skipping it unseen.
    fn real_libsrt() -> Option<&'static Api> {
        match libsrt::api() {
            Ok(api) => Some(api),
            Err(error) if std::env::var_os("VIDEORC_REQUIRE_LIBSRT").is_some() => {
                panic!("VIDEORC_REQUIRE_LIBSRT is set, but libsrt did not load: {error}")
            }
            Err(_) => {
                eprintln!("libsrt is missing on this machine; the real listener is not checked");
                None
            }
        }
    }

    fn test_config(port: u16) -> ListenConfig {
        ListenConfig {
            enabled: true,
            port,
            latency_ms: 40,
            passphrase: "real-listener-test-passphrase-01".to_string(),
        }
    }

    /// Would have caught the callback installed after `srt_listen` (which
    /// libsrt refuses): every caller must pass through it.
    #[cfg(unix)]
    #[test]
    fn srt_listener_judges_every_caller_in_its_callback() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = test_config(free_port());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let listener = start_listener(config.clone(), stop.clone());
        let calls_before = CALLBACK_CALLS.load(std::sync::atomic::Ordering::Acquire);
        let caller = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        )
        .expect("the first caller is let in");
        let calls_after = CALLBACK_CALLS.load(std::sync::atomic::Ordering::Acquire);
        // SAFETY: the caller's socket is this test's.
        unsafe { (api.close)(caller) };
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        assert!(
            calls_after > calls_before,
            "libsrt asked the listen callback about the caller"
        );
    }

    /// D14, D18: while a sender sends, a caller from another address is
    /// refused with exactly SRT_REJX_OVERLOAD (1402, "busy"), and a redial
    /// from the sender's own address takes over at once.
    #[cfg(unix)]
    #[test]
    fn srt_listener_refuses_another_address_with_1402_and_lets_a_redial_in() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let Some(other) = second_local_address_or_skip() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = test_config(free_port());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let listener = start_listener(config.clone(), stop.clone());
        let first = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        )
        .expect("the first sender is let in");
        let sending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let feeder = {
            let sending = sending.clone();
            std::thread::spawn(move || {
                let packet = [0x47_u8; 188];
                while sending.load(std::sync::atomic::Ordering::Acquire) {
                    // SAFETY: the buffer outlives the call; the socket is
                    // the test's.
                    unsafe {
                        (api.sendmsg2)(first, packet.as_ptr().cast(), 188, std::ptr::null_mut())
                    };
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        let busy = dial(api, other, config.port, &config.passphrase);
        let redial = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        );
        sending.store(false, std::sync::atomic::Ordering::Release);
        feeder.join().expect("the feeder stops");
        // SAFETY: the sockets are this test's.
        unsafe {
            (api.close)(first);
            if let Ok(redial) = redial {
                (api.close)(redial);
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        assert_eq!(
            busy,
            Err(1402),
            "another address is told the camera is busy"
        );
        assert!(
            redial.is_ok(),
            "a redial from the sender's own address gets in at once"
        );
    }

    /// libsrt runs the listen callback before it checks the passphrase: a
    /// redial with a wrong one, from the live sender's own address, must
    /// neither replace nor drop that sender.
    #[cfg(unix)]
    #[test]
    fn srt_listener_a_wrong_passphrase_redial_leaves_the_live_sender() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = test_config(free_port());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // (accepted, left) while the test's own sender is still open.
        let seen = std::sync::Arc::new(Mutex::new((0_u32, 0_u32)));
        let (ready, listening) = std::sync::mpsc::channel();
        let listener = {
            let (config, stop, closing, seen) =
                (config.clone(), stop.clone(), closing.clone(), seen.clone());
            std::thread::spawn(move || {
                let keep_running = || !stop.load(std::sync::atomic::Ordering::Acquire);
                run(&config, &keep_running, &mut |event| {
                    let open = !closing.load(std::sync::atomic::Ordering::Acquire);
                    let mut seen = seen.lock().unwrap();
                    match event {
                        ListenerEvent::Listening => {
                            let _ = ready.send(());
                        }
                        ListenerEvent::SenderAccepted(_) if open => seen.0 += 1,
                        ListenerEvent::SenderLeft if open => seen.1 += 1,
                        _ => {}
                    }
                })
                .expect("the listener opens");
            })
        };
        listening
            .recv_timeout(Duration::from_secs(5))
            .expect("the listener is listening");
        let first = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        )
        .expect("the sender is let in");
        let sending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let feeder = {
            let sending = sending.clone();
            std::thread::spawn(move || {
                let packet = [0x47_u8; 188];
                while sending.load(std::sync::atomic::Ordering::Acquire) {
                    // SAFETY: the buffer outlives the call; the socket is
                    // the test's.
                    unsafe {
                        (api.sendmsg2)(first, packet.as_ptr().cast(), 188, std::ptr::null_mut())
                    };
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        let wrong = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            "not-the-passphrase-of-this-test0",
        );
        std::thread::sleep(Duration::from_millis(300));
        closing.store(true, std::sync::atomic::Ordering::Release);
        sending.store(false, std::sync::atomic::Ordering::Release);
        feeder.join().expect("the feeder stops");
        // SAFETY: the sockets are this test's.
        unsafe {
            (api.close)(first);
            if let Ok(wrong) = wrong {
                (api.close)(wrong);
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        assert_eq!(
            wrong,
            Err(SRT_REJ_BADSECRET),
            "a wrong passphrase is refused as one"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            (1, 0),
            "the live sender was neither replaced nor dropped"
        );
    }

    /// libsrt's reject reasons a caller reads (srt.h `SRT_REJECT_REASON`).
    const SRT_REJ_BADSECRET: c_int = 10;
    const SRT_REJ_UNSECURE: c_int = 11;

    /// D4: a caller with a wrong passphrase or none is refused, and the
    /// camera says so (its only source is libsrt's log).
    #[cfg(unix)]
    #[test]
    fn srt_listener_refuses_a_wrong_or_missing_passphrase_and_says_so() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = test_config(free_port());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (listener, events) = start_recording_listener(config.clone(), stop.clone());
        let wrong = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            "not-the-passphrase-of-this-test0",
        );
        let said = wait_for(&events, |event| {
            *event == ListenerEvent::Refused(SrtSenderRefusal::WrongPassphrase)
        });
        let none = dial(api, std::net::Ipv4Addr::LOCALHOST, config.port, "");
        let said_none = wait_for(&events, |event| {
            *event == ListenerEvent::Refused(SrtSenderRefusal::WrongPassphrase)
        });
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        // SAFETY: the sockets are this test's.
        unsafe {
            for socket in [wrong, none].into_iter().flatten() {
                (api.close)(socket);
            }
        }
        assert_eq!(
            wrong,
            Err(SRT_REJ_BADSECRET),
            "a wrong passphrase is refused"
        );
        assert_eq!(
            none,
            Err(SRT_REJ_UNSECURE),
            "a caller without one is refused"
        );
        assert!(said, "the camera says the passphrase was wrong");
        assert!(said_none, "and says so for a caller without one");
    }

    /// D14: once a sender leaves, a caller from another address gets in at
    /// once, and the camera hears the first one leave before it.
    #[cfg(unix)]
    #[test]
    fn srt_listener_a_sender_that_left_frees_the_camera_for_another_address() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let Some(other) = second_local_address_or_skip() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = test_config(free_port());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (listener, events) = start_recording_listener(config.clone(), stop.clone());
        let accepted = |event: &ListenerEvent| matches!(event, ListenerEvent::SenderAccepted(_));
        let first = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        )
        .expect("the first sender is let in");
        let first_accepted = wait_for(&events, accepted);
        // SAFETY: the socket is this test's.
        unsafe { (api.close)(first) };
        // The camera hears the first sender leave, then the next one dials.
        let left = wait_for(&events, |event| *event == ListenerEvent::SenderLeft);
        let next = dial(api, other, config.port, &config.passphrase);
        let next_accepted = wait_for(&events, accepted);
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        if let Ok(next) = next {
            // SAFETY: the socket is this test's.
            unsafe { (api.close)(next) };
        }
        assert!(first_accepted, "the first sender is accepted");
        assert!(next.is_ok(), "the next sender gets in at once: {next:?}");
        assert!(left, "the camera hears the first sender leave");
        assert!(next_accepted, "then it accepts the next sender");
    }

    /// Needs libsrt (staged or Homebrew); without it there is nothing to check.
    #[test]
    fn srt_listener_frees_its_callback_context_after_closing() {
        if real_libsrt().is_none() {
            return;
        }
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let before = LIVE_CONTEXTS.load(std::sync::atomic::Ordering::Acquire);
        let config = ListenConfig {
            enabled: true,
            // The OS picks a free port: never 9000 or 9100.
            port: 0,
            latency_ms: 40,
            passphrase: "teardown-test-passphrase-0123456".to_string(),
        };
        for _ in 0..3 {
            let listening = std::cell::Cell::new(false);
            run(&config, &|| !listening.get(), &mut |event| {
                if event == ListenerEvent::Listening {
                    listening.set(true);
                }
            })
            .expect("the listener opens");
            assert!(listening.get());
        }
        assert_eq!(
            LIVE_CONTEXTS.load(std::sync::atomic::Ordering::Acquire),
            before,
            "every listener frees its callback context once its socket is closed"
        );
    }

    #[test]
    fn srt_listener_options_follow_the_setting() {
        let config = ListenConfig {
            enabled: true,
            port: 9100,
            latency_ms: 120,
            passphrase: "x".repeat(32),
        };
        assert_eq!(
            listener_options(&config),
            vec![
                SocketOption::Int(libsrt::SRTO_TRANSTYPE, libsrt::SRTT_LIVE),
                SocketOption::Int(libsrt::SRTO_RCVLATENCY, 120),
                SocketOption::Int(libsrt::SRTO_PEERLATENCY, 120),
                SocketOption::Text(libsrt::SRTO_PASSPHRASE, "x".repeat(32)),
                SocketOption::Int(libsrt::SRTO_ENFORCEDENCRYPTION, 1),
                SocketOption::Int(libsrt::SRTO_MINVERSION, 0x01_03_00),
                SocketOption::Int(libsrt::SRTO_RCVSYN, 0),
            ]
        );
    }

    /// libsrt 1.5.7 wakes a blocking reader only on its next full ACK, which
    /// comes about 10 ms after the last packet of a burst (core.cpp
    /// `checkACKTimer`, queue.cpp's idle sweep). Each message must reach the
    /// camera as soon as it arrives.
    #[cfg(unix)]
    #[test]
    fn srt_listener_hands_on_each_message_without_waiting_for_an_ack() {
        let Some(api) = real_libsrt() else {
            return;
        };
        let _one_at_a_time = REAL_LIBSRT.lock().unwrap_or_else(PoisonError::into_inner);
        let config = ListenConfig {
            latency_ms: 0,
            ..test_config(free_port())
        };
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (ready, listening) = std::sync::mpsc::channel();
        let (data, arrivals) = std::sync::mpsc::channel();
        let listener = {
            let config = config.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let keep_running = || !stop.load(std::sync::atomic::Ordering::Acquire);
                run(&config, &keep_running, &mut |event| match event {
                    ListenerEvent::Listening => {
                        let _ = ready.send(());
                    }
                    ListenerEvent::Data(_) => {
                        let _ = data.send(Instant::now());
                    }
                    _ => {}
                })
                .expect("the listener opens");
            })
        };
        listening
            .recv_timeout(Duration::from_secs(5))
            .expect("the listener is listening");
        let sender = dial(
            api,
            std::net::Ipv4Addr::LOCALHOST,
            config.port,
            &config.passphrase,
        )
        .expect("the sender is let in");
        std::thread::sleep(Duration::from_millis(200));
        let packet = [0x47_u8; 188];
        let mut delays = Vec::new();
        for _ in 0..20 {
            let sent = Instant::now();
            // SAFETY: the buffer outlives the call; the socket is the test's.
            unsafe { (api.sendmsg2)(sender, packet.as_ptr().cast(), 188, std::ptr::null_mut()) };
            let arrived = arrivals
                .recv_timeout(Duration::from_secs(1))
                .expect("the message arrives");
            delays.push(arrived.duration_since(sent));
            std::thread::sleep(Duration::from_millis(30));
        }
        // SAFETY: the socket is this test's.
        unsafe { (api.close)(sender) };
        stop.store(true, std::sync::atomic::Ordering::Release);
        listener.join().expect("the listener stops");
        delays.sort();
        let median = delays[delays.len() / 2];
        assert!(
            median < Duration::from_millis(5),
            "a message took {median:?} (median) to reach the camera"
        );
    }
}
