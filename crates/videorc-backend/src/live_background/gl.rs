//! Plan 190 S5: the Linux live background renderer, OpenGL ES 3.0 through EGL.
//!
//! The GLSL in `glsl/*.frag` runs here as it is (it is GLSL ES 3.00). One
//! dedicated thread, `videorc-live-background-gl`, owns the EGL context: the
//! compositor tick posts the newest request (latest-wins) and takes the newest
//! finished frame, and never waits on the GPU. The thread renders the passes
//! into FBOs, packs the live frame flipped and swizzled to top-down BGRA in one
//! more pass, reads it back through a pixel buffer and publishes it; the CPU
//! compositor draws it like a picture.
//!
//! GPU safety (AGENTS.md, `linux_vaapi.rs`): the thread opens exactly one
//! render node, the pin when one is set, else the first node neither the VAAPI
//! nor the live background quarantine lists; it never tries another. A sentinel
//! is armed before the first context and draw, so a host hang quarantines that
//! node for live backgrounds on the next start. Software rasterisers are
//! refused (`software-gpu`): they would burn the CPU this plan protects.
//!
//! EGL and GLES are loaded with dlopen, only the first time a live background
//! composes; a machine without them shows the poster (`no-gpu`).
//!
//! Plan 194 S5: the instanced pass kind (`PassKind::Instanced`, Ghost Fibers'
//! dots and dust) is `glDrawArraysInstanced` of a triangle strip with
//! additive blending into a cleared scene, from the pass's own vertex shader
//! (`ghost_fibers.vert`). The new scratch: Beams' mipmapped half-float
//! field, Dither's cell field (fetched by texel), Ferrofluid's grid and
//! bound, Ghost Fibers' scene and bloom chain. The half-float targets need a
//! colour-buffer-float extension, as Plasma Wave's do.

use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use glow::HasContext;

use super::glsl::{LivePass, PassBlend, PassKind, VERTEX, fragment_source, passes, vertex_source};
use super::guard::{GuardLevel, LiveBackgroundGuard};
use super::looks::{LiveLook, UNIFORM_VEC4_COUNT, Uniforms, ferrofluid_look_camera, uniforms};
use super::runtime::{CpuLiveFrame, LiveBackgroundBoard, LiveBackgroundFrameInput};
use super::sizes::{
    beams_field_size, dither_field_size, ferrofluid_grid, ghost_fibers_bloom_sizes, internal_size,
    plasma_sizes, silk_field_size,
};
use crate::linux_vaapi::{ProbeQuarantine, QuarantineEntry, RenderNodeCandidate};
use crate::protocol::{
    LiveBackgroundId, LiveBackgroundRendering, LiveBackgroundStatus, LiveBackgroundStillReason,
};

/// The live background's own quarantine, beside the VAAPI one.
const LIVE_QUARANTINE_DIRECTORY_NAME: &str = "linux-live-background";
/// The sentinel's "what was probing" field.
const SENTINEL_PROBE: &str = "live-background-gles";
/// How long the worker waits for a request before checking its stop flag.
const WORKER_IDLE_WAIT: Duration = Duration::from_millis(250);
/// The readback fence's wait; a GPU slower than this is over any budget.
const READBACK_TIMEOUT_NS: i32 = 250_000_000;

/// Packs the live frame for the CPU compositor: flipped to top-down rows and
/// swizzled so the RGBA readback bytes are BGRA.
const PACK_FRAGMENT: &str = "#version 300 es
precision highp float;
uniform vec4 u[16];
uniform sampler2D t0;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u[0].xy;
  outColor = texture(t0, vec2(uv.x, 1.0 - uv.y)).bgra;
}
";

/// A failure that shows the poster. `background` scopes it to one live
/// background (a shader or a format that background needs); `None` is the
/// whole GPU (no EGL, no node, a software rasteriser).
#[derive(Debug, Clone, PartialEq)]
struct Failure {
    reason: LiveBackgroundStillReason,
    background: Option<LiveBackgroundId>,
    detail: String,
}

impl Failure {
    fn gpu(reason: LiveBackgroundStillReason, detail: impl Into<String>) -> Self {
        Self {
            reason,
            background: None,
            detail: detail.into(),
        }
    }

    fn background(
        reason: LiveBackgroundStillReason,
        id: LiveBackgroundId,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            reason,
            background: Some(id),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct Request {
    id: LiveBackgroundId,
    look: &'static LiveLook,
    phase: f64,
    dim: f32,
    view: (u32, u32),
    rendering: LiveBackgroundRendering,
}

#[derive(Debug, Default)]
struct WorkerStats {
    /// The last frame's render time on the thread (GPU + readback), taken
    /// by the next tick for the guard.
    last_render_ms: Option<f64>,
    failure: Option<Failure>,
    programs: u32,
    scratch_bytes: u64,
}

/// What the compositor and the worker share.
#[derive(Debug, Default)]
struct Shared {
    request: Mutex<Option<Request>>,
    wake: Condvar,
    latest: Mutex<Option<Arc<CpuLiveFrame>>>,
    stats: Mutex<WorkerStats>,
    stop: AtomicBool,
}

impl Shared {
    /// Post the newest request; an unserved older one is dropped.
    fn post(&self, request: Request) {
        *lock(&self.request) = Some(request);
        self.wake.notify_one();
    }

    /// The worker's wait: the newest request, or `None` once stopped.
    fn wait_for_request(&self) -> Option<Request> {
        let mut slot = lock(&self.request);
        loop {
            if self.stop.load(Ordering::Acquire) {
                return None;
            }
            if let Some(request) = slot.take() {
                return Some(request);
            }
            slot = self
                .wake
                .wait_timeout(slot, WORKER_IDLE_WAIT)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    fn publish(&self, frame: Arc<CpuLiveFrame>) -> Option<Arc<CpuLiveFrame>> {
        lock(&self.latest).replace(frame)
    }

    fn latest(&self) -> Option<Arc<CpuLiveFrame>> {
        lock(&self.latest).clone()
    }

    fn fail(&self, failure: Failure) {
        lock(&self.stats).failure = Some(failure);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The CPU compositor's live background renderer on Linux: the compositor
/// side of the worker thread (guard, status, resources).
pub struct LiveBackgroundGlRenderer {
    board: Arc<LiveBackgroundBoard>,
    guard: LiveBackgroundGuard,
    shared: Option<Arc<Shared>>,
    failure: Option<Failure>,
    reported_status: Option<LiveBackgroundStatus>,
    reported_resources: (u32, u64),
}

impl LiveBackgroundGlRenderer {
    pub fn new(board: Arc<LiveBackgroundBoard>) -> Self {
        Self {
            board,
            guard: LiveBackgroundGuard::new(),
            shared: None,
            failure: None,
            reported_status: None,
            reported_resources: (0, 0),
        }
    }

    /// This tick's live frame: the newest one the worker finished, or `None`
    /// while it starts or when the poster must show (the board says why).
    pub fn render(
        &mut self,
        input: &LiveBackgroundFrameInput,
        output: (u32, u32),
        preflight: Option<LiveBackgroundStillReason>,
    ) -> Option<Arc<CpuLiveFrame>> {
        let tick = input.tick;
        let render_ms = self.poll_worker();
        self.guard.follow(input.spec.id);
        self.guard.record(
            tick.at,
            render_ms,
            tick.missed_deadline,
            tick.frame_interval,
        );
        let p95 = self.guard.last_p95_ms();
        if let Some(reason) = preflight {
            self.stop_worker();
            self.report_status(input.status(LiveBackgroundRendering::Still, Some(reason), p95));
            return None;
        }
        // A background-scoped failure lifts when the background changes.
        if self
            .failure
            .as_ref()
            .is_some_and(|failure| failure.background.is_some_and(|id| id != input.spec.id))
        {
            self.failure = None;
        }
        if let Some(failure) = self.failure.clone() {
            self.report_status(input.status(
                LiveBackgroundRendering::Still,
                Some(failure.reason),
                p95,
            ));
            return None;
        }
        let level = self.guard.level();
        if level == GuardLevel::Still {
            self.stop_worker();
            self.report_status(input.status(
                LiveBackgroundRendering::Still,
                Some(LiveBackgroundStillReason::GpuBudget),
                p95,
            ));
            return None;
        }
        let shared = self.ensure_worker();
        shared.post(Request {
            id: input.spec.id,
            look: input.look,
            phase: input.phase_at(tick.at),
            dim: input.dim,
            view: internal_size(input.spec.id, output, level),
            rendering: match level {
                GuardLevel::Half => LiveBackgroundRendering::Half,
                _ => LiveBackgroundRendering::Shader,
            },
        });
        // Only a frame of this background: a switch shows the poster until
        // the new background's first frame lands, never the old one.
        let frame = shared
            .latest()
            .filter(|frame| frame.sequence > 0 && self.frame_matches(frame, input))?;
        self.report_status(input.status(frame.rendering, None, p95));
        Some(frame)
    }

    fn frame_matches(&self, frame: &CpuLiveFrame, input: &LiveBackgroundFrameInput) -> bool {
        // The worker stamps each frame with the background it drew in its
        // sequence's high bits (see `frame_tag`).
        frame.sequence >> 56 == u64::from(background_tag(input.spec.id))
    }

    /// The worker's last render time (taken once), and any failure it hit.
    fn poll_worker(&mut self) -> Option<f64> {
        let shared = self.shared.as_ref()?;
        let (render_ms, failure, resources) = {
            let mut stats = lock(&shared.stats);
            (
                stats.last_render_ms.take(),
                stats.failure.take(),
                (stats.programs, stats.scratch_bytes),
            )
        };
        self.report_resources(resources);
        if let Some(failure) = failure {
            tracing::warn!(
                "live background (Linux GLES): showing the poster, {:?}: {}",
                failure.reason,
                failure.detail
            );
            let whole_gpu = failure.background.is_none();
            self.failure = Some(failure);
            if whole_gpu {
                self.stop_worker();
            }
        }
        render_ms
    }

    fn ensure_worker(&mut self) -> Arc<Shared> {
        if let Some(shared) = &self.shared {
            return Arc::clone(shared);
        }
        let shared = Arc::new(Shared::default());
        let worker_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("videorc-live-background-gl".to_string())
            .spawn(move || worker_main(&worker_shared));
        if let Err(error) = spawned {
            shared.fail(Failure::gpu(
                LiveBackgroundStillReason::NoGpu,
                format!("could not start the GL thread: {error}"),
            ));
        }
        self.shared = Some(Arc::clone(&shared));
        shared
    }

    /// Stop the worker without waiting for it: it finishes its frame, frees
    /// its GL objects and context, and exits on its own (a hung driver must
    /// never stall the compositor).
    fn stop_worker(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.stop.store(true, Ordering::Release);
            shared.wake.notify_all();
        }
        self.report_resources((0, 0));
    }

    pub fn holds_resources(&self) -> bool {
        self.shared.is_some()
    }

    /// The live background left (or composition stopped): stop the worker and
    /// clear what this renderer reported.
    pub fn release(&mut self) {
        self.stop_worker();
        self.reported_status = None;
    }

    fn report_status(&mut self, status: LiveBackgroundStatus) {
        if self.reported_status.as_ref() != Some(&status) {
            self.board.report(status.clone());
            self.reported_status = Some(status);
        }
    }

    fn report_resources(&mut self, resources: (u32, u64)) {
        if resources != self.reported_resources {
            self.reported_resources = resources;
            self.board.set_resources(resources.0, resources.1);
        }
    }
}

impl Drop for LiveBackgroundGlRenderer {
    fn drop(&mut self) {
        self.stop_worker();
    }
}

/// The backgrounds this renderer can draw: all ten since plan 194 S5 (the
/// GLSL runs as it is; the scratch and the instanced pass are here).
pub fn ported(_id: LiveBackgroundId) -> bool {
    true
}

/// The background tag a frame's sequence carries in its top byte.
fn background_tag(id: LiveBackgroundId) -> u8 {
    super::looks::ALL_LIVE_BACKGROUNDS
        .iter()
        .position(|candidate| *candidate == id)
        .unwrap_or(0) as u8
        + 1
}

fn frame_tag(id: LiveBackgroundId, counter: u64) -> u64 {
    (u64::from(background_tag(id)) << 56) | (counter & ((1 << 56) - 1))
}

// ---------------------------------------------------------------- render node

/// The one render node live backgrounds may open: the pin when set (the
/// operator asked for it by name, quarantine or not), else the first node
/// neither quarantine list names. Never a list of fallbacks to wander through.
pub(crate) fn choose_live_node(
    candidates: &[RenderNodeCandidate],
    pin: Option<&Path>,
    vaapi_quarantined: &[QuarantineEntry],
    live_quarantined: &[QuarantineEntry],
) -> Result<RenderNodeCandidate, LiveBackgroundStillReason> {
    if let Some(pin) = pin {
        return candidates
            .iter()
            .find(|candidate| candidate.path == pin)
            .cloned()
            .ok_or(LiveBackgroundStillReason::NoGpu);
    }
    if candidates.is_empty() {
        return Err(LiveBackgroundStillReason::NoGpu);
    }
    let quarantined = |candidate: &RenderNodeCandidate| {
        let node = candidate.node_name();
        vaapi_quarantined
            .iter()
            .chain(live_quarantined)
            .any(|entry| entry.node == node)
    };
    candidates
        .iter()
        .find(|candidate| !quarantined(candidate))
        .cloned()
        .ok_or(LiveBackgroundStillReason::QuarantinedNode)
}

/// Whether `GL_RENDERER` names a software rasteriser.
pub(crate) fn is_software_renderer(renderer: &str) -> bool {
    let renderer = renderer.to_ascii_lowercase();
    [
        "llvmpipe",
        "softpipe",
        "swrast",
        "swiftshader",
        "software rasterizer",
    ]
    .iter()
    .any(|needle| renderer.contains(needle))
}

fn live_quarantine() -> ProbeQuarantine {
    ProbeQuarantine::new(
        ProbeQuarantine::default_directory().with_file_name(LIVE_QUARANTINE_DIRECTORY_NAME),
    )
}

fn pick_node() -> Result<RenderNodeCandidate, Failure> {
    let live = live_quarantine();
    if let Ok(Some(entry)) = live.adopt_stale_sentinel() {
        tracing::warn!(
            "live background (Linux GLES): {} never came back last time; it is quarantined for live backgrounds ({})",
            entry.node,
            entry.detail()
        );
    }
    let candidates = crate::linux_vaapi::render_node_candidates(
        Path::new("/dev/dri"),
        Path::new("/sys/class/drm"),
    );
    let pin = crate::linux_vaapi::parse_device_pin(
        std::env::var(crate::linux_vaapi::DEVICE_PIN_ENV)
            .ok()
            .as_deref(),
    )
    .map_err(|error| Failure::gpu(LiveBackgroundStillReason::NoGpu, error))?;
    let vaapi = ProbeQuarantine::new(ProbeQuarantine::default_directory()).quarantined();
    choose_live_node(&candidates, pin.as_deref(), &vaapi, &live.quarantined()).map_err(|reason| {
        Failure::gpu(
            reason,
            format!(
                "no render node for live backgrounds (candidates: {})",
                candidates
                    .iter()
                    .map(RenderNodeCandidate::describe)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
    })
}

// ---------------------------------------------------------------- EGL

type Egl = khronos_egl::DynamicInstance<khronos_egl::EGL1_5>;

const EGL_PLATFORM_DEVICE_EXT: khronos_egl::Enum = 0x313F;
const EGL_DRM_RENDER_NODE_FILE_EXT: i32 = 0x3377;

type QueryDevices = unsafe extern "C" fn(i32, *mut *mut c_void, *mut i32) -> u32;
type QueryDeviceString = unsafe extern "C" fn(*mut c_void, i32) -> *const c_char;

/// One surfaceless GLES 3.0 context on one render node.
struct GlesContext {
    egl: Egl,
    display: khronos_egl::Display,
    context: khronos_egl::Context,
    gl: glow::Context,
}

impl GlesContext {
    /// # Safety
    /// Loads and calls into the system's EGL; the caller owns the thread the
    /// context becomes current on.
    unsafe fn open(node: &Path) -> Result<Self, Failure> {
        let no_gpu = |detail: String| Failure::gpu(LiveBackgroundStillReason::NoGpu, detail);
        let egl = unsafe { Egl::load_required() }
            .map_err(|error| no_gpu(format!("EGL 1.5 is not available: {error}")))?;
        let device = unsafe { egl_device_for_node(&egl, node) }?;
        let display = unsafe {
            egl.get_platform_display(EGL_PLATFORM_DEVICE_EXT, device, &[khronos_egl::ATTRIB_NONE])
        }
        .map_err(|error| no_gpu(format!("eglGetPlatformDisplay: {error}")))?;
        egl.initialize(display)
            .map_err(|error| no_gpu(format!("eglInitialize: {error}")))?;
        let opened = (|| {
            egl.bind_api(khronos_egl::OPENGL_ES_API)
                .map_err(|error| no_gpu(format!("eglBindAPI: {error}")))?;
            let config = egl
                .choose_first_config(
                    display,
                    &[
                        khronos_egl::RENDERABLE_TYPE,
                        khronos_egl::OPENGL_ES3_BIT,
                        khronos_egl::NONE,
                    ],
                )
                .map_err(|error| no_gpu(format!("eglChooseConfig: {error}")))?
                .ok_or_else(|| no_gpu("no GLES 3 EGL config".to_string()))?;
            let context = egl
                .create_context(
                    display,
                    config,
                    None,
                    &[khronos_egl::CONTEXT_MAJOR_VERSION, 3, khronos_egl::NONE],
                )
                .map_err(|error| no_gpu(format!("eglCreateContext: {error}")))?;
            // Surfaceless (EGL_KHR_surfaceless_context): every pass renders
            // into an FBO.
            if let Err(error) = egl.make_current(display, None, None, Some(context)) {
                let _ = egl.destroy_context(display, context);
                return Err(no_gpu(format!("eglMakeCurrent: {error}")));
            }
            Ok(context)
        })();
        let context = match opened {
            Ok(context) => context,
            Err(failure) => {
                let _ = egl.terminate(display);
                return Err(failure);
            }
        };
        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                egl.get_proc_address(name)
                    .map_or(std::ptr::null(), |function| function as *const c_void)
            })
        };
        Ok(Self {
            egl,
            display,
            context,
            gl,
        })
    }
}

impl Drop for GlesContext {
    fn drop(&mut self) {
        let _ = self.egl.make_current(self.display, None, None, None);
        let _ = self.egl.destroy_context(self.display, self.context);
        let _ = self.egl.terminate(self.display);
    }
}

/// The EGL device whose DRM render node is `node` (EGL_EXT_device_enumeration
/// with EGL_EXT_device_drm_render_node). Never a fallback device.
unsafe fn egl_device_for_node(egl: &Egl, node: &Path) -> Result<*mut c_void, Failure> {
    let no_gpu = |detail: String| Failure::gpu(LiveBackgroundStillReason::NoGpu, detail);
    let query_devices = egl
        .get_proc_address("eglQueryDevicesEXT")
        .ok_or_else(|| no_gpu("EGL has no eglQueryDevicesEXT".to_string()))?;
    let query_string = egl
        .get_proc_address("eglQueryDeviceStringEXT")
        .ok_or_else(|| no_gpu("EGL has no eglQueryDeviceStringEXT".to_string()))?;
    // SAFETY: the EGL_EXT_device_enumeration / device_query signatures.
    let query_devices: QueryDevices = unsafe { std::mem::transmute(query_devices) };
    let query_string: QueryDeviceString = unsafe { std::mem::transmute(query_string) };
    let mut count = 0;
    if unsafe { query_devices(0, std::ptr::null_mut(), &mut count) } == 0 || count <= 0 {
        return Err(no_gpu("EGL lists no devices".to_string()));
    }
    let mut devices = vec![std::ptr::null_mut(); count as usize];
    if unsafe { query_devices(count, devices.as_mut_ptr(), &mut count) } == 0 {
        return Err(no_gpu("eglQueryDevicesEXT failed".to_string()));
    }
    devices.truncate(count.max(0) as usize);
    let wanted = node.to_string_lossy();
    for device in devices {
        let name = unsafe { query_string(device, EGL_DRM_RENDER_NODE_FILE_EXT) };
        if name.is_null() {
            continue;
        }
        if unsafe { CStr::from_ptr(name) }.to_string_lossy() == wanted {
            return Ok(device);
        }
    }
    Err(no_gpu(format!("no EGL device drives {wanted}")))
}

// ---------------------------------------------------------------- the worker

fn worker_main(shared: &Arc<Shared>) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_worker(shared)));
    let failure = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(failure)) => failure,
        Err(_) => Failure::gpu(
            LiveBackgroundStillReason::NoGpu,
            "the GL thread panicked".to_string(),
        ),
    };
    shared.fail(failure);
}

fn run_worker(shared: &Arc<Shared>) -> Result<(), Failure> {
    let node = pick_node()?;
    let live = live_quarantine();
    // No sentinel, no GPU: a context that hangs the host must be remembered.
    live.begin_probe(&node, SENTINEL_PROBE).map_err(|error| {
        Failure::gpu(
            LiveBackgroundStillReason::NoGpu,
            format!("could not arm the live background sentinel: {error}"),
        )
    })?;
    let mut sentinel_armed = true;
    let result = (|| {
        let context = unsafe { GlesContext::open(&node.path) }?;
        let gl = &context.gl;
        let renderer = unsafe { gl.get_parameter_string(glow::RENDERER) };
        if is_software_renderer(&renderer) && !allow_software_renderer() {
            return Err(Failure::gpu(
                LiveBackgroundStillReason::SoftwareGpu,
                format!("{} renders in software ({renderer})", node.describe()),
            ));
        }
        tracing::info!(
            "live background (Linux GLES) on {}: {renderer}",
            node.describe()
        );
        let mut state = unsafe { GlState::new(gl) }?;
        let mut counter = 0u64;
        // The frame the last publish replaced: its buffer is reused once the
        // compositor no longer holds it (else a new one is allocated).
        let mut recycle: Option<Arc<CpuLiveFrame>> = None;
        while let Some(request) = shared.wait_for_request() {
            let started = Instant::now();
            let reuse = recycle
                .take()
                .and_then(|frame| Arc::try_unwrap(frame).ok())
                .and_then(|frame| Arc::try_unwrap(frame.bgra).ok());
            match unsafe { state.render(gl, &request, reuse) } {
                Ok(bgra) => {
                    counter += 1;
                    recycle = shared.publish(Arc::new(CpuLiveFrame {
                        bgra: Arc::new(bgra),
                        width: request.view.0,
                        height: request.view.1,
                        sequence: frame_tag(request.id, counter),
                        rendering: request.rendering,
                    }));
                    if sentinel_armed {
                        // The node drew a frame: the sentinel no longer means
                        // a hang.
                        let _ = live.finish_probe();
                        sentinel_armed = false;
                    }
                    let mut stats = lock(&shared.stats);
                    stats.last_render_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                    stats.programs = state.programs.len() as u32;
                    stats.scratch_bytes = state.scratch_bytes();
                }
                Err(failure) => {
                    // A background-scoped failure: report it and keep serving
                    // other backgrounds; a whole-GPU one ends the thread.
                    let whole_gpu = failure.background.is_none();
                    shared.fail(failure.clone());
                    if whole_gpu {
                        return Err(failure);
                    }
                }
            }
        }
        unsafe { state.destroy(gl) };
        Ok(())
    })();
    if sentinel_armed {
        // The thread ended without hanging: whatever failed, it returned.
        let _ = live.finish_probe();
    }
    result
}

/// Tests may run the golden check on Mesa's llvmpipe (CI has no GPU).
fn allow_software_renderer() -> bool {
    cfg!(test)
        && std::env::var("VIDEORC_LIVE_BACKGROUND_GL_ALLOW_SOFTWARE")
            .map(|value| value == "1")
            .unwrap_or(false)
}

// ---------------------------------------------------------------- GL state

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum ProgramKey {
    Pass(LivePass),
    Pack,
}

struct Program {
    program: glow::Program,
    u: Option<glow::UniformLocation>,
    t0: Option<glow::UniformLocation>,
    t1: Option<glow::UniformLocation>,
}

/// A target's storage and sampling: RGBA8 or RGBA16F, with or without a mip
/// chain, sampled linearly or fetched by texel (nearest).
#[derive(Clone, Copy, PartialEq, Eq)]
struct TargetKind {
    float: bool,
    mipmapped: bool,
    nearest: bool,
}

impl TargetKind {
    /// The live frame, the pack target.
    const BYTE: Self = Self {
        float: false,
        mipmapped: false,
        nearest: false,
    };
    /// Dither's cells.
    const BYTE_NEAREST: Self = Self {
        float: false,
        mipmapped: false,
        nearest: true,
    };
    /// Silk's field.
    const MIPMAPPED: Self = Self {
        float: false,
        mipmapped: true,
        nearest: false,
    };
    /// Plasma Wave's trace and chain, Ferrofluid's grid, Ghost Fibers' scene
    /// and chain.
    const FLOAT: Self = Self {
        float: true,
        mipmapped: false,
        nearest: false,
    };
    /// Ferrofluid's bound.
    const FLOAT_NEAREST: Self = Self {
        float: true,
        mipmapped: false,
        nearest: true,
    };
    /// Beams' field.
    const MIPMAPPED_FLOAT: Self = Self {
        float: true,
        mipmapped: true,
        nearest: false,
    };
}

struct Target {
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
    size: (u32, u32),
    kind: TargetKind,
    bytes: u64,
}

struct GlState {
    vao: glow::VertexArray,
    programs: HashMap<ProgramKey, Program>,
    targets: HashMap<&'static str, Target>,
    readback: Option<(glow::Buffer, usize)>,
    float_targets: bool,
    target_id: Option<LiveBackgroundId>,
}

impl GlState {
    unsafe fn new(gl: &glow::Context) -> Result<Self, Failure> {
        let vao = unsafe { gl.create_vertex_array() }.map_err(|error| {
            Failure::gpu(LiveBackgroundStillReason::NoGpu, format!("VAO: {error}"))
        })?;
        let extensions = gl.supported_extensions();
        let float_targets = extensions.contains("GL_EXT_color_buffer_float")
            || extensions.contains("GL_EXT_color_buffer_half_float");
        Ok(Self {
            vao,
            programs: HashMap::new(),
            targets: HashMap::new(),
            readback: None,
            float_targets,
            target_id: None,
        })
    }

    fn scratch_bytes(&self) -> u64 {
        self.targets
            .values()
            .map(|target| target.bytes)
            .sum::<u64>()
            + self.readback.as_ref().map_or(0, |(_, len)| *len as u64)
    }

    unsafe fn program(
        &mut self,
        gl: &glow::Context,
        key: ProgramKey,
        id: LiveBackgroundId,
    ) -> Result<&Program, Failure> {
        if let std::collections::hash_map::Entry::Vacant(slot) = self.programs.entry(key) {
            // The full-screen triangle, or an instanced pass's own vertex
            // shader.
            let (vertex, fragment) = match key {
                ProgramKey::Pass(pass) => (vertex_source(pass), fragment_source(pass)),
                ProgramKey::Pack => (VERTEX.into(), PACK_FRAGMENT.into()),
            };
            let program = unsafe { link_program(gl, &vertex, &fragment) }.map_err(|detail| {
                Failure::background(LiveBackgroundStillReason::ShaderCompileFailed, id, detail)
            })?;
            let entry = unsafe {
                Program {
                    u: gl.get_uniform_location(program, "u"),
                    t0: gl.get_uniform_location(program, "t0"),
                    t1: gl.get_uniform_location(program, "t1"),
                    program,
                }
            };
            slot.insert(entry);
        }
        Ok(&self.programs[&key])
    }

    unsafe fn target(
        &mut self,
        gl: &glow::Context,
        key: &'static str,
        size: (u32, u32),
        kind: TargetKind,
        id: LiveBackgroundId,
    ) -> Result<(), Failure> {
        if self
            .targets
            .get(key)
            .is_some_and(|target| target.size == size && target.kind == kind)
        {
            return Ok(());
        }
        if let Some(old) = self.targets.remove(key) {
            unsafe { delete_target(gl, old) };
        }
        if kind.float && !self.float_targets {
            return Err(Failure::background(
                LiveBackgroundStillReason::NoGpu,
                id,
                "this GPU cannot render to half-float targets (EXT_color_buffer_float)",
            ));
        }
        let failed = |what: &str, error: String| {
            Failure::background(
                LiveBackgroundStillReason::NoGpu,
                id,
                format!("{what}: {error}"),
            )
        };
        unsafe {
            let texture = gl
                .create_texture()
                .map_err(|error| failed("texture", error))?;
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            let (internal, ty, bytes_per_pixel) = if kind.float {
                (glow::RGBA16F, glow::HALF_FLOAT, 8u64)
            } else {
                (glow::RGBA8, glow::UNSIGNED_BYTE, 4u64)
            };
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                internal as i32,
                size.0 as i32,
                size.1 as i32,
                0,
                glow::RGBA,
                ty,
                glow::PixelUnpackData::Slice(None),
            );
            let (min_filter, mag_filter) = if kind.mipmapped {
                (glow::LINEAR_MIPMAP_LINEAR, glow::LINEAR)
            } else if kind.nearest {
                (glow::NEAREST, glow::NEAREST)
            } else {
                (glow::LINEAR, glow::LINEAR)
            };
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                min_filter as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                mag_filter as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
            let framebuffer = gl
                .create_framebuffer()
                .map_err(|error| failed("framebuffer", error))?;
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );
            let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
            let base = u64::from(size.0) * u64::from(size.1) * bytes_per_pixel;
            let target = Target {
                texture,
                framebuffer,
                size,
                kind,
                bytes: if kind.mipmapped { base * 4 / 3 } else { base },
            };
            if status != glow::FRAMEBUFFER_COMPLETE {
                delete_target(gl, target);
                return Err(failed("framebuffer", format!("incomplete (0x{status:x})")));
            }
            self.targets.insert(key, target);
        }
        Ok(())
    }

    /// One pass into `destination`: the full-screen triangle, or `kind`'s
    /// instanced quads (an additive pass blends `ONE, ONE`; the first pass
    /// into a scene clears it first, `LivePass::clears_target`).
    #[allow(clippy::too_many_arguments)]
    unsafe fn pass(
        &mut self,
        gl: &glow::Context,
        key: ProgramKey,
        kind: PassKind,
        id: LiveBackgroundId,
        destination: &'static str,
        uniform_values: &Uniforms,
        t0: Option<&'static str>,
        t1: Option<&'static str>,
    ) -> Result<(), Failure> {
        let (program, u, l0, l1) = {
            let program = unsafe { self.program(gl, key, id) }?;
            (program.program, program.u, program.t0, program.t1)
        };
        let clears = matches!(key, ProgramKey::Pass(pass) if pass.clears_target());
        let target = &self.targets[destination];
        let flat: Vec<f32> = uniform_values.iter().flatten().copied().collect();
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
            gl.viewport(0, 0, target.size.0 as i32, target.size.1 as i32);
            gl.use_program(Some(program));
            gl.uniform_4_f32_slice(u.as_ref(), &flat);
            if let Some(name) = t0 {
                gl.active_texture(glow::TEXTURE0);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.targets[name].texture));
                gl.uniform_1_i32(l0.as_ref(), 0);
            }
            if let Some(name) = t1 {
                gl.active_texture(glow::TEXTURE1);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.targets[name].texture));
                gl.uniform_1_i32(l1.as_ref(), 1);
            }
            if clears {
                gl.clear_color(0.0, 0.0, 0.0, 0.0);
                gl.clear(glow::COLOR_BUFFER_BIT);
            }
            match kind {
                PassKind::FullScreen => gl.draw_arrays(glow::TRIANGLES, 0, 3),
                PassKind::Instanced {
                    vertices,
                    instances,
                    blend,
                } => {
                    if blend == PassBlend::Additive {
                        gl.enable(glow::BLEND);
                        gl.blend_func(glow::ONE, glow::ONE);
                    }
                    gl.draw_arrays_instanced(
                        glow::TRIANGLE_STRIP,
                        0,
                        vertices as i32,
                        instances as i32,
                    );
                    gl.disable(glow::BLEND);
                }
            }
        }
        Ok(())
    }

    /// Render one live frame and read it back as top-down BGRA.
    unsafe fn render(
        &mut self,
        gl: &glow::Context,
        request: &Request,
        reuse: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, Failure> {
        let id = request.id;
        if !ported(id) {
            return Err(Failure::background(
                LiveBackgroundStillReason::ShaderCompileFailed,
                id,
                "not ported to GLES",
            ));
        }
        let view = request.view;
        let look = request.look;
        let packed = |target: (u32, u32)| uniforms(look, target, view, request.phase, request.dim);
        const FULL: PassKind = PassKind::FullScreen;
        if self.target_id != Some(id) {
            // Another background: drop the old one's scratch.
            let keep = ["frame", "pack"];
            let stale: Vec<_> = self
                .targets
                .keys()
                .copied()
                .filter(|key| !keep.contains(key))
                .collect();
            for key in stale {
                if let Some(target) = self.targets.remove(key) {
                    unsafe { delete_target(gl, target) };
                }
            }
            self.target_id = Some(id);
        }
        // Programs first: a background whose shader won't build allocates
        // nothing.
        for pass in passes(id) {
            unsafe { self.program(gl, ProgramKey::Pass(*pass), id) }?;
        }
        unsafe {
            self.program(gl, ProgramKey::Pack, id)?;
            gl.bind_vertex_array(Some(self.vao));
            gl.disable(glow::BLEND);
            self.target(gl, "frame", view, TargetKind::BYTE, id)?;
            self.target(gl, "pack", view, TargetKind::BYTE, id)?;
        }
        match id {
            LiveBackgroundId::Silk => unsafe {
                let field = silk_field_size(view);
                self.target(gl, "silk-field", field, TargetKind::MIPMAPPED, id)?;
                let field_pass = ProgramKey::Pass(LivePass::SilkField);
                self.pass(
                    gl,
                    field_pass,
                    FULL,
                    id,
                    "silk-field",
                    &packed(field),
                    None,
                    None,
                )?;
                gl.bind_texture(glow::TEXTURE_2D, Some(self.targets["silk-field"].texture));
                gl.generate_mipmap(glow::TEXTURE_2D);
                let composite = ProgramKey::Pass(LivePass::SilkComposite);
                self.pass(
                    gl,
                    composite,
                    FULL,
                    id,
                    "frame",
                    &packed(view),
                    Some("silk-field"),
                    None,
                )?;
            },
            LiveBackgroundId::PlasmaWave => unsafe {
                let sizes = plasma_sizes(view);
                const DOWN: [&str; 5] = [
                    "plasma-down-0",
                    "plasma-down-1",
                    "plasma-down-2",
                    "plasma-down-3",
                    "plasma-down-4",
                ];
                const UP: [&str; 4] = ["", "plasma-up-1", "plasma-up-2", "plasma-up-3"];
                self.target(gl, "plasma-coarse", sizes.coarse, TargetKind::FLOAT, id)?;
                self.target(gl, "plasma-fine", sizes.fine, TargetKind::FLOAT, id)?;
                for (level, key) in DOWN.iter().enumerate() {
                    self.target(gl, key, sizes.down[level], TargetKind::FLOAT, id)?;
                }
                for (level, key) in UP.iter().enumerate().skip(1) {
                    self.target(gl, key, sizes.down[level], TargetKind::FLOAT, id)?;
                }
                let coarse = ProgramKey::Pass(LivePass::PlasmaCoarse);
                self.pass(
                    gl,
                    coarse,
                    FULL,
                    id,
                    "plasma-coarse",
                    &packed(sizes.coarse),
                    None,
                    None,
                )?;
                let fine = ProgramKey::Pass(LivePass::PlasmaFine);
                self.pass(
                    gl,
                    fine,
                    FULL,
                    id,
                    "plasma-fine",
                    &packed(sizes.fine),
                    Some("plasma-coarse"),
                    None,
                )?;
                let down = ProgramKey::Pass(LivePass::PlasmaDown);
                let mut source = "plasma-fine";
                for (level, key) in DOWN.iter().enumerate() {
                    self.pass(
                        gl,
                        down,
                        FULL,
                        id,
                        key,
                        &packed(sizes.down[level]),
                        Some(source),
                        None,
                    )?;
                    source = *key;
                }
                let up = ProgramKey::Pass(LivePass::PlasmaUp);
                for level in (1..=3).rev() {
                    let from = if level == 3 { DOWN[4] } else { UP[level + 1] };
                    self.pass(
                        gl,
                        up,
                        FULL,
                        id,
                        UP[level],
                        &packed(sizes.down[level]),
                        Some(from),
                        Some(DOWN[level]),
                    )?;
                }
                let composite = ProgramKey::Pass(LivePass::PlasmaComposite);
                self.pass(
                    gl,
                    composite,
                    FULL,
                    id,
                    "frame",
                    &packed(view),
                    Some("plasma-fine"),
                    Some("plasma-up-1"),
                )?;
            },
            LiveBackgroundId::Beams => unsafe {
                let field = beams_field_size(view);
                self.target(gl, "beams-field", field, TargetKind::MIPMAPPED_FLOAT, id)?;
                let field_pass = ProgramKey::Pass(LivePass::BeamsField);
                self.pass(
                    gl,
                    field_pass,
                    FULL,
                    id,
                    "beams-field",
                    &packed(field),
                    None,
                    None,
                )?;
                gl.bind_texture(glow::TEXTURE_2D, Some(self.targets["beams-field"].texture));
                gl.generate_mipmap(glow::TEXTURE_2D);
                let composite = ProgramKey::Pass(LivePass::BeamsComposite);
                self.pass(
                    gl,
                    composite,
                    FULL,
                    id,
                    "frame",
                    &packed(view),
                    Some("beams-field"),
                    None,
                )?;
            },
            LiveBackgroundId::Dither => unsafe {
                // One texel per cell; the cell comes from the look's pixel
                // size (`u[3].z`), as the shader derives it.
                let cells = dither_field_size(view, look.statics[1][2]);
                self.target(gl, "dither-field", cells, TargetKind::BYTE_NEAREST, id)?;
                let wave = ProgramKey::Pass(LivePass::DitherWave);
                self.pass(
                    gl,
                    wave,
                    FULL,
                    id,
                    "dither-field",
                    &packed(cells),
                    None,
                    None,
                )?;
                let composite = ProgramKey::Pass(LivePass::DitherComposite);
                self.pass(
                    gl,
                    composite,
                    FULL,
                    id,
                    "frame",
                    &packed(view),
                    Some("dither-field"),
                    None,
                )?;
            },
            LiveBackgroundId::Ferrofluid => unsafe {
                let grid = ferrofluid_grid(&ferrofluid_look_camera(look), view);
                self.target(gl, "ferrofluid-field", grid.size, TargetKind::FLOAT, id)?;
                self.target(
                    gl,
                    "ferrofluid-bound",
                    grid.bound,
                    TargetKind::FLOAT_NEAREST,
                    id,
                )?;
                let field = ProgramKey::Pass(LivePass::FerrofluidField);
                self.pass(
                    gl,
                    field,
                    FULL,
                    id,
                    "ferrofluid-field",
                    &packed(grid.size),
                    None,
                    None,
                )?;
                let bound = ProgramKey::Pass(LivePass::FerrofluidBound);
                self.pass(
                    gl,
                    bound,
                    FULL,
                    id,
                    "ferrofluid-bound",
                    &packed(grid.bound),
                    Some("ferrofluid-field"),
                    None,
                )?;
                let render = ProgramKey::Pass(LivePass::FerrofluidRender);
                self.pass(
                    gl,
                    render,
                    FULL,
                    id,
                    "frame",
                    &packed(view),
                    Some("ferrofluid-field"),
                    Some("ferrofluid-bound"),
                )?;
            },
            LiveBackgroundId::GhostFibers => unsafe {
                // The bright level and four down levels, then the up chain
                // back to level 0 (each up level adds the matching down
                // level, as Plasma's does).
                const DOWN: [&str; 5] = [
                    "ghost-bloom-0",
                    "ghost-bloom-1",
                    "ghost-bloom-2",
                    "ghost-bloom-3",
                    "ghost-bloom-4",
                ];
                const UP: [&str; 4] = ["ghost-up-0", "ghost-up-1", "ghost-up-2", "ghost-up-3"];
                let sizes = ghost_fibers_bloom_sizes(view);
                self.target(gl, "ghost-scene", view, TargetKind::FLOAT, id)?;
                for (level, key) in DOWN.iter().enumerate() {
                    self.target(gl, key, sizes[level], TargetKind::FLOAT, id)?;
                }
                for (level, key) in UP.iter().enumerate() {
                    self.target(gl, key, sizes[level], TargetKind::FLOAT, id)?;
                }
                // The dots clear the scene and add into it; the dust adds
                // after them (a look with none skips the draw).
                let dots = LivePass::GhostFibersDots;
                let scene_uniforms = packed(view);
                self.pass(
                    gl,
                    ProgramKey::Pass(dots),
                    dots.kind(look),
                    id,
                    "ghost-scene",
                    &scene_uniforms,
                    None,
                    None,
                )?;
                let dust = LivePass::GhostFibersDust;
                if let PassKind::Instanced { instances, .. } = dust.kind(look)
                    && instances > 0
                {
                    self.pass(
                        gl,
                        ProgramKey::Pass(dust),
                        dust.kind(look),
                        id,
                        "ghost-scene",
                        &scene_uniforms,
                        None,
                        None,
                    )?;
                }
                let bright = ProgramKey::Pass(LivePass::GhostFibersBright);
                self.pass(
                    gl,
                    bright,
                    FULL,
                    id,
                    DOWN[0],
                    &packed(sizes[0]),
                    Some("ghost-scene"),
                    None,
                )?;
                let down = ProgramKey::Pass(LivePass::GhostFibersDown);
                for level in 1..DOWN.len() {
                    self.pass(
                        gl,
                        down,
                        FULL,
                        id,
                        DOWN[level],
                        &packed(sizes[level]),
                        Some(DOWN[level - 1]),
                        None,
                    )?;
                }
                let up = ProgramKey::Pass(LivePass::GhostFibersUp);
                for level in (0..UP.len()).rev() {
                    let from = if level == 3 { DOWN[4] } else { UP[level + 1] };
                    self.pass(
                        gl,
                        up,
                        FULL,
                        id,
                        UP[level],
                        &packed(sizes[level]),
                        Some(from),
                        Some(DOWN[level]),
                    )?;
                }
                let composite = ProgramKey::Pass(LivePass::GhostFibersComposite);
                self.pass(
                    gl,
                    composite,
                    FULL,
                    id,
                    "frame",
                    &scene_uniforms,
                    Some("ghost-scene"),
                    Some(UP[0]),
                )?;
            },
            _ => unsafe {
                let pass = ProgramKey::Pass(passes(id)[0]);
                self.pass(gl, pass, FULL, id, "frame", &packed(view), None, None)?;
            },
        }
        unsafe {
            let mut pack_uniforms: Uniforms = [[0.0f32; 4]; UNIFORM_VEC4_COUNT];
            pack_uniforms[0] = [view.0 as f32, view.1 as f32, 0.0, 0.0];
            self.pass(
                gl,
                ProgramKey::Pack,
                FULL,
                id,
                "pack",
                &pack_uniforms,
                Some("frame"),
                None,
            )?;
            self.read_back(gl, view, reuse, id)
        }
    }

    unsafe fn read_back(
        &mut self,
        gl: &glow::Context,
        view: (u32, u32),
        reuse: Option<Vec<u8>>,
        id: LiveBackgroundId,
    ) -> Result<Vec<u8>, Failure> {
        let len = view.0 as usize * view.1 as usize * 4;
        let failed = |detail: String| {
            Failure::background(
                LiveBackgroundStillReason::NoGpu,
                id,
                format!("readback: {detail}"),
            )
        };
        unsafe {
            if self.readback.as_ref().is_none_or(|(_, size)| *size != len) {
                if let Some((buffer, _)) = self.readback.take() {
                    gl.delete_buffer(buffer);
                }
                let buffer = gl.create_buffer().map_err(failed)?;
                gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(buffer));
                gl.buffer_data_size(glow::PIXEL_PACK_BUFFER, len as i32, glow::STREAM_READ);
                self.readback = Some((buffer, len));
            }
            let (buffer, _) = self
                .readback
                .as_ref()
                .copied()
                .ok_or_else(|| failed("no buffer".into()))?;
            gl.bind_framebuffer(
                glow::READ_FRAMEBUFFER,
                Some(self.targets["pack"].framebuffer),
            );
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(buffer));
            gl.read_pixels(
                0,
                0,
                view.0 as i32,
                view.1 as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::BufferOffset(0),
            );
            let fence = gl
                .fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0)
                .map_err(failed)?;
            let waited =
                gl.client_wait_sync(fence, glow::SYNC_FLUSH_COMMANDS_BIT, READBACK_TIMEOUT_NS);
            gl.delete_sync(fence);
            if waited == glow::TIMEOUT_EXPIRED || waited == glow::WAIT_FAILED {
                gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
                return Err(failed(format!("the GPU did not finish (0x{waited:x})")));
            }
            let mapped =
                gl.map_buffer_range(glow::PIXEL_PACK_BUFFER, 0, len as i32, glow::MAP_READ_BIT);
            if mapped.is_null() {
                gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
                return Err(failed("map failed".into()));
            }
            let mut out = reuse
                .filter(|buffer| buffer.len() == len)
                .unwrap_or_else(|| vec![0; len]);
            std::ptr::copy_nonoverlapping(mapped, out.as_mut_ptr(), len);
            gl.unmap_buffer(glow::PIXEL_PACK_BUFFER);
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            Ok(out)
        }
    }

    unsafe fn destroy(self, gl: &glow::Context) {
        unsafe {
            for (_, program) in self.programs {
                gl.delete_program(program.program);
            }
            for (_, target) in self.targets {
                delete_target(gl, target);
            }
            if let Some((buffer, _)) = self.readback {
                gl.delete_buffer(buffer);
            }
            gl.delete_vertex_array(self.vao);
        }
    }
}

unsafe fn delete_target(gl: &glow::Context, target: Target) {
    unsafe {
        gl.delete_framebuffer(target.framebuffer);
        gl.delete_texture(target.texture);
    }
}

unsafe fn link_program(
    gl: &glow::Context,
    vertex: &str,
    fragment: &str,
) -> Result<glow::Program, String> {
    unsafe {
        let compile = |kind: u32, source: &str| -> Result<glow::Shader, String> {
            let shader = gl.create_shader(kind)?;
            gl.shader_source(shader, source);
            gl.compile_shader(shader);
            if gl.get_shader_compile_status(shader) {
                Ok(shader)
            } else {
                let log = gl.get_shader_info_log(shader);
                gl.delete_shader(shader);
                Err(log)
            }
        };
        let vertex = compile(glow::VERTEX_SHADER, vertex)?;
        let fragment = match compile(glow::FRAGMENT_SHADER, fragment) {
            Ok(shader) => shader,
            Err(log) => {
                gl.delete_shader(vertex);
                return Err(log);
            }
        };
        let program = gl.create_program()?;
        gl.attach_shader(program, vertex);
        gl.attach_shader(program, fragment);
        gl.link_program(program);
        gl.delete_shader(vertex);
        gl.delete_shader(fragment);
        if gl.get_program_link_status(program) {
            Ok(program)
        } else {
            let log = gl.get_program_info_log(program);
            gl.delete_program(program);
            Err(log)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str) -> RenderNodeCandidate {
        RenderNodeCandidate {
            path: PathBuf::from(format!("/dev/dri/{name}")),
            driver: Some("i915".to_string()),
        }
    }

    fn quarantined(node: &str) -> QuarantineEntry {
        QuarantineEntry {
            node: node.to_string(),
            driver: None,
            ffmpeg_path: SENTINEL_PROBE.to_string(),
            probe_started_at_unix_secs: 0,
            quarantined_at_unix_secs: 0,
        }
    }

    #[test]
    fn the_first_unquarantined_node_is_the_only_one() {
        let nodes = [candidate("renderD128"), candidate("renderD129")];
        assert_eq!(
            choose_live_node(&nodes, None, &[], &[])
                .unwrap()
                .node_name(),
            "renderD128"
        );
        // Quarantined by VAAPI or by live backgrounds: skipped, never retried.
        assert_eq!(
            choose_live_node(&nodes, None, &[quarantined("renderD128")], &[])
                .unwrap()
                .node_name(),
            "renderD129"
        );
        assert_eq!(
            choose_live_node(&nodes, None, &[], &[quarantined("renderD128")])
                .unwrap()
                .node_name(),
            "renderD129"
        );
        assert_eq!(
            choose_live_node(
                &nodes,
                None,
                &[quarantined("renderD128")],
                &[quarantined("renderD129")]
            ),
            Err(LiveBackgroundStillReason::QuarantinedNode)
        );
        assert_eq!(
            choose_live_node(&[], None, &[], &[]),
            Err(LiveBackgroundStillReason::NoGpu)
        );
    }

    #[test]
    fn a_pin_names_one_node_quarantine_or_not() {
        let nodes = [candidate("renderD128"), candidate("renderD129")];
        let pin = PathBuf::from("/dev/dri/renderD129");
        assert_eq!(
            choose_live_node(&nodes, Some(&pin), &[], &[quarantined("renderD129")])
                .unwrap()
                .node_name(),
            "renderD129"
        );
        let missing = PathBuf::from("/dev/dri/renderD130");
        assert_eq!(
            choose_live_node(&nodes, Some(&missing), &[], &[]),
            Err(LiveBackgroundStillReason::NoGpu)
        );
    }

    #[test]
    fn software_rasterisers_are_recognised() {
        assert!(is_software_renderer("llvmpipe (LLVM 17.0.6, 256 bits)"));
        assert!(is_software_renderer("softpipe"));
        assert!(is_software_renderer("Mesa swrast"));
        assert!(!is_software_renderer(
            "Mesa Intel(R) UHD Graphics 620 (KBL GT2)"
        ));
        assert!(!is_software_renderer(
            "AMD Radeon RX 6600 (radeonsi, navi23)"
        ));
    }

    #[test]
    fn requests_are_latest_wins_and_never_block() {
        let shared = Shared::default();
        let look = &super::super::looks::looks(LiveBackgroundId::Silk)[0];
        for phase in [1.0, 2.0, 3.0] {
            shared.post(Request {
                id: LiveBackgroundId::Silk,
                look,
                phase,
                dim: 0.0,
                view: (16, 16),
                rendering: LiveBackgroundRendering::Shader,
            });
        }
        assert_eq!(
            shared.wait_for_request().map(|request| request.phase),
            Some(3.0)
        );
        shared.stop.store(true, Ordering::Release);
        assert!(shared.wait_for_request().is_none());
    }

    #[test]
    fn frames_carry_their_background() {
        let tag = frame_tag(LiveBackgroundId::PlasmaWave, 7);
        assert_eq!(
            tag >> 56,
            u64::from(background_tag(LiveBackgroundId::PlasmaWave))
        );
        assert_eq!(tag & 0xff, 7);
        assert_ne!(
            background_tag(LiveBackgroundId::Silk),
            background_tag(LiveBackgroundId::LineWaves)
        );
    }

    #[test]
    fn every_background_is_ported_and_only_ghost_fibers_draws_instanced() {
        for id in super::super::looks::ALL_LIVE_BACKGROUNDS {
            assert!(ported(id), "{id:?}");
        }
        let violet = &super::super::looks::looks(LiveBackgroundId::GhostFibers)[0];
        assert!(matches!(
            LivePass::GhostFibersDots.kind(violet),
            PassKind::Instanced {
                vertices: 4,
                blend: PassBlend::Additive,
                ..
            }
        ));
        // The instanced passes link their own vertex shader; every other pass
        // the full-screen triangle.
        assert!(vertex_source(LivePass::GhostFibersDots).contains("gl_InstanceID"));
        assert_eq!(vertex_source(LivePass::GhostFibersBright), VERTEX);
    }

    /// The GLSL of all ten backgrounds through real GLES against the golden
    /// grids, when this host has EGL (Linux CI may only have Mesa's llvmpipe:
    /// `VIDEORC_LIVE_BACKGROUND_GL_ALLOW_SOFTWARE=1`). Skips otherwise.
    #[cfg(target_os = "linux")]
    #[test]
    fn gles_matches_the_golden_grids_or_skips() {
        let Ok(node) = pick_node() else {
            eprintln!("SKIP: no render node for a GLES golden check");
            return;
        };
        let context = match unsafe { GlesContext::open(&node.path) } {
            Ok(context) => context,
            Err(failure) => {
                eprintln!("SKIP: no GLES context ({})", failure.detail);
                return;
            }
        };
        let gl = &context.gl;
        let renderer = unsafe { gl.get_parameter_string(glow::RENDERER) };
        if is_software_renderer(&renderer) && !allow_software_renderer() {
            eprintln!("SKIP: {renderer} is a software rasteriser");
            return;
        }
        let mut state = unsafe { GlState::new(gl) }.expect("GL state");
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/live-background-golden.json"
        ))
        .unwrap();
        let (width, height) = (640u32, 360u32);
        for frame in fixture["frames"].as_array().unwrap() {
            let id: LiveBackgroundId = serde_json::from_value(frame["id"].clone()).unwrap();
            let (look, _) = super::super::looks::look_or_first(id, frame["look"].as_str().unwrap());
            let request = Request {
                id,
                look,
                phase: frame["phase"].as_f64().unwrap(),
                dim: 0.0,
                view: internal_size(id, (width, height), GuardLevel::Full),
                rendering: LiveBackgroundRendering::Shader,
            };
            let Ok(bgra) = (unsafe { state.render(gl, &request, None) }) else {
                eprintln!("SKIP {id:?}: this GPU cannot render it");
                continue;
            };
            let expected = base64_decode(frame["rgb"].as_str().unwrap());
            let (mean, max) = grid_error(&bgra, width, height, &expected);
            assert!(
                mean <= 2.0 && max <= 10,
                "{id:?} {}: mean {mean:.3}, max {max}",
                look.id
            );
        }
        unsafe { state.destroy(gl) };
    }

    #[cfg(target_os = "linux")]
    fn base64_decode(text: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .unwrap()
    }

    /// Box-filter top-down BGRA to 64×36 RGB and compare with the fixture.
    #[cfg(target_os = "linux")]
    fn grid_error(bgra: &[u8], width: u32, height: u32, expected: &[u8]) -> (f64, u8) {
        let (cells_x, cells_y) = (64usize, 36usize);
        let (cell_w, cell_h) = (width as usize / cells_x, height as usize / cells_y);
        let mut total = 0u64;
        let mut max = 0u8;
        for gy in 0..cells_y {
            for gx in 0..cells_x {
                let mut sum = [0u64; 3];
                for y in gy * cell_h..(gy + 1) * cell_h {
                    for x in gx * cell_w..(gx + 1) * cell_w {
                        let at = (y * width as usize + x) * 4;
                        sum[0] += u64::from(bgra[at + 2]);
                        sum[1] += u64::from(bgra[at + 1]);
                        sum[2] += u64::from(bgra[at]);
                    }
                }
                let count = (cell_w * cell_h) as u64;
                for channel in 0..3 {
                    let value = ((sum[channel] + count / 2) / count) as i32;
                    let want = i32::from(expected[(gy * cells_x + gx) * 3 + channel]);
                    let error = (value - want).unsigned_abs() as u8;
                    total += u64::from(error);
                    max = max.max(error);
                }
            }
        }
        (total as f64 / (cells_x * cells_y * 3) as f64, max)
    }
}
