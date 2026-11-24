//! Plan 220 S4.2c: the Linux presenter, the route P4-D2 chose: the backend's
//! CPU-composed frames, already whole BGRA pixels in the shared-memory ring
//! (`videorc-preview-ring`, S4.1d), put on the screen by the display server
//! itself, outside Slint's redraw.
//!
//! - **Wayland:** a `wl_subsurface` of the host window's own `wl_surface`,
//!   fed by a `wl_shm` pool of the presenter's own: three buffers of the
//!   frame's size in a memory file of its own. A frame is a copy of the
//!   leased slot into a buffer the compositor has released, then `attach` +
//!   `damage` + `commit`; the ring's lease goes back once the copy is done.
//!   Wayland allows reusing a buffer only after its `release`, and no
//!   deadline stands in for that: a pool over the ring itself would either
//!   hold the ring's one reader lease until the compositor lets go (some
//!   keep a buffer until the next one replaces it) or let the writer
//!   overwrite pixels the compositor still reads. Viewporter scales the
//!   buffer to the slot on the compositor's side; the subsurface follows the
//!   slot through `set_position` (applied with the parent's commit, the same
//!   frame the UI lays the slot out) and `set_destination`.
//! - **X11** (XWayland on ogre; a real X server speaks the same
//!   extensions): a child window of the host window, fed by MIT-SHM 1.2 fd
//!   passing of a memory file of the presenter's own, three frames long. A
//!   frame is a copy of the leased slot into one of those frames the server
//!   is not reading, one `shm::put_image` from it into a pixmap of the
//!   frame's size, then an XRender composite of that pixmap, scaled to the
//!   child, so the picture fits the slot as viewporter fits it on Wayland.
//!   The ring's lease goes once the copy is done; a frame of the presenter's
//!   own is written again only after its `ShmCompletion` (or the X error
//!   that refused its put). Nothing waits on the server without a bound, so
//!   a quit or a stalled server never holds the thread, and the ring lease
//!   never depends on the server at all.
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

use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use videorc_preview_ring::RingInfo;
use videorc_protocol::PreviewSurfaceBacking;

use crate::LayerRect;

/// How long `attach` waits for the thread to connect and build the child.
const ATTACH_WAIT: Duration = Duration::from_secs(5);
/// Wayland: how long a frame waits for the compositor to release one of the
/// presenter's own buffers before it is dropped (the ring's lease is never
/// what waits for a release).
const RELEASE_WAIT: Duration = Duration::from_millis(250);
/// Wayland: the presenter's own buffers: the one on screen, one the
/// compositor may still hold, one to fill.
const OWN_BUFFERS: usize = 3;
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
    /// The surface status's name for it (`videorc-protocol`).
    pub fn protocol(self) -> PreviewSurfaceBacking {
        match self {
            Backing::WaylandSubsurface => PreviewSurfaceBacking::WlShmSubsurface,
            Backing::X11ChildWindow => PreviewSurfaceBacking::X11ShmChildWindow,
        }
    }

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
    /// The ring's slot is no longer read: both routes copy it into a buffer
    /// of the presenter's own before they answer. The lease goes once the
    /// report arrives, never before.
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

    /// Hands a leased slot to the thread. The receiver yields once the slot
    /// is no longer read (copied into a buffer of the presenter's own), so
    /// the lease may go back as soon as the report arrives, and not before.
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
        // The Wayland child borrows winit's display and the window's
        // surface (raw pointers); the X11 child has a connection of its own
        // and only the parent's window id.
        let borrows_host = handles.wayland_display != 0 && handles.wayland_surface != 0;
        let bell = Arc::new(Doorbell::new()?);
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Backing, String>>();
        // Set when `attach` stopped waiting: a child built after that closes
        // at once instead of serving a caller that is gone.
        let abandoned = Arc::new(AtomicBool::new(false));
        let thread_abandoned = abandoned.clone();
        let thread_bell = bell.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-linux-presenter".to_string())
            .spawn(move || {
                let wanted = |backing: Backing| {
                    !thread_abandoned.load(Ordering::Acquire) && ready_tx.send(Ok(backing)).is_ok()
                };
                if handles.wayland_display != 0 && handles.wayland_surface != 0 {
                    match wayland::Child::build(handles) {
                        Ok(child) if wanted(Backing::WaylandSubsurface) => {
                            child.run(inbox, &thread_bell);
                        }
                        Ok(child) => child.close(),
                        Err(error) => {
                            let _ = ready_tx.send(Err(format!("Wayland subsurface: {error}")));
                        }
                    }
                } else if handles.x11_window != 0 {
                    match x11::Child::build(handles) {
                        Ok(child) if wanted(Backing::X11ChildWindow) => {
                            child.run(inbox, &thread_bell);
                        }
                        Ok(child) => child.close(),
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
                // Stop it: a child built from now on closes at once, and one
                // that got its answer in sees its commands end.
                abandoned.store(true, Ordering::Release);
                drop(commands);
                bell.ring();
                if borrows_host {
                    // The thread may still be inside `registry_queue_init`
                    // on winit's display, and would then use the window's
                    // surface: nothing can cancel that, and nothing here can
                    // keep the window alive, so it is joined before this
                    // returns, however long it takes. Its wait is a roundtrip
                    // on the display winit's own loop shares, so a compositor
                    // that stalls it has stalled the UI already.
                    while ready_rx.recv().is_ok() {}
                    let _ = thread.join();
                    return Err(format!(
                        "the presenter thread did not connect within {ATTACH_WAIT:?}"
                    ));
                }
                // X11: the thread holds only its own connection and the
                // parent's id (an X id, not a pointer: a gone window is an X
                // error, never a use after free). It is joined when it ends
                // within another wait, and left to end by itself otherwise.
                return Err(match ready_rx.recv_timeout(ATTACH_WAIT) {
                    Err(mpsc::RecvTimeoutError::Timeout) => format!(
                        "the presenter thread did not connect within {ATTACH_WAIT:?}, and did not stop within another {ATTACH_WAIT:?}"
                    ),
                    _ => {
                        // Its answer (or its end) arrived: the readiness
                        // sender goes with the thread, so wait for the end.
                        while ready_rx.recv().is_ok() {}
                        let _ = thread.join();
                        format!("the presenter thread did not connect within {ATTACH_WAIT:?}")
                    }
                });
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

/// A shared mapping of a memory file, unmapped on drop. It never hands out
/// the whole region: the ring's other slots and header are written by the
/// backend while this lives.
struct Mapped {
    ptr: NonNull<u8>,
    len: usize,
}

impl Mapped {
    fn map(fd: BorrowedFd<'_>, len: usize, writable: bool) -> Result<Self, String> {
        let prot = if writable {
            libc::PROT_READ | libc::PROT_WRITE
        } else {
            libc::PROT_READ
        };
        // SAFETY: a fresh shared mapping of `len` bytes of a live descriptor.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                prot,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!("mmap: {}", std::io::Error::last_os_error()));
        }
        NonNull::new(ptr.cast::<u8>())
            .map(|ptr| Self { ptr, len })
            .ok_or_else(|| "mmap gave a null mapping".to_string())
    }

    /// `len` bytes at `offset`, when they are inside the mapping.
    ///
    /// # Safety
    /// Nothing may write those bytes while the slice lives (a ring slot: the
    /// reader holds its lease).
    unsafe fn slice(&self, offset: usize, len: usize) -> Option<&[u8]> {
        let end = offset.checked_add(len)?;
        // SAFETY: inside the mapping; the caller rules out writers.
        (end <= self.len)
            .then(|| unsafe { std::slice::from_raw_parts(self.ptr.as_ptr().add(offset), len) })
    }

    /// `len` bytes at `offset` of a mapping this process alone writes.
    fn slice_mut(&mut self, offset: usize, len: usize) -> Option<&mut [u8]> {
        let end = offset.checked_add(len)?;
        // SAFETY: inside the mapping; only this thread writes it, and `&mut
        // self` keeps this the one slice.
        (end <= self.len)
            .then(|| unsafe { std::slice::from_raw_parts_mut(self.ptr.as_ptr().add(offset), len) })
    }
}

impl Mapped {
    /// Copies `len` bytes from `from` to `to` inside a mapping this process
    /// alone writes; the two ranges must not overlap. False when either is
    /// outside the mapping or they overlap.
    fn copy_within(&mut self, from: usize, to: usize, len: usize) -> bool {
        let (Some(from_end), Some(to_end)) = (from.checked_add(len), to.checked_add(len)) else {
            return false;
        };
        if from_end > self.len || to_end > self.len || (from < to_end && to < from_end) {
            return false;
        }
        // SAFETY: both ranges are inside the mapping and disjoint; only this
        // thread writes it, and `&mut self` keeps this the one access.
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.ptr.as_ptr().add(from),
                self.ptr.as_ptr().add(to),
                len,
            );
        }
        true
    }
}

impl Drop for Mapped {
    fn drop(&mut self) {
        // SAFETY: the mapping `map` made, unmapped once.
        unsafe { libc::munmap(self.ptr.as_ptr().cast(), self.len) };
    }
}

/// A memory file of `len` bytes for the presenter's own buffers.
fn own_memory(len: usize) -> Result<OwnedFd, String> {
    // SAFETY: a static NUL-terminated name.
    let raw = unsafe { libc::memfd_create(c"videorc-preview-frames".as_ptr(), libc::MFD_CLOEXEC) };
    if raw < 0 {
        return Err(format!("memfd_create: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: memfd_create gave a fresh descriptor this now owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let size = libc::off_t::try_from(len).map_err(|_| format!("{len} bytes is too large"))?;
    // SAFETY: sizing a descriptor this owns.
    if unsafe { libc::ftruncate(fd.as_raw_fd(), size) } != 0 {
        return Err(format!("ftruncate: {}", std::io::Error::last_os_error()));
    }
    Ok(fd)
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
    use wayland_protocols::wp::viewporter::client::wp_viewport::WpViewport;
    use wayland_protocols::wp::viewporter::client::wp_viewporter::WpViewporter;

    use std::os::fd::AsFd;
    use std::sync::mpsc::TryRecvError;

    use super::{
        Command, Doorbell, IDLE_POLL, Mapped, NativeHandles, OWN_BUFFERS, Placement, RELEASE_WAIT,
        RingMapping, own_memory, poll_readable, report,
    };

    /// The dispatch state: which of the presenter's own buffers the
    /// compositor has given back.
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
            index: &usize,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_buffer::Event::Release = event
                && let Some(released) = state.released.get_mut(*index)
            {
                *released = true;
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

    /// One ring's frames: the ring itself, read-only (the leased slot is
    /// copied out of it), and the presenter's own buffers of its frame size.
    struct Pool {
        info: videorc_preview_ring::RingInfo,
        ring: Mapped,
        _ring_fd: std::os::fd::OwnedFd,
        frames: Mapped,
        _frames_fd: std::os::fd::OwnedFd,
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
        pool: Option<Pool>,
        placement: Option<Placement>,
        hidden: bool,
        /// The own buffer last attached (it holds the last frame shown), so a
        /// show after a hide attaches it again.
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
            let frame_bytes = info.frame_bytes();
            let ring_map = Mapped::map(ring.fd.as_fd(), info.total_bytes as usize, false)
                .map_err(|error| format!("mapping the ring: {error}"))?;
            let frames_len = frame_bytes * OWN_BUFFERS;
            let pool_len = i32::try_from(frames_len)
                .map_err(|_| format!("{frames_len} bytes is too large for a wl_shm pool"))?;
            let frames_fd = own_memory(frames_len)?;
            let frames = Mapped::map(frames_fd.as_fd(), frames_len, true)
                .map_err(|error| format!("mapping the subsurface's buffers: {error}"))?;
            let qh = self.queue.handle();
            let pool = self.shm.create_pool(frames_fd.as_fd(), pool_len, &qh, ());
            let buffers: Vec<WlBuffer> = (0..OWN_BUFFERS)
                .map(|index| {
                    pool.create_buffer(
                        (index * frame_bytes) as i32,
                        info.width as i32,
                        info.height as i32,
                        info.stride as i32,
                        wl_shm::Format::Argb8888,
                        &qh,
                        index,
                    )
                })
                .collect();
            self.state.released = vec![true; OWN_BUFFERS];
            self.pool = Some(Pool {
                info,
                ring: ring_map,
                _ring_fd: ring.fd,
                frames,
                _frames_fd: frames_fd,
                _pool: pool,
                buffers,
            });
            Ok(())
        }

        /// A buffer the compositor has released, preferring one that is not
        /// on screen.
        fn free_buffer(&self) -> Option<usize> {
            let released = |index: &usize| self.state.released.get(*index).copied() == Some(true);
            (0..OWN_BUFFERS)
                .filter(released)
                .find(|index| Some(*index) != self.attached)
                .or_else(|| (0..OWN_BUFFERS).find(released))
        }

        /// Copies the leased `slot` into a released buffer of the
        /// presenter's own; the buffer's index. Once this returns, the ring's
        /// slot is not read again, so its lease may go.
        fn fill(&mut self, slot: u32, bell: &Doorbell) -> Result<usize, String> {
            let mut index = self.free_buffer();
            if index.is_none() {
                let deadline = Instant::now() + RELEASE_WAIT;
                while index.is_none() && Instant::now() < deadline {
                    // A rung bell would wake the poll at once and spin; the
                    // commands it announces wait in the inbox for `run`.
                    bell.drain();
                    self.dispatch_for(bell, Duration::from_millis(5))?;
                    index = self.free_buffer();
                }
            }
            let index = index.ok_or_else(|| {
                format!(
                    "the compositor still holds every buffer of the subsurface after {RELEASE_WAIT:?}"
                )
            })?;
            let pool = self
                .pool
                .as_mut()
                .ok_or("no ring is mapped for the subsurface")?;
            if slot >= pool.info.slot_count {
                return Err(format!("slot {slot} is outside the ring"));
            }
            let frame_bytes = pool.info.frame_bytes();
            // SAFETY: the reader holds this slot's lease until the report,
            // which is sent after this copy, so the writer leaves it alone.
            let source = unsafe { pool.ring.slice(pool.info.slot_start(slot), frame_bytes) }
                .ok_or_else(|| format!("slot {slot} is outside the mapped ring"))?;
            let target = pool
                .frames
                .slice_mut(index * frame_bytes, frame_bytes)
                .ok_or_else(|| format!("buffer {index} is outside the subsurface's memory"))?;
            target.copy_from_slice(source);
            Ok(index)
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

        /// Shows the last frame again after a hide. A buffer is attached
        /// again only once its earlier `release` has been consumed: the one
        /// that was on screen may still be the compositor's (the release of
        /// the commit before the hide not yet read), and a stale release
        /// arriving after a new attach would mark it free while that commit
        /// still uses it. So a busy last buffer is copied into a released
        /// one, and that one is attached.
        fn reshow(&mut self, last: usize) -> bool {
            if self.state.released.get(last).copied() == Some(true) {
                return self.attach_buffer(last);
            }
            // `free_buffer` only returns released buffers, so never `last`.
            let Some(index) = self.free_buffer() else {
                // All three are the compositor's: the next frame shows.
                return false;
            };
            let Some(pool) = self.pool.as_mut() else {
                return false;
            };
            let frame_bytes = pool.info.frame_bytes();
            if !pool
                .frames
                .copy_within(last * frame_bytes, index * frame_bytes, frame_bytes)
            {
                return false;
            }
            self.attach_buffer(index)
        }

        fn attach_buffer(&mut self, index: usize) -> bool {
            let Some(pool) = self.pool.as_ref() else {
                return false;
            };
            let Some(buffer) = pool.buffers.get(index) else {
                return false;
            };
            let info = &pool.info;
            if let Some(released) = self.state.released.get_mut(index) {
                *released = false;
            }
            self.attached = Some(index);
            self.child.attach(Some(buffer), 0, 0);
            self.child
                .damage_buffer(0, 0, info.width as i32, info.height as i32);
            // No frame callback: the release is the one event per frame
            // (every event on the shared display wakes winit's loop too).
            self.child.commit();
            true
        }

        pub(super) fn run(mut self, inbox: Receiver<Command>, bell: &Doorbell) {
            loop {
                bell.drain();
                let mut quit = false;
                loop {
                    let command = match inbox.try_recv() {
                        Ok(command) => command,
                        Err(TryRecvError::Empty) => break,
                        // Every client is gone: nobody can send a Quit.
                        Err(TryRecvError::Disconnected) => {
                            quit = true;
                            break;
                        }
                    };
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
                                } else if let Some(last) = self.attached {
                                    // The last frame again, until the next
                                    // one lands.
                                    self.reshow(last);
                                }
                            }
                        }
                        Command::Present {
                            slot,
                            frame_id,
                            reply,
                        } => {
                            let started_at = Instant::now();
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
                            let index = match self.fill(slot, bell) {
                                Ok(index) => index,
                                Err(error) => {
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
                            };
                            // The ring's slot is copied: the report lets its
                            // lease go. The buffer stays the compositor's
                            // until its `release`.
                            if !self.attach_buffer(index) {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some(format!("buffer {index} is missing")),
                                ));
                                continue;
                            }
                            let committed_at = Instant::now();
                            let flushed = self.queue.flush();
                            let _ = reply.send(match flushed {
                                Ok(_) => report(
                                    frame_id,
                                    started_at,
                                    Some(committed_at),
                                    true,
                                    true,
                                    None,
                                ),
                                Err(error) => report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some(format!("flush: {error}")),
                                ),
                            });
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
            self.close();
        }

        /// Takes the subsurface down: the end of `run`, or a child whose
        /// caller stopped waiting for it (`Presenter::attach`).
        pub(super) fn close(mut self) {
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

    use std::os::fd::{AsFd, AsRawFd};
    use std::sync::mpsc::{Receiver, TryRecvError};
    use std::time::{Duration, Instant};

    use x11rb::connection::Connection;
    use x11rb::protocol::Event;
    use x11rb::protocol::render::{self, ConnectionExt as _};
    use x11rb::protocol::shape::{self, ConnectionExt as _};
    use x11rb::protocol::shm::ConnectionExt as _;
    use x11rb::protocol::xproto::{self, ConnectionExt as _};
    use x11rb::rust_connection::RustConnection;

    use super::{
        Command, Doorbell, IDLE_POLL, Mapped, NativeHandles, OWN_BUFFERS, Placement, RELEASE_WAIT,
        RingMapping, own_memory, poll_readable, report,
    };

    /// One ring's frames on the X side: the ring itself, read-only (the
    /// leased slot is copied out of it), the presenter's own frames in a
    /// segment the server maps, and the pixmap they are put into.
    struct Segment {
        info: videorc_preview_ring::RingInfo,
        ring: Mapped,
        frames: Mapped,
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
        /// Per own frame: the sequence number of the put the server may
        /// still be reading it for. Cleared by its `ShmCompletion` or by the
        /// X error that refused the put; only a clear frame is written.
        busy: Vec<Option<u64>>,
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
                busy: vec![None; OWN_BUFFERS],
            })
        }

        fn drain_events(&mut self) -> Result<(), String> {
            while let Some(event) = self
                .conn
                .poll_for_event()
                .map_err(|error| format!("events: {error}"))?
            {
                match event {
                    Event::ShmCompletion(done) => {
                        // Which own frame the server has finished reading:
                        // the put's offset in this ring's segment.
                        if let Some(segment) = self.segment.as_ref()
                            && done.shmseg == segment.segment
                        {
                            let index = done.offset as usize / segment.info.frame_bytes().max(1);
                            if let Some(busy) = self.busy.get_mut(index) {
                                *busy = None;
                            }
                        }
                    }
                    Event::Error(error) => {
                        // A refused put reads nothing: its frame is free.
                        for busy in &mut self.busy {
                            if busy.is_some_and(|sequence| sequence as u16 == error.sequence) {
                                *busy = None;
                            }
                        }
                        eprintln!(
                            "[preview] x11 presenter: X error {:?} (request {}.{})",
                            error.error_kind, error.major_opcode, error.minor_opcode
                        );
                    }
                    _ => {}
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
            // The old segment's frames are never written again (the server
            // unmaps its own mapping once it is done with them).
            self.busy = vec![None; OWN_BUFFERS];
            let Some(ring) = ring else {
                let _ = self.conn.flush();
                return Ok(());
            };
            let info = ring.info;
            let ring_map = Mapped::map(ring.fd.as_fd(), info.total_bytes as usize, false)
                .map_err(|error| format!("mapping the ring: {error}"))?;
            let frames_len = info.frame_bytes() * OWN_BUFFERS;
            let frames_fd = own_memory(frames_len)?;
            let frames = Mapped::map(frames_fd.as_fd(), frames_len, true)
                .map_err(|error| format!("mapping the child window's frames: {error}"))?;
            let segment = self
                .conn
                .generate_id()
                .map_err(|error| format!("{error}"))?;
            self.conn
                .shm_attach_fd(segment, frames_fd, true)
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
                ring: ring_map,
                frames,
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

        /// Copies the leased `slot` into an own frame the server is not
        /// reading; the frame's index. Once this returns, the ring's slot is
        /// not read again, so its lease may go.
        fn fill(&mut self, slot: u32, bell: &Doorbell) -> Result<usize, String> {
            let free = |busy: &[Option<u64>]| busy.iter().position(Option::is_none);
            let mut index = free(self.busy.as_slice());
            if index.is_none() {
                let deadline = Instant::now() + RELEASE_WAIT;
                while index.is_none() && Instant::now() < deadline {
                    // A rung bell would wake the poll at once and spin; the
                    // commands it announces wait in the inbox for `run`.
                    bell.drain();
                    self.wait_for(bell, Duration::from_millis(5))?;
                    index = free(self.busy.as_slice());
                }
            }
            let index = index.ok_or_else(|| {
                format!("the X server is still reading every frame of the child window after {RELEASE_WAIT:?}")
            })?;
            let segment = self
                .segment
                .as_mut()
                .ok_or("no ring is attached for the child window")?;
            if slot >= segment.info.slot_count {
                return Err(format!("slot {slot} is outside the ring"));
            }
            let frame_bytes = segment.info.frame_bytes();
            // SAFETY: the reader holds this slot's lease until the report,
            // which is sent after this copy, so the writer leaves it alone.
            let source = unsafe {
                segment
                    .ring
                    .slice(segment.info.slot_start(slot), frame_bytes)
            }
            .ok_or_else(|| format!("slot {slot} is outside the mapped ring"))?;
            let target = segment
                .frames
                .slice_mut(index * frame_bytes, frame_bytes)
                .ok_or_else(|| format!("frame {index} is outside the child window's memory"))?;
            target.copy_from_slice(source);
            Ok(index)
        }

        /// Puts own frame `index` into the pixmap; the put's sequence number.
        fn put(&self, index: usize) -> Result<u64, String> {
            let segment = self
                .segment
                .as_ref()
                .ok_or("no ring is attached for the child window")?;
            let info = segment.info;
            let offset = u32::try_from(index * info.frame_bytes())
                .map_err(|_| format!("frame {index} is past MIT-SHM's 32-bit offsets"))?;
            let cookie = self
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
                    offset,
                )
                .map_err(|error| format!("shm_put_image: {error}"))?;
            // Dropping the cookie sends a refusal to the event queue, where
            // `drain_events` frees the frame by this number.
            Ok(cookie.sequence_number())
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
                loop {
                    let command = match inbox.try_recv() {
                        Ok(command) => command,
                        Err(TryRecvError::Empty) => break,
                        // Every client is gone: nobody can send a Quit.
                        Err(TryRecvError::Disconnected) => {
                            quit = true;
                            break;
                        }
                    };
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
                            if self.segment.is_none() {
                                let _ = reply.send(report(
                                    frame_id,
                                    started_at,
                                    None,
                                    true,
                                    false,
                                    Some("no ring is attached for the child window".to_string()),
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
                            let shown = self.fill(slot, bell).and_then(|index| {
                                // The ring's slot is copied: the report lets
                                // its lease go. The own frame stays the
                                // server's until its completion.
                                let sequence = self.put(index)?;
                                if let Some(busy) = self.busy.get_mut(index) {
                                    *busy = Some(sequence);
                                }
                                self.composite()?;
                                self.conn.flush().map_err(|error| format!("flush: {error}"))
                            });
                            let _ = reply.send(match shown {
                                Ok(()) => report(
                                    frame_id,
                                    started_at,
                                    Some(Instant::now()),
                                    true,
                                    true,
                                    None,
                                ),
                                Err(error) => {
                                    report(frame_id, started_at, None, true, false, Some(error))
                                }
                            });
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
            self.close();
        }

        /// Takes the child window down: the end of `run`, or a child whose
        /// caller stopped waiting for it (`Presenter::attach`).
        pub(super) fn close(mut self) {
            let _ = self.set_ring(None);
            let _ = self.conn.render_free_picture(self.window_picture);
            let _ = self.conn.free_gc(self.gc);
            let _ = self.conn.destroy_window(self.child);
            let _ = self.conn.flush();
        }
    }
}
