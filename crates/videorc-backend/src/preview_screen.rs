use std::sync::{Arc, Mutex as StdMutex, mpsc as std_mpsc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use uuid::Uuid;

use crate::protocol::{
    PreviewScreenSourceKind, PreviewScreenStartParams, PreviewScreenState, PreviewScreenStatus,
    VideoSettings,
};
use crate::screen_capture::{parse_screencapturekit_display_id, parse_screencapturekit_window_id};
use crate::state::AppState;

const PREVIEW_SCREEN_MAX_PNG_WIDTH: u32 = 960;
const PREVIEW_SCREEN_MAX_CAPTURE_WIDTH: u32 = 2560;
const PREVIEW_SCREEN_MAX_CAPTURE_HEIGHT: u32 = 1440;

pub type PreviewScreenSlot = Arc<tokio::sync::Mutex<PreviewScreenRuntime>>;

#[derive(Debug)]
pub struct PreviewScreenRuntime {
    pub status: PreviewScreenStatus,
    run_id: Option<String>,
    active: Option<NativeScreenPreviewThread>,
    poll_task: Option<JoinHandle<()>>,
}

#[derive(Debug)]
struct NativeScreenPreviewThread {
    stop_tx: std_mpsc::Sender<()>,
    join_handle: Option<thread::JoinHandle<()>>,
    shared: Arc<StdMutex<PreviewScreenShared>>,
}

#[derive(Debug, Clone)]
pub struct PreviewScreenFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub pixel_format: PreviewScreenPixelFormat,
    pub bytes: Vec<u8>,
    pub captured_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewScreenPixelFormat {
    Bgra8,
}

#[derive(Debug, Default)]
pub struct PreviewScreenShared {
    latest_frame: Option<PreviewScreenFrame>,
    frames_captured: u64,
    dropped_frames: u64,
    frames_in_window: u64,
    window_started_at: Option<Instant>,
    source_fps: Option<f64>,
    last_error: Option<String>,
}

pub fn initial_preview_screen_state() -> PreviewScreenRuntime {
    PreviewScreenRuntime {
        status: idle_status(Some("Native screen preview is not running.".to_string())),
        run_id: None,
        active: None,
        poll_task: None,
    }
}

pub async fn start_preview_screen(
    state: AppState,
    params: PreviewScreenStartParams,
) -> PreviewScreenStatus {
    stop_current_screen(&state).await;

    let Some(source) = selected_screen_source(&params) else {
        let status = status_for_missing_source(None, None, "No screen or window source is selected.");
        set_screen_status(&state, status.clone()).await;
        return status;
    };

    let run_id = Uuid::new_v4().to_string();
    let target_fps = params.video.fps.clamp(1, 120);
    let include_cursor = true;
    let exclude_current_process_windows = true;
    let shared = Arc::new(StdMutex::new(PreviewScreenShared::default()));
    let (stop_tx, stop_rx) = std_mpsc::channel();
    let (startup_tx, startup_rx) = std_mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    let thread_config = NativeScreenPreviewConfig {
        source_id: source.source_id.clone(),
        source_kind: source.source_kind.clone(),
        display_id: source.display_id,
        window_id: source.window_id,
        video: params.video.clone(),
        include_cursor,
        exclude_current_process_windows,
    };

    let starting = PreviewScreenStatus {
        state: PreviewScreenState::Starting,
        source_id: Some(source.source_id.clone()),
        source_kind: Some(source.source_kind.clone()),
        target_fps,
        width: None,
        height: None,
        source_fps: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor,
        exclude_current_process_windows,
        updated_at: Utc::now().to_rfc3339(),
        message: Some("Starting native screen preview.".to_string()),
    };
    set_screen_status(&state, starting).await;

    let join_handle = thread::Builder::new()
        .name("videorc-preview-screen".to_string())
        .spawn(move || run_native_screen_preview(thread_config, thread_shared, stop_rx, startup_tx));

    let join_handle = match join_handle {
        Ok(join_handle) => join_handle,
        Err(error) => {
            let status = failed_status(
                Some(source.source_id),
                Some(source.source_kind),
                target_fps,
                include_cursor,
                exclude_current_process_windows,
                format!("Could not start screen preview thread: {error}"),
            );
            set_screen_status(&state, status.clone()).await;
            return status;
        }
    };

    let startup = tokio::task::spawn_blocking(move || {
        startup_rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| {
            NativeScreenStartup::Failed("Timed out while starting native screen preview.".to_string())
        })
    })
    .await
    .unwrap_or_else(|error| {
        NativeScreenStartup::Failed(format!("Screen startup task failed: {error}"))
    });

    match startup {
        NativeScreenStartup::Live {
            width,
            height,
            selected_fps,
            message,
        } => {
            let poll_task = tokio::spawn(poll_screen_metrics(
                state.clone(),
                run_id.clone(),
                Arc::clone(&shared),
                target_fps,
            ));
            let status = PreviewScreenStatus {
                state: PreviewScreenState::Live,
                source_id: Some(source.source_id),
                source_kind: Some(source.source_kind),
                target_fps,
                width: Some(width),
                height: Some(height),
                source_fps: Some(selected_fps),
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                include_cursor,
                exclude_current_process_windows,
                updated_at: Utc::now().to_rfc3339(),
                message,
            };
            {
                let mut slot = state.preview_screen.lock().await;
                slot.status = status.clone();
                slot.run_id = Some(run_id);
                slot.active = Some(NativeScreenPreviewThread {
                    stop_tx,
                    join_handle: Some(join_handle),
                    shared,
                });
                slot.poll_task = Some(poll_task);
            }
            state.emit_event("preview.screen.status", status.clone());
            status
        }
        NativeScreenStartup::PermissionNeeded(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = PreviewScreenStatus {
                state: PreviewScreenState::PermissionNeeded,
                source_id: Some(source.source_id),
                source_kind: Some(source.source_kind),
                target_fps,
                width: None,
                height: None,
                source_fps: None,
                frames_captured: 0,
                dropped_frames: 0,
                sequence: None,
                include_cursor,
                exclude_current_process_windows,
                updated_at: Utc::now().to_rfc3339(),
                message: Some(message),
            };
            set_screen_status(&state, status.clone()).await;
            status
        }
        NativeScreenStartup::SourceMissing(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = status_for_missing_source(
                Some(source.source_id),
                Some(source.source_kind),
                &message,
            );
            set_screen_status(&state, status.clone()).await;
            status
        }
        NativeScreenStartup::Failed(message) => {
            let _ = stop_tx.send(());
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
            let status = failed_status(
                Some(source.source_id),
                Some(source.source_kind),
                target_fps,
                include_cursor,
                exclude_current_process_windows,
                message,
            );
            set_screen_status(&state, status.clone()).await;
            status
        }
    }
}

pub async fn stop_preview_screen(state: &AppState) -> PreviewScreenStatus {
    stop_current_screen(state).await;
    let status = idle_status(Some("Native screen preview stopped.".to_string()));
    set_screen_status(state, status.clone()).await;
    status
}

pub async fn preview_screen_status(state: &AppState) -> PreviewScreenStatus {
    state.preview_screen.lock().await.status.clone()
}

pub async fn latest_preview_screen_png(state: &AppState) -> Option<Vec<u8>> {
    let frame = {
        let slot = state.preview_screen.lock().await;
        let active = slot.active.as_ref()?;
        let guard = active
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.latest_frame.clone()?
    };

    let mut rgba = Vec::with_capacity(frame.bytes.len());
    for pixel in frame.bytes.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    let (rgba, width, height) =
        downscale_rgba_for_preview(rgba, frame.width, frame.height, PREVIEW_SCREEN_MAX_PNG_WIDTH);

    let mut png = Vec::new();
    let encoder = PngEncoder::new(&mut png);
    encoder
        .write_image(
            &rgba,
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(png)
}

#[derive(Debug, Clone)]
struct SelectedScreenSource {
    source_id: String,
    source_kind: PreviewScreenSourceKind,
    display_id: Option<u32>,
    window_id: Option<u32>,
}

fn selected_screen_source(params: &PreviewScreenStartParams) -> Option<SelectedScreenSource> {
    if let Some(window_id) = params.sources.window_id.clone() {
        return parse_screencapturekit_window_id(&window_id).map(|native_window_id| {
            SelectedScreenSource {
                source_id: window_id,
                source_kind: PreviewScreenSourceKind::Window,
                display_id: None,
                window_id: Some(native_window_id),
            }
        });
    }

    if let Some(screen_id) = params.sources.screen_id.clone() {
        return parse_screencapturekit_display_id(&screen_id).map(|native_display_id| {
            SelectedScreenSource {
                source_id: screen_id,
                source_kind: PreviewScreenSourceKind::Screen,
                display_id: Some(native_display_id),
                window_id: None,
            }
        });
    }

    None
}

async fn set_screen_status(state: &AppState, status: PreviewScreenStatus) {
    {
        let mut slot = state.preview_screen.lock().await;
        slot.status = status.clone();
        slot.run_id = None;
    }
    state.emit_event("preview.screen.status", status);
}

async fn stop_current_screen(state: &AppState) {
    let (previous, poll_task) = {
        let mut slot = state.preview_screen.lock().await;
        slot.run_id = None;
        (slot.active.take(), slot.poll_task.take())
    };

    if let Some(task) = poll_task {
        task.abort();
    }

    if let Some(mut previous) = previous {
        let _ = previous.stop_tx.send(());
        if let Some(join_handle) = previous.join_handle.take() {
            let _ = tokio::task::spawn_blocking(move || join_handle.join()).await;
        }
    }
}

async fn poll_screen_metrics(
    state: AppState,
    run_id: String,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    target_fps: u32,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        let snapshot = {
            let guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            ScreenSharedSnapshot {
                frames_captured: guard.frames_captured,
                dropped_frames: guard.dropped_frames,
                source_fps: guard.source_fps,
                latest_frame: guard.latest_frame.clone(),
                last_error: guard.last_error.clone(),
            }
        };

        let status = {
            let mut slot = state.preview_screen.lock().await;
            if slot.run_id.as_deref() != Some(run_id.as_str()) {
                break;
            }
            slot.status.frames_captured = snapshot.frames_captured;
            slot.status.dropped_frames = snapshot.dropped_frames;
            slot.status.source_fps = snapshot.source_fps.or(Some(f64::from(target_fps)));
            if let Some(frame) = snapshot.latest_frame {
                slot.status.state = PreviewScreenState::Live;
                slot.status.width = Some(frame.width);
                slot.status.height = Some(frame.height);
                slot.status.sequence = Some(frame.sequence);
                let _frame_bytes = frame.bytes.len();
                let _frame_age = frame.captured_at.elapsed();
                match frame.pixel_format {
                    PreviewScreenPixelFormat::Bgra8 => {}
                }
            }
            if let Some(error) = snapshot.last_error {
                slot.status.state = PreviewScreenState::Failed;
                slot.status.message = Some(error);
            }
            slot.status.updated_at = Utc::now().to_rfc3339();
            slot.status.clone()
        };
        state.emit_event("preview.screen.status", status);
    }
}

#[derive(Debug)]
struct ScreenSharedSnapshot {
    frames_captured: u64,
    dropped_frames: u64,
    source_fps: Option<f64>,
    latest_frame: Option<PreviewScreenFrame>,
    last_error: Option<String>,
}

fn idle_status(message: Option<String>) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::SourceMissing,
        source_id: None,
        source_kind: None,
        target_fps: 0,
        width: None,
        height: None,
        source_fps: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor: true,
        exclude_current_process_windows: true,
        updated_at: Utc::now().to_rfc3339(),
        message,
    }
}

fn status_for_missing_source(
    source_id: Option<String>,
    source_kind: Option<PreviewScreenSourceKind>,
    message: &str,
) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::SourceMissing,
        source_id,
        source_kind,
        target_fps: 0,
        width: None,
        height: None,
        source_fps: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor: true,
        exclude_current_process_windows: true,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message.to_string()),
    }
}

fn failed_status(
    source_id: Option<String>,
    source_kind: Option<PreviewScreenSourceKind>,
    target_fps: u32,
    include_cursor: bool,
    exclude_current_process_windows: bool,
    message: String,
) -> PreviewScreenStatus {
    PreviewScreenStatus {
        state: PreviewScreenState::Failed,
        source_id,
        source_kind,
        target_fps,
        width: None,
        height: None,
        source_fps: None,
        frames_captured: 0,
        dropped_frames: 0,
        sequence: None,
        include_cursor,
        exclude_current_process_windows,
        updated_at: Utc::now().to_rfc3339(),
        message: Some(message),
    }
}

fn downscale_rgba_for_preview(
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    max_width: u32,
) -> (Vec<u8>, u32, u32) {
    if width <= max_width || width == 0 || height == 0 {
        return (bytes, width, height);
    }

    let next_width = max_width.max(1);
    let next_height = ((u64::from(height) * u64::from(next_width)) / u64::from(width))
        .clamp(1, u64::from(u32::MAX)) as u32;
    let mut next = vec![0; next_width as usize * next_height as usize * 4];
    let width_usize = width as usize;
    let height_usize = height as usize;

    for y in 0..next_height as usize {
        let source_y = (y * height_usize / next_height as usize).min(height_usize - 1);
        for x in 0..next_width as usize {
            let source_x = (x * width_usize / next_width as usize).min(width_usize - 1);
            let source = (source_y * width_usize + source_x) * 4;
            let target = (y * next_width as usize + x) * 4;
            next[target..target + 4].copy_from_slice(&bytes[source..source + 4]);
        }
    }

    (next, next_width, next_height)
}

#[derive(Clone)]
struct NativeScreenPreviewConfig {
    source_id: String,
    source_kind: PreviewScreenSourceKind,
    display_id: Option<u32>,
    window_id: Option<u32>,
    video: VideoSettings,
    include_cursor: bool,
    exclude_current_process_windows: bool,
}

#[derive(Debug)]
enum NativeScreenStartup {
    Live {
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    },
    PermissionNeeded(String),
    SourceMissing(String),
    Failed(String),
}

fn run_native_screen_preview(
    config: NativeScreenPreviewConfig,
    shared: Arc<StdMutex<PreviewScreenShared>>,
    stop_rx: std_mpsc::Receiver<()>,
    startup_tx: std_mpsc::Sender<NativeScreenStartup>,
) {
    #[cfg(target_os = "macos")]
    macos::run_native_screen_preview(config, shared, stop_rx, startup_tx);

    #[cfg(not(target_os = "macos"))]
    {
        let _ = config;
        let _ = shared;
        let _ = stop_rx;
        let _ = startup_tx.send(NativeScreenStartup::Failed(
            "Native screen preview is only available on macOS.".to_string(),
        ));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::slice;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_core_media::{CMSampleBuffer, CMTime};
    use objc2_core_video::{
        CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
        CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
        CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelFormatType_32BGRA,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCDisplay, SCFrameStatus, SCShareableContent, SCStream,
        SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
    };

    use super::*;

    struct ScreenDelegateIvars {
        shared: Arc<StdMutex<PreviewScreenShared>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[ivars = ScreenDelegateIvars]
        struct ScreenPreviewDelegate;

        unsafe impl NSObjectProtocol for ScreenPreviewDelegate {}

        unsafe impl SCStreamOutput for ScreenPreviewDelegate {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            fn stream_did_output_sample_buffer(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                output_type: SCStreamOutputType,
            ) {
                if output_type != SCStreamOutputType::Screen {
                    return;
                }
                copy_sample_buffer(sample_buffer, &self.ivars().shared);
            }
        }

        unsafe impl SCStreamDelegate for ScreenPreviewDelegate {
            #[unsafe(method(stream:didStopWithError:))]
            fn stream_did_stop_with_error(&self, _stream: &SCStream, error: &NSError) {
                let description = error.localizedDescription();
                let mut guard = self
                    .ivars()
                    .shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.last_error = Some(format!(
                    "ScreenCaptureKit stream stopped: {}",
                    ns_string_to_string(&description)
                        .unwrap_or_else(|| "unknown error".to_string())
                ));
            }
        }
    );

    impl ScreenPreviewDelegate {
        fn new(shared: Arc<StdMutex<PreviewScreenShared>>) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(ScreenDelegateIvars { shared });
            unsafe { msg_send![super(delegate), init] }
        }
    }

    pub fn run_native_screen_preview(
        config: NativeScreenPreviewConfig,
        shared: Arc<StdMutex<PreviewScreenShared>>,
        stop_rx: std_mpsc::Receiver<()>,
        startup_tx: std_mpsc::Sender<NativeScreenStartup>,
    ) {
        autoreleasepool(|_| {
            match start_stream(config, Arc::clone(&shared)) {
                Ok(session) => {
                    let _ = startup_tx.send(NativeScreenStartup::Live {
                        width: session.width,
                        height: session.height,
                        selected_fps: session.selected_fps,
                        message: session.message,
                    });
                    let _ = stop_rx.recv();
                    stop_stream(&session.stream);
                    unsafe {
                        let _ = session.stream.removeStreamOutput_type_error(
                            ProtocolObject::from_ref(&*session.delegate),
                            SCStreamOutputType::Screen,
                        );
                    }
                }
                Err(error) => {
                    let _ = startup_tx.send(error);
                }
            }
        });
    }

    struct ScreenSession {
        stream: Retained<SCStream>,
        delegate: Retained<ScreenPreviewDelegate>,
        _filter: Retained<SCContentFilter>,
        _configuration: Retained<SCStreamConfiguration>,
        _queue: dispatch2::DispatchRetained<DispatchQueue>,
        width: u32,
        height: u32,
        selected_fps: f64,
        message: Option<String>,
    }

    fn start_stream(
        config: NativeScreenPreviewConfig,
        shared: Arc<StdMutex<PreviewScreenShared>>,
    ) -> Result<ScreenSession, NativeScreenStartup> {
        let content = load_shareable_content()?;
        let selected = select_content(&content, &config)?;
        let output_size = choose_preview_dimensions(
            selected.source_width,
            selected.source_height,
            &config.video,
        );
        let stream_config = unsafe { SCStreamConfiguration::new() };
        configure_stream(&stream_config, output_size, &config);
        let delegate = ScreenPreviewDelegate::new(shared);
        let delegate_protocol = ProtocolObject::from_ref(&*delegate);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &selected.filter,
                &stream_config,
                Some(delegate_protocol),
            )
        };
        let queue = DispatchQueue::new("com.videorc.preview.screen", None);

        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*delegate),
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
                .map_err(|error| {
                    NativeScreenStartup::Failed(format!(
                        "Could not attach ScreenCaptureKit output: {}",
                        ns_error_description(&error)
                    ))
                })?;
        }
        start_capture(&stream)?;

        let selected_fps = f64::from(config.video.fps.clamp(1, 120));
        let message = Some(format!(
            "Native {} preview running at {}x{} and {:.0} fps. Cursor {}, Videorc windows excluded {}.",
            match config.source_kind {
                PreviewScreenSourceKind::Screen => "screen",
                PreviewScreenSourceKind::Window => "window",
            },
            output_size.0,
            output_size.1,
            selected_fps,
            if config.include_cursor { "visible" } else { "hidden" },
            if config.exclude_current_process_windows { "yes" } else { "no" }
        ));

        Ok(ScreenSession {
            stream,
            delegate,
            _filter: selected.filter,
            _configuration: stream_config,
            _queue: queue,
            width: output_size.0,
            height: output_size.1,
            selected_fps,
            message,
        })
    }

    struct SelectedContent {
        filter: Retained<SCContentFilter>,
        source_width: u32,
        source_height: u32,
    }

    fn select_content(
        content: &SCShareableContent,
        config: &NativeScreenPreviewConfig,
    ) -> Result<SelectedContent, NativeScreenStartup> {
        match config.source_kind {
            PreviewScreenSourceKind::Screen => {
                let display_id = config.display_id.ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "Screen source is not a ScreenCaptureKit display: {}",
                        config.source_id
                    ))
                })?;
                let display = find_display(content, display_id).ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit display is missing: {}",
                        config.source_id
                    ))
                })?;
                let excluded = if config.exclude_current_process_windows {
                    videorc_windows(content)
                } else {
                    NSArray::<SCWindow>::new()
                };
                let filter = unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &excluded,
                    )
                };
                Ok(SelectedContent {
                    source_width: positive_u32(unsafe { display.width() }),
                    source_height: positive_u32(unsafe { display.height() }),
                    filter,
                })
            }
            PreviewScreenSourceKind::Window => {
                let window_id = config.window_id.ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "Window source is not a ScreenCaptureKit window: {}",
                        config.source_id
                    ))
                })?;
                let window = find_window(content, window_id).ok_or_else(|| {
                    NativeScreenStartup::SourceMissing(format!(
                        "ScreenCaptureKit window is missing: {}",
                        config.source_id
                    ))
                })?;
                let frame = unsafe { window.frame() };
                let filter = unsafe {
                    SCContentFilter::initWithDesktopIndependentWindow(
                        SCContentFilter::alloc(),
                        &window,
                    )
                };
                Ok(SelectedContent {
                    source_width: frame.size.width.round().max(1.0) as u32,
                    source_height: frame.size.height.round().max(1.0) as u32,
                    filter,
                })
            }
        }
    }

    fn load_shareable_content() -> Result<Retained<SCShareableContent>, NativeScreenStartup> {
        enum ShareableContentResult {
            Content(usize),
            Error(String),
        }

        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !error.is_null() {
                    ShareableContentResult::Error(error_description(error))
                } else if content.is_null() {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit returned no shareable content.".to_string(),
                    )
                } else if let Some(retained) = unsafe { Retained::retain(content) } {
                    ShareableContentResult::Content(Retained::into_raw(retained) as usize)
                } else {
                    ShareableContentResult::Error(
                        "ScreenCaptureKit shareable content could not be retained.".to_string(),
                    )
                };
                let _ = tx.send(result);
            },
        );

        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true, true, &handler,
            );
        }

        match rx.recv_timeout(Duration::from_secs(4)) {
            Ok(ShareableContentResult::Content(raw)) => {
                let content = unsafe { Retained::from_raw(raw as *mut SCShareableContent) }
                    .ok_or_else(|| {
                        NativeScreenStartup::Failed(
                            "ScreenCaptureKit shareable content pointer was invalid.".to_string(),
                        )
                    })?;
                Ok(content)
            }
            Ok(ShareableContentResult::Error(error)) => {
                if is_permission_error(&error) {
                    Err(NativeScreenStartup::PermissionNeeded(error))
                } else {
                    Err(NativeScreenStartup::Failed(error))
                }
            }
            Err(_) => Err(NativeScreenStartup::Failed(
                "ScreenCaptureKit source discovery timed out.".to_string(),
            )),
        }
    }

    fn configure_stream(
        stream_config: &SCStreamConfiguration,
        output_size: (u32, u32),
        config: &NativeScreenPreviewConfig,
    ) {
        unsafe {
            stream_config.setWidth(output_size.0 as usize);
            stream_config.setHeight(output_size.1 as usize);
            stream_config.setPixelFormat(kCVPixelFormatType_32BGRA);
            stream_config.setMinimumFrameInterval(CMTime::new(1, config.video.fps.clamp(1, 120) as i32));
            stream_config.setQueueDepth(3);
            stream_config.setShowsCursor(config.include_cursor);
            stream_config.setScalesToFit(config.source_kind == PreviewScreenSourceKind::Window);
            stream_config.setPreservesAspectRatio(true);
            stream_config.setCapturesAudio(false);
            stream_config.setCaptureMicrophone(false);
        }
    }

    fn start_capture(stream: &SCStream) -> Result<(), NativeScreenStartup> {
        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(if error.is_null() {
                Ok(())
            } else {
                Err(error_description(error))
            });
        });

        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&handler));
        }

        match rx.recv_timeout(Duration::from_secs(4)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) if is_permission_error(&error) => {
                Err(NativeScreenStartup::PermissionNeeded(error))
            }
            Ok(Err(error)) => Err(NativeScreenStartup::Failed(format!(
                "ScreenCaptureKit stream failed to start: {error}"
            ))),
            Err(_) => Err(NativeScreenStartup::Failed(
                "ScreenCaptureKit stream start timed out.".to_string(),
            )),
        }
    }

    fn stop_stream(stream: &SCStream) {
        let (tx, rx) = std_mpsc::channel();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        unsafe {
            stream.stopCaptureWithCompletionHandler(Some(&handler));
        }
        let _ = rx.recv_timeout(Duration::from_secs(2));
    }

    fn copy_sample_buffer(
        sample_buffer: &CMSampleBuffer,
        shared: &Arc<StdMutex<PreviewScreenShared>>,
    ) {
        if !sample_buffer_is_complete(sample_buffer) {
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let Some(pixel_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        };

        let pixel_format = CVPixelBufferGetPixelFormatType(&pixel_buffer);
        if pixel_format != kCVPixelFormatType_32BGRA {
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let lock_result = unsafe {
            CVPixelBufferLockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
        };
        if lock_result != 0 {
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let width = CVPixelBufferGetWidth(&pixel_buffer) as u32;
        let height = CVPixelBufferGetHeight(&pixel_buffer) as u32;
        let bytes_per_row = CVPixelBufferGetBytesPerRow(&pixel_buffer);
        let base_address = CVPixelBufferGetBaseAddress(&pixel_buffer);

        if base_address.is_null() || width == 0 || height == 0 {
            unsafe {
                CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
            };
            let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.dropped_frames = guard.dropped_frames.saturating_add(1);
            return;
        }

        let width_usize = width as usize;
        let height_usize = height as usize;
        let row_bytes = width_usize * 4;
        let mut bytes = vec![0; row_bytes * height_usize];
        unsafe {
            let source = base_address.cast::<u8>();
            for row in 0..height_usize {
                let source_row = source.add(row * bytes_per_row);
                let target_row = &mut bytes[row * row_bytes..(row + 1) * row_bytes];
                target_row.copy_from_slice(slice::from_raw_parts(source_row, row_bytes));
            }
            CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
        }

        let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        guard.frames_captured = guard.frames_captured.saturating_add(1);
        guard.frames_in_window = guard.frames_in_window.saturating_add(1);
        let window_started = *guard.window_started_at.get_or_insert(now);
        let elapsed = window_started.elapsed();
        if elapsed >= Duration::from_millis(500) {
            guard.source_fps = Some(guard.frames_in_window as f64 / elapsed.as_secs_f64().max(0.001));
            guard.frames_in_window = 0;
            guard.window_started_at = Some(now);
        }
        guard.latest_frame = Some(PreviewScreenFrame {
            sequence: guard.frames_captured,
            width,
            height,
            pixel_format: PreviewScreenPixelFormat::Bgra8,
            bytes,
            captured_at: now,
        });
    }

    fn sample_buffer_is_complete(_sample_buffer: &CMSampleBuffer) -> bool {
        let _ = SCFrameStatus::Complete;
        true
    }

    fn find_display(content: &SCShareableContent, display_id: u32) -> Option<Retained<SCDisplay>> {
        let displays = unsafe { content.displays() };
        for index in 0..displays.count() {
            let display = displays.objectAtIndex(index);
            if unsafe { display.displayID() } == display_id {
                return Some(display);
            }
        }
        None
    }

    fn find_window(content: &SCShareableContent, window_id: u32) -> Option<Retained<SCWindow>> {
        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            if unsafe { window.windowID() } == window_id {
                return Some(window);
            }
        }
        None
    }

    fn videorc_windows(content: &SCShareableContent) -> Retained<NSArray<SCWindow>> {
        let mut excluded = NSArray::<SCWindow>::new();
        let windows = unsafe { content.windows() };
        for index in 0..windows.count() {
            let window = windows.objectAtIndex(index);
            if is_videorc_window(&window) {
                excluded = excluded.arrayByAddingObject(&window);
            }
        }
        excluded
    }

    fn is_videorc_window(window: &SCWindow) -> bool {
        let current_pid = unsafe { libc::getpid() };
        let app = unsafe { window.owningApplication() };
        let app_name = app
            .as_ref()
            .and_then(|app| {
                let name = unsafe { app.applicationName() };
                ns_string_to_string(&name)
            })
            .unwrap_or_default()
            .to_lowercase();
        let title = unsafe { window.title() }
            .as_ref()
            .and_then(|title| ns_string_to_string(title))
            .unwrap_or_default()
            .to_lowercase();
        let process_id_matches = app
            .as_ref()
            .map(|app| unsafe { app.processID() } == current_pid)
            .unwrap_or(false);

        process_id_matches || app_name.contains("videorc") || title.contains("videorc")
    }

    fn choose_preview_dimensions(
        source_width: u32,
        source_height: u32,
        video: &VideoSettings,
    ) -> (u32, u32) {
        let source_width = source_width.max(1);
        let source_height = source_height.max(1);
        let max_width = video.width.clamp(1, PREVIEW_SCREEN_MAX_CAPTURE_WIDTH);
        let max_height = video.height.clamp(1, PREVIEW_SCREEN_MAX_CAPTURE_HEIGHT);
        let scale = (f64::from(max_width) / f64::from(source_width))
            .min(f64::from(max_height) / f64::from(source_height))
            .clamp(0.001, 1.0);
        let width = (f64::from(source_width) * scale).round().max(1.0) as u32;
        let height = (f64::from(source_height) * scale).round().max(1.0) as u32;
        (width, height)
    }

    fn positive_u32(value: isize) -> u32 {
        value.max(1) as u32
    }

    fn is_permission_error(error: &str) -> bool {
        let normalized = error.to_lowercase();
        normalized.contains("permission")
            || normalized.contains("denied")
            || normalized.contains("not authorized")
            || normalized.contains("tcc")
            || normalized.contains("declined")
    }

    fn error_description(error: *mut NSError) -> String {
        if error.is_null() {
            return "Unknown ScreenCaptureKit error.".to_string();
        }
        ns_error_description(unsafe { &*error })
    }

    fn ns_error_description(error: &NSError) -> String {
        let description = error.localizedDescription();
        ns_string_to_string(&description)
            .unwrap_or_else(|| "Unknown ScreenCaptureKit error.".to_string())
    }

    fn ns_string_to_string(value: &NSString) -> Option<String> {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SourceSelection, VideoPreset};

    #[test]
    fn selects_window_source_before_screen_source() {
        let params = PreviewScreenStartParams {
            sources: SourceSelection {
                screen_id: Some("screen:screencapturekit:5".to_string()),
                window_id: Some("window:screencapturekit:42".to_string()),
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            video: VideoSettings {
                preset: VideoPreset::Tutorial1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            },
        };

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Window);
        assert_eq!(selected.window_id, Some(42));
        assert_eq!(selected.display_id, None);
    }

    #[test]
    fn selects_screen_source_when_no_window_source_exists() {
        let params = PreviewScreenStartParams {
            sources: SourceSelection {
                screen_id: Some("screen:screencapturekit:5".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            video: VideoSettings {
                preset: VideoPreset::Tutorial1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            },
        };

        let selected = selected_screen_source(&params).unwrap();

        assert_eq!(selected.source_kind, PreviewScreenSourceKind::Screen);
        assert_eq!(selected.display_id, Some(5));
    }

    #[test]
    fn ignores_non_native_screen_sources() {
        let params = PreviewScreenStartParams {
            sources: SourceSelection {
                screen_id: Some("screen:avfoundation:1".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            video: VideoSettings {
                preset: VideoPreset::Tutorial1080p30,
                width: 1920,
                height: 1080,
                fps: 30,
                bitrate_kbps: 6000,
            },
        };

        assert!(selected_screen_source(&params).is_none());
    }

    #[test]
    fn downscales_screen_preview_png_payload() {
        let bytes = vec![255; 8 * 4 * 4];

        let (scaled, width, height) = downscale_rgba_for_preview(bytes, 8, 4, 4);

        assert_eq!(width, 4);
        assert_eq!(height, 2);
        assert_eq!(scaled.len(), 4 * 2 * 4);
    }
}
