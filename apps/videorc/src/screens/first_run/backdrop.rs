//! First-run setup's moving backdrop (plan 203 S4, `welcome-backdrop.tsx`):
//! Liquid Chrome behind the card, drawn by the app itself as Electron's
//! renderer draws it, by the rules in `videorc_app_core::first_run::backdrop`.
//!
//! macOS: a `CAMetalLayer` in a GPUI `NativeView` (the preview's route,
//! `preview/macos.rs`), which GPUI shows beneath what it paints after it, so
//! the card and its words stay GPUI's, above the picture. One thread draws
//! the backend's own Metal port of the shader (`live_background.metal`) at
//! thirty frames a second and stops with setup; nothing is left allocated.
//! The poster shows until the first frame is on the layer, and whenever the
//! picture can't move cheaply.
//!
//! Windows and Linux have no native view under GPUI's drawing yet: the
//! poster stays there.

use videorc_app_core::first_run::backdrop::{StillReason, Tone};

/// What the backdrop shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The poster, while the first frame is on its way.
    Starting,
    Moving,
    /// The poster, for the reason given.
    Still(StillReason),
}

/// What the player tells the screen.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    FirstFrame,
    Still(StillReason, Option<String>),
}

/// What the screen knows each time it draws.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub tone: Tone,
    /// The system asks for less motion.
    pub reduced_motion: bool,
    /// The window's frames are being shown.
    pub visible: bool,
    /// The backdrop's box in points, and the window's scale.
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

/// The line the log gets when the poster stays (Electron's console line).
pub fn still_line(reason: StillReason, detail: Option<&str>) -> String {
    match detail {
        Some(detail) => format!(
            "[first-run] Liquid Chrome backdrop shows its poster: {} ({detail})",
            reason.as_str()
        ),
        None => format!(
            "[first-run] Liquid Chrome backdrop shows its poster: {}",
            reason.as_str()
        ),
    }
}

/// Whether the system asks for less motion. The app's own switch
/// (`theme::motion`) is the smokes'; this is the Mac's setting, read where
/// it is used until the shell follows it for every screen (S2.6).
pub fn system_reduces_motion() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::system_reduces_motion()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
pub use macos::Player;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use gpui::{App, NativeView, Window};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{ClassType, class, msg_send};
    use objc2_foundation::{NSSize, NSString};
    use objc2_metal::{
        MTLCommandBuffer, MTLCommandBufferStatus, MTLCommandEncoder, MTLCommandQueue,
        MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLLibrary, MTLLoadAction,
        MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder, MTLRenderPassDescriptor,
        MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLSamplerDescriptor,
        MTLSamplerMinMagFilter, MTLSamplerState, MTLStorageMode, MTLStoreAction, MTLTexture,
        MTLTextureDescriptor, MTLTextureUsage,
    };
    use objc2_quartz_core::{
        CAAutoresizingMask, CALayer, CAMetalDrawable, CAMetalLayer, CATransaction,
    };
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
    use videorc_app_core::first_run::backdrop::{
        self as rules, Clock, Guard, GuardLevel, Level, StillReason, Tone,
    };

    use super::{Event, Frame};
    use crate::preview::macos::HostView;

    /// The backend's Metal port of every live background; the backdrop draws
    /// its Liquid Chrome pass, so the two can never drift.
    const LIVE_BACKGROUND_MSL: &str = include_str!(
        "../../../../../crates/videorc-backend/src/live_background/live_background.metal"
    );
    const LIQUID_CHROME_VERTEX: &str = "live_vertex";
    const LIQUID_CHROME_FRAGMENT: &str = "liquid_chrome_main";

    /// The shader's frame onto the layer, scaled up, and the tone a theme
    /// puts on it after the shader: `tone.x` turns the picture around
    /// (`invert(1)`), `tone.y` is the brightness after that.
    const TONE_MSL: &str = r#"
#include <metal_stdlib>
using namespace metal;

struct ToneVOut { float4 pos [[position]]; float2 uv; };

vertex ToneVOut backdrop_tone_vertex(uint vid [[vertex_id]]) {
  const float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
  ToneVOut out;
  out.pos = float4(corners[vid], 0.0, 1.0);
  out.uv = float2(0.5 * corners[vid].x + 0.5, 0.5 - 0.5 * corners[vid].y);
  return out;
}

fragment float4 backdrop_tone_main(ToneVOut in [[stage_in]],
                                   texture2d<float> frame [[texture(0)]],
                                   sampler smooth [[sampler(0)]],
                                   constant float4* tone [[buffer(0)]]) {
  float3 color = frame.sample(smooth, in.uv).rgb;
  color = mix(color, 1.0 - color, tone[0].x) * tone[0].y;
  return float4(color, 1.0);
}
"#;

    const FRAME_FORMAT: MTLPixelFormat = MTLPixelFormat::BGRA8Unorm;
    /// How often a held player looks again without being told.
    const HELD_POLL: Duration = Duration::from_millis(250);

    /// `VIDEORC_FIRST_RUN_BACKDROP_STALL_MS` makes every frame take that much
    /// longer (debug builds only), so a check can watch the guard step down
    /// to the poster without a busy GPU.
    fn debug_stall() -> Option<Duration> {
        if !cfg!(debug_assertions) {
            return None;
        }
        std::env::var("VIDEORC_FIRST_RUN_BACKDROP_STALL_MS")
            .ok()?
            .parse()
            .ok()
            .map(Duration::from_millis)
    }

    type MetalDevice = ProtocolObject<dyn MTLDevice>;
    type MetalTexture = ProtocolObject<dyn MTLTexture>;
    type MetalPipeline = ProtocolObject<dyn MTLRenderPipelineState>;

    /// Moves a retained Metal object or layer to the drawing thread. Metal
    /// devices and `CAMetalLayer`'s drawable API are documented as safe to
    /// use from any one thread at a time (`videorc-preview` does the same).
    struct SendRetained<T: ?Sized>(Retained<T>);
    // SAFETY: see above; each value is used by the drawing thread alone
    // after it is sent.
    unsafe impl<T: ?Sized> Send for SendRetained<T> {}

    pub fn system_reduces_motion() -> bool {
        // SAFETY: `NSWorkspace.sharedWorkspace` is a process-wide object and
        // `accessibilityDisplayShouldReduceMotion` a plain BOOL property.
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return false;
            }
            let reduced: Bool = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
            reduced.as_bool()
        }
    }

    /// What the drawing thread reads before each frame.
    #[derive(Debug, Clone, Copy, PartialEq)]
    struct Controls {
        tone: Tone,
        running: bool,
        quit: bool,
    }

    struct Shared {
        controls: Mutex<Controls>,
        changed: Condvar,
        /// Frames the GPU finished and presented, since the player started
        /// (the smokes' presented-frames counter, `first-run-state`).
        presented: AtomicU64,
    }

    impl Shared {
        fn update(&self, change: impl FnOnce(&mut Controls)) {
            if let Ok(mut controls) = self.controls.lock() {
                let before = *controls;
                change(&mut controls);
                if *controls != before {
                    self.changed.notify_all();
                }
            }
        }
    }

    /// The moving backdrop while setup is open: its host view, its layer and
    /// the thread drawing into it. Dropping it stops the thread and lets
    /// everything go.
    pub struct Player {
        host: HostView,
        layer: Retained<CAMetalLayer>,
        shared: Arc<Shared>,
        canvas: Option<(u32, u32)>,
    }

    impl Player {
        /// Starts drawing. Main thread; `Err` is why the poster stays.
        pub fn start(
            frame: Frame,
            window: &mut Window,
            cx: &mut App,
        ) -> Result<(Self, UnboundedReceiver<Event>), (StillReason, Option<String>)> {
            let device = MTLCreateSystemDefaultDevice().ok_or((StillReason::NoGpu, None))?;
            let host = HostView::new(window, cx)
                .map_err(|error| (StillReason::Unsupported, Some(error)))?;
            let root = host
                .view
                .layer()
                .ok_or((StillReason::Unsupported, Some("no host layer".to_string())))?;
            let layer = CAMetalLayer::new();
            layer.setDevice(Some(&device));
            layer.setPixelFormat(FRAME_FORMAT);
            layer.setOpaque(true);
            layer.setFramebufferOnly(true);
            layer.setMaximumDrawableCount(3);
            layer.setPresentsWithTransaction(false);
            // A hidden window gives no drawable: the wait ends instead of
            // holding the thread.
            layer.setAllowsNextDrawableTimeout(true);
            layer.setDisplaySyncEnabled(true);
            let ca_layer: &CALayer = layer.as_super();
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            // The layer fills the host view whatever size GPUI gives it; the
            // drawable (the capped canvas) is scaled to it.
            ca_layer.setFrame(root.bounds());
            ca_layer.setAutoresizingMask(
                CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
            );
            root.addSublayer(ca_layer);
            CATransaction::commit();

            let shared = Arc::new(Shared {
                controls: Mutex::new(Controls {
                    tone: frame.tone,
                    running: frame.visible,
                    quit: false,
                }),
                changed: Condvar::new(),
                presented: AtomicU64::new(0),
            });
            let (events, inbox) = unbounded_channel();
            let mut player = Self {
                host,
                layer,
                shared: shared.clone(),
                canvas: None,
            };
            player.sync(frame);

            let thread_layer = SendRetained(player.layer.clone());
            let thread_device = SendRetained(device);
            let spawned = std::thread::Builder::new()
                .name("first-run-backdrop".to_string())
                .spawn(move || {
                    let (layer, device) = (thread_layer, thread_device);
                    draw_until_stopped(&device.0, &layer.0, &shared, &events);
                });
            if let Err(error) = spawned {
                return Err((StillReason::Unsupported, Some(error.to_string())));
            }
            Ok((player, inbox))
        }

        /// Frames the GPU has presented since this player started.
        pub fn presented_frames(&self) -> u64 {
            self.shared.presented.load(Ordering::Relaxed)
        }

        /// The element that shows the picture; paint it after the poster.
        pub fn element(&self) -> NativeView {
            self.host.native.clone()
        }

        /// Follows the theme, the window's visibility and its size.
        pub fn sync(&mut self, frame: Frame) {
            self.shared.update(|controls| {
                controls.tone = frame.tone;
                controls.running = frame.visible;
            });
            let canvas = rules::canvas_size(frame.width, frame.height, frame.scale_factor);
            if let Some((width, height)) = canvas
                && self.canvas != canvas
            {
                self.canvas = canvas;
                CATransaction::begin();
                CATransaction::setDisableActions(true);
                self.layer
                    .setDrawableSize(NSSize::new(width.into(), height.into()));
                CATransaction::commit();
            }
        }
    }

    impl Drop for Player {
        fn drop(&mut self) {
            self.shared.update(|controls| controls.quit = true);
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            self.layer.as_super().removeFromSuperlayer();
            CATransaction::commit();
        }
    }

    struct Pipelines {
        queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
        chrome: Retained<MetalPipeline>,
        tone: Retained<MetalPipeline>,
        sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
    }

    fn pipeline(
        device: &MetalDevice,
        library: &ProtocolObject<dyn MTLLibrary>,
        vertex: &str,
        fragment: &str,
    ) -> Result<Retained<MetalPipeline>, String> {
        let vertex_function = library
            .newFunctionWithName(&NSString::from_str(vertex))
            .ok_or_else(|| format!("{vertex} is missing from the shader"))?;
        let fragment_function = library
            .newFunctionWithName(&NSString::from_str(fragment))
            .ok_or_else(|| format!("{fragment} is missing from the shader"))?;
        let descriptor = MTLRenderPipelineDescriptor::new();
        descriptor.setVertexFunction(Some(&vertex_function));
        descriptor.setFragmentFunction(Some(&fragment_function));
        // SAFETY: index 0 of a fresh descriptor's colour attachments exists.
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setPixelFormat(FRAME_FORMAT);
        device
            .newRenderPipelineStateWithDescriptor_error(&descriptor)
            .map_err(|error| format!("the {fragment} pipeline was refused: {error}"))
    }

    fn pipelines(device: &MetalDevice) -> Result<Pipelines, String> {
        let queue = device.newCommandQueue().ok_or("no Metal command queue")?;
        let compile = |source: &str, what: &str| {
            device
                .newLibraryWithSource_options_error(&NSString::from_str(source), None)
                .map_err(|error| format!("{what} did not compile: {error}"))
        };
        let live = compile(LIVE_BACKGROUND_MSL, "the live background shader")?;
        let tone = compile(TONE_MSL, "the tone shader")?;
        let sampler_descriptor = MTLSamplerDescriptor::new();
        sampler_descriptor.setMinFilter(MTLSamplerMinMagFilter::Linear);
        sampler_descriptor.setMagFilter(MTLSamplerMinMagFilter::Linear);
        let sampler = device
            .newSamplerStateWithDescriptor(&sampler_descriptor)
            .ok_or("no linear sampler")?;
        Ok(Pipelines {
            queue,
            chrome: pipeline(device, &live, LIQUID_CHROME_VERTEX, LIQUID_CHROME_FRAGMENT)?,
            tone: pipeline(device, &tone, "backdrop_tone_vertex", "backdrop_tone_main")?,
            sampler,
        })
    }

    fn scratch(device: &MetalDevice, size: (u32, u32)) -> Option<Retained<MetalTexture>> {
        // SAFETY: a plain 2D texture descriptor of a non-zero size.
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                FRAME_FORMAT,
                size.0.max(1) as usize,
                size.1.max(1) as usize,
                false,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        descriptor.setStorageMode(MTLStorageMode::Private);
        device.newTextureWithDescriptor(&descriptor)
    }

    /// One full-screen pass into `target`: `pipeline` with `bytes` as its
    /// fragment buffer and, for the tone pass, the frame to read.
    fn pass<T>(
        command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
        pipeline: &MetalPipeline,
        target: &MetalTexture,
        bytes: &T,
        source: Option<(&MetalTexture, &ProtocolObject<dyn MTLSamplerState>)>,
    ) -> Result<(), String> {
        let descriptor = MTLRenderPassDescriptor::new();
        // SAFETY: index 0 of a fresh descriptor's colour attachments exists.
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setTexture(Some(target));
        attachment.setLoadAction(MTLLoadAction::DontCare);
        attachment.setStoreAction(MTLStoreAction::Store);
        let encoder = command_buffer
            .renderCommandEncoderWithDescriptor(&descriptor)
            .ok_or("no render command encoder")?;
        encoder.setRenderPipelineState(pipeline);
        let pointer = NonNull::new(std::ptr::from_ref(bytes) as *mut c_void).ok_or("no bytes")?;
        // SAFETY: `bytes` lives for the whole encoding (Metal copies it into
        // the command buffer), the buffer, texture and sampler indices are
        // the shaders', and three vertices make the full-screen triangle.
        unsafe {
            encoder.setFragmentBytes_length_atIndex(pointer, std::mem::size_of::<T>(), 0);
            if let Some((texture, sampler)) = source {
                encoder.setFragmentTexture_atIndex(Some(texture), 0);
                encoder.setFragmentSamplerState_atIndex(Some(sampler), 0);
            }
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
        }
        encoder.endEncoding();
        Ok(())
    }

    /// The drawing thread: compiles, then draws at thirty frames a second
    /// until told to quit or until the poster has to stay.
    fn draw_until_stopped(
        device: &MetalDevice,
        layer: &CAMetalLayer,
        shared: &Shared,
        events: &UnboundedSender<Event>,
    ) {
        let still = |reason: StillReason, detail: Option<String>| {
            let _ = events.send(Event::Still(reason, detail));
        };
        let pipelines = match objc2::rc::autoreleasepool(|_| pipelines(device)) {
            Ok(pipelines) => pipelines,
            Err(error) => return still(StillReason::ShaderCompileFailed, Some(error)),
        };
        let stall = debug_stall();
        let epoch = Instant::now();
        let mut clock = Clock::start(Duration::ZERO);
        let mut guard = Guard::default();
        let mut level = Level::Full;
        let mut frame: Option<(Retained<MetalTexture>, (u32, u32))> = None;
        let mut canvas = (0, 0);
        let mut last_draw: Option<Duration> = None;
        let mut drawn = false;
        let mut held = false;

        loop {
            let controls = {
                let Ok(mut controls) = shared.controls.lock() else {
                    return;
                };
                while !controls.quit && !controls.running {
                    // Hidden: the phase holds and nothing is drawn.
                    if !held {
                        held = true;
                        clock.hold(epoch.elapsed());
                    }
                    controls = match shared.changed.wait_timeout(controls, HELD_POLL) {
                        Ok((controls, _)) => controls,
                        Err(_) => return,
                    };
                }
                *controls
            };
            if controls.quit {
                return;
            }
            if held {
                held = false;
                clock.release(epoch.elapsed());
                guard.reset_window();
                last_draw = None;
            }

            let started = epoch.elapsed();
            let outcome = objc2::rc::autoreleasepool(|_| -> Result<bool, String> {
                // Up to a second when the window can't show a frame; no
                // frame is drawn then.
                let Some(drawable) = layer.nextDrawable() else {
                    return Ok(false);
                };
                let target = drawable.texture();
                let size = (target.width() as u32, target.height() as u32);
                if size != canvas {
                    canvas = size;
                    guard.reset_window();
                    last_draw = None;
                }
                let view = rules::internal_size(canvas, level);
                if frame.as_ref().is_none_or(|(_, size)| *size != view) {
                    let texture = scratch(device, view).ok_or("no texture for the frame")?;
                    frame = Some((texture, view));
                }
                let Some((scratch, _)) = frame.as_ref() else {
                    return Ok(false);
                };
                let command_buffer = pipelines.queue.commandBuffer().ok_or("no command buffer")?;
                // The clock reads when the frame is drawn, after the wait.
                let phase = clock.phase_at(epoch.elapsed());
                let uniforms = rules::uniforms(view, phase, controls.tone.shader_dim);
                pass(&command_buffer, &pipelines.chrome, scratch, &uniforms, None)?;
                let tone = [
                    if controls.tone.inverse { 1.0f32 } else { 0.0 },
                    controls.tone.brightness,
                    0.0,
                    0.0,
                ];
                pass(
                    &command_buffer,
                    &pipelines.tone,
                    &target,
                    &tone,
                    Some((scratch, &pipelines.sampler)),
                )?;
                let presented: &ProtocolObject<dyn MTLDrawable> =
                    ProtocolObject::from_ref(&*drawable);
                command_buffer.presentDrawable(presented);
                command_buffer.commit();
                // A busy GPU finishes late, and the next frame starts late
                // with it: that is what the guard measures.
                command_buffer.waitUntilCompleted();
                if command_buffer.status() != MTLCommandBufferStatus::Completed {
                    return Err("the GPU did not finish the frame".to_string());
                }
                shared.presented.fetch_add(1, Ordering::Relaxed);
                Ok(true)
            });
            if let Some(stall) = stall {
                std::thread::sleep(stall);
            }
            match outcome {
                Ok(true) => {
                    if !drawn {
                        drawn = true;
                        let _ = events.send(Event::FirstFrame);
                    }
                    if let Some(last) = last_draw {
                        match guard.record(started.saturating_sub(last), started) {
                            GuardLevel::Moving(next) => level = next,
                            GuardLevel::Still => return still(StillReason::GpuBudget, None),
                        }
                    }
                    last_draw = Some(started);
                }
                Ok(false) => {
                    // No drawable: the time since is the window's, not the
                    // GPU's.
                    guard.reset_window();
                    last_draw = None;
                }
                Err(error) => return still(StillReason::ContextLost, Some(error)),
            }

            let due = started + rules::FRAME_INTERVAL;
            let now = epoch.elapsed();
            if due > now {
                let Ok(controls) = shared.controls.lock() else {
                    return;
                };
                // A quit ends the wait at once; anything else is read at
                // the next frame.
                let _ = shared
                    .changed
                    .wait_timeout_while(controls, due - now, |controls| !controls.quit);
            }
        }
    }
}
