//! Videorc Camera on macOS (plan 214, workstream B4): the sink client in the
//! backend.
//!
//! The Camera Extension (B1, `apps/desktop/camera-extension/`) owns one
//! device with a source stream other apps read and a sink stream Videorc
//! pushes into. This module is the pusher: it finds the device by its fixed
//! UID through the CoreMediaIO C API, picks the sink stream by
//! `kCMIOStreamPropertyDirection` (0 on the sink, 1 on the source: spike
//! P0a, measured), copies the stream's buffer queue with a non-nil callback
//! (the nil-callback trap; the callback is also the release signal below),
//! starts the stream, and hands it one `CMSampleBuffer` per output tick.
//!
//! Per frame the compositor's IOSurface-backed BGRA target is copied on the
//! GPU into a camera-owned `CVPixelBufferPool` buffer (a Metal blit when the
//! program fills the canvas, a cleared scaled draw when it is pillarboxed),
//! so the compositor's ring slot is free as soon as the copy lands and no
//! CPU byte is touched. The CPU compositor's I420 frames (the
//! `VIDEORC_METAL_COMPOSITOR=0` path) are converted on the CPU into the same
//! pool.
//!
//! P0a measured that the extension forwards the producer's IOSurface
//! untouched to every client, so a pool buffer must not be recycled while a
//! client may still display it. The sink therefore holds every enqueued
//! buffer in flight and lets one go only after the queue-altered callback
//! (one call per consumed frame) has counted it consumed plus a margin of
//! later frames; the queue's own capacity (10 on P0a's Mac, depth 0 to 2)
//! and a hard in-flight cap turn a stalled reader into drops, never into a
//! recycled picture. The pool's allocation threshold sits above the cap.
//!
//! P0a also showed that this bare, hardened-runtime binary in
//! `Contents/Resources` sees the device and pushes with no camera prompt, so
//! the sink stays in the backend (plan STOP condition B4 did not fire).
//!
//! "Off" is signalled the way B1 expects: the sink stream is stopped (the
//! extension forgets the producer word on `sinkStopped`), then the producer
//! word `off` is written to the device's `4cc_vcpw_glob_0000` property, so
//! the still reads "Videorc Camera is off". At exit with the switch on, and
//! after a lost device, the stream is stopped and no word is written: the
//! extension's reset leaves the still at "Videorc isn't running" (D12).
//! Every connect re-finds the ids (the extension may restart), and the
//! viewer count comes from the `4cc_vccc_glob_0000` property (D13).
//!
//! Layout: the pure half (four-char codes, the property-name parser, the
//! sink-stream rule, the client-count decoder, the fit geometry, the PTS
//! clock, the I420 → BGRA converter) and [`CmioSink`]'s connect / off /
//! reconnect state machine over a [`CameraTransport`] trait, both covered
//! by unit tests with a fake transport; and [`SystemCmio`], the one real
//! transport, self-contained so it could move into the N-API addon if P0a
//! step 5 says the bare backend cannot see the device (STOP condition B4).

#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMClock, CMSampleBuffer, CMSampleTimingInfo, CMSimpleQueue, CMTime, CMTimeFlags,
    CMVideoFormatDescription, CMVideoFormatDescriptionCreateForImageBuffer,
    kCMSimpleQueueError_QueueIsFull, kCMTimeInvalid,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetIOSurface, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferPool, CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey,
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferPoolAllocationThresholdKey,
    kCVPixelBufferPoolMinimumBufferCountKey, kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
    kCVReturnWouldExceedAllocationThreshold,
};
use objc2_foundation::NSString;
use objc2_metal::{
    MTLBlitCommandEncoder, MTLClearColor, MTLCommandBuffer, MTLCommandBufferStatus,
    MTLCommandEncoder, MTLCommandQueue, MTLCreateSystemDefaultDevice, MTLDevice, MTLLibrary,
    MTLLoadAction, MTLOrigin, MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder,
    MTLRenderPassDescriptor, MTLRenderPipelineDescriptor, MTLRenderPipelineState,
    MTLResourceOptions, MTLSamplerDescriptor, MTLSamplerMinMagFilter, MTLSamplerState, MTLSize,
    MTLStoreAction, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};

use crate::virtual_camera::{
    FitRect, I420View, VIRTUAL_CAMERA_FPS, VIRTUAL_CAMERA_HEIGHT, VIRTUAL_CAMERA_MACOS_DEVICE_UUID,
    VIRTUAL_CAMERA_WIDTH, VirtualCameraFrame, VirtualCameraPts, VirtualCameraPush,
    VirtualCameraSink, VirtualCameraSinkError,
};

// ---------------------------------------------------------------------------
// Identifiers shared with the extension (identifiers.json, checked in tests)
// ---------------------------------------------------------------------------

/// B1 names its sink stream so; the first rule of [`choose_sink_stream`].
pub const VIRTUAL_CAMERA_MACOS_SINK_STREAM_NAME: &str = "Videorc Camera Sink";
/// Read-only: how many apps hold the source stream (D13).
pub const VIRTUAL_CAMERA_MACOS_CLIENT_COUNT_PROPERTY: &str = "4cc_vccc_glob_0000";
/// Writable by the producer: `on` while pushing, `off` after a clean stop
/// (D12 picks the still from it).
pub const VIRTUAL_CAMERA_MACOS_PRODUCER_WORD_PROPERTY: &str = "4cc_vcpw_glob_0000";
pub const PRODUCER_WORD_ON: &str = "on";
pub const PRODUCER_WORD_OFF: &str = "off";

/// The compositor's and the camera's pixel format: `kCVPixelFormatType_32BGRA`.
const CAMERA_PIXEL_FORMAT: u32 = kCVPixelFormatType_32BGRA;
/// Buffers the sink holds in flight at most (P0a: the sink queue's capacity
/// was 10, its depth 0 to 2). At the cap a push is a drop: the reader is
/// behind, and a recycled surface would change a picture it still shows.
pub const IN_FLIGHT_CAP: usize = 16;
/// Consumed frames a client may still display after the callback counted
/// them: the current one plus two of slack for the XPC hand-off.
pub const DISPLAY_MARGIN: u64 = 3;
/// The pool refuses to allocate past this; above the cap so the cap, not the
/// pool, is what a stalled reader hits.
const POOL_ALLOCATION_THRESHOLD: i32 = IN_FLIGHT_CAP as i32 + 4;
const POOL_MINIMUM_BUFFERS: i32 = 3;
const NANOS_PER_SECOND: i64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// Four-char codes and property addresses
// ---------------------------------------------------------------------------

/// A CoreMediaIO four-character code as the C headers spell it (`'glob'`).
pub const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

/// `CMIOObjectPropertyAddress`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CmioPropertyAddress {
    pub selector: u32,
    pub scope: u32,
    pub element: u32,
}

const CMIO_SYSTEM_OBJECT: u32 = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const SCOPE_OUTPUT: u32 = fourcc(b"outp");
const ELEMENT_MAIN: u32 = 0;
const PROPERTY_DEVICES: u32 = fourcc(b"dev#");
const PROPERTY_DEVICE_UID: u32 = fourcc(b"uid ");
const PROPERTY_STREAMS: u32 = fourcc(b"stm#");
const PROPERTY_NAME: u32 = fourcc(b"lnam");
/// `kCMIOStreamPropertyDirection`: 0 on the sink (host → device), 1 on the
/// source stream apps read (spike P0a, measured on macOS 26.5.1).
const PROPERTY_STREAM_DIRECTION: u32 = fourcc(b"sdir");
pub const STREAM_DIRECTION_SINK: u32 = 0;
/// `kCMIOHardwareBadObjectError`: the id names nothing (the extension
/// restarted).
const CMIO_BAD_OBJECT: i32 = fourcc(b"!obj") as i32;

impl CmioPropertyAddress {
    const fn global(selector: u32) -> Self {
        Self {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }
}

/// Parse a Camera Extension custom property name (`4cc_vccc_glob_0000`:
/// selector, scope, element) into the address a client reads it at.
pub fn custom_property_address(name: &str) -> Option<CmioPropertyAddress> {
    let mut parts = name.split('_');
    if parts.next()? != "4cc" {
        return None;
    }
    let selector: [u8; 4] = parts.next()?.as_bytes().try_into().ok()?;
    let scope: [u8; 4] = parts.next()?.as_bytes().try_into().ok()?;
    let element = parts.next()?;
    if parts.next().is_some() || element.len() != 4 {
        return None;
    }
    Some(CmioPropertyAddress {
        selector: fourcc(&selector),
        scope: fourcc(&scope),
        element: element.parse().ok()?,
    })
}

// ---------------------------------------------------------------------------
// The sink stream and the client count: pure rules
// ---------------------------------------------------------------------------

/// One of the device's streams as CMIO lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamInfo {
    pub id: u32,
    /// `kCMIOStreamPropertyDirection`, when readable: 0 is the sink.
    pub direction: Option<u32>,
    /// `kCMIOObjectPropertyName`, when the stream has one.
    pub name: Option<String>,
    /// Listed under `kCMIODevicePropertyScopeOutput` (host → device).
    pub output_scope: bool,
}

/// Which rule picked the sink stream, for the log and the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkStreamRule {
    /// The one stream whose `kCMIOStreamPropertyDirection` is 0 (P0a).
    Direction,
    /// The stream B1 named "Videorc Camera Sink".
    Name,
    /// The one stream CMIO lists in the output scope.
    OutputScope,
    /// The second stream, as OBS takes it. Last resort, never position first.
    Second,
}

impl SinkStreamRule {
    pub fn label(self) -> &'static str {
        match self {
            Self::Direction => "direction",
            Self::Name => "stream-name",
            Self::OutputScope => "output-scope",
            Self::Second => "second-stream",
        }
    }
}

/// The sink stream among the device's streams: the one stream whose
/// direction reads 0 (P0a's measured fact), else B1's name, else the single
/// output-scope stream, else the second stream (OBS's position rule).
pub fn choose_sink_stream(streams: &[StreamInfo]) -> Option<(u32, SinkStreamRule)> {
    let mut sinks = streams
        .iter()
        .filter(|stream| stream.direction == Some(STREAM_DIRECTION_SINK));
    if let (Some(only), None) = (sinks.next(), sinks.next()) {
        return Some((only.id, SinkStreamRule::Direction));
    }
    if let Some(named) = streams
        .iter()
        .find(|stream| stream.name.as_deref() == Some(VIRTUAL_CAMERA_MACOS_SINK_STREAM_NAME))
    {
        return Some((named.id, SinkStreamRule::Name));
    }
    let mut output = streams.iter().filter(|stream| stream.output_scope);
    if let (Some(only), None) = (output.next(), output.next()) {
        return Some((only.id, SinkStreamRule::OutputScope));
    }
    streams
        .get(1)
        .map(|second| (second.id, SinkStreamRule::Second))
}

/// What a custom property read produced, before decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyValue {
    Number(i64),
    Text(String),
    /// A plain 32-bit payload (a property that is not a CF object).
    Raw(u32),
}

/// The viewer count from the `4cc_vccc_glob_0000` value: a number, a numeric
/// string, or a raw word. Negative or unparsable counts are unknown.
pub fn decode_client_count(value: &PropertyValue) -> Option<u32> {
    match value {
        PropertyValue::Number(count) => u32::try_from(*count).ok(),
        PropertyValue::Text(text) => text.trim().parse::<u32>().ok(),
        PropertyValue::Raw(count) => Some(*count),
    }
}

// ---------------------------------------------------------------------------
// The in-flight ledger: when a pushed buffer may be recycled
// ---------------------------------------------------------------------------

/// How many of the `held` in-flight buffers (oldest first) may be let go:
/// every buffer not yet consumed stays (`enqueued - consumed`), and so do
/// the `margin` most recently consumed ones a client may still display.
pub fn releasable(held: usize, enqueued: u64, consumed: u64, margin: u64) -> usize {
    let keep = enqueued.saturating_sub(consumed).saturating_add(margin);
    held.saturating_sub(usize::try_from(keep).unwrap_or(usize::MAX))
}

/// Whether one more buffer may go in flight under `cap`.
pub fn admits(held: usize, cap: usize) -> bool {
    held < cap
}

// ---------------------------------------------------------------------------
// Geometry: how the program lands in the pool buffer
// ---------------------------------------------------------------------------

/// How one frame is copied into the camera buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CopyPlan {
    /// The program is exactly the canvas: a blit, no clear, no sampling.
    Blit,
    /// Clear to black, then draw the program scaled into the fit rect.
    Draw { vertices: [[f32; 4]; 6] },
}

/// The plan for a `source_width`×`source_height` program landing at `fit`
/// in a `canvas_width`×`canvas_height` buffer.
pub fn copy_plan(
    source_width: u32,
    source_height: u32,
    fit: FitRect,
    canvas_width: u32,
    canvas_height: u32,
) -> CopyPlan {
    if fit.is_full(canvas_width, canvas_height)
        && source_width == canvas_width
        && source_height == canvas_height
    {
        return CopyPlan::Blit;
    }
    CopyPlan::Draw {
        vertices: fit_quad_vertices(fit, canvas_width, canvas_height),
    }
}

/// Six `[x, y, u, v]` vertices (two triangles) covering `fit` in the
/// canvas, in Metal clip space (y up), sampling the whole source.
pub fn fit_quad_vertices(fit: FitRect, canvas_width: u32, canvas_height: u32) -> [[f32; 4]; 6] {
    let canvas_width = canvas_width.max(1) as f32;
    let canvas_height = canvas_height.max(1) as f32;
    let x0 = 2.0 * fit.x as f32 / canvas_width - 1.0;
    let x1 = 2.0 * (fit.x + fit.width) as f32 / canvas_width - 1.0;
    let y0 = 1.0 - 2.0 * fit.y as f32 / canvas_height;
    let y1 = 1.0 - 2.0 * (fit.y + fit.height) as f32 / canvas_height;
    [
        [x0, y0, 0.0, 0.0], // top-left
        [x0, y1, 0.0, 1.0], // bottom-left
        [x1, y0, 1.0, 0.0], // top-right
        [x1, y0, 1.0, 0.0], // top-right
        [x0, y1, 0.0, 1.0], // bottom-left
        [x1, y1, 1.0, 1.0], // bottom-right
    ]
}

// ---------------------------------------------------------------------------
// The presentation clock
// ---------------------------------------------------------------------------

/// `CMTime` → nanoseconds, saturating; `None` for a zero timescale.
pub fn cmtime_to_nanos(value: i64, timescale: i32) -> Option<i64> {
    if timescale <= 0 {
        return None;
    }
    let nanos = i128::from(value) * i128::from(NANOS_PER_SECOND) / i128::from(timescale);
    Some(nanos.clamp(0, i128::from(i64::MAX)) as i64)
}

/// A monotonic PTS on the host clock: a frame never carries a time at or
/// before the previous one, even when the host clock reads the same tick
/// twice.
#[derive(Debug, Default, Clone)]
pub struct PtsClock {
    last_nanos: Option<i64>,
}

impl PtsClock {
    pub fn next(&mut self, host_nanos: i64) -> i64 {
        let pts = match self.last_nanos {
            Some(last) if host_nanos <= last => last.saturating_add(1),
            _ => host_nanos,
        };
        self.last_nanos = Some(pts);
        pts
    }
}

fn cmtime_nanos(nanos: i64) -> CMTime {
    CMTime {
        value: nanos,
        timescale: NANOS_PER_SECOND as i32,
        flags: CMTimeFlags::Valid,
        epoch: 0,
    }
}

fn frame_duration() -> CMTime {
    CMTime {
        value: 1,
        timescale: VIRTUAL_CAMERA_FPS as i32,
        flags: CMTimeFlags::Valid,
        epoch: 0,
    }
}

// ---------------------------------------------------------------------------
// The CPU path: I420 (BT.709, video range) → BGRA
// ---------------------------------------------------------------------------

const FIX: f64 = 65536.0;
const Y_GAIN: i32 = (255.0 / 219.0 * FIX) as i32;
const R_CR: i32 = (1.5748 * 255.0 / 224.0 * FIX) as i32;
const G_CB: i32 = (0.1873 * 255.0 / 224.0 * FIX) as i32;
const G_CR: i32 = (0.4681 * 255.0 / 224.0 * FIX) as i32;
const B_CB: i32 = (1.8556 * 255.0 / 224.0 * FIX) as i32;

#[inline]
fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

/// Convert `src` into tightly packed BGRA rows at `dst` (`dst_stride` bytes
/// per row, at least `width * 4`). Rows beyond `src.height` are untouched.
/// Returns false when `dst` is too small.
pub fn i420_to_bgra_rows(src: &I420View<'_>, dst: &mut [u8], dst_stride: usize) -> bool {
    let width = src.width as usize;
    let height = src.height as usize;
    let chroma_width = width.div_ceil(2);
    if width == 0 || height == 0 || dst_stride < width * 4 || dst.len() < dst_stride * height {
        return false;
    }
    if src.y.len() < width * height || src.u.len() < chroma_width * height.div_ceil(2) {
        return false;
    }
    for (row_index, out_row) in dst.chunks_exact_mut(dst_stride).take(height).enumerate() {
        let y_row = &src.y[row_index * width..(row_index + 1) * width];
        let chroma_row = row_index / 2;
        let u_row = &src.u[chroma_row * chroma_width..(chroma_row + 1) * chroma_width];
        let v_row = &src.v[chroma_row * chroma_width..(chroma_row + 1) * chroma_width];
        for (x, pixel) in out_row[..width * 4].chunks_exact_mut(4).enumerate() {
            let luma = (i32::from(y_row[x]) - 16) * Y_GAIN;
            let cb = i32::from(u_row[x / 2]) - 128;
            let cr = i32::from(v_row[x / 2]) - 128;
            let r = (luma + R_CR * cr + 32768) >> 16;
            let g = (luma - G_CB * cb - G_CR * cr + 32768) >> 16;
            let b = (luma + B_CB * cb + 32768) >> 16;
            pixel[0] = clamp_u8(b);
            pixel[1] = clamp_u8(g);
            pixel[2] = clamp_u8(r);
            pixel[3] = 255;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// The transport the state machine drives (real below, fake in tests)
// ---------------------------------------------------------------------------

/// What the sink needs from CoreMediaIO and the frame copy, behind a trait
/// so the connect / off / reconnect rules are unit-tested with a fake.
pub trait CameraTransport: Send {
    /// The Videorc Camera device id, found afresh on every call.
    fn find_device(&mut self) -> Result<u32, String>;
    fn list_streams(&mut self, device: u32) -> Result<Vec<StreamInfo>, String>;
    /// Copy the stream's buffer queue and start the stream.
    fn open_sink(&mut self, device: u32, stream: u32) -> Result<(), String>;
    /// Stop the stream and drop the queue.
    fn close_sink(&mut self, device: u32, stream: u32);
    fn write_producer_word(&mut self, device: u32, word: &str) -> Result<(), String>;
    /// `Ok(None)` when the extension cannot count; `Err` when the device is
    /// gone (the sink reconnects).
    fn read_client_count(&self, device: u32) -> Result<Option<u32>, String>;
    /// Copy one frame into a camera buffer and enqueue it at `pts`.
    fn enqueue(
        &mut self,
        frame: &VirtualCameraFrame<'_>,
        pts: VirtualCameraPts,
    ) -> Result<VirtualCameraPush, VirtualCameraSinkError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Connection {
    device: u32,
    stream: u32,
    rule: SinkStreamRule,
}

/// The macOS sink: [`CmioSink::system`] in the app, a fake transport in
/// tests. One per process, driven from the output thread only.
pub struct CmioSink<T: CameraTransport = SystemCmio> {
    transport: T,
    connection: Option<Connection>,
    /// A push or a viewer read found the device gone: `disconnect` writes no
    /// `off` (the camera is not off, it is lost), and the engine reconnects.
    /// A cell because the trait reads viewers through `&self`.
    lost: RefCell<Option<String>>,
    connects: u64,
}

impl CmioSink<SystemCmio> {
    /// The real sink. Touches nothing until `connect`.
    pub fn system() -> Self {
        Self::with_transport(SystemCmio::new())
    }
}

impl<T: CameraTransport> CmioSink<T> {
    pub(crate) fn with_transport(transport: T) -> Self {
        Self {
            transport,
            connection: None,
            lost: RefCell::new(None),
            connects: 0,
        }
    }

    /// Which rule found the sink stream on the current connection.
    #[allow(dead_code)] // Health (E3) and the smoke read it.
    pub fn sink_stream_rule(&self) -> Option<SinkStreamRule> {
        self.connection.map(|connection| connection.rule)
    }

    /// How many times the sink connected (each time re-finding the ids).
    #[allow(dead_code)] // Health (E3) and the smoke read it.
    pub fn connects(&self) -> u64 {
        self.connects
    }

    #[cfg(test)]
    fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: CameraTransport> VirtualCameraSink for CmioSink<T> {
    fn label(&self) -> &'static str {
        "cmio-sink"
    }

    fn connect(&mut self) -> Result<(), VirtualCameraSinkError> {
        if self.connection.is_some() {
            return Ok(());
        }
        // Ids are never reused across connects: the extension may have
        // restarted, and CMIO hands out new ones then.
        let device = self
            .transport
            .find_device()
            .map_err(VirtualCameraSinkError::disconnected)?;
        let streams = self
            .transport
            .list_streams(device)
            .map_err(VirtualCameraSinkError::disconnected)?;
        let Some((stream, rule)) = choose_sink_stream(&streams) else {
            return Err(VirtualCameraSinkError::disconnected(
                "Videorc Camera has no sink stream to push into.",
            ));
        };
        self.transport
            .open_sink(device, stream)
            .map_err(VirtualCameraSinkError::disconnected)?;
        if let Err(error) = self.transport.write_producer_word(device, PRODUCER_WORD_ON) {
            // Not fatal: live frames outrank the word; the still only reads
            // the word after a second of silence.
            tracing::warn!("Videorc Camera could not tell the extension it is on: {error}");
        }
        self.connection = Some(Connection {
            device,
            stream,
            rule,
        });
        *self.lost.borrow_mut() = None;
        self.connects = self.connects.saturating_add(1);
        tracing::info!(
            "Videorc Camera connected to the extension's sink stream (device {device}, stream {stream}, found by {})",
            rule.label()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        self.transport
            .close_sink(connection.device, connection.stream);
        if self.lost.borrow_mut().take().is_none() {
            // Stopped by the switch: the still says "off". After the stop,
            // so the extension's reset on `sinkStopped` does not erase the
            // word.
            if let Err(error) = self
                .transport
                .write_producer_word(connection.device, PRODUCER_WORD_OFF)
            {
                tracing::warn!("Videorc Camera could not tell the extension it is off: {error}");
            }
        }
    }

    fn disconnect_at_exit(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        // Videorc is quitting with the switch on: the stream stops and no
        // word is written, so the extension's reset leaves the still at
        // "Videorc isn't running" (D12), the truth until the next launch
        // turns the camera back on (D4).
        self.transport
            .close_sink(connection.device, connection.stream);
        *self.lost.borrow_mut() = None;
    }

    fn push(
        &mut self,
        frame: &VirtualCameraFrame<'_>,
        pts: VirtualCameraPts,
    ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
        if self.connection.is_none() {
            return Err(VirtualCameraSinkError::disconnected(
                "Videorc Camera isn't connected.",
            ));
        }
        if let Some(reason) = self.lost.borrow().clone() {
            return Err(VirtualCameraSinkError::disconnected(reason));
        }
        let result = self.transport.enqueue(frame, pts);
        if let Err(error) = &result
            && error.disconnected
        {
            *self.lost.borrow_mut() = Some(error.message.clone());
        }
        result
    }

    fn viewers(&self) -> Option<u32> {
        let connection = self.connection?;
        match self.transport.read_client_count(connection.device) {
            Ok(count) => count,
            Err(reason) => {
                // The device is gone: the next push reports it and the engine
                // reconnects with fresh ids. Until then "unknown" keeps the
                // demand (D13), at most one second.
                *self.lost.borrow_mut() = Some(reason);
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The real transport: CoreMediaIO + CoreMedia + CoreVideo + Metal
// ---------------------------------------------------------------------------

type QueueAlteredProc =
    unsafe extern "C-unwind" fn(stream: u32, token: *mut c_void, ref_con: *mut c_void);

#[link(name = "CoreMediaIO", kind = "framework")]
unsafe extern "C-unwind" {
    fn CMIOObjectHasProperty(object: u32, address: *const CmioPropertyAddress) -> u8;
    fn CMIOObjectGetPropertyDataSize(
        object: u32,
        address: *const CmioPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn CMIOObjectGetPropertyData(
        object: u32,
        address: *const CmioPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        used: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn CMIOObjectSetPropertyData(
        object: u32,
        address: *const CmioPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32;
    fn CMIODeviceStartStream(device: u32, stream: u32) -> i32;
    fn CMIODeviceStopStream(device: u32, stream: u32) -> i32;
    fn CMIOStreamCopyBufferQueue(
        stream: u32,
        queue_altered: Option<QueueAlteredProc>,
        ref_con: *mut c_void,
        queue: *mut *mut CMSimpleQueue,
    ) -> i32;
}

/// Frames the extension consumed from the sink queue, over the process's
/// life (one sink per process). The queue-altered callback counts them; the
/// transport reads the count against the baseline it took at open.
static CONSUMED_FRAMES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The non-nil callback `CMIOStreamCopyBufferQueue` needs (the nil-callback
/// trap), and the release signal: P0a measured it fires once per frame the
/// extension consumed. It runs on CMIO's thread and touches one atomic.
unsafe extern "C-unwind" fn queue_altered(
    _stream: u32,
    _token: *mut c_void,
    _ref_con: *mut c_void,
) {
    CONSUMED_FRAMES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

fn os_status(status: i32) -> String {
    let bytes = status.to_be_bytes();
    if bytes
        .iter()
        .all(|byte| byte.is_ascii_graphic() || *byte == b' ')
    {
        format!("'{}' ({status})", String::from_utf8_lossy(&bytes))
    } else {
        status.to_string()
    }
}

/// Read a `u32` list property.
fn cmio_u32_list(object: u32, address: &CmioPropertyAddress) -> Result<Vec<u32>, i32> {
    let mut size: u32 = 0;
    // SAFETY: plain C calls with valid out-pointers; CMIO reads nothing else.
    let status =
        unsafe { CMIOObjectGetPropertyDataSize(object, address, 0, std::ptr::null(), &mut size) };
    if status != 0 {
        return Err(status);
    }
    let count = size as usize / std::mem::size_of::<u32>();
    let mut ids = vec![0u32; count];
    let mut used: u32 = 0;
    let status = unsafe {
        CMIOObjectGetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            size,
            &mut used,
            ids.as_mut_ptr().cast(),
        )
    };
    if status != 0 {
        return Err(status);
    }
    ids.truncate(used as usize / std::mem::size_of::<u32>());
    Ok(ids)
}

/// Read a property whose payload is one retained CF object (a `CFStringRef`
/// name or UID, a custom property's property-list value). `Ok(None)` when
/// the payload is not pointer-sized.
fn cmio_cf_object(
    object: u32,
    address: &CmioPropertyAddress,
) -> Result<Option<CFRetained<CFType>>, i32> {
    let mut size: u32 = 0;
    let status =
        unsafe { CMIOObjectGetPropertyDataSize(object, address, 0, std::ptr::null(), &mut size) };
    if status != 0 {
        return Err(status);
    }
    if size as usize != std::mem::size_of::<*const CFType>() {
        return Ok(None);
    }
    let mut pointer: *mut CFType = std::ptr::null_mut();
    let mut used: u32 = 0;
    let status = unsafe {
        CMIOObjectGetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            size,
            &mut used,
            (&mut pointer as *mut *mut CFType).cast(),
        )
    };
    if status != 0 {
        return Err(status);
    }
    // SAFETY: CMIO hands back a +1 reference the caller owns.
    Ok(NonNull::new(pointer).map(|ptr| unsafe { CFRetained::from_raw(ptr) }))
}

fn cmio_raw_u32(object: u32, address: &CmioPropertyAddress) -> Result<Option<u32>, i32> {
    let mut size: u32 = 0;
    let status =
        unsafe { CMIOObjectGetPropertyDataSize(object, address, 0, std::ptr::null(), &mut size) };
    if status != 0 {
        return Err(status);
    }
    if size as usize != std::mem::size_of::<u32>() {
        return Ok(None);
    }
    let mut value: u32 = 0;
    let mut used: u32 = 0;
    let status = unsafe {
        CMIOObjectGetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            size,
            &mut used,
            (&mut value as *mut u32).cast(),
        )
    };
    if status != 0 {
        return Err(status);
    }
    Ok(Some(value))
}

fn cmio_string(object: u32, address: &CmioPropertyAddress) -> Result<Option<String>, i32> {
    Ok(cmio_cf_object(object, address)?.and_then(|value| {
        value
            .downcast_ref::<CFString>()
            .map(|text| text.to_string())
    }))
}

fn cmio_has_property(object: u32, address: &CmioPropertyAddress) -> bool {
    unsafe { CMIOObjectHasProperty(object, address) != 0 }
}

type Texture = Retained<ProtocolObject<dyn MTLTexture>>;
/// A texture over an IOSurface, with the surface's width and height.
type SizedTexture = (usize, usize, Texture);

/// The Metal objects the GPU copy needs, built on the first GPU frame.
struct GpuPath {
    device: Retained<ProtocolObject<dyn MTLDevice>>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    sampler: Retained<ProtocolObject<dyn MTLSamplerState>>,
    /// Source textures over the compositor's ring slots, by IOSurface id.
    sources: HashMap<u32, SizedTexture>,
    /// Target textures over the pool's buffers, by IOSurface id.
    targets: HashMap<u32, Texture>,
}

const COPY_SHADER_SOURCE: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct VOut { float4 pos [[position]]; float2 uv; };
vertex VOut vcam_vertex(uint vid [[vertex_id]], const device float4* verts [[buffer(0)]]) {
    VOut out;
    float4 v = verts[vid];
    out.pos = float4(v.x, v.y, 0.0, 1.0);
    out.uv = float2(v.z, v.w);
    return out;
}
fragment float4 vcam_fragment(VOut in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler s [[sampler(0)]]) {
    float4 c = tex.sample(s, in.uv);
    return float4(c.rgb, 1.0);
}
"#;

/// Bounded caches: the compositor's ring is three slots, and the pool holds
/// at most the in-flight cap plus a few free buffers; past these the caches
/// are rebuilt from scratch (a cached texture keeps its surface alive, so a
/// canvas change must not pin a dozen old targets).
const SOURCE_TEXTURE_CACHE_LIMIT: usize = 6;
const TARGET_TEXTURE_CACHE_LIMIT: usize = IN_FLIGHT_CAP + 8;

impl GpuPath {
    fn new() -> Result<Self, String> {
        let device = MTLCreateSystemDefaultDevice()
            .ok_or_else(|| "No Metal device for Videorc Camera's frame copy.".to_string())?;
        let queue = device.newCommandQueue().ok_or_else(|| {
            "Could not make a Metal command queue for Videorc Camera.".to_string()
        })?;
        let source = NSString::from_str(COPY_SHADER_SOURCE);
        let library = device
            .newLibraryWithSource_options_error(&source, None)
            .map_err(|error| format!("Videorc Camera's copy shader did not compile: {error}"))?;
        let vertex = library
            .newFunctionWithName(&NSString::from_str("vcam_vertex"))
            .ok_or_else(|| "Videorc Camera's vertex function is missing.".to_string())?;
        let fragment = library
            .newFunctionWithName(&NSString::from_str("vcam_fragment"))
            .ok_or_else(|| "Videorc Camera's fragment function is missing.".to_string())?;
        let descriptor = MTLRenderPipelineDescriptor::new();
        descriptor.setVertexFunction(Some(&vertex));
        descriptor.setFragmentFunction(Some(&fragment));
        let attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        let pipeline = device
            .newRenderPipelineStateWithDescriptor_error(&descriptor)
            .map_err(|error| format!("Videorc Camera's copy pipeline failed: {error}"))?;
        let sampler_descriptor = MTLSamplerDescriptor::new();
        sampler_descriptor.setMinFilter(MTLSamplerMinMagFilter::Linear);
        sampler_descriptor.setMagFilter(MTLSamplerMinMagFilter::Linear);
        let sampler = device
            .newSamplerStateWithDescriptor(&sampler_descriptor)
            .ok_or_else(|| "Could not make Videorc Camera's sampler.".to_string())?;
        Ok(Self {
            device,
            queue,
            pipeline,
            sampler,
            sources: HashMap::new(),
            targets: HashMap::new(),
        })
    }

    /// A texture over the buffer's IOSurface, keyed by the surface's id.
    fn texture_over_iosurface(
        &self,
        pixel_buffer: &CVPixelBuffer,
        usage: MTLTextureUsage,
    ) -> Option<(u32, SizedTexture)> {
        let surface = CVPixelBufferGetIOSurface(Some(pixel_buffer))?;
        // The surface's own geometry is the truth (a stale frame after a
        // canvas change must not abort the process in Metal's validation).
        let width = surface.width();
        let height = surface.height();
        if width == 0 || height == 0 {
            return None;
        }
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                width,
                height,
                false,
            )
        };
        descriptor.setUsage(usage);
        let texture = self.device.newTextureWithDescriptor_iosurface_plane(
            &descriptor,
            surface.as_ref(),
            0,
        )?;
        Some((surface.id(), (width, height, texture)))
    }

    fn source_texture(&mut self, pixel_buffer: &CVPixelBuffer) -> Option<SizedTexture> {
        let surface_id = CVPixelBufferGetIOSurface(Some(pixel_buffer))?.id();
        if let Some((width, height, texture)) = self.sources.get(&surface_id) {
            return Some((*width, *height, texture.clone()));
        }
        if self.sources.len() >= SOURCE_TEXTURE_CACHE_LIMIT {
            self.sources.clear();
        }
        let (id, (width, height, texture)) =
            self.texture_over_iosurface(pixel_buffer, MTLTextureUsage::ShaderRead)?;
        self.sources.insert(id, (width, height, texture.clone()));
        Some((width, height, texture))
    }

    fn target_texture(&mut self, pixel_buffer: &CVPixelBuffer) -> Option<Texture> {
        let surface_id = CVPixelBufferGetIOSurface(Some(pixel_buffer))?.id();
        if let Some(texture) = self.targets.get(&surface_id) {
            return Some(texture.clone());
        }
        if self.targets.len() >= TARGET_TEXTURE_CACHE_LIMIT {
            self.targets.clear();
        }
        let (id, (_, _, texture)) = self.texture_over_iosurface(
            pixel_buffer,
            MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead,
        )?;
        self.targets.insert(id, texture.clone());
        Some(texture)
    }

    /// Copy `source` into `target` per `plan`, and wait for the GPU: the
    /// compositor's ring slot is released the moment this returns.
    fn copy(
        &mut self,
        source: &CVPixelBuffer,
        target: &CVPixelBuffer,
        plan: CopyPlan,
    ) -> Result<(), String> {
        let (source_width, source_height, source_texture) = self
            .source_texture(source)
            .ok_or_else(|| "The program frame has no IOSurface to copy from.".to_string())?;
        let target_texture = self
            .target_texture(target)
            .ok_or_else(|| "The camera buffer has no IOSurface to copy into.".to_string())?;
        let command_buffer = self
            .queue
            .commandBuffer()
            .ok_or_else(|| "No Metal command buffer for Videorc Camera.".to_string())?;
        match plan {
            CopyPlan::Blit => {
                let width = source_width.min(target_texture.width());
                let height = source_height.min(target_texture.height());
                let encoder = command_buffer
                    .blitCommandEncoder()
                    .ok_or_else(|| "No Metal blit encoder for Videorc Camera.".to_string())?;
                unsafe {
                    encoder.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toTexture_destinationSlice_destinationLevel_destinationOrigin(
                        &source_texture,
                        0,
                        0,
                        MTLOrigin { x: 0, y: 0, z: 0 },
                        MTLSize { width, height, depth: 1 },
                        &target_texture,
                        0,
                        0,
                        MTLOrigin { x: 0, y: 0, z: 0 },
                    );
                }
                encoder.endEncoding();
            }
            CopyPlan::Draw { vertices } => {
                let pass = MTLRenderPassDescriptor::new();
                let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
                attachment.setTexture(Some(&*target_texture));
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
                    .ok_or_else(|| "No Metal render encoder for Videorc Camera.".to_string())?;
                encoder.setRenderPipelineState(&self.pipeline);
                let flat: [f32; 24] = std::array::from_fn(|index| vertices[index / 4][index % 4]);
                let buffer = unsafe {
                    self.device.newBufferWithBytes_length_options(
                        NonNull::new(flat.as_ptr() as *mut c_void)
                            .ok_or_else(|| "vertex pointer".to_string())?,
                        std::mem::size_of_val(&flat),
                        MTLResourceOptions::StorageModeShared,
                    )
                }
                .ok_or_else(|| "No Metal vertex buffer for Videorc Camera.".to_string())?;
                unsafe {
                    encoder.setVertexBuffer_offset_atIndex(Some(&buffer), 0, 0);
                    encoder.setFragmentTexture_atIndex(Some(&*source_texture), 0);
                    encoder.setFragmentSamplerState_atIndex(Some(&*self.sampler), 0);
                    encoder.drawPrimitives_vertexStart_vertexCount(
                        MTLPrimitiveType::Triangle,
                        0,
                        6,
                    );
                }
                encoder.endEncoding();
            }
        }
        command_buffer.commit();
        command_buffer.waitUntilCompleted();
        if command_buffer.status() == MTLCommandBufferStatus::Error {
            return Err("Videorc Camera's GPU copy failed.".to_string());
        }
        Ok(())
    }
}

/// The camera-owned buffers and their one format description.
struct Pool {
    pool: CFRetained<CVPixelBufferPool>,
    aux_attributes: CFRetained<CFDictionary<CFType, CFType>>,
    format: Option<CFRetained<CMVideoFormatDescription>>,
}

impl Pool {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let empty = CFDictionary::<CFType, CFType>::from_slices(&[], &[]);
        let format_type = CFNumber::new_i64(i64::from(CAMERA_PIXEL_FORMAT));
        let width_number = CFNumber::new_i64(i64::from(width));
        let height_number = CFNumber::new_i64(i64::from(height));
        let pixel_buffer_attributes = CFDictionary::<CFType, CFType>::from_slices(
            &[
                unsafe { kCVPixelBufferPixelFormatTypeKey }.as_ref(),
                unsafe { kCVPixelBufferWidthKey }.as_ref(),
                unsafe { kCVPixelBufferHeightKey }.as_ref(),
                unsafe { kCVPixelBufferIOSurfacePropertiesKey }.as_ref(),
                unsafe { kCVPixelBufferMetalCompatibilityKey }.as_ref(),
            ],
            &[
                format_type.as_ref(),
                width_number.as_ref(),
                height_number.as_ref(),
                empty.as_ref(),
                CFBoolean::new(true).as_ref(),
            ],
        );
        let minimum = CFNumber::new_i32(POOL_MINIMUM_BUFFERS);
        let pool_attributes = CFDictionary::<CFType, CFType>::from_slices(
            &[unsafe { kCVPixelBufferPoolMinimumBufferCountKey }.as_ref()],
            &[minimum.as_ref()],
        );
        let threshold = CFNumber::new_i32(POOL_ALLOCATION_THRESHOLD);
        let aux_attributes = CFDictionary::<CFType, CFType>::from_slices(
            &[unsafe { kCVPixelBufferPoolAllocationThresholdKey }.as_ref()],
            &[threshold.as_ref()],
        );
        let mut pool: *mut CVPixelBufferPool = std::ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create(
                None,
                Some(pool_attributes.as_ref()),
                Some(pixel_buffer_attributes.as_ref()),
                NonNull::from(&mut pool),
            )
        };
        let pool = NonNull::new(pool)
            .filter(|_| status == 0)
            .map(|ptr| unsafe { CFRetained::from_raw(ptr) })
            .ok_or_else(|| format!("Could not make Videorc Camera's buffer pool ({status})."))?;
        Ok(Self {
            pool,
            aux_attributes,
            format: None,
        })
    }

    /// A free buffer, or `None` when every buffer is still in flight (a
    /// drop, never an allocation past the threshold).
    fn buffer(&self) -> Result<Option<CFRetained<CVPixelBuffer>>, String> {
        let mut pixel_buffer: *mut CVPixelBuffer = std::ptr::null_mut();
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer_with_aux_attributes(
                None,
                &self.pool,
                Some(self.aux_attributes.as_ref()),
                NonNull::from(&mut pixel_buffer),
            )
        };
        if status == kCVReturnWouldExceedAllocationThreshold {
            return Ok(None);
        }
        if status != 0 {
            return Err(format!(
                "Videorc Camera's buffer pool refused a buffer ({status})."
            ));
        }
        Ok(NonNull::new(pixel_buffer).map(|ptr| unsafe { CFRetained::from_raw(ptr) }))
    }

    fn format_for(
        &mut self,
        buffer: &CVPixelBuffer,
    ) -> Result<CFRetained<CMVideoFormatDescription>, String> {
        if let Some(format) = &self.format {
            return Ok(format.clone());
        }
        let mut format: *const CMVideoFormatDescription = std::ptr::null();
        let status = unsafe {
            CMVideoFormatDescriptionCreateForImageBuffer(None, buffer, NonNull::from(&mut format))
        };
        let format = NonNull::new(format.cast_mut())
            .filter(|_| status == 0)
            .map(|ptr| unsafe { CFRetained::from_raw(ptr) })
            .ok_or_else(|| format!("Videorc Camera's format description failed ({status})."))?;
        self.format = Some(format.clone());
        Ok(format)
    }
}

/// One CoreMediaIO device as the system lists it, for the lab aid and the
/// smoke's diagnostics.
#[allow(dead_code)] // The ignored lab test and the smoke's diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmioDeviceListing {
    pub id: u32,
    pub uid: Option<String>,
    pub name: Option<String>,
}

/// What the real transport did, for the log at disconnect (the plan's
/// "zero CPU copies" evidence).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TransportCounters {
    pub gpu_blits: u64,
    pub gpu_draws: u64,
    pub cpu_converts: u64,
    pub queue_full: u64,
    /// Drops at the in-flight cap (the reader stopped consuming).
    pub in_flight_full: u64,
    pub pool_exhausted: u64,
    /// The most buffers held in flight at once.
    pub in_flight_peak: u64,
}

/// The one real transport. Self-contained: CoreMediaIO, CoreMedia,
/// CoreVideo and Metal, nothing of the compositor's.
pub struct SystemCmio {
    queue: Option<CFRetained<CMSimpleQueue>>,
    gpu: Option<GpuPath>,
    pool: Option<Pool>,
    pts: PtsClock,
    /// Pushed buffers the extension or a client may still read, oldest
    /// first. Released by [`releasable`] against the callback's count.
    in_flight: std::collections::VecDeque<CFRetained<CVPixelBuffer>>,
    /// Frames enqueued since `open_sink`.
    enqueued: u64,
    /// `CONSUMED_FRAMES` when the sink opened.
    consumed_base: u64,
    counters: TransportCounters,
    client_count_address: CmioPropertyAddress,
    producer_word_address: CmioPropertyAddress,
}

// SAFETY: every CF and Metal handle here is owned by this transport, which
// the output thread owns and drives in order; nothing is shared across
// threads, and every command buffer is waited on before `enqueue` returns.
unsafe impl Send for SystemCmio {}

impl Default for SystemCmio {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemCmio {
    pub fn new() -> Self {
        Self {
            queue: None,
            gpu: None,
            pool: None,
            pts: PtsClock::default(),
            in_flight: std::collections::VecDeque::new(),
            enqueued: 0,
            consumed_base: 0,
            counters: TransportCounters::default(),
            client_count_address: custom_property_address(
                VIRTUAL_CAMERA_MACOS_CLIENT_COUNT_PROPERTY,
            )
            .expect("a valid custom property name"),
            producer_word_address: custom_property_address(
                VIRTUAL_CAMERA_MACOS_PRODUCER_WORD_PROPERTY,
            )
            .expect("a valid custom property name"),
        }
    }

    #[allow(dead_code)] // Health (E3) prints them.
    pub fn counters(&self) -> TransportCounters {
        self.counters
    }

    /// Frames the extension consumed since the sink opened.
    fn consumed(&self) -> u64 {
        CONSUMED_FRAMES
            .load(std::sync::atomic::Ordering::Relaxed)
            .saturating_sub(self.consumed_base)
    }

    /// Let go of every in-flight buffer the reader is done showing.
    fn release_consumed(&mut self) {
        let release = releasable(
            self.in_flight.len(),
            self.enqueued,
            self.consumed(),
            DISPLAY_MARGIN,
        );
        for _ in 0..release {
            self.in_flight.pop_front();
        }
    }

    /// Every CMIO device with its UID, for the lab (`cargo test -- --ignored
    /// cmio_lists`) and the smoke's diagnostics.
    #[allow(dead_code)] // The ignored lab test and the smoke's diagnostics.
    pub fn list_devices() -> Result<Vec<CmioDeviceListing>, String> {
        let devices = cmio_u32_list(
            CMIO_SYSTEM_OBJECT,
            &CmioPropertyAddress::global(PROPERTY_DEVICES),
        )
        .map_err(|status| format!("CoreMediaIO would not list devices: {}", os_status(status)))?;
        Ok(devices
            .into_iter()
            .map(|device| {
                let uid = cmio_string(device, &CmioPropertyAddress::global(PROPERTY_DEVICE_UID))
                    .ok()
                    .flatten();
                let name = cmio_string(device, &CmioPropertyAddress::global(PROPERTY_NAME))
                    .ok()
                    .flatten();
                CmioDeviceListing {
                    id: device,
                    uid,
                    name,
                }
            })
            .collect())
    }

    fn host_nanos() -> i64 {
        // SAFETY: the host time clock is a process-wide singleton.
        let now = unsafe { CMClock::host_time_clock().time() };
        cmtime_to_nanos(now.value, now.timescale).unwrap_or(0)
    }

    fn fill_from_i420(buffer: &CVPixelBuffer, view: &I420View<'_>) -> Result<(), String> {
        // SAFETY: a retained pool buffer, locked for writing and unlocked on
        // every path below.
        if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::empty()) } != 0 {
            return Err("Could not lock a Videorc Camera buffer.".to_string());
        }
        let result = (|| {
            let stride = CVPixelBufferGetBytesPerRow(buffer);
            let base = CVPixelBufferGetBaseAddress(buffer);
            if base.is_null() || stride < VIRTUAL_CAMERA_WIDTH as usize * 4 {
                return Err("A Videorc Camera buffer has no rows to write.".to_string());
            }
            let rows = VIRTUAL_CAMERA_HEIGHT as usize;
            // SAFETY: the buffer is locked, `stride * rows` bytes are its
            // own, and nothing else writes it while locked.
            let dst = unsafe { std::slice::from_raw_parts_mut(base.cast::<u8>(), stride * rows) };
            if view.width != VIRTUAL_CAMERA_WIDTH || view.height != VIRTUAL_CAMERA_HEIGHT {
                return Err("The CPU frame is not at the camera format.".to_string());
            }
            if !i420_to_bgra_rows(view, dst, stride) {
                return Err("The CPU frame did not fit the camera buffer.".to_string());
            }
            Ok(())
        })();
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::empty()) };
        result
    }
}

impl CameraTransport for SystemCmio {
    fn find_device(&mut self) -> Result<u32, String> {
        let devices = cmio_u32_list(
            CMIO_SYSTEM_OBJECT,
            &CmioPropertyAddress::global(PROPERTY_DEVICES),
        )
        .map_err(|status| format!("CoreMediaIO would not list cameras: {}", os_status(status)))?;
        for device in devices {
            let uid = cmio_string(device, &CmioPropertyAddress::global(PROPERTY_DEVICE_UID))
                .ok()
                .flatten();
            if uid.is_some_and(|uid| uid.eq_ignore_ascii_case(VIRTUAL_CAMERA_MACOS_DEVICE_UUID)) {
                return Ok(device);
            }
        }
        Err(
            "No Videorc Camera device. Allow Videorc Camera in System Settings, then try again."
                .to_string(),
        )
    }

    fn list_streams(&mut self, device: u32) -> Result<Vec<StreamInfo>, String> {
        let all = cmio_u32_list(device, &CmioPropertyAddress::global(PROPERTY_STREAMS)).map_err(
            |status| {
                format!(
                    "Videorc Camera's streams could not be listed: {}",
                    os_status(status)
                )
            },
        )?;
        let output = cmio_u32_list(
            device,
            &CmioPropertyAddress {
                selector: PROPERTY_STREAMS,
                scope: SCOPE_OUTPUT,
                element: ELEMENT_MAIN,
            },
        )
        .unwrap_or_default();
        Ok(all
            .into_iter()
            .map(|id| StreamInfo {
                id,
                direction: cmio_raw_u32(
                    id,
                    &CmioPropertyAddress::global(PROPERTY_STREAM_DIRECTION),
                )
                .ok()
                .flatten(),
                name: cmio_string(id, &CmioPropertyAddress::global(PROPERTY_NAME))
                    .ok()
                    .flatten(),
                output_scope: output.contains(&id),
            })
            .collect())
    }

    fn open_sink(&mut self, device: u32, stream: u32) -> Result<(), String> {
        let mut queue: *mut CMSimpleQueue = std::ptr::null_mut();
        // The nil-callback trap: CMIO refuses a null `queueAlteredProc`.
        let status = unsafe {
            CMIOStreamCopyBufferQueue(
                stream,
                Some(queue_altered),
                std::ptr::null_mut(),
                &mut queue,
            )
        };
        let queue = NonNull::new(queue)
            .filter(|_| status == 0)
            .map(|ptr| unsafe { CFRetained::from_raw(ptr) })
            .ok_or_else(|| {
                format!(
                    "Videorc Camera's sink queue could not be copied: {}",
                    os_status(status)
                )
            })?;
        let status = unsafe { CMIODeviceStartStream(device, stream) };
        if status != 0 {
            return Err(format!(
                "Videorc Camera's sink stream would not start: {}",
                os_status(status)
            ));
        }
        tracing::info!(
            "Videorc Camera's sink queue holds {} frames",
            // SAFETY: a retained queue.
            unsafe { queue.capacity() }
        );
        self.queue = Some(queue);
        self.pts = PtsClock::default();
        self.in_flight.clear();
        self.enqueued = 0;
        self.consumed_base = CONSUMED_FRAMES.load(std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    fn close_sink(&mut self, device: u32, stream: u32) {
        let status = unsafe { CMIODeviceStopStream(device, stream) };
        if status != 0 {
            tracing::debug!(
                "Videorc Camera's sink stream stop answered {}",
                os_status(status)
            );
        }
        self.queue = None;
        // The stream is stopped: clients show the still within a second,
        // and until then may still display the last pushed surfaces. The
        // pool and the textures over its buffers go, so a reconnect draws
        // into fresh surfaces and the old ones live exactly as long as
        // someone holds them.
        self.in_flight.clear();
        self.pool = None;
        if let Some(gpu) = &mut self.gpu {
            gpu.targets.clear();
        }
        tracing::info!(
            "Videorc Camera sink closed: {} GPU blits, {} GPU draws, {} CPU converts, {} full-queue drops, {} in-flight-cap drops, {} pool-exhausted drops, {} in flight at peak, {} consumed",
            self.counters.gpu_blits,
            self.counters.gpu_draws,
            self.counters.cpu_converts,
            self.counters.queue_full,
            self.counters.in_flight_full,
            self.counters.pool_exhausted,
            self.counters.in_flight_peak,
            self.consumed()
        );
    }

    fn write_producer_word(&mut self, device: u32, word: &str) -> Result<(), String> {
        if !cmio_has_property(device, &self.producer_word_address) {
            return Err("the extension has no producer-word property".to_string());
        }
        let value = CFString::from_str(word);
        let pointer: *const CFString = &*value;
        let status = unsafe {
            CMIOObjectSetPropertyData(
                device,
                &self.producer_word_address,
                0,
                std::ptr::null(),
                std::mem::size_of::<*const CFString>() as u32,
                (&pointer as *const *const CFString).cast(),
            )
        };
        if status != 0 {
            return Err(format!("CoreMediaIO answered {}", os_status(status)));
        }
        Ok(())
    }

    fn read_client_count(&self, device: u32) -> Result<Option<u32>, String> {
        if !cmio_has_property(device, &self.client_count_address) {
            // No count on this extension build: make sure the device is
            // still there before calling the count unknown.
            return match cmio_string(device, &CmioPropertyAddress::global(PROPERTY_DEVICE_UID)) {
                Ok(_) => Ok(None),
                Err(status) => Err(format!(
                    "Videorc Camera's device is gone: {}",
                    os_status(status)
                )),
            };
        }
        let value = match cmio_cf_object(device, &self.client_count_address) {
            Ok(Some(object)) => {
                if let Some(number) = object.downcast_ref::<CFNumber>() {
                    number.as_i64().map(PropertyValue::Number)
                } else {
                    object
                        .downcast_ref::<CFString>()
                        .map(|text| PropertyValue::Text(text.to_string()))
                }
            }
            Ok(None) => cmio_raw_u32(device, &self.client_count_address)
                .map_err(|status| {
                    format!(
                        "Videorc Camera's viewer count could not be read: {}",
                        os_status(status)
                    )
                })?
                .map(PropertyValue::Raw),
            Err(status) if status == CMIO_BAD_OBJECT => {
                return Err(
                    "Videorc Camera's device is gone (the extension restarted).".to_string()
                );
            }
            Err(status) => {
                return Err(format!(
                    "Videorc Camera's viewer count could not be read: {}",
                    os_status(status)
                ));
            }
        };
        Ok(value.as_ref().and_then(decode_client_count))
    }

    fn enqueue(
        &mut self,
        frame: &VirtualCameraFrame<'_>,
        _pts: VirtualCameraPts,
    ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
        // The engine's PTS counts ticks from zero on the camera's own clock.
        // The extension forwards a sample's PTS to its clients as host time
        // (`hostTimeInNanoseconds` in `DeviceSource.swift`), so the frame is
        // stamped on the host clock here instead, kept monotonic by
        // `PtsClock`; the tick count is not needed for that.
        let Some(queue) = self.queue.clone() else {
            return Err(VirtualCameraSinkError::disconnected(
                "Videorc Camera's sink queue is closed.",
            ));
        };
        // A full queue is a drop before any copy: the reader is behind.
        // SAFETY: a retained queue.
        if unsafe { queue.count() >= queue.capacity() } {
            self.counters.queue_full += 1;
            return Ok(VirtualCameraPush::Dropped);
        }
        // Recycle what the reader is done showing; at the cap, drop rather
        // than touch a surface a client may still display (P0a).
        self.release_consumed();
        if !admits(self.in_flight.len(), IN_FLIGHT_CAP) {
            self.counters.in_flight_full += 1;
            return Ok(VirtualCameraPush::Dropped);
        }
        if self.pool.is_none() {
            self.pool = Some(
                Pool::new(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT)
                    .map_err(VirtualCameraSinkError::transient)?,
            );
        }
        let pool = self.pool.as_mut().expect("built above");
        let Some(buffer) = pool.buffer().map_err(VirtualCameraSinkError::transient)? else {
            self.counters.pool_exhausted += 1;
            return Ok(VirtualCameraPush::Dropped);
        };
        match frame {
            VirtualCameraFrame::MetalTarget {
                target,
                source_width,
                source_height,
                fit,
            } => {
                if self.gpu.is_none() {
                    self.gpu = Some(GpuPath::new().map_err(VirtualCameraSinkError::transient)?);
                }
                let plan = copy_plan(
                    *source_width,
                    *source_height,
                    *fit,
                    VIRTUAL_CAMERA_WIDTH,
                    VIRTUAL_CAMERA_HEIGHT,
                );
                self.gpu
                    .as_mut()
                    .expect("built above")
                    .copy(target.pixel_buffer(), &buffer, plan)
                    .map_err(VirtualCameraSinkError::transient)?;
                match plan {
                    CopyPlan::Blit => self.counters.gpu_blits += 1,
                    CopyPlan::Draw { .. } => self.counters.gpu_draws += 1,
                }
            }
            VirtualCameraFrame::I420 { planes, .. } => {
                Self::fill_from_i420(&buffer, &planes.view())
                    .map_err(VirtualCameraSinkError::transient)?;
                self.counters.cpu_converts += 1;
            }
            VirtualCameraFrame::D3d11Texture { .. } => {
                return Err(VirtualCameraSinkError::transient(
                    "A Direct3D frame cannot reach the macOS camera.",
                ));
            }
        }
        let format = pool
            .format_for(&buffer)
            .map_err(VirtualCameraSinkError::transient)?;
        let mut timing = CMSampleTimingInfo {
            duration: frame_duration(),
            presentationTimeStamp: cmtime_nanos(self.pts.next(Self::host_nanos())),
            decodeTimeStamp: unsafe { kCMTimeInvalid },
        };
        let mut sample: *mut CMSampleBuffer = std::ptr::null_mut();
        let status = unsafe {
            CMSampleBuffer::create_for_image_buffer(
                None,
                &buffer,
                true,
                None,
                std::ptr::null_mut(),
                &format,
                NonNull::from(&mut timing),
                NonNull::from(&mut sample),
            )
        };
        let sample = NonNull::new(sample)
            .filter(|_| status == 0)
            .map(|ptr| unsafe { CFRetained::from_raw(ptr) })
            .ok_or_else(|| {
                VirtualCameraSinkError::transient(format!(
                    "Videorc Camera's sample buffer failed ({status})."
                ))
            })?;
        // The queue takes the +1 reference; the extension releases it once
        // consumed. On refusal the reference comes back here and drops.
        let raw = CFRetained::into_raw(sample);
        let status = unsafe { queue.enqueue(raw.cast()) };
        if status == 0 {
            self.enqueued += 1;
            self.in_flight.push_back(buffer);
            self.counters.in_flight_peak = self
                .counters
                .in_flight_peak
                .max(self.in_flight.len() as u64);
            return Ok(VirtualCameraPush::Pushed);
        }
        drop(unsafe { CFRetained::from_raw(raw) });
        if status == kCMSimpleQueueError_QueueIsFull {
            self.counters.queue_full += 1;
            return Ok(VirtualCameraPush::Dropped);
        }
        Err(VirtualCameraSinkError::transient(format!(
            "Videorc Camera's sink refused a frame ({status})."
        )))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_camera::{I420Planes, fit_rect};
    use std::sync::{Arc, Mutex};

    fn identifiers() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../apps/desktop/camera-extension/identifiers.json"
        ))
        .expect("identifiers.json is valid JSON")
    }

    #[test]
    fn the_constants_mirror_identifiers_json() {
        let ids = identifiers();
        assert_eq!(
            ids["customProperties"]["clientCount"].as_str().unwrap(),
            VIRTUAL_CAMERA_MACOS_CLIENT_COUNT_PROPERTY
        );
        assert_eq!(
            ids["customProperties"]["producerWord"].as_str().unwrap(),
            VIRTUAL_CAMERA_MACOS_PRODUCER_WORD_PROPERTY
        );
        let words: Vec<&str> = ids["producerWords"]
            .as_array()
            .unwrap()
            .iter()
            .map(|word| word.as_str().unwrap())
            .collect();
        assert_eq!(words, vec![PRODUCER_WORD_ON, PRODUCER_WORD_OFF]);
        assert_eq!(ids["format"]["fourcc"].as_str().unwrap(), "BGRA");
        assert_eq!(CAMERA_PIXEL_FORMAT, fourcc(b"BGRA"));
        assert_eq!(
            format!("{} Sink", ids["cameraName"].as_str().unwrap()),
            VIRTUAL_CAMERA_MACOS_SINK_STREAM_NAME
        );
    }

    #[test]
    fn four_char_codes_and_custom_property_names_decode() {
        assert_eq!(fourcc(b"glob"), 0x676C_6F62);
        assert_eq!(fourcc(b"dev#"), 0x6465_7623);
        assert_eq!(
            custom_property_address("4cc_vccc_glob_0000"),
            Some(CmioPropertyAddress {
                selector: fourcc(b"vccc"),
                scope: SCOPE_GLOBAL,
                element: 0,
            })
        );
        assert_eq!(
            custom_property_address("4cc_vcpw_outp_0003").map(|address| address.element),
            Some(3)
        );
        for bad in [
            "vccc_glob_0000",
            "4cc_vcc_glob_0000",
            "4cc_vccc_glob_0000_x",
            "4cc_vccc_glob_zero",
            "",
        ] {
            assert!(custom_property_address(bad).is_none(), "{bad}");
        }
        assert_eq!(os_status(CMIO_BAD_OBJECT), "'!obj' (560947818)");
        assert_eq!(os_status(kCMSimpleQueueError_QueueIsFull), "-12773");
    }

    fn stream(
        id: u32,
        direction: Option<u32>,
        name: Option<&str>,
        output_scope: bool,
    ) -> StreamInfo {
        StreamInfo {
            id,
            direction,
            name: name.map(str::to_string),
            output_scope,
        }
    }

    /// P0a measured direction 1 on the source stream and 0 on the sink; the
    /// position rule (OBS) is the last resort, never first.
    #[test]
    fn the_sink_stream_is_found_by_direction_then_name_then_output_scope_then_second() {
        let by_direction = vec![
            stream(9, Some(0), Some("Videorc Camera Sink"), false),
            stream(7, Some(1), Some("Videorc Camera"), false),
        ];
        assert_eq!(
            choose_sink_stream(&by_direction),
            Some((9, SinkStreamRule::Direction)),
            "the sink listed first is still the sink"
        );
        let named = vec![
            stream(7, None, Some("Videorc Camera"), false),
            stream(9, None, Some("Videorc Camera Sink"), false),
        ];
        assert_eq!(choose_sink_stream(&named), Some((9, SinkStreamRule::Name)));
        let two_sinks = vec![
            stream(7, Some(0), None, false),
            stream(9, Some(0), Some("Videorc Camera Sink"), false),
        ];
        assert_eq!(
            choose_sink_stream(&two_sinks),
            Some((9, SinkStreamRule::Name)),
            "two direction-0 streams settle nothing"
        );
        let scoped = vec![
            stream(3, Some(1), None, false),
            stream(4, None, None, true),
            stream(5, Some(1), None, false),
        ];
        assert_eq!(
            choose_sink_stream(&scoped),
            Some((4, SinkStreamRule::OutputScope))
        );
        let bare = vec![
            stream(3, Some(1), None, true),
            stream(4, Some(1), None, true),
        ];
        assert_eq!(
            choose_sink_stream(&bare),
            Some((4, SinkStreamRule::Second)),
            "two output-scope streams settle nothing; the second it is"
        );
        assert_eq!(
            choose_sink_stream(&bare[..1]),
            Some((3, SinkStreamRule::OutputScope)),
            "one stream in the output scope is the sink"
        );
        let lone = vec![stream(3, Some(1), None, false)];
        assert_eq!(choose_sink_stream(&lone), None, "a source alone is no sink");
        assert_eq!(choose_sink_stream(&[]), None);
        assert_eq!(SinkStreamRule::Direction.label(), "direction");
        assert_eq!(SinkStreamRule::Name.label(), "stream-name");
        assert_eq!(STREAM_DIRECTION_SINK, 0);
    }

    /// P0a: the extension passes the producer's IOSurface through to every
    /// client, so a buffer is recycled only after the callback counted it
    /// consumed and a margin of later frames went by; a stalled reader
    /// hits the cap and drops.
    #[test]
    fn in_flight_buffers_release_behind_the_consumed_count_with_a_margin() {
        // Nothing consumed yet: everything stays.
        assert_eq!(releasable(5, 5, 0, 3), 0);
        // Two consumed, three kept as the margin: 5 - (3 + 3) < 0, so none.
        assert_eq!(releasable(5, 5, 2, 3), 0);
        // Eight pushed, five consumed: keep 3 unconsumed + 3 margin.
        assert_eq!(releasable(8, 8, 5, 3), 2);
        // Everything consumed: only the margin stays.
        assert_eq!(releasable(10, 10, 10, 3), 7);
        // A margin of zero releases every consumed buffer.
        assert_eq!(releasable(10, 10, 10, 0), 10);
        // An over-count (more callbacks than pushes) never releases past the
        // margin of what is held.
        assert_eq!(releasable(4, 4, 9, 3), 1);
        assert_eq!(releasable(2, 4, 9, 3), 0);
        assert!(admits(0, IN_FLIGHT_CAP));
        assert!(admits(IN_FLIGHT_CAP - 1, IN_FLIGHT_CAP));
        assert!(!admits(IN_FLIGHT_CAP, IN_FLIGHT_CAP));
        const { assert!(IN_FLIGHT_CAP > 10, "well above the sink queue P0a measured") };
        assert!(POOL_ALLOCATION_THRESHOLD as usize > IN_FLIGHT_CAP);
        const { assert!(DISPLAY_MARGIN >= 1) };
    }

    #[test]
    fn the_client_count_decodes_from_a_number_a_string_or_a_raw_word() {
        assert_eq!(decode_client_count(&PropertyValue::Number(2)), Some(2));
        assert_eq!(decode_client_count(&PropertyValue::Number(-1)), None);
        assert_eq!(
            decode_client_count(&PropertyValue::Text(" 3 ".to_string())),
            Some(3)
        );
        assert_eq!(
            decode_client_count(&PropertyValue::Text("many".to_string())),
            None
        );
        assert_eq!(decode_client_count(&PropertyValue::Raw(0)), Some(0));
    }

    #[test]
    fn a_full_canvas_program_blits_and_anything_else_draws_into_the_fit() {
        let full = fit_rect(1920, 1080, 1920, 1080);
        assert_eq!(copy_plan(1920, 1080, full, 1920, 1080), CopyPlan::Blit);
        // A 4K program fits the canvas but is not it: scaled, so a draw.
        assert!(matches!(
            copy_plan(3840, 2160, full, 1920, 1080),
            CopyPlan::Draw { .. }
        ));
        let vertical = fit_rect(1080, 1920, 1920, 1080);
        assert_eq!((vertical.width, vertical.height), (608, 1080));
        let CopyPlan::Draw { vertices } = copy_plan(1080, 1920, vertical, 1920, 1080) else {
            panic!("a vertical program is drawn")
        };
        let x0 = 2.0 * vertical.x as f32 / 1920.0 - 1.0;
        let x1 = 2.0 * (vertical.x + vertical.width) as f32 / 1920.0 - 1.0;
        assert!((vertices[0][0] - x0).abs() < 1e-6 && (vertices[5][0] - x1).abs() < 1e-6);
        assert_eq!((vertices[0][1], vertices[5][1]), (1.0, -1.0), "full height");
        assert_eq!((vertices[0][2], vertices[0][3]), (0.0, 0.0));
        assert_eq!((vertices[5][2], vertices[5][3]), (1.0, 1.0));
        // The pillarbox is centred: as much bar on the left as on the right.
        assert!((x0 + x1).abs() < 1e-6);
        assert_eq!(
            fit_quad_vertices(FitRect::full(1920, 1080), 1920, 1080)[0],
            [-1.0, 1.0, 0.0, 0.0]
        );
    }

    #[test]
    fn the_pts_clock_is_monotonic_on_the_host_clock() {
        assert_eq!(cmtime_to_nanos(30, 30), Some(NANOS_PER_SECOND));
        assert_eq!(cmtime_to_nanos(1, 1_000_000_000), Some(1));
        assert_eq!(cmtime_to_nanos(5, 0), None);
        assert_eq!(cmtime_to_nanos(-5, 10), Some(0));
        let mut clock = PtsClock::default();
        assert_eq!(clock.next(1_000), 1_000);
        assert_eq!(clock.next(1_000), 1_001, "never the same time twice");
        assert_eq!(clock.next(900), 1_002, "never backwards");
        assert_eq!(clock.next(5_000), 5_000);
        let duration = frame_duration();
        assert_eq!((duration.value, duration.timescale), (1, 30));
        let pts = cmtime_nanos(7);
        assert_eq!((pts.value, pts.timescale), (7, NANOS_PER_SECOND as i32));
        assert!(pts.flags.contains(CMTimeFlags::Valid));
    }

    #[test]
    fn i420_converts_to_bgra_in_bt709_video_range() {
        let mut planes = I420Planes::black(4, 2);
        // Row 0: white, white (neutral chroma 0), red, red (chroma 1).
        // Row 1 shares the chroma row: its first pair stays black.
        planes.y[0] = 235;
        planes.y[1] = 235;
        let (ry, ru, rv) = crate::color::rgb_to_yuv_video_range_bt709(255, 0, 0);
        planes.y[2] = ry;
        planes.y[3] = ry;
        planes.u[1] = ru;
        planes.v[1] = rv;
        let stride = 4 * 4 + 8; // padded rows, as a CVPixelBuffer may have
        let mut dst = vec![0xAAu8; stride * 2];
        assert!(i420_to_bgra_rows(&planes.view(), &mut dst, stride));
        assert_eq!(&dst[0..4], &[255, 255, 255, 255], "white");
        assert_eq!(&dst[4..8], &[255, 255, 255, 255], "white");
        let red = &dst[8..12];
        assert!(red[2] >= 250 && red[1] <= 8 && red[0] <= 8, "red: {red:?}");
        assert_eq!(red[3], 255, "opaque");
        assert_eq!(dst[16], 0xAA, "the padding is untouched");
        assert_eq!(&dst[stride..stride + 4], &[0, 0, 0, 255], "row 1 black");
        // A short destination or a short stride is refused, never a panic.
        assert!(!i420_to_bgra_rows(&planes.view(), &mut dst[..8], stride));
        assert!(!i420_to_bgra_rows(&planes.view(), &mut dst, 8));
        // A round trip of a mid grey lands within rounding.
        let (gy, gu, gv) = crate::color::rgb_to_yuv_video_range_bt709(100, 150, 200);
        let mut one = I420Planes::black(2, 2);
        one.y.fill(gy);
        one.u.fill(gu);
        one.v.fill(gv);
        let mut out = vec![0u8; 16];
        assert!(i420_to_bgra_rows(&one.view(), &mut out, 8));
        assert!((i32::from(out[2]) - 100).abs() <= 3, "r {}", out[2]);
        assert!((i32::from(out[1]) - 150).abs() <= 3, "g {}", out[1]);
        assert!((i32::from(out[0]) - 200).abs() <= 3, "b {}", out[0]);
    }

    // --- the state machine over a fake transport ---

    #[derive(Debug)]
    struct FakeState {
        /// Each find hands out fresh ids, like CMIO after an extension restart.
        finds: u32,
        find_fails: Option<String>,
        open_fails: Option<String>,
        streams: Vec<StreamInfo>,
        opened: Vec<(u32, u32)>,
        closed: Vec<(u32, u32)>,
        words: Vec<(u32, String)>,
        word_fails: bool,
        viewers: Result<Option<u32>, String>,
        pushes: Vec<(u64, &'static str)>,
        push_result: Option<Result<VirtualCameraPush, VirtualCameraSinkError>>,
    }

    impl Default for FakeState {
        fn default() -> Self {
            Self {
                finds: 0,
                find_fails: None,
                open_fails: None,
                streams: Vec::new(),
                opened: Vec::new(),
                closed: Vec::new(),
                words: Vec::new(),
                word_fails: false,
                viewers: Ok(None),
                pushes: Vec::new(),
                push_result: None,
            }
        }
    }

    struct FakeTransport(Arc<Mutex<FakeState>>);

    impl CameraTransport for FakeTransport {
        fn find_device(&mut self) -> Result<u32, String> {
            let mut state = self.0.lock().unwrap();
            if let Some(error) = &state.find_fails {
                return Err(error.clone());
            }
            state.finds += 1;
            Ok(100 + state.finds)
        }

        fn list_streams(&mut self, device: u32) -> Result<Vec<StreamInfo>, String> {
            let state = self.0.lock().unwrap();
            Ok(state
                .streams
                .iter()
                .cloned()
                .map(|stream| StreamInfo {
                    id: device * 10 + stream.id,
                    ..stream
                })
                .collect())
        }

        fn open_sink(&mut self, device: u32, stream: u32) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            if let Some(error) = &state.open_fails {
                return Err(error.clone());
            }
            state.opened.push((device, stream));
            Ok(())
        }

        fn close_sink(&mut self, device: u32, stream: u32) {
            self.0.lock().unwrap().closed.push((device, stream));
        }

        fn write_producer_word(&mut self, device: u32, word: &str) -> Result<(), String> {
            let mut state = self.0.lock().unwrap();
            if state.word_fails {
                return Err("no property".to_string());
            }
            state.words.push((device, word.to_string()));
            Ok(())
        }

        fn read_client_count(&self, _device: u32) -> Result<Option<u32>, String> {
            self.0.lock().unwrap().viewers.clone()
        }

        fn enqueue(
            &mut self,
            frame: &VirtualCameraFrame<'_>,
            pts: VirtualCameraPts,
        ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
            let mut state = self.0.lock().unwrap();
            state.pushes.push((pts.tick, frame.kind()));
            state
                .push_result
                .clone()
                .unwrap_or(Ok(VirtualCameraPush::Pushed))
        }
    }

    fn two_streams() -> Vec<StreamInfo> {
        vec![
            stream(1, Some(1), Some("Videorc Camera"), false),
            stream(2, Some(0), Some("Videorc Camera Sink"), true),
        ]
    }

    fn sink() -> (CmioSink<FakeTransport>, Arc<Mutex<FakeState>>) {
        let state = Arc::new(Mutex::new(FakeState {
            streams: two_streams(),
            viewers: Ok(Some(0)),
            ..FakeState::default()
        }));
        (
            CmioSink::with_transport(FakeTransport(state.clone())),
            state,
        )
    }

    fn cpu_frame(planes: &I420Planes) -> VirtualCameraFrame<'_> {
        VirtualCameraFrame::I420 {
            planes,
            fit: FitRect::full(planes.width, planes.height),
        }
    }

    #[test]
    fn connect_finds_the_ids_opens_the_sink_and_says_on() {
        let (mut sink, state) = sink();
        assert_eq!(sink.label(), "cmio-sink");
        assert!(sink.sink_stream_rule().is_none());
        sink.connect().expect("connects");
        assert_eq!(sink.sink_stream_rule(), Some(SinkStreamRule::Direction));
        assert_eq!(sink.connects(), 1);
        {
            let state = state.lock().unwrap();
            assert_eq!(state.opened, vec![(101, 1012)]);
            assert_eq!(state.words, vec![(101, "on".to_string())]);
        }
        // Idempotent: a second connect touches nothing.
        sink.connect().expect("still connected");
        assert_eq!(state.lock().unwrap().opened.len(), 1);
        assert_eq!(sink.connects(), 1);
        assert_eq!(sink.viewers(), Some(0));
        state.lock().unwrap().viewers = Ok(Some(2));
        assert_eq!(sink.viewers(), Some(2));
        state.lock().unwrap().viewers = Ok(None);
        assert_eq!(sink.viewers(), None, "the extension cannot count");
    }

    #[test]
    fn off_stops_the_stream_then_writes_off_and_a_lost_device_writes_nothing() {
        let (mut sink, state) = sink();
        sink.connect().unwrap();
        sink.disconnect();
        {
            let state = state.lock().unwrap();
            assert_eq!(state.closed, vec![(101, 1012)]);
            assert_eq!(
                state.words,
                vec![(101, "on".to_string()), (101, "off".to_string())],
                "stop first, then the word, so the extension keeps it"
            );
        }
        // Disconnecting twice is harmless.
        sink.disconnect();
        assert_eq!(state.lock().unwrap().closed.len(), 1);

        // A push that lost the device: the engine disconnects; no "off".
        sink.connect().unwrap();
        state.lock().unwrap().push_result = Some(Err(VirtualCameraSinkError::disconnected("gone")));
        let planes = I420Planes::black(4, 2);
        let error = sink
            .push(&cpu_frame(&planes), VirtualCameraPts::for_tick(0, 30))
            .unwrap_err();
        assert!(error.disconnected);
        sink.disconnect();
        let state = state.lock().unwrap();
        assert_eq!(state.closed.len(), 2);
        assert_eq!(state.words.len(), 3, "on, off, on: no off after a loss");
        assert_eq!(state.words[2].1, "on");
    }

    /// D12: quitting with the switch on is not "off". The stream stops, no
    /// word is written, and the next launch connects afresh.
    #[test]
    fn exit_stops_the_stream_and_writes_no_word() {
        let (mut sink, state) = sink();
        sink.connect().unwrap();
        sink.disconnect_at_exit();
        {
            let state = state.lock().unwrap();
            assert_eq!(state.closed, vec![(101, 1012)]);
            assert_eq!(state.words, vec![(101, "on".to_string())], "no off");
        }
        assert!(sink.sink_stream_rule().is_none());
        sink.disconnect_at_exit();
        assert_eq!(state.lock().unwrap().closed.len(), 1, "idempotent");
        // A lost device, then exit: still nothing written, and a later
        // connect starts clean.
        sink.connect().unwrap();
        state.lock().unwrap().viewers = Err("gone".to_string());
        assert_eq!(sink.viewers(), None);
        sink.disconnect_at_exit();
        sink.connect().unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.words.len(), 3, "on, on, on");
        assert!(state.words.iter().all(|(_, word)| word == "on"));
    }

    #[test]
    fn every_reconnect_finds_fresh_ids() {
        let (mut sink, state) = sink();
        sink.connect().unwrap();
        sink.disconnect();
        sink.connect().unwrap();
        assert_eq!(sink.connects(), 2);
        let state = state.lock().unwrap();
        assert_eq!(state.opened, vec![(101, 1012), (102, 1022)]);
    }

    #[test]
    fn a_failed_find_open_or_missing_sink_disconnects_with_plain_copy() {
        let (mut sink, state) = sink();
        state.lock().unwrap().find_fails = Some("No Videorc Camera device.".to_string());
        let error = sink.connect().unwrap_err();
        assert!(error.disconnected);
        assert_eq!(error.message, "No Videorc Camera device.");
        state.lock().unwrap().find_fails = None;
        state.lock().unwrap().open_fails = Some("would not start".to_string());
        assert_eq!(sink.connect().unwrap_err().message, "would not start");
        state.lock().unwrap().open_fails = None;
        state.lock().unwrap().streams = two_streams()[..1].to_vec();
        assert_eq!(
            sink.connect().unwrap_err().message,
            "Videorc Camera has no sink stream to push into."
        );
        assert!(sink.sink_stream_rule().is_none());
        assert_eq!(sink.connects(), 0);
        // A missing producer-word property is not fatal.
        state.lock().unwrap().streams = two_streams();
        state.lock().unwrap().word_fails = true;
        sink.connect().expect("connects without the word");
        assert!(state.lock().unwrap().words.is_empty());
    }

    #[test]
    fn pushes_reach_the_transport_and_a_full_queue_is_a_drop() {
        let (mut sink, state) = sink();
        let planes = I420Planes::black(4, 2);
        let before = sink
            .push(&cpu_frame(&planes), VirtualCameraPts::for_tick(0, 30))
            .unwrap_err();
        assert!(before.disconnected);
        sink.connect().unwrap();
        assert_eq!(
            sink.push(&cpu_frame(&planes), VirtualCameraPts::for_tick(3, 30)),
            Ok(VirtualCameraPush::Pushed)
        );
        state.lock().unwrap().push_result = Some(Ok(VirtualCameraPush::Dropped));
        assert_eq!(
            sink.push(&cpu_frame(&planes), VirtualCameraPts::for_tick(4, 30)),
            Ok(VirtualCameraPush::Dropped)
        );
        assert!(sink.connection.is_some(), "a drop never disconnects");
        let state = state.lock().unwrap();
        assert_eq!(state.pushes, vec![(3, "i420"), (4, "i420")]);
    }

    #[test]
    fn a_vanished_device_seen_by_the_viewer_read_fails_the_next_push() {
        let (mut sink, state) = sink();
        sink.connect().unwrap();
        state.lock().unwrap().viewers = Err("Videorc Camera's device is gone.".to_string());
        assert_eq!(sink.viewers(), None, "unknown keeps the demand");
        let planes = I420Planes::black(4, 2);
        let error = sink
            .push(&cpu_frame(&planes), VirtualCameraPts::for_tick(1, 30))
            .unwrap_err();
        assert!(error.disconnected);
        assert_eq!(error.message, "Videorc Camera's device is gone.");
        assert!(
            state.lock().unwrap().pushes.is_empty(),
            "nothing was pushed"
        );
        sink.disconnect();
        assert_eq!(
            state.lock().unwrap().words.len(),
            1,
            "lost, so no off was written"
        );
        // The engine reconnects with fresh ids and the word comes back on.
        state.lock().unwrap().viewers = Ok(Some(1));
        sink.connect().unwrap();
        assert_eq!(sink.viewers(), Some(1));
        assert_eq!(state.lock().unwrap().words[1], (102, "on".to_string()));
        let _ = sink.transport();
    }

    /// Lab aid, not a gate: `cargo test -p videorc-backend -- --ignored
    /// cmio_lists` prints what CoreMediaIO shows this process (plan 214 P0a
    /// step 5: whether a bare binary sees the extension's device).
    #[test]
    #[ignore = "reads the host's CoreMediaIO devices"]
    fn cmio_lists_devices_and_the_videorc_camera_streams() {
        let devices = SystemCmio::list_devices().expect("CoreMediaIO lists devices");
        for device in &devices {
            eprintln!(
                "device {}: {:?} uid {:?}",
                device.id, device.name, device.uid
            );
        }
        let mut transport = SystemCmio::new();
        match transport.find_device() {
            Ok(device) => {
                let streams = transport.list_streams(device).expect("streams");
                for stream in &streams {
                    eprintln!("  stream {stream:?}");
                }
                eprintln!("  sink: {:?}", choose_sink_stream(&streams));
                eprintln!("  viewers: {:?}", transport.read_client_count(device));
            }
            Err(error) => eprintln!("no Videorc Camera: {error}"),
        }
    }
}
