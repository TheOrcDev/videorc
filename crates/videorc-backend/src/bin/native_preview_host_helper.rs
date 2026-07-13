#[cfg(target_os = "macos")]
#[path = "../color.rs"]
mod color;
#[cfg(target_os = "macos")]
#[path = "../metal_compositor.rs"]
mod metal_compositor;
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../native_preview_host.rs"]
mod native_preview_host;

#[cfg(target_os = "macos")]
mod protocol {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PreviewSurfaceBounds {
        pub screen_x: f64,
        pub screen_y: f64,
        pub width: f64,
        pub height: f64,
        pub scale_factor: f64,
        #[serde(default)]
        pub screen_height: Option<f64>,
        // Mirror of crate::protocol::PreviewSurfaceBounds (this helper substitutes its
        // own protocol module): visible clip rect + visibility, absent = fully visible.
        #[serde(default)]
        pub clip_x: Option<f64>,
        #[serde(default)]
        pub clip_y: Option<f64>,
        #[serde(default)]
        pub clip_width: Option<f64>,
        #[serde(default)]
        pub clip_height: Option<f64>,
        #[serde(default)]
        pub visible: Option<bool>,
        #[serde(default)]
        pub order_above_window_id: Option<u32>,
        #[serde(default)]
        pub elevated: Option<bool>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum PreviewTransport {
        NativeSurface,
        ElectronProofSurface,
        LatestJpegPolling,
        MjpegStream,
        Unavailable,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum PreviewSurfaceBacking {
        #[serde(rename = "cametal-layer")]
        CaMetalLayer,
        ElectronBrowserWindow,
        None,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io::{self, BufRead, Write};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::thread;
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result, bail};
    use objc2::MainThreadMarker;
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSApplication;
    use serde::{Deserialize, Serialize};

    use crate::metal_compositor::{GpuSource, GpuSourceKind, MetalSceneCompositor};
    use crate::native_preview_host::{
        NativePreviewHostActivation, NativePreviewHostBounds, NativePreviewHostCommand,
        NativePreviewHostCommandKind, NativePreviewIosurfacePresenterRunner,
    };

    const HELPER_IDLE_PUMP_INTERVAL: Duration = Duration::from_millis(16);
    /// Keep stdin request buffering bounded so a stalled AppKit/Metal operation
    /// backpressures the parent through the OS pipe instead of retaining an
    /// unbounded number of request lines in the helper. `SyncSender::send`
    /// preserves FIFO ordering and wakes with an error when the receiver exits.
    const HELPER_STDIN_QUEUE_CAPACITY: usize = 32;

    enum HelperLoopControl {
        Continue,
        Exit,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperRequest {
        id: Option<String>,
        method: String,
        commands: Option<Vec<NativePreviewHostCommand>>,
        handoff: Option<IosurfaceHandoff>,
    }

    #[derive(Debug, Clone, Copy, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IosurfaceHandoff {
        iosurface_id: u32,
        width: usize,
        height: usize,
        frame_id: u64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperResponse<T: Serialize> {
        id: Option<String>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<T>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperEvent<T: Serialize> {
        event: &'static str,
        payload: T,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HelperReadyPayload {
        pid: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_pid: Option<u32>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct HostCommandPayload {
        has_overlay: bool,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PresentPayload {
        has_overlay: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        present_failure_reason: Option<String>,
        activation: Option<ActivationPayload>,
        native_preview_iosurface_cache_hits: u64,
        native_preview_iosurface_imports: u64,
        native_preview_iosurface_invalidations: u64,
        native_preview_iosurface_import_failures: u64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ActivationPayload {
        transport: crate::protocol::PreviewTransport,
        backing: crate::protocol::PreviewSurfaceBacking,
        presented_frame_id: u64,
        frame_polling_suppressed: bool,
        source_pixels_present: bool,
        message: Option<String>,
    }

    impl From<NativePreviewHostActivation> for ActivationPayload {
        fn from(activation: NativePreviewHostActivation) -> Self {
            Self {
                transport: activation.transport,
                backing: activation.backing,
                presented_frame_id: activation.presented_frame_id,
                frame_polling_suppressed: activation.frame_polling_suppressed,
                source_pixels_present: activation.source_pixels_present,
                message: activation.message,
            }
        }
    }

    pub fn run() -> Result<()> {
        if std::env::args().any(|arg| arg == "--self-test") {
            return self_test();
        }
        if std::env::args().any(|arg| arg == "--lifecycle-smoke") {
            return lifecycle_smoke();
        }
        if std::env::args().any(|arg| arg == "--present-smoke") {
            return present_smoke();
        }
        if std::env::args().any(|arg| arg == "--present-benchmark") {
            return present_benchmark();
        }

        let mtm = MainThreadMarker::new()
            .context("native preview host helper must run on the macOS main thread")?;
        let app = NSApplication::sharedApplication(mtm);
        // A non-bundled helper defaults to the PROHIBITED activation policy, under
        // which the window server refuses to put its windows on screen — presents
        // would "succeed" into a window nobody can ever see. Accessory keeps it out
        // of the Dock/app switcher while allowing real on-screen windows.
        app.setActivationPolicy(objc2_app_kit::NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
        let mut runner = NativePreviewIosurfacePresenterRunner::new()
            .context("Metal preview presenter is unavailable")?;
        let request_rx = spawn_stdin_reader();

        let mut stdout = io::stdout();
        write_event(
            &mut stdout,
            &HelperEvent {
                event: "helper.ready",
                payload: HelperReadyPayload {
                    pid: std::process::id(),
                    parent_pid: current_parent_pid(),
                },
            },
        )?;
        loop {
            let control = autoreleasepool(|_| -> Result<HelperLoopControl> {
                let line = match request_rx.recv_timeout(HELPER_IDLE_PUMP_INTERVAL) {
                    Ok(Ok(line)) => line,
                    Ok(Err(error)) => {
                        return Err(error).context("native preview helper stdin failed");
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        pump_core_animation(&app);
                        return Ok(HelperLoopControl::Continue);
                    }
                    Err(RecvTimeoutError::Disconnected) => return Ok(HelperLoopControl::Exit),
                };
                let should_exit = if line.trim().is_empty() {
                    false
                } else {
                    handle_request_line(mtm, &mut runner, line, &mut stdout)?
                };
                pump_core_animation(&app);
                if should_exit {
                    Ok(HelperLoopControl::Exit)
                } else {
                    Ok(HelperLoopControl::Continue)
                }
            })?;
            if matches!(control, HelperLoopControl::Exit) {
                break;
            }
        }

        Ok(())
    }

    /// This helper never runs the AppKit run loop, so implicit Core Animation
    /// transactions (layer attachment, window/layer frame changes) would never be
    /// committed to the render server — the window then composites as an empty
    /// (black) layer no matter how many drawables were presented. Flush explicitly
    /// on each request or display-paced idle tick.
    fn pump_core_animation(app: &NSApplication) {
        app.updateWindows();
        objc2_quartz_core::CATransaction::flush();
    }

    fn spawn_stdin_reader() -> mpsc::Receiver<io::Result<String>> {
        let (tx, rx) = helper_stdin_channel();
        thread::spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        rx
    }

    fn helper_stdin_channel<T>() -> (mpsc::SyncSender<T>, mpsc::Receiver<T>) {
        mpsc::sync_channel(HELPER_STDIN_QUEUE_CAPACITY)
    }

    fn handle_request_line(
        mtm: MainThreadMarker,
        runner: &mut NativePreviewIosurfacePresenterRunner,
        line: String,
        stdout: &mut impl Write,
    ) -> Result<bool> {
        let request: HelperRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    stdout,
                    &HelperResponse::<serde_json::Value> {
                        id: None,
                        ok: false,
                        payload: None,
                        error: Some(format!("invalid request: {error}")),
                    },
                )?;
                return Ok(false);
            }
        };
        handle_request(mtm, runner, request, stdout)
    }

    fn self_test() -> Result<()> {
        let mtm = MainThreadMarker::new()
            .context("native preview host helper self-test must run on the macOS main thread")?;
        NSApplication::sharedApplication(mtm).finishLaunching();
        let Some(runner) = NativePreviewIosurfacePresenterRunner::new() else {
            println!("SKIP metal preview presenter unavailable");
            return Ok(());
        };
        println!(
            "OK native preview host helper initialized; hasOverlay={}",
            runner.has_overlay()
        );
        Ok(())
    }

    fn lifecycle_smoke() -> Result<()> {
        let mtm = MainThreadMarker::new().context(
            "native preview host helper lifecycle smoke must run on the macOS main thread",
        )?;
        NSApplication::sharedApplication(mtm).finishLaunching();
        let mut runner = NativePreviewIosurfacePresenterRunner::new()
            .context("Metal preview presenter is unavailable")?;

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Create,
                bounds: Some(NativePreviewHostBounds {
                    screen_x: -10_000.0,
                    screen_y: -10_000.0,
                    width: 16.0,
                    height: 16.0,
                    scale_factor: 1.0,
                    screen_height: Some(1000.0),
                    ..Default::default()
                }),
            },
            mtm,
        );
        if !runner.has_overlay() {
            bail!("native preview helper did not create an overlay")
        }

        if runner.present_iosurface(1, 8, 4, 12).is_some() {
            bail!("native preview helper claimed activation for an invalid IOSurface")
        }

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Destroy,
                bounds: None,
            },
            mtm,
        );
        if runner.has_overlay() {
            bail!("native preview helper did not destroy the overlay")
        }

        println!("OK native preview host helper lifecycle smoke passed");
        Ok(())
    }

    fn present_smoke() -> Result<()> {
        let mtm = MainThreadMarker::new().context(
            "native preview host helper present smoke must run on the macOS main thread",
        )?;
        NSApplication::sharedApplication(mtm).finishLaunching();
        let mut runner = NativePreviewIosurfacePresenterRunner::new()
            .context("Metal preview presenter is unavailable")?;

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Create,
                bounds: Some(smoke_overlay_bounds()),
            },
            mtm,
        );
        if !runner.has_overlay() {
            bail!("native preview helper did not create an overlay for present smoke")
        }

        let mut compositor =
            MetalSceneCompositor::new().context("Metal scene compositor is unavailable")?;
        let red = [0u8, 0, 255, 255];
        let source = GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &red,
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0, 0.0, 0.0, 0.0],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
            chroma_key: None,
        };
        compositor
            .compose_bgra(16, 16, [0.0, 0.0, 0.0, 1.0], &[source])
            .context("Metal compositor failed to create present-smoke target")?;
        let target = compositor
            .latest_target_pixel_buffer()
            .context("Metal compositor did not retain an IOSurface-backed target")?;
        let iosurface_id = target
            .iosurface_id()
            .context("Metal compositor target has no IOSurface id")?;

        let mut activation = None;
        for _ in 0..10 {
            activation = runner.present_iosurface(iosurface_id, target.width(), target.height(), 1);
            if activation.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(16));
        }
        let activation =
            activation.context("native preview helper did not present the smoke IOSurface")?;
        if activation.presented_frame_id != 1 {
            bail!(
                "native preview helper presented unexpected frame id {}",
                activation.presented_frame_id
            )
        }

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Destroy,
                bounds: None,
            },
            mtm,
        );

        println!(
            "OK native preview host helper present smoke passed; iosurface={} size={}x{}",
            iosurface_id,
            target.width(),
            target.height()
        );
        Ok(())
    }

    fn present_benchmark() -> Result<()> {
        let mtm = MainThreadMarker::new().context(
            "native preview host helper present benchmark must run on the macOS main thread",
        )?;
        let app = NSApplication::sharedApplication(mtm);
        app.finishLaunching();
        let mut runner = NativePreviewIosurfacePresenterRunner::new()
            .context("Metal preview presenter is unavailable")?;

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Create,
                bounds: Some(smoke_overlay_bounds()),
            },
            mtm,
        );
        if !runner.has_overlay() {
            bail!("native preview helper did not create an overlay for present benchmark")
        }

        let mut compositor =
            MetalSceneCompositor::new().context("Metal scene compositor is unavailable")?;
        let red = [0u8, 0, 255, 255];
        let source = GpuSource {
            kind: GpuSourceKind::Image,
            bgra: &red,
            content_key: None,
            iosurface: None,
            pixel_buffer: None,
            width: 1,
            height: 1,
            dest: [0.0, 0.0, 1.0, 1.0],
            crop: [0.0, 0.0, 0.0, 0.0],
            mirror: false,
            mask: crate::metal_compositor::SourceMask::None,
            blend: false,
            chroma_key: None,
        };
        compositor
            .compose_bgra(16, 16, [0.0, 0.0, 0.0, 1.0], &[source])
            .context("Metal compositor failed to create present-benchmark target")?;
        let target = compositor
            .latest_target_pixel_buffer()
            .context("Metal compositor did not retain an IOSurface-backed target")?;
        let iosurface_id = target
            .iosurface_id()
            .context("Metal compositor target has no IOSurface id")?;

        let frames = smoke_env_usize("VIDEORC_NATIVE_PREVIEW_HELPER_BENCHMARK_FRAMES")
            .unwrap_or(240)
            .max(2);
        let mut failures = 0usize;
        let mut presented_at = Vec::with_capacity(frames);
        for frame_id in 1..=frames {
            if runner
                .present_iosurface(
                    iosurface_id,
                    target.width(),
                    target.height(),
                    frame_id as u64,
                )
                .is_some()
            {
                presented_at.push(Instant::now());
            } else {
                failures = failures.saturating_add(1);
            }
            app.updateWindows();
        }

        runner.apply_command(
            NativePreviewHostCommand {
                kind: NativePreviewHostCommandKind::Destroy,
                bounds: None,
            },
            mtm,
        );

        let fps = measured_fps(&presented_at);
        let interval_p95_ms = interval_p95_ms(&presented_at);
        println!(
            "OK native preview host helper present benchmark; frames={} presented={} failures={} fps={:.1} interval_p95_ms={:.1} iosurface={} size={}x{}",
            frames,
            presented_at.len(),
            failures,
            fps.unwrap_or(0.0),
            interval_p95_ms.unwrap_or(0.0),
            iosurface_id,
            target.width(),
            target.height()
        );
        Ok(())
    }

    fn smoke_overlay_bounds() -> NativePreviewHostBounds {
        NativePreviewHostBounds {
            screen_x: smoke_env_f64("VIDEORC_NATIVE_PREVIEW_HELPER_SMOKE_X").unwrap_or(24.0),
            screen_y: smoke_env_f64("VIDEORC_NATIVE_PREVIEW_HELPER_SMOKE_Y").unwrap_or(24.0),
            width: smoke_env_f64("VIDEORC_NATIVE_PREVIEW_HELPER_SMOKE_WIDTH").unwrap_or(24.0),
            height: smoke_env_f64("VIDEORC_NATIVE_PREVIEW_HELPER_SMOKE_HEIGHT").unwrap_or(24.0),
            scale_factor: smoke_env_f64("VIDEORC_NATIVE_PREVIEW_HELPER_SMOKE_SCALE").unwrap_or(1.0),
            screen_height: None,
            ..Default::default()
        }
    }

    fn smoke_env_f64(name: &str) -> Option<f64> {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
    }

    fn smoke_env_usize(name: &str) -> Option<usize> {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
    }

    fn measured_fps(presented_at: &[Instant]) -> Option<f64> {
        if presented_at.len() < 2 {
            return None;
        }
        let elapsed = presented_at
            .last()?
            .duration_since(*presented_at.first()?)
            .as_secs_f64();
        (elapsed > 0.0).then_some((presented_at.len() - 1) as f64 / elapsed)
    }

    fn interval_p95_ms(presented_at: &[Instant]) -> Option<f64> {
        if presented_at.len() < 2 {
            return None;
        }
        let mut intervals: Vec<f64> = presented_at
            .windows(2)
            .map(|pair| pair[1].duration_since(pair[0]).as_secs_f64() * 1000.0)
            .collect();
        intervals.sort_by(|a, b| a.total_cmp(b));
        let index = ((intervals.len() - 1) as f64 * 0.95).ceil() as usize;
        intervals.get(index).copied()
    }

    fn handle_request(
        mtm: MainThreadMarker,
        runner: &mut NativePreviewIosurfacePresenterRunner,
        request: HelperRequest,
        stdout: &mut impl Write,
    ) -> Result<bool> {
        match request.method.as_str() {
            "applyHostCommands" => {
                let commands = request
                    .commands
                    .context("applyHostCommands requires commands")?;
                for command in commands {
                    runner.apply_command(command, mtm);
                }
                write_response(
                    stdout,
                    &HelperResponse {
                        id: request.id,
                        ok: true,
                        payload: Some(HostCommandPayload {
                            has_overlay: runner.has_overlay(),
                        }),
                        error: None,
                    },
                )?;
                Ok(false)
            }
            "presentCompositorHandoff" => {
                let handoff = request
                    .handoff
                    .context("presentCompositorHandoff requires handoff")?;
                let present_result = runner.try_present_iosurface(
                    handoff.iosurface_id,
                    handoff.width,
                    handoff.height,
                    handoff.frame_id,
                );
                let (activation, present_failure_reason) = match present_result {
                    Ok(activation) => (Some(ActivationPayload::from(activation)), None),
                    Err(failure) => (None, Some(failure.reason().to_string())),
                };
                let cache_metrics = runner.cache_metrics();
                write_response(
                    stdout,
                    &HelperResponse {
                        id: request.id,
                        ok: true,
                        payload: Some(PresentPayload {
                            has_overlay: runner.has_overlay(),
                            present_failure_reason,
                            activation,
                            native_preview_iosurface_cache_hits: cache_metrics.hits,
                            native_preview_iosurface_imports: cache_metrics.imports,
                            native_preview_iosurface_invalidations: cache_metrics.invalidations,
                            native_preview_iosurface_import_failures: cache_metrics.import_failures,
                        }),
                        error: None,
                    },
                )?;
                Ok(false)
            }
            "shutdown" => {
                write_response(
                    stdout,
                    &HelperResponse {
                        id: request.id,
                        ok: true,
                        payload: Some(HostCommandPayload { has_overlay: false }),
                        error: None,
                    },
                )?;
                Ok(true)
            }
            method => bail!("unknown native preview host helper method: {method}"),
        }
    }

    fn write_response<T: Serialize>(
        stdout: &mut impl Write,
        response: &HelperResponse<T>,
    ) -> Result<()> {
        serde_json::to_writer(&mut *stdout, response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
        Ok(())
    }

    fn write_event<T: Serialize>(stdout: &mut impl Write, event: &HelperEvent<T>) -> Result<()> {
        serde_json::to_writer(&mut *stdout, event)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{HELPER_IDLE_PUMP_INTERVAL, HELPER_STDIN_QUEUE_CAPACITY, helper_stdin_channel};
        use std::sync::mpsc::TrySendError;
        use std::time::Duration;

        #[test]
        fn idle_pump_is_display_paced_instead_of_a_one_millisecond_spin() {
            assert!(HELPER_IDLE_PUMP_INTERVAL >= Duration::from_millis(8));
            assert!(HELPER_IDLE_PUMP_INTERVAL <= Duration::from_millis(17));
        }

        #[test]
        fn stdin_queue_is_bounded_and_preserves_request_order() {
            let (tx, rx) = helper_stdin_channel();
            for value in 0..HELPER_STDIN_QUEUE_CAPACITY {
                tx.try_send(value)
                    .expect("queue should accept up to its declared capacity");
            }
            assert!(matches!(
                tx.try_send(HELPER_STDIN_QUEUE_CAPACITY),
                Err(TrySendError::Full(value)) if value == HELPER_STDIN_QUEUE_CAPACITY
            ));

            for expected in 0..HELPER_STDIN_QUEUE_CAPACITY {
                assert_eq!(
                    rx.recv().expect("queued request should remain available"),
                    expected
                );
            }

            drop(rx);
            assert!(tx.send(HELPER_STDIN_QUEUE_CAPACITY).is_err());
        }
    }

    #[cfg(unix)]
    fn current_parent_pid() -> Option<u32> {
        Some(std::os::unix::process::parent_id())
    }

    #[cfg(not(unix))]
    fn current_parent_pid() -> Option<u32> {
        None
    }
}

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    macos::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("native_preview_host_helper is only available on macOS");
}
