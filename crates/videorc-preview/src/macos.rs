//! macOS: the `CAMetalLayer` sublayer and the presenter thread.
//!
//! The reference is the addon's in-process presenter
//! (`crates/videorc-native-preview-addon`, `present_native_preview`, and the
//! backend's `MetalPreviewPresenter`): a `CAMetalLayer` added to the window's
//! `NSView` layer with a high `zPosition`, its frame set inside a
//! `CATransaction` with implicit actions disabled, the IOSurface imported
//! once per ring slot and drawn into the layer's next drawable through one
//! textured-quad render pass with a linear sampler. What differs here: the
//! draw runs on its own thread, not the UI thread, and every step is timed.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{ClassType, MainThreadMarker};
use objc2_app_kit::NSView;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSString;
use objc2_metal::{
    MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLLibrary, MTLLoadAction,
    MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder, MTLRenderPassDescriptor,
    MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLSamplerDescriptor,
    MTLSamplerMinMagFilter, MTLSamplerState, MTLStoreAction, MTLTexture,
};
use objc2_quartz_core::{
    CACurrentMediaTime, CALayer, CAMetalDrawable, CAMetalLayer, CATransaction,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use videorc_gpu_import::{ImportedMetalTexture, import_iosurface_metal};

use crate::LayerRect;
use crate::stats::{ImportKind, LayerFrameRecord, LayerPresentRecord, PresentedStamp};

/// The addon keeps three imported textures: one per slot of the backend's
/// ring.
const IMPORT_CACHE_SIZE: usize = 3;

/// The layer is inserted above everything the UI framework draws (the
/// addon's value).
const LAYER_Z_POSITION: f64 = 10_000.0;

const SHADER_SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct VOut { float4 pos [[position]]; float2 uv; };
vertex VOut v_main(uint vid [[vertex_id]], constant float4* verts [[buffer(0)]]) {
    VOut out;
    float4 v = verts[vid];
    out.pos = float4(v.x, v.y, 0.0, 1.0);
    out.uv = float2(v.z, v.w);
    return out;
}
fragment float4 f_main(VOut in [[stage_in]],
                       texture2d<float> tex [[texture(0)]],
                       sampler samp [[sampler(0)]]) {
    return float4(tex.sample(samp, in.uv).rgb, 1.0);
}
"#;

type MetalDevice = ProtocolObject<dyn MTLDevice>;

/// A retained Objective-C object moved to another thread. Metal devices,
/// command queues and `CAMetalLayer`'s drawable API are documented as
/// thread-safe; the main thread only touches the layer's geometry.
struct SendRetained<T: ?Sized>(Retained<T>);
// SAFETY: see the type's doc; every object wrapped here is one Apple
// documents as safe to use from any thread.
unsafe impl<T: ?Sized> Send for SendRetained<T> {}

/// A Core Animation media time paired with an `Instant`, so the display's
/// `presentedTime` stamps convert to the run's clock. Both read
/// `mach_absolute_time`, so the pairing error is the two calls' distance.
#[derive(Debug, Clone, Copy)]
pub struct ClockAnchor {
    pub instant: Instant,
    pub media_time: f64,
}

impl ClockAnchor {
    pub fn now() -> Self {
        let media_time = CACurrentMediaTime();
        let instant = Instant::now();
        Self {
            instant,
            media_time,
        }
    }

    /// `media_time` as an `Instant`; `None` before the anchor.
    pub fn instant_of(&self, media_time: f64) -> Option<Instant> {
        let delta = media_time - self.media_time;
        if delta >= 0.0 {
            Some(self.instant + Duration::from_secs_f64(delta))
        } else {
            self.instant.checked_sub(Duration::from_secs_f64(-delta))
        }
    }
}

/// The sublayer in one window, driven from the main thread.
pub struct VideoLayer {
    host_view: Retained<NSView>,
    layer: Retained<CAMetalLayer>,
    frame: Option<LayerRect>,
    scale: f64,
    /// Hidden on purpose by the host (over and above "no frame yet").
    hidden: bool,
}

impl VideoLayer {
    /// Adds a `CAMetalLayer` on `device` as a sublayer of the window's
    /// `NSView` layer, hidden until the first [`set_frame`](Self::set_frame).
    /// Main thread only; the native window must exist (after the first event
    /// loop iteration past `show()`).
    pub fn attach(window: &dyn HasWindowHandle, device: &MetalDevice) -> Result<Self, String> {
        MainThreadMarker::new().ok_or_else(|| "not on the main thread".to_string())?;
        let raw = window
            .window_handle()
            .map_err(|error| format!("no window handle yet: {error}"))?
            .as_raw();
        let RawWindowHandle::AppKit(appkit) = raw else {
            return Err("the window is not an AppKit window".to_string());
        };
        // SAFETY: raw-window-handle guarantees `ns_view` points at the
        // window's NSView for as long as the handle lives; this runs on the
        // main thread (checked above).
        let host_view: Retained<NSView> =
            unsafe { Retained::retain(appkit.ns_view.cast::<NSView>().as_ptr()) }
                .ok_or_else(|| "the NSView pointer could not be retained".to_string())?;
        host_view.setWantsLayer(true);
        let host_layer = host_view
            .layer()
            .ok_or_else(|| "the NSView has no backing CALayer".to_string())?;
        let scale = host_view
            .window()
            .map(|window| window.backingScaleFactor())
            .unwrap_or(1.0)
            .max(1.0);
        let layer = CAMetalLayer::new();
        layer.setDevice(Some(device));
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        layer.setOpaque(true);
        layer.setFramebufferOnly(true);
        layer.setMaximumDrawableCount(3);
        layer.setPresentsWithTransaction(false);
        layer.setAllowsNextDrawableTimeout(true);
        layer.setDisplaySyncEnabled(true);
        let ca_layer: &CALayer = layer.as_super();
        without_implicit_actions(|| {
            ca_layer.setContentsScale(scale);
            ca_layer.setZPosition(LAYER_Z_POSITION);
            ca_layer.setHidden(true);
            host_layer.addSublayer(ca_layer);
        });
        Ok(Self {
            host_view,
            layer,
            frame: None,
            scale,
            hidden: false,
        })
    }

    /// The layer the presenter draws into.
    pub fn handle(&self) -> LayerHandle {
        LayerHandle(SendRetained(self.layer.clone()))
    }

    /// The backing scale factor the layer was attached at.
    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// The host layer's height in points and whether its sublayers' origins
    /// are measured from the top; read every time, the host resizes with its
    /// window.
    fn host_geometry(&self) -> (f64, bool) {
        match self.host_view.layer() {
            Some(host) => (host.bounds().size.height, host.isGeometryFlipped()),
            None => (0.0, true),
        }
    }

    /// Places the layer on `rect` (top-left points in the window's content)
    /// and sizes its drawable to the backing pixels, in one transaction with
    /// implicit actions disabled. Call it from the UI's layout or paint pass.
    /// Returns true when something changed.
    pub fn set_frame(&mut self, rect: LayerRect) -> bool {
        let rect = rect.snapped(self.scale);
        let first = self.frame.is_none();
        if !first && self.frame.is_some_and(|previous| previous == rect) {
            return false;
        }
        let (host_height, host_flipped) = self.host_geometry();
        let frame = frame_in_host(rect, host_height, host_flipped);
        let drawable = CGSize {
            width: (rect.width * self.scale).round().max(1.0),
            height: (rect.height * self.scale).round().max(1.0),
        };
        let size_changed = self
            .frame
            .is_none_or(|previous| previous.width != rect.width || previous.height != rect.height);
        let ca_layer: &CALayer = self.layer.as_super();
        without_implicit_actions(|| {
            if size_changed {
                self.layer.setDrawableSize(drawable);
            }
            ca_layer.setFrame(frame);
            if first && !self.hidden {
                ca_layer.setHidden(false);
            }
        });
        self.frame = Some(rect);
        true
    }

    /// The frame the UI last set.
    pub fn frame(&self) -> Option<LayerRect> {
        self.frame
    }

    /// Hides or shows the layer in one transaction (S2.3b: a docked preview
    /// hides on purpose behind a dialog, with its reason in the status). A
    /// layer with no frame yet stays hidden until its first `set_frame`.
    pub fn set_hidden(&mut self, hidden: bool) {
        self.hidden = hidden;
        let ca_layer: &CALayer = self.layer.as_super();
        let hidden = hidden || self.frame.is_none();
        if ca_layer.isHidden() == hidden {
            return;
        }
        without_implicit_actions(|| ca_layer.setHidden(hidden));
    }

    /// Whether the layer is hidden right now.
    pub fn is_hidden(&self) -> bool {
        let ca_layer: &CALayer = self.layer.as_super();
        ca_layer.isHidden()
    }

    /// Sets the current frame again in one transaction (the present-kick's
    /// UI half: a layer whose host re-laid itself out lands back in place).
    pub fn reapply_frame(&mut self) {
        if let Some(rect) = self.frame.take() {
            self.set_frame(rect);
        }
    }

    /// The height in points of the screen behind the window.
    pub fn screen_height(&self) -> Option<f64> {
        let screen = self.host_view.window()?.screen()?;
        Some(screen.frame().size.height)
    }

    /// The frame Core Animation's presentation tree currently shows for this
    /// layer, back in top-left points; `None` before the first commit.
    pub fn displayed_frame(&self) -> Option<LayerRect> {
        let ca_layer: &CALayer = self.layer.as_super();
        // SAFETY: the presentation layer is a read-only snapshot; it is read
        // on the main thread, which also commits this layer's changes.
        let presented = unsafe { ca_layer.presentationLayer() }?;
        let (host_height, host_flipped) = self.host_geometry();
        Some(frame_from_host(
            presented.frame(),
            host_height,
            host_flipped,
        ))
    }

    /// The drawable size the layer currently reports (backing pixels).
    pub fn drawable_size(&self) -> (f64, f64) {
        let size = self.layer.drawableSize();
        (size.width, size.height)
    }
}

impl Drop for VideoLayer {
    fn drop(&mut self) {
        let ca_layer: &CALayer = self.layer.as_super();
        without_implicit_actions(|| ca_layer.removeFromSuperlayer());
    }
}

/// A layer the presenter thread draws into.
pub struct LayerHandle(SendRetained<CAMetalLayer>);

/// Core Animation animates frame and hidden changes by default; the layer is
/// placed by the UI's layout, so every change commits as one frame.
fn without_implicit_actions(mutate: impl FnOnce()) {
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    mutate();
    CATransaction::commit();
    CATransaction::flush();
}

/// A top-left rect in the host layer's own coordinate space: AppKit measures
/// a sublayer's origin from the bottom unless the host is geometry-flipped
/// (the addon's `layer_frame_in_host`).
fn frame_in_host(rect: LayerRect, host_height: f64, host_flipped: bool) -> CGRect {
    let y = if host_flipped {
        rect.y
    } else {
        host_height - rect.y - rect.height
    };
    CGRect {
        origin: CGPoint { x: rect.x, y },
        size: CGSize {
            width: rect.width,
            height: rect.height,
        },
    }
}

fn frame_from_host(frame: CGRect, host_height: f64, host_flipped: bool) -> LayerRect {
    let y = if host_flipped {
        frame.origin.y
    } else {
        host_height - frame.origin.y - frame.size.height
    };
    LayerRect {
        x: frame.origin.x,
        y,
        width: frame.size.width,
        height: frame.size.height,
    }
}

/// How the presenter got a frame's texture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    Cached,
    Imported,
    Failed(String),
}

/// One layer's part of one presented frame, as the presenter reports it.
#[derive(Debug, Clone)]
pub struct LayerPresent {
    pub layer: u8,
    pub drawable_wait: Duration,
    pub committed_at: Instant,
    /// `GPUEndTime - GPUStartTime`, zero when the command buffer did not
    /// report them.
    pub gpu_time: Duration,
    pub failure: Option<String>,
}

/// What the presenter did with one frame.
#[derive(Debug, Clone)]
pub struct PresentReport {
    pub frame_id: u64,
    /// The presenter thread picked the frame up.
    pub started_at: Instant,
    pub import: ImportOutcome,
    pub import_time: Duration,
    pub layers: Vec<LayerPresent>,
    /// Every layer's command buffer completed (`waitUntilCompleted`).
    pub gpu_done_at: Instant,
}

impl PresentReport {
    /// The record the shared summaries read. A failed layer keeps its wait and
    /// commit time (the failure is in `failure`); a failed import gives a
    /// record with no layers, counted as an import.
    pub fn into_record(self) -> LayerFrameRecord {
        LayerFrameRecord {
            frame_id: self.frame_id,
            started_at: self.started_at,
            import: match self.import {
                ImportOutcome::Cached => ImportKind::Cached,
                ImportOutcome::Imported | ImportOutcome::Failed(_) => ImportKind::Imported,
            },
            import_time: self.import_time,
            layers: self
                .layers
                .into_iter()
                .map(|layer| LayerPresentRecord {
                    layer: layer.layer,
                    drawable_wait: layer.drawable_wait,
                    committed_at: layer.committed_at,
                    gpu_time: layer.gpu_time,
                    presented_at: None,
                })
                .collect(),
            gpu_done_at: self.gpu_done_at,
        }
    }
}

/// The block Metal calls when a drawable reaches the display.
type PresentedHandler = RcBlock<dyn Fn(NonNull<ProtocolObject<dyn MTLDrawable>>)>;

struct FrameRequest {
    frame_id: u64,
    iosurface_id: u32,
    width: u32,
    height: u32,
    reply: Sender<PresentReport>,
}

enum Command {
    AddLayer {
        id: u8,
        layer: LayerHandle,
    },
    /// The layer left its window (S2.3b: the preview moved to another
    /// window); the presenter stops drawing into it.
    RemoveLayer {
        id: u8,
    },
    Present(FrameRequest),
    Quit,
}

/// The presenter: its own thread, its own Metal device, command queue and
/// pipeline, drawing leased frames into every attached layer.
pub struct Presenter {
    device: Retained<MetalDevice>,
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
    stamps: Arc<Mutex<Vec<PresentedStamp>>>,
    anchor: ClockAnchor,
}

impl Presenter {
    /// Creates the device and the thread. Fails when Metal is unavailable or
    /// the pipeline does not compile.
    pub fn start() -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice().ok_or("no Metal device")?;
        let anchor = ClockAnchor::now();
        let stamps: Arc<Mutex<Vec<PresentedStamp>>> = Arc::new(Mutex::new(Vec::new()));
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread_device = SendRetained(device.clone());
        let thread_stamps = stamps.clone();
        let thread = std::thread::Builder::new()
            .name("videorc-layer-presenter".to_string())
            .spawn(move || {
                let device = thread_device.0;
                // A plain Rust thread has no autorelease pool: setup gets its
                // own (the retained objects the worker keeps outlive it), and
                // every command another one (`Worker::run`).
                let built =
                    objc2::rc::autoreleasepool(|_| Worker::new(device, thread_stamps, anchor));
                let worker = match built {
                    Ok(worker) => {
                        let _ = ready_tx.send(Ok(()));
                        worker
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                worker.run(inbox);
            })
            .map_err(|error| format!("spawning the presenter thread: {error}"))?;
        ready_rx
            .recv()
            .map_err(|_| "the presenter thread died before it was ready".to_string())??;
        Ok(Self {
            device,
            commands,
            thread: Some(thread),
            stamps,
            anchor,
        })
    }

    /// The device layers must be created on.
    pub fn device(&self) -> &MetalDevice {
        &self.device
    }

    pub fn anchor(&self) -> ClockAnchor {
        self.anchor
    }

    /// Adds a layer; the next frame is drawn into it too. `id` 0 is the main
    /// window's layer, 1 the floating window's, by convention.
    pub fn add_layer(&self, id: u8, layer: &VideoLayer) {
        let _ = self.commands.send(Command::AddLayer {
            id,
            layer: layer.handle(),
        });
    }

    /// Removes a layer by id; frames stop going to it.
    pub fn remove_layer(&self, id: u8) {
        let _ = self.commands.send(Command::RemoveLayer { id });
    }

    /// The `Send` half: what a driver on another thread needs to present
    /// frames and read the display's stamps.
    pub fn client(&self) -> PresenterClient {
        PresenterClient {
            commands: self.commands.clone(),
            stamps: self.stamps.clone(),
        }
    }

    /// The display's refresh rate behind the window, from
    /// `NSScreen.maximumFramesPerSecond` (120 on this MacBook's panel), for
    /// the resize lag's tick unit.
    pub fn display_max_fps(layer: &VideoLayer) -> Option<u32> {
        let screen = layer.host_view.window()?.screen()?;
        u32::try_from(screen.maximumFramesPerSecond()).ok()
    }
}

/// The presenter's `Send` half; see [`Presenter::client`].
#[derive(Clone)]
pub struct PresenterClient {
    commands: Sender<Command>,
    stamps: Arc<Mutex<Vec<PresentedStamp>>>,
}

impl PresenterClient {
    /// Hands a leased frame to the presenter thread. The receiver yields the
    /// report once every layer's command buffer has completed on the GPU, so
    /// the lease may be released as soon as it arrives.
    pub fn present(
        &self,
        frame_id: u64,
        iosurface_id: u32,
        width: u32,
        height: u32,
    ) -> Receiver<PresentReport> {
        let (reply, receiver) = mpsc::channel();
        let _ = self.commands.send(Command::Present(FrameRequest {
            frame_id,
            iosurface_id,
            width,
            height,
            reply,
        }));
        receiver
    }

    /// Drains the presented-time stamps the display delivered so far.
    pub fn take_presented(&self) -> Vec<PresentedStamp> {
        match self.stamps.lock() {
            Ok(mut stamps) => std::mem::take(&mut *stamps),
            Err(_) => Vec::new(),
        }
    }
}

impl Drop for Presenter {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct AttachedLayer {
    id: u8,
    layer: Retained<CAMetalLayer>,
}

struct Worker {
    device: Retained<MetalDevice>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
    layers: Vec<AttachedLayer>,
    cache: Vec<ImportedMetalTexture>,
    stamps: Arc<Mutex<Vec<PresentedStamp>>>,
    anchor: ClockAnchor,
}

impl Worker {
    fn new(
        device: Retained<MetalDevice>,
        stamps: Arc<Mutex<Vec<PresentedStamp>>>,
        anchor: ClockAnchor,
    ) -> Result<Self, String> {
        let queue = device.newCommandQueue().ok_or("no Metal command queue")?;
        let source = NSString::from_str(SHADER_SOURCE);
        let library = device
            .newLibraryWithSource_options_error(&source, None)
            .map_err(|error| format!("the present shader did not compile: {error}"))?;
        let vertex = library
            .newFunctionWithName(&NSString::from_str("v_main"))
            .ok_or("v_main is missing from the present shader")?;
        let fragment = library
            .newFunctionWithName(&NSString::from_str("f_main"))
            .ok_or("f_main is missing from the present shader")?;
        let descriptor = MTLRenderPipelineDescriptor::new();
        descriptor.setVertexFunction(Some(&vertex));
        descriptor.setFragmentFunction(Some(&fragment));
        // SAFETY: index 0 of a fresh descriptor's colour attachments exists.
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        let pipeline = device
            .newRenderPipelineStateWithDescriptor_error(&descriptor)
            .map_err(|error| format!("the present pipeline was refused: {error}"))?;
        let sampler_descriptor = MTLSamplerDescriptor::new();
        sampler_descriptor.setMinFilter(MTLSamplerMinMagFilter::Linear);
        sampler_descriptor.setMagFilter(MTLSamplerMinMagFilter::Linear);
        let sampler = device
            .newSamplerStateWithDescriptor(&sampler_descriptor)
            .ok_or("no linear sampler")?;
        Ok(Self {
            device,
            queue,
            pipeline,
            sampler,
            layers: Vec::new(),
            cache: Vec::new(),
            stamps,
            anchor,
        })
    }

    fn run(mut self, inbox: Receiver<Command>) {
        while let Ok(command) = inbox.recv() {
            if matches!(command, Command::Quit) {
                break;
            }
            // One pool per command, drained before the next: Metal's
            // autoreleased objects (the command buffer, its encoder, the
            // drawable) would otherwise pile up for the thread's life. A
            // present's pool drains after `waitUntilCompleted`, on every
            // path out of `present`.
            objc2::rc::autoreleasepool(|_| self.handle(command));
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::AddLayer { id, layer } => {
                self.layers.retain(|attached| attached.id != id);
                self.layers.push(AttachedLayer {
                    id,
                    layer: layer.0.0,
                });
            }
            Command::RemoveLayer { id } => {
                self.layers.retain(|attached| attached.id != id);
            }
            Command::Present(request) => {
                let report = self.present(&request);
                let _ = request.reply.send(report);
            }
            // `run` stops before handing it here.
            Command::Quit => {}
        }
    }

    /// The cached texture for this surface, importing it when the cache has
    /// none (and dropping entries of another size, as the addon does).
    fn texture_for(
        &mut self,
        iosurface_id: u32,
        width: u32,
        height: u32,
    ) -> Result<(usize, ImportOutcome), String> {
        if let Some(index) = self.cache.iter().position(|texture| {
            texture.iosurface_id == iosurface_id
                && texture.width == width
                && texture.height == height
        }) {
            return Ok((index, ImportOutcome::Cached));
        }
        let imported = import_iosurface_metal(
            &self.device,
            iosurface_id,
            width,
            height,
            wgpu::TextureFormat::Bgra8Unorm,
        )
        .map_err(|error| error.to_string())?;
        self.cache
            .retain(|texture| texture.width == width && texture.height == height);
        if self.cache.len() >= IMPORT_CACHE_SIZE {
            self.cache.remove(0);
        }
        self.cache.push(imported);
        Ok((self.cache.len() - 1, ImportOutcome::Imported))
    }

    fn present(&mut self, request: &FrameRequest) -> PresentReport {
        let started_at = Instant::now();
        let (index, import) =
            match self.texture_for(request.iosurface_id, request.width, request.height) {
                Ok(found) => found,
                Err(error) => {
                    return PresentReport {
                        frame_id: request.frame_id,
                        started_at,
                        import: ImportOutcome::Failed(error),
                        import_time: started_at.elapsed(),
                        layers: Vec::new(),
                        gpu_done_at: Instant::now(),
                    };
                }
            };
        let import_time = started_at.elapsed();
        let source = self.cache[index].texture.clone();
        let mut committed: Vec<(u8, Retained<ProtocolObject<dyn MTLCommandBuffer>>)> = Vec::new();
        let mut layers = Vec::with_capacity(self.layers.len());
        for attached in &self.layers {
            let wait_started = Instant::now();
            let Some(drawable) = attached.layer.nextDrawable() else {
                layers.push(LayerPresent {
                    layer: attached.id,
                    drawable_wait: wait_started.elapsed(),
                    committed_at: Instant::now(),
                    gpu_time: Duration::ZERO,
                    failure: Some("no drawable within the layer's timeout".to_string()),
                });
                continue;
            };
            let drawable_wait = wait_started.elapsed();
            let Some(command_buffer) = self.queue.commandBuffer() else {
                layers.push(LayerPresent {
                    layer: attached.id,
                    drawable_wait,
                    committed_at: Instant::now(),
                    gpu_time: Duration::ZERO,
                    failure: Some("no command buffer".to_string()),
                });
                continue;
            };
            let target = drawable.texture();
            if let Err(failure) = encode_present(
                &command_buffer,
                &self.pipeline,
                &self.sampler,
                &source,
                &target,
            ) {
                layers.push(LayerPresent {
                    layer: attached.id,
                    drawable_wait,
                    committed_at: Instant::now(),
                    gpu_time: Duration::ZERO,
                    failure: Some(failure),
                });
                continue;
            }
            let mtl_drawable: &ProtocolObject<dyn MTLDrawable> =
                ProtocolObject::from_ref(&*drawable);
            self.install_presented_handler(mtl_drawable, request.frame_id, attached.id);
            command_buffer.presentDrawable(mtl_drawable);
            command_buffer.commit();
            layers.push(LayerPresent {
                layer: attached.id,
                drawable_wait,
                committed_at: Instant::now(),
                gpu_time: Duration::ZERO,
                failure: None,
            });
            committed.push((attached.id, command_buffer));
        }
        for (id, command_buffer) in &committed {
            command_buffer.waitUntilCompleted();
            let gpu = (command_buffer.GPUEndTime() - command_buffer.GPUStartTime()).max(0.0);
            if let Some(record) = layers.iter_mut().find(|layer| layer.layer == *id) {
                record.gpu_time = Duration::from_secs_f64(gpu);
            }
        }
        PresentReport {
            frame_id: request.frame_id,
            started_at,
            import,
            import_time,
            layers,
            gpu_done_at: Instant::now(),
        }
    }

    /// Records the drawable's `presentedTime` when the display shows it.
    fn install_presented_handler(
        &self,
        drawable: &ProtocolObject<dyn MTLDrawable>,
        frame_id: u64,
        layer: u8,
    ) {
        let stamps = self.stamps.clone();
        let anchor = self.anchor;
        let block: PresentedHandler =
            RcBlock::new(move |presented: NonNull<ProtocolObject<dyn MTLDrawable>>| {
                // SAFETY: Metal passes the drawable the handler was added to.
                let media_time = unsafe { presented.as_ref() }.presentedTime();
                if media_time <= 0.0 {
                    return;
                }
                if let Some(presented_at) = anchor.instant_of(media_time)
                    && let Ok(mut stamps) = stamps.lock()
                {
                    stamps.push(PresentedStamp {
                        frame_id,
                        layer,
                        presented_at,
                    });
                }
            });
        // SAFETY: the block is a valid heap block; Metal copies it.
        unsafe { drawable.addPresentedHandler(RcBlock::as_ptr(&block)) };
    }
}

/// Contain-fit of `source` into `target` as a normalised top-left rect, as
/// the backend's `contain_dest_rect`.
fn contain_dest_rect(src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> [f32; 4] {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return [0.0, 0.0, 1.0, 1.0];
    }
    let src_aspect = src_w as f64 / src_h as f64;
    let dst_aspect = dst_w as f64 / dst_h as f64;
    if (src_aspect - dst_aspect).abs() < 1e-4 {
        return [0.0, 0.0, 1.0, 1.0];
    }
    if src_aspect > dst_aspect {
        let h = (dst_aspect / src_aspect) as f32;
        [0.0, (1.0 - h) / 2.0, 1.0, h]
    } else {
        let w = (src_aspect / dst_aspect) as f32;
        [(1.0 - w) / 2.0, 0.0, w, 1.0]
    }
}

fn quad_vertices(dest: [f32; 4]) -> [f32; 24] {
    let [x, y, w, h] = dest;
    let x0 = 2.0 * x - 1.0;
    let x1 = 2.0 * (x + w) - 1.0;
    let y0 = 1.0 - 2.0 * y;
    let y1 = 1.0 - 2.0 * (y + h);
    [
        x0, y0, 0.0, 0.0, // top-left
        x0, y1, 0.0, 1.0, // bottom-left
        x1, y0, 1.0, 0.0, // top-right
        x1, y0, 1.0, 0.0, // top-right
        x0, y1, 0.0, 1.0, // bottom-left
        x1, y1, 1.0, 1.0, // bottom-right
    ]
}

/// One render pass: clear to black, draw the source contain-fit into the
/// drawable's texture with the linear sampler.
fn encode_present(
    command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
    pipeline: &ProtocolObject<dyn MTLRenderPipelineState>,
    sampler: &ProtocolObject<dyn MTLSamplerState>,
    source: &ProtocolObject<dyn MTLTexture>,
    target: &ProtocolObject<dyn MTLTexture>,
) -> Result<(), String> {
    let pass = MTLRenderPassDescriptor::new();
    // SAFETY: index 0 of a fresh descriptor's colour attachments exists.
    let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
    attachment.setTexture(Some(target));
    attachment.setLoadAction(MTLLoadAction::Clear);
    attachment.setClearColor(MTLClearColor {
        red: 0.0,
        green: 0.0,
        blue: 0.0,
        alpha: 1.0,
    });
    attachment.setStoreAction(MTLStoreAction::Store);
    let encoder = command_buffer
        .renderCommandEncoderWithDescriptor(&pass)
        .ok_or("no render command encoder")?;
    encoder.setRenderPipelineState(pipeline);
    let vertices = quad_vertices(contain_dest_rect(
        source.width(),
        source.height(),
        target.width(),
        target.height(),
    ));
    let vertex_bytes = NonNull::new(vertices.as_ptr() as *mut c_void).ok_or("null vertices")?;
    // SAFETY: the vertex bytes live on this stack frame for the whole
    // encoding (Metal copies them into the command buffer), the texture and
    // sampler indices match the shader, and six vertices make the two
    // triangles of the quad.
    unsafe {
        encoder.setVertexBytes_length_atIndex(vertex_bytes, std::mem::size_of_val(&vertices), 0);
        encoder.setFragmentTexture_atIndex(Some(source), 0);
        encoder.setFragmentSamplerState_atIndex(Some(sampler), 0);
        encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
    }
    encoder.endEncoding();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flipped_host_keeps_the_top_left_origin() {
        let rect = LayerRect::new(240.0, 100.0, 1000.0, 562.5);
        let frame = frame_in_host(rect, 800.0, true);
        assert_eq!(frame.origin.y, 100.0);
        assert_eq!(frame_from_host(frame, 800.0, true), rect);
    }

    #[test]
    fn a_plain_host_measures_from_the_bottom_edge() {
        let rect = LayerRect::new(240.0, 100.0, 1000.0, 562.5);
        let frame = frame_in_host(rect, 800.0, false);
        assert_eq!(frame.origin.y, 800.0 - 100.0 - 562.5);
        assert_eq!(frame_from_host(frame, 800.0, false), rect);
    }

    #[test]
    fn contain_letterboxes_a_wider_source() {
        assert_eq!(contain_dest_rect(16, 9, 16, 9), [0.0, 0.0, 1.0, 1.0]);
        let [x, y, w, h] = contain_dest_rect(3840, 2160, 1000, 1000);
        assert_eq!((x, w), (0.0, 1.0));
        assert!((h - 0.5625).abs() < 1e-6);
        assert!((y - (1.0 - 0.5625) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn the_clock_anchor_converts_media_time_both_ways() {
        let anchor = ClockAnchor {
            instant: Instant::now(),
            media_time: 100.0,
        };
        let later = anchor.instant_of(100.25).unwrap();
        assert_eq!(
            later.duration_since(anchor.instant),
            Duration::from_millis(250)
        );
        assert!(
            anchor
                .instant_of(99.0)
                .is_none_or(|earlier| earlier <= anchor.instant)
        );
    }

    #[test]
    fn media_time_and_instant_share_a_clock() {
        let a = ClockAnchor::now();
        std::thread::sleep(Duration::from_millis(20));
        let b = ClockAnchor::now();
        let by_instant = b.instant.duration_since(a.instant).as_secs_f64();
        let by_media = b.media_time - a.media_time;
        assert!(
            (by_instant - by_media).abs() < 0.002,
            "{by_instant} vs {by_media}"
        );
    }
}
