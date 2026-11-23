//! Plan 260 S0.3: plan 220's Linux presenter, copied from
//! TheOrcDev/videorc-rust `crates/videorc-preview/src/linux.rs` at
//! 2c96c499, with three changes for GPUI: `Options::below` places the
//! subsurface below the host's own surface (GPUI draws over the video
//! through a transparent hole), `Options::presentation` asks
//! `wp_presentation` for on-screen feedback per frame, and the protocol
//! types are local. "winit" and "Slint" below read as GPUI's window.
//!
//! Plan 220 S4.2c: the Linux presenter, the route P4-D2 chose: the backend's
//! CPU-composed frames, already whole BGRA pixels in the shared-memory ring
//! (`videorc-preview-ring`, S4.1d), put on the screen by the display server
//! itself, outside Slint's redraw.
//!
//! - **Wayland:** a `wl_subsurface` of the host window's own `wl_surface`,
//!   fed by a `wl_shm` pool over the ring's memory file, one `wl_buffer` per
//!   slot. A frame is `attach` + `damage` + `commit` of the leased slot; the
//!   lease is held until the compositor's `release` (the reader thread
//!   waits on the report). Viewporter scales the buffer to the slot on the
//!   compositor's side; the subsurface follows the slot through
//!   `set_position` (applied with the parent's commit, the same frame Slint
//!   lays the slot out) and `set_destination`. The app copies no pixels.
//! - **X11** (XWayland on ogre; a real X server speaks the same
//!   extensions): a child window of the host window, fed by MIT-SHM 1.2 fd
//!   passing over the same memory file. A frame is one `shm::put_image`
//!   from the slot's offset into a pixmap of the frame's size, then an
//!   XRender composite of that pixmap, scaled to the child, so the picture
//!   fits the slot as viewporter fits it on Wayland. The `ShmCompletion`
//!   event is the release.
//!
//! Both are the "layer route" of the element on Linux, named
//! `wl-shm-subsurface` or `x11-shm-child-window` in the surface's status:
//! a CPU preview on a shared-memory surface, never a native GPU surface
//! (PF3). Slint's texture route (S4.1d) is the fallback when neither window
//! system is there, and the editor's route.
//!
//! The presenter owns one thread: it connects (Wayland: winit's own display,
//! with a queue of its own; X11: a connection of its own), builds the child,
//! and then serves commands: the ring to map, a frame to show, the slot's
//! rect, hidden or shown. The window handles are read on the UI thread and
//! cross as integers, as the spike did (`crates/videorc-spike-slint`,
//! S4.2b).

// Kept whole from videorc-rust for S2.3c: the spike uses no hide/show.
#![allow(dead_code)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use videorc_preview_ring::RingInfo;

/// A rect in the host window, logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Plan 260 S0.3: how the spike runs the presenter.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Wayland: the subsurface goes below the host's own surface, so the
    /// host draws over the video wherever it paints (its hole shows it).
    pub below: bool,
    /// Wayland: ask `wp_presentation` for feedback on each commit (one more
    /// event per frame on the shared display).
    pub presentation: bool,
}

pub static OPTIONS: std::sync::OnceLock<Options> = std::sync::OnceLock::new();

/// What the compositor said about each committed frame (`wp_presentation`).
#[derive(Debug, Default)]
pub struct PresentationLog {
    /// (frame id, presented at, CLOCK_MONOTONIC micros, refresh ns, flags)
    pub presented: Vec<(u64, u64, u32, u32)>,
    pub discarded: u64,
    pub clock_id: Option<u32>,
}

pub static PRESENTATION: std::sync::Mutex<PresentationLog> =
    std::sync::Mutex::new(PresentationLog {
        presented: Vec::new(),
        discarded: 0,
        clock_id: None,
    });

/// How long `attach` waits for the thread to connect and build the child.
const ATTACH_WAIT: Duration = Duration::from_secs(5);
/// How long a frame's buffer may stay with the server before the lease is
/// given back anyway (the writer has two other slots).
const RELEASE_WAIT: Duration = Duration::from_millis(250);
/// The thread's idle poll: it wakes for a command, a server event, or this.
const IDLE_POLL: Duration = Duration::from_millis(250);

/// A host window the presenter can attach to: it needs the window's handle
/// (the `wl_surface`, the X11 window) and the display's (the `wl_display`).
pub trait NativeHost: HasWindowHandle + HasDisplayHandle {}

impl<T: HasWindowHandle + HasDisplayHandle + ?Sized> NativeHost for T {}

/// Which window system hosts the frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backing {
    /// A `wl_subsurface` over a `wl_shm` pool on the ring.
    WaylandSubsurface,
    /// An X11 child window fed by MIT-SHM over the ring.
    X11ChildWindow,
}

impl Backing {
    pub fn as_str(self) -> &'static str {
        match self {
            Backing::WaylandSubsurface => "wl_subsurface over the shared-memory ring (wl_shm)",
            Backing::X11ChildWindow => "X11 child window over the shared-memory ring (MIT-SHM)",
        }
    }
}

/// What the presenter did with one frame.
#[derive(Debug, Clone)]
pub struct PresentReport {
    pub frame_id: u64,
    /// The thread picked the frame up.
    pub started_at: Instant,
    /// The buffer was committed to the server (`None`: nothing was shown,
    /// the reason in `error`, or the child is hidden).
    pub committed_at: Option<Instant>,
    /// The server gave the slot's buffer back before the wait ran out; the
    /// lease may go either way once the report arrives.
    pub released: bool,
    /// Shown on screen (a hidden child acknowledges the frame and draws
    /// nothing).
    pub shown: bool,
    pub error: Option<String>,
}

/// The window's native handles, as integers for the presenter thread.
#[derive(Debug, Clone, Copy)]
struct NativeHandles {
    wayland_display: usize,
    wayland_surface: usize,
    x11_window: u32,
}

fn native_handles(window: &dyn NativeHost) -> Result<NativeHandles, String> {
    let raw_window = window
        .window_handle()
        .map_err(|error| format!("no window handle: {error}"))?
        .as_raw();
    let raw_display = window
        .display_handle()
        .map_err(|error| format!("no display handle: {error}"))?
        .as_raw();
    let mut handles = NativeHandles {
        wayland_display: 0,
        wayland_surface: 0,
        x11_window: 0,
    };
    match raw_window {
        RawWindowHandle::Wayland(wayland) => {
            handles.wayland_surface = wayland.surface.as_ptr() as usize;
        }
        RawWindowHandle::Xlib(xlib) => handles.x11_window = xlib.window as u32,
        RawWindowHandle::Xcb(xcb) => handles.x11_window = xcb.window.get(),
        other => return Err(format!("an unexpected window handle: {other:?}")),
    }
    if let RawDisplayHandle::Wayland(wayland) = raw_display {
        handles.wayland_display = wayland.display.as_ptr() as usize;
    }
    Ok(handles)
}

/// The slot's rect in the host window, logical points, and the window's
/// scale (X11 places in device pixels).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub rect: LayerRect,
    pub scale: f64,
}

/// The ring the reader has mapped, for the presenter's own view of it: a
/// duplicate of the memory file's descriptor (valid while this lives,
/// whatever the backend does with its own) and the layout.
pub struct RingMapping {
    pub fd: OwnedFd,
    pub info: RingInfo,
}

enum Command {
    /// The ring to build buffers over (`None` takes them down).
    Ring(Option<RingMapping>),
    Present {
        slot: u32,
        frame_id: u64,
        reply: Sender<PresentReport>,
    },
    Place(Placement),
    Hidden(bool),
    Quit,
}

/// A pipe the client rings so the thread's poll wakes for a command.
struct Doorbell {
    read: OwnedFd,
    write: OwnedFd,
}

impl Doorbell {
    fn new() -> Result<Self, String> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: a two-element array for pipe2.
        let made = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if made != 0 {
            return Err(format!(
                "the presenter's doorbell pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: pipe2 gave two fresh descriptors this struct now owns.
        Ok(unsafe {
            Self {
                read: OwnedFd::from_raw_fd(fds[0]),
                write: OwnedFd::from_raw_fd(fds[1]),
            }
        })
    }

    fn ring(&self) {
        let byte = [1_u8];
        // SAFETY: one byte from a live buffer into an open pipe; a full
        // pipe (EAGAIN) means the thread is already due to wake.
        let _ = unsafe { libc::write(self.write.as_raw_fd(), byte.as_ptr().cast(), 1) };
    }

    fn drain(&self) {
        let mut sink = [0_u8; 64];
        loop {
            // SAFETY: reads into a live buffer of the given size.
            let read = unsafe { libc::read(self.read.as_raw_fd(), sink.as_mut_ptr().cast(), 64) };
            if read <= 0 {
                break;
            }
        }
    }
}

/// The `Send` half: what the ring's reader thread needs to show frames and
/// name the ring.
#[derive(Clone)]
pub struct PresenterClient {
    commands: Sender<Command>,
    bell: Arc<Doorbell>,
    backing: Backing,
}

impl PresenterClient {
    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
        self.bell.ring();
    }

    /// The ring whose slots the buffers map; `None` takes them down.
    pub fn set_ring(&self, ring: Option<RingMapping>) {
        self.send(Command::Ring(ring));
    }

    /// Hands a leased slot to the thread. The receiver yields once the
    /// server has released the slot (or the wait ran out), so the lease may
    /// go back as soon as the report arrives.
    pub fn present(&self, slot: u32, frame_id: u64) -> Receiver<PresentReport> {
        let (reply, receiver) = mpsc::channel();
        self.send(Command::Present {
            slot,
            frame_id,
            reply,
        });
        receiver
    }

    pub fn backing(&self) -> Backing {
        self.backing
    }
}

/// The presenter: its own thread, its child surface or window in the host
/// window, taken down with it.
pub struct Presenter {
    client: PresenterClient,
    thread: Option<JoinHandle<()>>,
    placement: Option<Placement>,
    hidden: bool,
}

impl Presenter {
    /// Builds the child in `window`: a subsurface under Wayland, a child
    /// window under X11, or the reason neither could be (the caller's
    /// fallback is the texture route, named).
    pub fn attach(window: &dyn NativeHost) -> Result<Self, String> {
        let handles = native_handles(window)?;
        let bell = Arc::new(Doorbell::new()?);
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Backing, String>>();
        let thread_bell = bell.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-linux-presenter".to_string())
            .spawn(move || {
                if handles.wayland_display != 0 && handles.wayland_surface != 0 {
                    match wayland::Child::build(handles) {
                        Ok(child) => {
                            let _ = ready_tx.send(Ok(Backing::WaylandSubsurface));
                            child.run(inbox, &thread_bell);
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(format!("Wayland subsurface: {error}")));
                        }
                    }
                } else if handles.x11_window != 0 {
                    match x11::Child::build(handles) {
                        Ok(child) => {
                            let _ = ready_tx.send(Ok(Backing::X11ChildWindow));
                            child.run(inbox, &thread_bell);
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(format!("X11 child window: {error}")));
                        }
                    }
                } else {
                    let _ = ready_tx.send(Err(
                        "the window is neither a Wayland surface nor an X11 window".to_string(),
                    ));
                }
            })
            .map_err(|error| format!("spawning the presenter thread: {error}"))?;
        let backing = match ready_rx.recv_timeout(ATTACH_WAIT) {
            Ok(Ok(backing)) => backing,
            Ok(Err(error)) => {
                let _ = thread.join();
                return Err(error);
            }
            Err(_) => {
                return Err(format!(
                    "the presenter thread did not connect within {ATTACH_WAIT:?}"
                ));
            }
        };
        Ok(Self {
            client: PresenterClient {
                commands,
                bell,
                backing,
            },
            thread: Some(thread),
            placement: None,
            hidden: false,
        })
    }

    pub fn client(&self) -> PresenterClient {
        self.client.clone()
    }

    pub fn backing(&self) -> Backing {
        self.client.backing
    }

    /// Moves the child onto the slot's rect. Returns true when it changed.
    pub fn set_placement(&mut self, placement: Placement) -> bool {
        if self.placement == Some(placement) {
            return false;
        }
        self.placement = Some(placement);
        self.client.send(Command::Place(placement));
        true
    }

    /// The child again where it is (`present-kick`).
    pub fn reapply_placement(&self) {
        if let Some(placement) = self.placement {
            self.client.send(Command::Place(placement));
        }
    }

    pub fn placement(&self) -> Option<Placement> {
        self.placement
    }

    /// Hidden: the child shows nothing (the host's decision: a sheet over
    /// the slot, the Preview in another window); shown: the next frame.
    pub fn set_hidden(&mut self, hidden: bool) {
        if self.hidden == hidden {
            return;
        }
        self.hidden = hidden;
        self.client.send(Command::Hidden(hidden));
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden
    }
}

impl Drop for Presenter {
    fn drop(&mut self) {
        self.client.send(Command::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Polls `fds` until one is readable or `timeout` passes; the answer says
/// which (bit `i` for `fds[i]`).
fn poll_readable(fds: &[libc::c_int], timeout: Duration) -> u32 {
    let mut polls: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    // SAFETY: a live array of pollfds of the given length, a bounded wait.
    let ready = unsafe {
        libc::poll(
            polls.as_mut_ptr(),
            polls.len() as libc::nfds_t,
            timeout.as_millis().min(i32::MAX as u128) as i32,
        )
    };
    if ready <= 0 {
        return 0;
    }
    polls
        .iter()
        .enumerate()
        .filter(|(_, poll)| poll.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
        .fold(0, |mask, (index, _)| mask | (1 << index))
}

fn report(
    frame_id: u64,
    started_at: Instant,
    committed_at: Option<Instant>,
    released: bool,
    shown: bool,
    error: Option<String>,
) -> PresentReport {
    PresentReport {
        frame_id,
        started_at,
        committed_at,
        released,
        shown,
        error,
    }
}

mod wayland {
    //! The `wl_subsurface` half.

    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    use wayland_client::backend::{Backend, ObjectId};
    use wayland_client::globals::{GlobalListContents, registry_queue_init};
    use wayland_client::protocol::wl_buffer::{self, WlBuffer};
    use wayland_client::protocol::wl_compositor::WlCompositor;
    use wayland_client::protocol::wl_region::WlRegion;
    use wayland_client::protocol::wl_registry::WlRegistry;
    use wayland_client::protocol::wl_shm::{self, WlShm};
    use wayland_client::protocol::wl_shm_pool::WlShmPool;
    use wayland_client::protocol::wl_subcompositor::WlSubcompositor;
    use wayland_client::protocol::wl_subsurface::WlSubsurface;
    use wayland_client::protocol::wl_surface::WlSurface;
    use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle, delegate_noop};
    use wayland_protocols::wp::presentation_time::client::wp_presentation::{self, WpPresentation};
    use wayland_protocols::wp::presentation_time::client::wp_presentation_feedback::{
        self, WpPresentationFeedback,
    };
    use wayland_protocols::wp::viewporter::client::wp_viewport::WpViewport;
    use wayland_protocols::wp::viewporter::client::wp_viewporter::WpViewporter;

    use super::{
        Command, Doorbell, IDLE_POLL, NativeHandles, Placement, RELEASE_WAIT, RingMapping,
        poll_readable, report,
    };

    /// The dispatch state: which slots the compositor has given back.
    struct State {
        released: Vec<bool>,
    }

    impl Dispatch<WlRegistry, GlobalListContents> for State {
        fn event(
            _: &mut Self,
            _: &WlRegistry,
            _: wayland_client::protocol::wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<WlBuffer, usize> for State {
        fn event(
            state: &mut Self,
            _: &WlBuffer,
            event: wl_buffer::Event,
            slot: &usize,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_buffer::Event::Release = event
                && let Some(released) = state.released.get_mut(*slot)
            {
                *released = true;
            }
        }
    }

    impl Dispatch<WpPresentation, ()> for State {
        fn event(
            _: &mut Self,
            _: &WpPresentation,
            event: wp_presentation::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wp_presentation::Event::ClockId { clk_id } = event {
                super::PRESENTATION.lock().unwrap().clock_id = Some(clk_id);
            }
        }
    }

    impl Dispatch<WpPresentationFeedback, u64> for State {
        fn event(
            _: &mut Self,
            _: &WpPresentationFeedback,
            event: wp_presentation_feedback::Event,
            frame_id: &u64,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                wp_presentation_feedback::Event::Presented {
                    tv_sec_hi,
                    tv_sec_lo,
                    tv_nsec,
                    refresh,
                    flags,
                    ..
                } => {
                    let secs = (u64::from(tv_sec_hi) << 32) | u64::from(tv_sec_lo);
                    let micros = secs * 1_000_000 + u64::from(tv_nsec) / 1000;
                    let flags = match flags {
                        wayland_client::WEnum::Value(value) => value.bits(),
                        wayland_client::WEnum::Unknown(value) => value,
                    };
                    super::PRESENTATION
                        .lock()
                        .unwrap()
                        .presented
                        .push((*frame_id, micros, refresh, flags));
                }
                wp_presentation_feedback::Event::Discarded => {
                    super::PRESENTATION.lock().unwrap().discarded += 1;
                }
                _ => {}
            }
        }
    }

    delegate_noop!(State: ignore WlCompositor);
    delegate_noop!(State: ignore WlSubcompositor);
    delegate_noop!(State: ignore WlShm);
    delegate_noop!(State: ignore WlShmPool);
    delegate_noop!(State: ignore WlSurface);
    delegate_noop!(State: ignore WlSubsurface);
    delegate_noop!(State: ignore WlRegion);
    delegate_noop!(State: ignore WpViewporter);
    delegate_noop!(State: ignore WpViewport);

    /// The buffers over one ring.
    struct Pool {
        info: videorc_preview_ring::RingInfo,
        _fd: std::os::fd::OwnedFd,
        _pool: WlShmPool,
        buffers: Vec<WlBuffer>,
    }

    impl Drop for Pool {
        fn drop(&mut self) {
            for buffer in &self.buffers {
                buffer.destroy();
            }
            self._pool.destroy();
        }
    }

    pub(super) struct Child {
        conn: Connection,
        queue: EventQueue<State>,
        state: State,
        shm: WlShm,
        child: WlSurface,
        subsurface: WlSubsurface,
        viewport: WpViewport,
        presentation: Option<WpPresentation>,
        pool: Option<Pool>,
        placement: Option<Placement>,
        hidden: bool,
        /// The slot last attached, so a show after a hide re-attaches it.
        attached: Option<usize>,
    }

    impl Child {
        pub(super) fn build(handles: NativeHandles) -> Result<Self, String> {
            // SAFETY: winit's live display pointer; the connection is not
            // owned (winit closes it) and outlives this thread, which the
            // presenter's drop joins before the window goes.
            let backend =
                unsafe { Backend::from_foreign_display(handles.wayland_display as *mut _) };
            let conn = Connection::from_backend(backend);
            let (globals, queue) = registry_queue_init::<State>(&conn)
                .map_err(|error| format!("registry: {error}"))?;
            let qh = queue.handle();
            let compositor: WlCompositor = globals
                .bind(&qh, 4..=6, ())
                .map_err(|error| format!("wl_compositor: {error}"))?;
            let subcompositor: WlSubcompositor = globals
                .bind(&qh, 1..=1, ())
                .map_err(|error| format!("wl_subcompositor: {error}"))?;
            let shm: WlShm = globals
                .bind(&qh, 1..=1, ())
                .map_err(|error| format!("wl_shm: {error}"))?;
            let viewporter: WpViewporter = globals
                .bind(&qh, 1..=1, ())
                .map_err(|error| format!("wp_viewporter: {error}"))?;
            // SAFETY: winit's live wl_surface pointer for this window.
            let parent_id = unsafe {
                ObjectId::from_ptr(WlSurface::interface(), handles.wayland_surface as *mut _)
            }
            .map_err(|error| format!("the parent surface id: {error}"))?;
            let parent = WlSurface::from_id(&conn, parent_id)
                .map_err(|error| format!("the parent surface: {error}"))?;
            let child = compositor.create_surface(&qh, ());
            // Input goes through to the host (the slot's own clicks stay
            // Slint's): an empty input region.
            let region = compositor.create_region(&qh, ());
            child.set_input_region(Some(&region));
            region.destroy();
            let subsurface = subcompositor.get_subsurface(&child, &parent, &qh, ());
            subsurface.set_desync();
            let options = super::OPTIONS.get().copied().unwrap_or_default();
            if options.below {
                // Applied with the parent's next commit (GPUI's next frame).
                subsurface.place_below(&parent);
            }
            let presentation: Option<WpPresentation> = if options.presentation {
                globals.bind(&qh, 1..=1, ()).ok()
            } else {
                None
            };
            let viewport = viewporter.get_viewport(&child, &qh, ());
            Ok(Self {
                conn,
                queue,
                state: State {
                    released: Vec::new(),
                },
                shm,
                child,
                subsurface,
                viewport,
                presentation,
                pool: None,
                placement: None,
                hidden: false,
                attached: None,
            })
        }

        /// Dispatches this queue's events for up to `timeout`, waking early
        /// for a command.
        fn dispatch_for(&mut self, bell: &Doorbell, timeout: Duration) -> Result<(), String> {
            self.queue
                .dispatch_pending(&mut self.state)
                .map_err(|error| format!("dispatch: {error}"))?;
            self.queue
                .flush()
                .map_err(|error| format!("flush: {error}"))?;
            let Some(guard) = self.conn.prepare_read() else {
                self.queue
                    .dispatch_pending(&mut self.state)
                    .map_err(|error| format!("dispatch: {error}"))?;
                return Ok(());
            };
            let fd = guard.connection_fd();
            let ready = poll_readable(
                &[
                    std::os::fd::AsRawFd::as_raw_fd(&fd),
                    std::os::fd::AsRawFd::as_raw_fd(&bell.read),
                ],
                timeout,
            );
            // Only the display's own readiness is read: libwayland's read
            // waits for every thread that prepared one (winit's included),
            // so a read on the doorbell alone would stall until winit's
            // loop next wakes.
            if ready & 1 != 0 {
                let _ = guard.read();
            } else {
                drop(guard);
            }
            self.queue
                .dispatch_pending(&mut self.state)
                .map_err(|error| format!("dispatch: {error}"))?;
            Ok(())
        }

        fn set_ring(&mut self, ring: Option<RingMapping>) -> Result<(), String> {
            self.pool = None;
            self.attached = None;
            self.child.attach(None, 0, 0);
            self.child.commit();
            let Some(ring) = ring else {
                return Ok(());
            };
            let info = ring.info;
            let qh = self.queue.handle();
            let pool = self.shm.create_pool(
                std::os::fd::AsFd::as_fd(&ring.fd),
                info.total_bytes as i32,
                &qh,
                (),
            );
            let buffers: Vec<WlBuffer> = (0..info.slot_count)
                .map(|slot| {
                    pool.create_buffer(
                        info.slot_start(slot) as i32,
                        info.width as i32,
                        info.height as i32,
                        info.stride as i32,
                        wl_shm::Format::Argb8888,
                        &qh,
                        slot as usize,
                    )
                })
                .collect();
            self.state.released = vec![true; info.slot_count as usize];
            self.pool = Some(Pool {
                info,
                _fd: ring.fd,
                _pool: pool,
                buffers,
            });
            Ok(())
        }

        fn place(&mut self, placement: Placement) {
            self.placement = Some(placement);
            let rect = placement.rect;
            self.subsurface
                .set_position(rect.x.round() as i32, rect.y.round() as i32);
            self.viewport.set_destination(
                rect.width.round().max(1.0) as i32,
                rect.height.round().max(1.0) as i32,
            );
            // The destination is the child's state and applies on its
            // commit; the position applies with the parent's next commit
            // (Slint's redraw of the new layout).
            self.child.commit();
        }

        fn attach_slot(&mut self, slot: usize) -> bool {
            self.attach_slot_for(slot, 0)
        }

        fn attach_slot_for(&mut self, slot: usize, frame_id: u64) -> bool {
            let Some(pool) = self.pool.as_ref() else {
                return false;
            };
            let Some(buffer) = pool.buffers.get(slot) else {
                return false;
            };
            let info = &pool.info;
            self.state.released[slot] = false;
            self.attached = Some(slot);
            self.child.attach(Some(buffer), 0, 0);
            self.child
                .damage_buffer(0, 0, info.width as i32, info.height as i32);
            if frame_id != 0
                && let Some(presentation) = self.presentation.as_ref()
            {
                presentation.feedback(&self.child, &self.queue.handle(), frame_id);
            }
            // No frame callback: the release is the one event per frame
            // (every event on the shared display wakes winit's loop too).
            self.child.commit();
            true
        }

        pub(super) fn run(mut self, inbox: Receiver<Command>, bell: &Doorbell) {
            loop {
                bell.drain();
                let mut quit = false;
                while let Ok(command) = inbox.try_recv() {
                    match command {
                        Command::Ring(ring) => {
                            if let Err(error) = self.set_ring(ring) {
                                eprintln!("[preview] wayland presenter: {error}");
                            }
                        }
                        Command::Place(placement) => self.place(placement),
                        Command::Hidden(hidden) => {
                            if self.hidden != hidden {
                                self.hidden = hidden;
                                if hidden {
                                    self.child.attach(None, 0, 0);
                                    self.child.commit();
                                } else if let Some(slot) = self.attached
                                    && self.state.released.get(slot).copied().unwrap_or(false)
                                {
                                    // The last frame again, until the next
                                    // one lands.
                                    self.attach_slot(slot);
                                }
                            }
                        }
                        Command::Present {
                            slot,
                            frame_id,
                            reply,
                        } => {
                            let started_at = Instant::now();
                            let slot = slot as usize;
                            if self.pool.is_none() {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some("no ring is mapped for the subsurface".to_string()),
                                ));
                                continue;
                            }
                            if self.hidden || self.placement.is_none() {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    Some(Instant::now()),
                                    true,
                                    false,
                                    None,
                                ));
                                continue;
                            }
                            // The compositor may still read this slot (it
                            // can only be the frame before last).
                            if !self.state.released.get(slot).copied().unwrap_or(true) {
                                let deadline = Instant::now() + RELEASE_WAIT;
                                while !self.state.released[slot] && Instant::now() < deadline {
                                    if let Err(error) =
                                        self.dispatch_for(bell, Duration::from_millis(5))
                                    {
                                        eprintln!("[preview] wayland presenter: {error}");
                                        break;
                                    }
                                }
                            }
                            if !self.attach_slot_for(slot, frame_id) {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some(format!("slot {slot} has no buffer")),
                                ));
                                continue;
                            }
                            let committed_at = Instant::now();
                            if let Err(error) = self.queue.flush() {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some(format!("flush: {error}")),
                                ));
                                continue;
                            }
                            // The lease holds until the compositor gives the
                            // buffer back (it copies a wl_shm buffer into
                            // its texture at the commit, within a frame).
                            let deadline = Instant::now() + RELEASE_WAIT;
                            while !self.state.released[slot] && Instant::now() < deadline {
                                if let Err(error) =
                                    self.dispatch_for(bell, Duration::from_millis(5))
                                {
                                    eprintln!("[preview] wayland presenter: {error}");
                                    break;
                                }
                            }
                            let _ = reply.send(report(
                                frame_id,
                                started_at,
                                Some(committed_at),
                                self.state.released[slot],
                                true,
                                None,
                            ));
                        }
                        Command::Quit => quit = true,
                    }
                }
                if quit {
                    break;
                }
                if let Err(error) = self.dispatch_for(bell, IDLE_POLL) {
                    eprintln!("[preview] wayland presenter: {error}; the subsurface stops");
                    break;
                }
            }
            // Take the subsurface down with the thread.
            self.pool = None;
            self.child.attach(None, 0, 0);
            self.child.commit();
            self.viewport.destroy();
            self.subsurface.destroy();
            self.child.destroy();
            let _ = self.queue.flush();
        }
    }
}

mod x11 {
    //! The X11 child-window half (XWayland on ogre).

    use std::os::fd::AsRawFd;
    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::render::{self, ConnectionExt as _};
    use x11rb::protocol::shape::{self, ConnectionExt as _};
    use x11rb::protocol::shm::ConnectionExt as _;
    use x11rb::protocol::xproto::{self, ConnectionExt as _};
    use x11rb::rust_connection::RustConnection;

    use super::{
        Command, Doorbell, IDLE_POLL, NativeHandles, Placement, RELEASE_WAIT, RingMapping,
        poll_readable, report,
    };

    /// The shared segment and the pixmap over one ring.
    struct Segment {
        info: videorc_preview_ring::RingInfo,
        segment: u32,
        pixmap: u32,
        picture: u32,
    }

    pub(super) struct Child {
        conn: RustConnection,
        parent: u32,
        child: u32,
        gc: u32,
        depth: u8,
        format: u32,
        window_picture: u32,
        segment: Option<Segment>,
        placement: Option<Placement>,
        /// The child's size in device pixels.
        child_size: (u32, u32),
        hidden: bool,
        mapped: bool,
        pending_completion: Option<u64>,
        completed: bool,
    }

    impl Child {
        pub(super) fn build(handles: NativeHandles) -> Result<Self, String> {
            let (conn, _screen) =
                x11rb::connect(None).map_err(|error| format!("the X connection: {error}"))?;
            let version = conn
                .shm_query_version()
                .map_err(|error| format!("MIT-SHM: {error}"))?
                .reply()
                .map_err(|error| format!("MIT-SHM: {error}"))?;
            if version.major_version < 1
                || (version.major_version == 1 && version.minor_version < 2)
            {
                return Err(format!(
                    "MIT-SHM {}.{} has no fd passing (1.2 is needed)",
                    version.major_version, version.minor_version
                ));
            }
            conn.render_query_version(0, 11)
                .map_err(|error| format!("XRender: {error}"))?
                .reply()
                .map_err(|error| format!("XRender: {error}"))?;
            conn.shape_query_version()
                .map_err(|error| format!("Shape: {error}"))?
                .reply()
                .map_err(|error| format!("Shape: {error}"))?;
            let parent = handles.x11_window;
            let geometry = conn
                .get_geometry(parent)
                .map_err(|error| format!("the parent's geometry: {error}"))?
                .reply()
                .map_err(|error| format!("the parent's geometry: {error}"))?;
            let attributes = conn
                .get_window_attributes(parent)
                .map_err(|error| format!("the parent's attributes: {error}"))?
                .reply()
                .map_err(|error| format!("the parent's attributes: {error}"))?;
            let formats = conn
                .render_query_pict_formats()
                .map_err(|error| format!("XRender formats: {error}"))?
                .reply()
                .map_err(|error| format!("XRender formats: {error}"))?;
            let format = formats
                .screens
                .iter()
                .flat_map(|screen| screen.depths.iter())
                .flat_map(|depth| depth.visuals.iter())
                .find(|info| info.visual == attributes.visual)
                .map(|info| info.format)
                .ok_or_else(|| "XRender has no format for the parent's visual".to_string())?;
            let child = conn.generate_id().map_err(|error| format!("{error}"))?;
            conn.create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                child,
                parent,
                0,
                0,
                1,
                1,
                0,
                xproto::WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &xproto::CreateWindowAux::new().background_pixel(0),
            )
            .map_err(|error| format!("create_window: {error}"))?;
            // Input goes through to the host: an empty input shape.
            conn.shape_rectangles(
                shape::SO::SET,
                shape::SK::INPUT,
                xproto::ClipOrdering::UNSORTED,
                child,
                0,
                0,
                &[],
            )
            .map_err(|error| format!("shape: {error}"))?;
            let gc = conn.generate_id().map_err(|error| format!("{error}"))?;
            conn.create_gc(gc, child, &xproto::CreateGCAux::new().graphics_exposures(0))
                .map_err(|error| format!("create_gc: {error}"))?;
            let window_picture = conn.generate_id().map_err(|error| format!("{error}"))?;
            conn.render_create_picture(
                window_picture,
                child,
                format,
                &render::CreatePictureAux::new(),
            )
            .map_err(|error| format!("create_picture: {error}"))?;
            conn.flush().map_err(|error| format!("flush: {error}"))?;
            Ok(Self {
                conn,
                parent,
                child,
                gc,
                depth: geometry.depth,
                format,
                window_picture,
                segment: None,
                placement: None,
                child_size: (1, 1),
                hidden: false,
                mapped: false,
                pending_completion: None,
                completed: false,
            })
        }

        fn drain_events(&mut self) -> Result<(), String> {
            while let Some(event) = self
                .conn
                .poll_for_event()
                .map_err(|error| format!("events: {error}"))?
            {
                if let Event::ShmCompletion(_) = event
                    && self.pending_completion.take().is_some()
                {
                    self.completed = true;
                }
            }
            Ok(())
        }

        fn wait_for(&mut self, bell: &Doorbell, timeout: Duration) -> Result<(), String> {
            self.conn
                .flush()
                .map_err(|error| format!("flush: {error}"))?;
            poll_readable(
                &[self.conn.stream().as_raw_fd(), bell.read.as_raw_fd()],
                timeout,
            );
            self.drain_events()
        }

        fn set_ring(&mut self, ring: Option<RingMapping>) -> Result<(), String> {
            if let Some(old) = self.segment.take() {
                let _ = self.conn.render_free_picture(old.picture);
                let _ = self.conn.free_pixmap(old.pixmap);
                let _ = self.conn.shm_detach(old.segment);
            }
            let Some(ring) = ring else {
                let _ = self.conn.flush();
                return Ok(());
            };
            let info = ring.info;
            let segment = self
                .conn
                .generate_id()
                .map_err(|error| format!("{error}"))?;
            self.conn
                .shm_attach_fd(segment, ring.fd, true)
                .map_err(|error| format!("shm_attach_fd: {error}"))?
                .check()
                .map_err(|error| format!("shm_attach_fd (MIT-SHM 1.2 fd passing): {error}"))?;
            let pixmap = self
                .conn
                .generate_id()
                .map_err(|error| format!("{error}"))?;
            self.conn
                .create_pixmap(
                    self.depth,
                    pixmap,
                    self.parent,
                    info.width as u16,
                    info.height as u16,
                )
                .map_err(|error| format!("create_pixmap: {error}"))?;
            let picture = self
                .conn
                .generate_id()
                .map_err(|error| format!("{error}"))?;
            self.conn
                .render_create_picture(
                    picture,
                    pixmap,
                    self.format,
                    &render::CreatePictureAux::new(),
                )
                .map_err(|error| format!("create_picture: {error}"))?;
            self.conn
                .render_set_picture_filter(picture, b"bilinear", &[])
                .map_err(|error| format!("set_picture_filter: {error}"))?;
            self.segment = Some(Segment {
                info,
                segment,
                pixmap,
                picture,
            });
            self.apply_transform()?;
            self.conn
                .flush()
                .map_err(|error| format!("flush: {error}"))?;
            Ok(())
        }

        /// The pixmap's picture scaled onto the child: the transform maps
        /// child pixels to frame pixels, in 16.16 fixed point.
        fn apply_transform(&self) -> Result<(), String> {
            let Some(segment) = self.segment.as_ref() else {
                return Ok(());
            };
            let info = &segment.info;
            let fixed = |value: f64| (value * 65536.0).round() as i32;
            let sx = f64::from(info.width) / f64::from(self.child_size.0.max(1));
            let sy = f64::from(info.height) / f64::from(self.child_size.1.max(1));
            self.conn
                .render_set_picture_transform(
                    segment.picture,
                    render::Transform {
                        matrix11: fixed(sx),
                        matrix12: 0,
                        matrix13: 0,
                        matrix21: 0,
                        matrix22: fixed(sy),
                        matrix23: 0,
                        matrix31: 0,
                        matrix32: 0,
                        matrix33: fixed(1.0),
                    },
                )
                .map_err(|error| format!("set_picture_transform: {error}"))?;
            Ok(())
        }

        fn place(&mut self, placement: Placement) -> Result<(), String> {
            self.placement = Some(placement);
            let scale = placement.scale.max(1.0);
            let rect = placement.rect;
            let (x, y) = (
                (rect.x * scale).round() as i32,
                (rect.y * scale).round() as i32,
            );
            let (w, h) = (
                (rect.width * scale).round().max(1.0) as u32,
                (rect.height * scale).round().max(1.0) as u32,
            );
            self.conn
                .configure_window(
                    self.child,
                    &xproto::ConfigureWindowAux::new()
                        .x(x)
                        .y(y)
                        .width(w)
                        .height(h),
                )
                .map_err(|error| format!("configure_window: {error}"))?;
            self.child_size = (w, h);
            self.apply_transform()?;
            if !self.hidden && !self.mapped {
                self.conn
                    .map_window(self.child)
                    .map_err(|error| format!("map_window: {error}"))?;
                self.mapped = true;
            }
            self.conn
                .flush()
                .map_err(|error| format!("flush: {error}"))?;
            Ok(())
        }

        fn composite(&self) -> Result<(), String> {
            let Some(segment) = self.segment.as_ref() else {
                return Ok(());
            };
            self.conn
                .render_composite(
                    render::PictOp::SRC,
                    segment.picture,
                    x11rb::NONE,
                    self.window_picture,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    self.child_size.0 as u16,
                    self.child_size.1 as u16,
                )
                .map_err(|error| format!("composite: {error}"))?;
            Ok(())
        }

        pub(super) fn run(mut self, inbox: Receiver<Command>, bell: &Doorbell) {
            loop {
                bell.drain();
                let mut quit = false;
                while let Ok(command) = inbox.try_recv() {
                    match command {
                        Command::Ring(ring) => {
                            if let Err(error) = self.set_ring(ring) {
                                eprintln!("[preview] x11 presenter: {error}");
                            }
                        }
                        Command::Place(placement) => {
                            if let Err(error) = self.place(placement) {
                                eprintln!("[preview] x11 presenter: {error}");
                            }
                        }
                        Command::Hidden(hidden) => {
                            if self.hidden != hidden {
                                self.hidden = hidden;
                                let outcome = if hidden {
                                    self.mapped = false;
                                    self.conn.unmap_window(self.child).map(|_| ())
                                } else if self.placement.is_some() {
                                    self.mapped = true;
                                    self.conn.map_window(self.child).map(|_| ())
                                } else {
                                    Ok(())
                                };
                                if let Err(error) = outcome.and_then(|_| self.conn.flush()) {
                                    eprintln!("[preview] x11 presenter: {error}");
                                }
                                if !hidden {
                                    let _ = self.composite();
                                    let _ = self.conn.flush();
                                }
                            }
                        }
                        Command::Present {
                            slot,
                            frame_id,
                            reply,
                        } => {
                            let started_at = Instant::now();
                            let Some(segment) = self.segment.as_ref() else {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some("no ring is attached for the child window".to_string()),
                                ));
                                continue;
                            };
                            if self.hidden || self.placement.is_none() {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    Some(Instant::now()),
                                    true,
                                    false,
                                    None,
                                ));
                                continue;
                            }
                            let info = segment.info;
                            let put = self
                                .conn
                                .shm_put_image(
                                    segment.pixmap,
                                    self.gc,
                                    info.width as u16,
                                    info.height as u16,
                                    0,
                                    0,
                                    info.width as u16,
                                    info.height as u16,
                                    0,
                                    0,
                                    self.depth,
                                    xproto::ImageFormat::Z_PIXMAP.into(),
                                    true,
                                    segment.segment,
                                    info.slot_start(slot) as u32,
                                )
                                .map_err(|error| format!("shm_put_image: {error}"))
                                .and_then(|_| self.composite())
                                .and_then(|_| {
                                    self.conn.flush().map_err(|error| format!("flush: {error}"))
                                });
                            if let Err(error) = put {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some(error),
                                ));
                                continue;
                            }
                            let committed_at = Instant::now();
                            self.pending_completion = Some(frame_id);
                            self.completed = false;
                            // The lease holds until the server has read the
                            // segment (`ShmCompletion`).
                            let deadline = Instant::now() + RELEASE_WAIT;
                            while self.pending_completion.is_some() && Instant::now() < deadline {
                                if let Err(error) = self.wait_for(bell, Duration::from_millis(5)) {
                                    eprintln!("[preview] x11 presenter: {error}");
                                    break;
                                }
                            }
                            let released = self.completed;
                            self.pending_completion = None;
                            let _ = reply.send(report(
                                frame_id,
                                started_at,
                                Some(committed_at),
                                released,
                                true,
                                None,
                            ));
                        }
                        Command::Quit => quit = true,
                    }
                }
                if quit {
                    break;
                }
                if let Err(error) = self.wait_for(bell, IDLE_POLL) {
                    eprintln!("[preview] x11 presenter: {error}; the child window stops");
                    break;
                }
            }
            let _ = self.set_ring(None);
            let _ = self.conn.render_free_picture(self.window_picture);
            let _ = self.conn.free_gc(self.gc);
            let _ = self.conn.destroy_window(self.child);
            let _ = self.conn.flush();
        }
    }
}
