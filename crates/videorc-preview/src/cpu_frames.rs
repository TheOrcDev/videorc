//! Plan 220 S4.1d: the CPU frame source.
//!
//! The backend's CPU-composed program reaches the app as whole BGRA frames
//! in a shared-memory ring (`videorc-preview-ring`, opened with
//! `preview.cpu.open` on the feed's lease socket so it closes with the
//! socket). This thread maps the ring, sleeps on its wake until a frame is
//! published, leases the latest frame and hands it to the sinks that are on
//! ([`CpuSinks`]):
//!
//! - the texture sink (S4.1d): the frame is uploaded into one of three wgpu
//!   textures (`Queue::write_texture` copies the pixels into staging at the
//!   call) and handed to the UI thread as the same `TextureFrame` the macOS
//!   texture route binds to Slint's image; the UI's bind answers;
//! - the Linux presenter (S4.2c, `crate::linux`): the leased slot's index
//!   goes to the presenter thread, which copies the slot into a buffer of
//!   its own (Wayland) or puts it from the MIT-SHM segment (X11) and answers
//!   once the ring's slot is no longer read: after the copy, or after the X
//!   server's completion. The lease is held until that answer, with no
//!   deadline, so the writer never touches a slot the display server reads.
//!
//! Either way a frame that was shown counts as presented in the feed's
//! telemetry, which the first-frame and presenting contracts read
//! unchanged; a frame the hidden or unplaced presenter only acknowledged
//! does not.
//!
//! A retired ring (the backend made a new one for a new frame size, or went
//! away) sends `CpuRequest::Reopen` to the session, which asks the backend
//! for the current ring and hands the handle back here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};
use videorc_app_core::{Level, Logger};
use videorc_preview_ring::{RingHandle, RingReader, Wait};
use videorc_protocol::{PreviewCpuRing, PreviewSurfaceBacking};

use crate::feed::{Telemetry, TextureFrame, TextureSink};

/// How long the thread waits for a frame before looking at its orders.
const FRAME_WAIT: Duration = Duration::from_millis(250);
/// How long the UI may take to bind a frame (the macOS route's deadline).
const BIND_DEADLINE: Duration = Duration::from_millis(250);
/// How long the presenter should take to answer (its buffer wait, plus the
/// hop). A late answer is waited for all the same: only the answer says the
/// slot is no longer read.
#[cfg(target_os = "linux")]
const PRESENT_DEADLINE: Duration = Duration::from_millis(400);
/// Textures in rotation: the one bound, the one being drawn, one to write.
const TEXTURE_POOL: usize = 3;
/// A ring handed over twice (the status had not moved on yet): a short wait
/// before asking again.
const REOPEN_SPACING: Duration = Duration::from_millis(100);
/// With no sink on, the thread looks at its orders this often.
const NO_SINK_WAIT: Duration = Duration::from_millis(50);

/// What became of a frame handed to the Linux presenter.
#[cfg(target_os = "linux")]
enum NativeAnswer {
    Report(crate::linux::PresentReport),
    /// The presenter's thread ended without answering.
    Gone,
    /// The source stopped while the presenter still had the frame.
    Stopped,
}

/// What the thread asks the session for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CpuRequest {
    /// The ring retired: ask the backend for the current one.
    Reopen,
}

/// Where the leased frames go. Both may be on during a route handover
/// (S2.3c): the new sink shows before the old one stops.
#[derive(Clone, Default)]
pub struct CpuSinks {
    /// The texture route's sink (the UI draws the frame).
    pub texture: Option<TextureSink>,
    /// Plan 220 S4.2c: the Linux presenter (the display server draws it).
    #[cfg(target_os = "linux")]
    pub presenter: Option<crate::linux::PresenterClient>,
}

impl CpuSinks {
    pub fn is_empty(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.texture.is_none() && self.presenter.is_none()
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.texture.is_none()
        }
    }

    /// What the surface's status names as the backing: the presenter's
    /// surface when one shows, else Slint's image.
    fn backing(&self) -> PreviewSurfaceBacking {
        #[cfg(target_os = "linux")]
        if let Some(presenter) = &self.presenter {
            return presenter.backing().protocol();
        }
        PreviewSurfaceBacking::GpuiImage
    }
}

struct Control {
    stop: AtomicBool,
    kick: AtomicBool,
    ring: Mutex<RingOrder>,
    changed: Condvar,
    sinks: Mutex<SinkOrder>,
}

#[derive(Default)]
struct RingOrder {
    /// The ring to map next (`None`: nothing to show).
    handle: Option<PreviewCpuRing>,
    /// Bumped on every `set_ring`, so the thread tells a new order from the
    /// one it already mapped.
    order: u64,
}

#[derive(Default)]
struct SinkOrder {
    sinks: CpuSinks,
    /// Bumped on every `set_sinks`.
    order: u64,
}

/// The running source; stopped and joined on `stop`.
pub struct CpuFrameSource {
    control: Arc<Control>,
    thread: Option<JoinHandle<()>>,
}

impl CpuFrameSource {
    pub fn start(
        sinks: CpuSinks,
        telemetry: Arc<Mutex<Telemetry>>,
        logger: Logger,
        requests: mpsc::UnboundedSender<CpuRequest>,
        runtime: tokio::runtime::Handle,
    ) -> std::io::Result<Self> {
        let control = Arc::new(Control {
            stop: AtomicBool::new(false),
            kick: AtomicBool::new(false),
            ring: Mutex::new(RingOrder::default()),
            changed: Condvar::new(),
            sinks: Mutex::new(SinkOrder { sinks, order: 1 }),
        });
        let thread_control = control.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-cpu-frames".to_string())
            .spawn(move || {
                Reader {
                    control: thread_control,
                    sinks: CpuSinks::default(),
                    sinks_order: 0,
                    telemetry,
                    logger,
                    requests,
                    runtime,
                    textures: Vec::new(),
                    texture_size: (0, 0),
                    next_texture: 0,
                    #[cfg(target_os = "linux")]
                    current_ring: None,
                }
                .run()
            })?;
        Ok(Self {
            control,
            thread: Some(thread),
        })
    }

    /// The ring to map (the backend's `preview.cpu.open` or `.status`
    /// answer); `None` takes the frames away.
    pub fn set_ring(&self, ring: Option<PreviewCpuRing>) {
        let mut order = self
            .control
            .ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.handle = ring;
        order.order += 1;
        self.control.changed.notify_all();
    }

    /// The sinks that are on now (a route switch, a presenter attached or
    /// detached); the thread takes them at its next frame.
    pub fn set_sinks(&self, sinks: CpuSinks) {
        let mut order = self
            .control
            .sinks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order.sinks = sinks;
        order.order += 1;
        self.control.changed.notify_all();
    }

    /// `present-kick`: the latest frame again, even if already shown.
    pub fn kick(&self) {
        self.control.kick.store(true, Ordering::Release);
    }

    pub fn stop(mut self) {
        self.control.stop.store(true, Ordering::Release);
        self.control.changed.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CpuFrameSource {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Release);
        self.control.changed.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Reader {
    control: Arc<Control>,
    sinks: CpuSinks,
    sinks_order: u64,
    telemetry: Arc<Mutex<Telemetry>>,
    logger: Logger,
    requests: mpsc::UnboundedSender<CpuRequest>,
    runtime: tokio::runtime::Handle,
    textures: Vec<wgpu::Texture>,
    texture_size: (u32, u32),
    next_texture: usize,
    /// The ring mapped now (a duplicate of its descriptor and the layout),
    /// for the presenter's own buffers over it.
    #[cfg(target_os = "linux")]
    current_ring: Option<(std::os::fd::OwnedFd, videorc_preview_ring::RingInfo)>,
}

impl Reader {
    fn stopped(&self) -> bool {
        self.control.stop.load(Ordering::Acquire)
    }

    /// Takes a newer sink order, telling a new presenter the ring. Returns
    /// true when the sinks changed.
    fn refresh_sinks(&mut self) -> bool {
        let (order, sinks) = {
            let current = self
                .control
                .sinks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if current.order == self.sinks_order {
                return false;
            }
            (current.order, current.sinks.clone())
        };
        self.sinks_order = order;
        self.sinks = sinks;
        self.tell_presenter_ring();
        if let Ok(mut t) = self.telemetry.lock() {
            t.cpu_backing = Some(self.sinks.backing());
        }
        true
    }

    /// The presenter maps its buffers over the ring the reader has: a
    /// duplicate of the memory file's descriptor (the backend may retire
    /// and close its own any time; the duplicate keeps the file).
    fn tell_presenter_ring(&self) {
        #[cfg(target_os = "linux")]
        if let Some(presenter) = &self.sinks.presenter {
            let mapping = self
                .current_ring
                .as_ref()
                .and_then(|(fd, info)| match fd.try_clone() {
                    Ok(fd) => Some(crate::linux::RingMapping { fd, info: *info }),
                    Err(error) => {
                        self.logger.log(
                            Level::Error,
                            &format!(
                                "[preview] the ring's descriptor could not be duplicated for the presenter: {error}"
                            ),
                        );
                        None
                    }
                });
            presenter.set_ring(mapping);
        }
    }

    /// Waits for a ring order newer than `seen`; `None` on stop.
    fn next_order(&self, seen: u64) -> Option<(u64, Option<PreviewCpuRing>)> {
        let mut order = self
            .control
            .ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if self.stopped() {
                return None;
            }
            if order.order != seen {
                return Some((order.order, order.handle.clone()));
            }
            let (guard, _) = self
                .control
                .changed
                .wait_timeout(order, FRAME_WAIT)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            order = guard;
        }
    }

    fn run(mut self) {
        let mut seen = 0_u64;
        let mut last_generation: Option<u64> = None;
        self.refresh_sinks();
        while let Some((order, ring)) = self.next_order(seen) {
            seen = order;
            let Some(ring) = ring else {
                // No ring yet (the backend waits for its first frame with
                // pixels): ask again shortly.
                self.note_ring(false, 0);
                self.set_current_ring(None);
                std::thread::sleep(REOPEN_SPACING);
                if !self.stopped() {
                    let _ = self.requests.send(CpuRequest::Reopen);
                }
                continue;
            };
            if last_generation == Some(ring.generation) {
                // The status had not moved past the retired ring: ask again
                // after a moment.
                std::thread::sleep(REOPEN_SPACING);
                let _ = self.requests.send(CpuRequest::Reopen);
                continue;
            }
            let handle = RingHandle {
                kind: if ring.handle_kind == "file-mapping" {
                    "file-mapping"
                } else {
                    "memfd-path"
                },
                name: ring.handle.clone(),
                bytes: ring.bytes,
            };
            let reader = match RingReader::open(&handle) {
                Ok(reader) => reader,
                Err(error) => {
                    self.logger.log(
                        Level::Error,
                        &format!(
                            "[preview] the CPU preview ring (generation {}) could not be mapped: {error}",
                            ring.generation
                        ),
                    );
                    if let Ok(mut t) = self.telemetry.lock() {
                        t.last_error = Some(format!("CPU preview ring: {error}"));
                    }
                    self.note_ring(false, 0);
                    std::thread::sleep(REOPEN_SPACING);
                    let _ = self.requests.send(CpuRequest::Reopen);
                    continue;
                }
            };
            last_generation = Some(ring.generation);
            self.logger.log(
                Level::Info,
                &format!(
                    "[preview] CPU preview ring generation {} mapped: {}x{} bgra8, {} slots, {} bytes ({})",
                    ring.generation,
                    ring.width,
                    ring.height,
                    ring.slot_count,
                    ring.bytes,
                    ring.handle_kind
                ),
            );
            self.note_ring(true, ring.generation);
            self.set_current_ring(Some(&reader));
            self.present_from(&reader, seen);
            self.note_ring(false, last_generation.unwrap_or(0));
            self.set_current_ring(None);
            if self.stopped() {
                break;
            }
            let _ = self.requests.send(CpuRequest::Reopen);
        }
        self.set_current_ring(None);
    }

    /// The ring the presenter builds its buffers over follows the one the
    /// reader has (a duplicate of the descriptor; nothing on Windows).
    #[cfg(target_os = "linux")]
    fn set_current_ring(&mut self, reader: Option<&RingReader>) {
        self.current_ring = reader.and_then(|reader| match reader.fd().try_clone_to_owned() {
            Ok(fd) => Some((fd, *reader.info())),
            Err(error) => {
                self.logger.log(
                    Level::Error,
                    &format!("[preview] the ring's descriptor could not be duplicated: {error}"),
                );
                None
            }
        });
        self.tell_presenter_ring();
    }

    #[cfg(not(target_os = "linux"))]
    fn set_current_ring(&mut self, _reader: Option<&RingReader>) {}

    fn note_ring(&self, open: bool, generation: u64) {
        if let Ok(mut t) = self.telemetry.lock() {
            t.cpu_ring_open = open;
            t.cpu_ring_generation = generation;
            // The frame target the contracts ask for: the ring, here.
            t.metal_target_present = open;
        }
    }

    /// Presents frames from `reader` until it retires, a new order arrives
    /// or the stop.
    fn present_from(&mut self, reader: &RingReader, order: u64) {
        let mut last_id = 0_u64;
        loop {
            if self.stopped() {
                return;
            }
            {
                let current = self
                    .control
                    .ring
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if current.order != order {
                    return;
                }
            }
            self.refresh_sinks();
            if self.sinks.is_empty() {
                // Nothing to show into: the frames stay in the ring.
                std::thread::sleep(NO_SINK_WAIT);
                continue;
            }
            let kick = self.control.kick.swap(false, Ordering::AcqRel);
            match reader.wait_newer(last_id, FRAME_WAIT) {
                Wait::Retired => return,
                Wait::Timeout => {
                    if kick && last_id > 0 {
                        last_id -= 1;
                    } else {
                        continue;
                    }
                }
                Wait::NewFrame(_) => {}
            }
            let Some(leased) = reader.lease_latest() else {
                continue;
            };
            let leased_id = leased.frame_id;
            if last_id > 0
                && leased_id > last_id + 1
                && let Ok(mut t) = self.telemetry.lock()
            {
                t.skipped += leased_id - last_id - 1;
            }
            let (width, height, stride) = (leased.width(), leased.height(), leased.stride());
            let captured_at_micros = leased.captured_at_micros;
            let source_sequence = leased.source_sequence;
            // S4.2c: the presenter first (it only needs the slot's index and
            // answers when the server has read it), then the upload.
            #[cfg(target_os = "linux")]
            let native = self
                .sinks
                .presenter
                .as_ref()
                .map(|presenter| presenter.present(leased.slot(), leased_id));
            let mut shown = false;
            let mut commit_at: Option<Instant> = None;
            if let Some(sink) = self.sinks.texture.clone() {
                let texture = self.texture_for(&sink, width, height);
                let uploaded_at = Instant::now();
                sink.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    leased.pixels(),
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(stride),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
                let (bound, bound_rx) = oneshot::channel();
                (sink.deliver)(TextureFrame {
                    frame_id: leased_id,
                    iosurface_id: 0,
                    width,
                    height,
                    texture,
                    bound,
                });
                // The timeout is built inside the runtime's context (a timer
                // needs the reactor), on this thread.
                let bound_at = self
                    .runtime
                    .block_on(async { tokio::time::timeout(BIND_DEADLINE, bound_rx).await });
                match bound_at {
                    Ok(Ok(at)) => {
                        shown = true;
                        commit_at = Some(at);
                        if let Ok(mut t) = self.telemetry.lock() {
                            t.texture_frames += 1;
                            t.cpu_upload_to_bind_ms =
                                at.saturating_duration_since(uploaded_at).as_secs_f64() * 1000.0;
                        }
                    }
                    Ok(Err(_)) | Err(_) => {
                        if let Ok(mut t) = self.telemetry.lock() {
                            t.dropped += 1;
                            t.last_error = Some(format!(
                                "the UI did not bind frame {leased_id} within {BIND_DEADLINE:?}"
                            ));
                        }
                    }
                }
            }
            #[cfg(target_os = "linux")]
            if let Some(native) = native {
                match self.await_native(&native, leased_id) {
                    NativeAnswer::Report(report) => match (report.committed_at, report.error) {
                        (Some(at), None) if report.shown => {
                            shown = true;
                            commit_at = commit_at.or(Some(at));
                            if let Ok(mut t) = self.telemetry.lock() {
                                t.layer_presented += 1;
                                t.cpu_present_to_release_ms =
                                    report.released.then(|| at.elapsed().as_secs_f64() * 1000.0);
                            }
                        }
                        // Hidden or unplaced: acknowledged, not drawn.
                        // Neither a present nor a drop; a frame the texture
                        // route bound still counts.
                        (Some(_), None) => {}
                        (_, error) => {
                            if let Ok(mut t) = self.telemetry.lock() {
                                t.dropped += 1;
                                t.last_error = Some(error.unwrap_or_else(|| {
                                    format!("the presenter showed nothing for frame {leased_id}")
                                }));
                            }
                        }
                    },
                    NativeAnswer::Gone => {
                        if let Ok(mut t) = self.telemetry.lock() {
                            t.dropped += 1;
                            t.last_error = Some(format!(
                                "the presenter ended before it answered for frame {leased_id}"
                            ));
                        }
                    }
                    NativeAnswer::Stopped => {
                        // The display server may still read the slot: the
                        // lease stays in the ring's header (the writer keeps
                        // off that slot) instead of going back with the
                        // guard. Only the stop gets here.
                        std::mem::forget(leased);
                        return;
                    }
                }
            }
            // The upload's staging copy is done and the presenter no longer
            // reads the slot: it goes back to the writer.
            drop(leased);
            if shown && let Ok(mut t) = self.telemetry.lock() {
                let age_ms = videorc_preview_ring::now_micros().saturating_sub(captured_at_micros)
                    as f64
                    / 1000.0;
                t.presented += 1;
                // The compositor's own sequence, not the ring's frame id: a
                // new ring (a new size) restarts its ids at 1, and the
                // contracts' "advancing" and the backend's stale-report
                // rule both need one monotonic count across rings.
                t.presented_frame_id = source_sequence;
                t.frame_width = width;
                t.frame_height = height;
                t.note_commit(commit_at.unwrap_or_else(Instant::now));
                t.note_latency(age_ms);
                t.cpu_last_source_sequence = Some(source_sequence);
            }
            last_id = leased_id;
        }
    }

    /// The presenter's answer for one frame, however late: only the answer
    /// (or the presenter's thread ending, which takes its child down) says
    /// the slot is no longer read. The stop ends the wait.
    #[cfg(target_os = "linux")]
    fn await_native(
        &self,
        native: &std::sync::mpsc::Receiver<crate::linux::PresentReport>,
        frame_id: u64,
    ) -> NativeAnswer {
        let mut wait = PRESENT_DEADLINE;
        let mut late = false;
        loop {
            match native.recv_timeout(wait) {
                Ok(report) => return NativeAnswer::Report(report),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return NativeAnswer::Gone,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if self.stopped() {
                        return NativeAnswer::Stopped;
                    }
                    if !late {
                        late = true;
                        self.logger.log(
                            Level::Warn,
                            &format!(
                                "[preview] the presenter has not answered for frame {frame_id} within {PRESENT_DEADLINE:?}; the slot stays leased until it does"
                            ),
                        );
                    }
                    wait = FRAME_WAIT;
                }
            }
        }
    }

    /// The next texture of the pool, rebuilt for a new size.
    fn texture_for(&mut self, sink: &TextureSink, width: u32, height: u32) -> wgpu::Texture {
        if self.texture_size != (width, height) || self.textures.len() != TEXTURE_POOL {
            self.textures = (0..TEXTURE_POOL)
                .map(|index| {
                    sink.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some(match index {
                            0 => "videorc-cpu-preview-0",
                            1 => "videorc-cpu-preview-1",
                            _ => "videorc-cpu-preview-2",
                        }),
                        size: wgpu::Extent3d {
                            width,
                            height,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Bgra8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING
                            | wgpu::TextureUsages::COPY_DST
                            | wgpu::TextureUsages::RENDER_ATTACHMENT,
                        view_formats: &[],
                    })
                })
                .collect();
            self.texture_size = (width, height);
            self.next_texture = 0;
        }
        let texture = self.textures[self.next_texture].clone();
        self.next_texture = (self.next_texture + 1) % TEXTURE_POOL;
        texture
    }
}
