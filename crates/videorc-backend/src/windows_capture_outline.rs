//! A faint outline around the display Videorc captures, for the streamer only.
//!
//! Windows draws a yellow border around a display under Windows Graphics
//! Capture, but Desktop Duplication records that border into the recording
//! and the stream, so every Videorc session turns it off
//! (`windows_graphics_capture::turn_off_capture_border`). This outline puts
//! the "this screen is being captured" cue back on the streamer's monitor:
//! four thin, faint, click-through, topmost windows along the display's
//! edges, each excluded from capture (`WDA_EXCLUDEFROMCAPTURE`), so no
//! recording, stream, Clip or screenshot ever contains it. An edge whose
//! exclusion Windows refuses is never shown.

use std::sync::OnceLock;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI,
    SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HTTRANSPARENT,
    HWND_TOPMOST, LWA_ALPHA, MA_NOACTIVATE, MSG, PM_REMOVE, PeekMessageW, PostThreadMessageW,
    RegisterClassExW, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_CLOSE, WM_DISPLAYCHANGE, WM_MOUSEACTIVATE, WM_NCHITTEST,
    WM_QUIT, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::screen_capture::WindowsDxgiSourceId;

/// Amber, near the colour of the Windows capture border it replaces.
const OUTLINE_RGB: (u8, u8, u8) = (245, 197, 24);
/// About 35% opaque: present at the edge of vision, never in the way.
const OUTLINE_ALPHA: u8 = 90;
/// Two pixels at 100% scaling, scaled with the display.
const OUTLINE_THICKNESS_AT_96_DPI: u32 = 2;
/// Other topmost windows (the taskbar when clicked) can rise above an edge;
/// the outline takes the top back this often.
const RAISE_INTERVAL: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
/// Posted to the outline thread when the display layout changes.
const WM_OUTLINE_REPOSITION: u32 = WM_APP + 1;

const OUTLINE_CLASS_NAME: PCWSTR = w!("VideorcCaptureOutline");
static OUTLINE_CLASS: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OutlineRect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

fn outline_value_enabled(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off" | "disabled"
        )
    })
}

/// The edge thickness in physical pixels for a display at `dpi`.
pub(crate) fn outline_thickness_px(dpi: u32) -> i32 {
    let dpi = if dpi == 0 { 96 } else { dpi };
    let px = (OUTLINE_THICKNESS_AT_96_DPI * dpi + 48) / 96;
    i32::try_from(px.max(1)).unwrap_or(1)
}

/// Top, bottom, left and right bands inside `display`, without overlap (an
/// overlap would double the alpha in the corners).
pub(crate) fn outline_edges(display: OutlineRect, thickness: i32) -> Option<[OutlineRect; 4]> {
    if thickness <= 0 || display.width < thickness * 2 || display.height < thickness * 2 {
        return None;
    }
    let OutlineRect {
        left,
        top,
        width,
        height,
    } = display;
    let side_height = height - thickness * 2;
    Some([
        OutlineRect {
            left,
            top,
            width,
            height: thickness,
        },
        OutlineRect {
            left,
            top: top + height - thickness,
            width,
            height: thickness,
        },
        OutlineRect {
            left,
            top: top + thickness,
            width: thickness,
            height: side_height,
        },
        OutlineRect {
            left: left + width - thickness,
            top: top + thickness,
            width: thickness,
            height: side_height,
        },
    ])
}

/// Shows the outline until dropped. Resolving the monitor again on a display
/// change keeps it on the right display after a resolution or layout change.
pub(crate) struct CaptureOutline {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl CaptureOutline {
    /// Shows the outline around a captured DXGI display, or logs why not.
    /// The capture never depends on it. `VIDEORC_WINDOWS_CAPTURE_OUTLINE=0`
    /// turns it off.
    pub(crate) fn show_for_source(source: WindowsDxgiSourceId) -> Option<Self> {
        if !outline_value_enabled(
            std::env::var("VIDEORC_WINDOWS_CAPTURE_OUTLINE")
                .ok()
                .as_deref(),
        ) {
            return None;
        }
        let resolve = move || crate::windows_graphics_capture::monitor_for_source(source).ok();
        match Self::show_with(resolve, true) {
            Ok(outline) => Some(outline),
            Err(reason) => {
                tracing::warn!(
                    reason = %reason,
                    "the capture outline is not shown; the capture continues without it"
                );
                None
            }
        }
    }

    /// Shows the outline around the display `resolve_monitor` names.
    /// `exclude_from_capture` is false only in the test that proves the
    /// capture check would see an outline that leaked.
    pub(crate) fn show_with(
        resolve_monitor: impl Fn() -> Option<HMONITOR> + Send + 'static,
        exclude_from_capture: bool,
    ) -> Result<Self, String> {
        let (ready_tx, ready_rx) = channel();
        let thread = std::thread::Builder::new()
            .name("videorc-capture-outline".to_string())
            .spawn(move || run_outline_thread(&resolve_monitor, exclude_from_capture, &ready_tx))
            .map_err(|error| format!("could not start the capture outline thread: {error}"))?;
        match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                thread: Some(thread),
            }),
            Ok(Err(reason)) => {
                let _ = thread.join();
                Err(reason)
            }
            Err(_) => Err("the capture outline did not start within 5 seconds".to_string()),
        }
    }
}

impl Drop for CaptureOutline {
    fn drop(&mut self) {
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct OutlineWindows {
    edges: Vec<HWND>,
}

impl OutlineWindows {
    fn destroy(&mut self) {
        for hwnd in self.edges.drain(..) {
            let _ = unsafe { DestroyWindow(hwnd) };
        }
    }
}

fn run_outline_thread(
    resolve_monitor: &dyn Fn() -> Option<HMONITOR>,
    exclude_from_capture: bool,
    ready_tx: &Sender<Result<u32, String>>,
) {
    // Physical pixels for the monitor rectangle and the window positions,
    // whatever DPI awareness the process itself declares.
    let _ = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let thread_id = unsafe { GetCurrentThreadId() };
    let mut windows = match register_outline_class()
        .and_then(|()| create_outline(resolve_monitor, exclude_from_capture))
    {
        Ok(windows) => windows,
        Err(reason) => {
            let _ = ready_tx.send(Err(reason));
            return;
        }
    };
    let _ = unsafe {
        SetTimer(
            None,
            0,
            u32::try_from(RAISE_INTERVAL.as_millis()).unwrap_or(2000),
            None,
        )
    };
    let _ = ready_tx.send(Ok(thread_id));

    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        if message.hwnd.is_invalid() {
            match message.message {
                WM_TIMER => raise(&windows),
                WM_OUTLINE_REPOSITION => {
                    // Each edge hears the display change: rebuild once.
                    let mut duplicate = MSG::default();
                    while unsafe {
                        PeekMessageW(
                            &mut duplicate,
                            None,
                            WM_OUTLINE_REPOSITION,
                            WM_OUTLINE_REPOSITION,
                            PM_REMOVE,
                        )
                    }
                    .as_bool()
                    {}
                    windows.destroy();
                    match create_outline(resolve_monitor, exclude_from_capture) {
                        Ok(replacement) => windows = replacement,
                        Err(reason) => tracing::warn!(
                            reason = %reason,
                            "the capture outline could not follow a display change"
                        ),
                    }
                }
                _ => {}
            }
            continue;
        }
        unsafe { DispatchMessageW(&message) };
    }
    windows.destroy();
}

fn create_outline(
    resolve_monitor: &dyn Fn() -> Option<HMONITOR>,
    exclude_from_capture: bool,
) -> Result<OutlineWindows, String> {
    let monitor = resolve_monitor().ok_or("the captured display has no monitor")?;
    let mut info = MONITORINFO {
        cbSize: u32::try_from(size_of::<MONITORINFO>()).unwrap_or(u32::MAX),
        ..MONITORINFO::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return Err("GetMonitorInfoW failed for the captured display".to_string());
    }
    let mut dpi_x = 96;
    let mut dpi_y = 96;
    let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    let RECT {
        left,
        top,
        right,
        bottom,
    } = info.rcMonitor;
    let display = OutlineRect {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
    let edges = outline_edges(display, outline_thickness_px(dpi_x))
        .ok_or("the captured display is too small for an outline")?;
    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }
        .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
    let mut windows = OutlineWindows { edges: Vec::new() };
    for edge in edges {
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_TOPMOST,
                OUTLINE_CLASS_NAME,
                w!("Videorc capture outline"),
                WS_POPUP,
                edge.left,
                edge.top,
                edge.width,
                edge.height,
                None,
                None,
                Some(HINSTANCE(module.0)),
                None,
            )
        };
        let hwnd = match hwnd {
            Ok(hwnd) => hwnd,
            Err(error) => {
                windows.destroy();
                return Err(format!("CreateWindowExW failed: {error}"));
            }
        };
        windows.edges.push(hwnd);
        // Excluded before it is ever shown: an edge Windows will not keep out
        // of capture would land in the recording, so the outline gives up.
        if exclude_from_capture
            && let Err(error) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }
        {
            windows.destroy();
            return Err(format!(
                "SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) failed: {error}"
            ));
        }
        if let Err(error) =
            unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), OUTLINE_ALPHA, LWA_ALPHA) }
        {
            windows.destroy();
            return Err(format!("SetLayeredWindowAttributes failed: {error}"));
        }
    }
    for &hwnd in &windows.edges {
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    }
    raise(&windows);
    Ok(windows)
}

fn raise(windows: &OutlineWindows) {
    for &hwnd in &windows.edges {
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
    }
}

fn register_outline_class() -> Result<(), String> {
    OUTLINE_CLASS
        .get_or_init(|| {
            let module = unsafe { GetModuleHandleW(PCWSTR::null()) }
                .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
            let (r, g, b) = OUTLINE_RGB;
            let class = WNDCLASSEXW {
                cbSize: u32::try_from(size_of::<WNDCLASSEXW>()).unwrap_or(u32::MAX),
                lpfnWndProc: Some(outline_wnd_proc),
                hInstance: HINSTANCE(module.0),
                // The class owns the brush for the life of the process.
                hbrBackground: unsafe {
                    CreateSolidBrush(COLORREF(
                        u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16),
                    ))
                },
                lpszClassName: OUTLINE_CLASS_NAME,
                ..WNDCLASSEXW::default()
            };
            if unsafe { RegisterClassExW(&class) } == 0 {
                return Err(format!(
                    "RegisterClassExW failed: {}",
                    windows::core::Error::from_thread()
                ));
            }
            Ok(())
        })
        .clone()
}

unsafe extern "system" fn outline_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        // Only the outline's owner removes it.
        WM_CLOSE => LRESULT(0),
        // Every outline window lives on its outline thread's message loop.
        WM_DISPLAYCHANGE => {
            let _ = unsafe {
                PostThreadMessageW(
                    GetCurrentThreadId(),
                    WM_OUTLINE_REPOSITION,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_graphics_capture::tests::{
        DISPLAY_TEST_LOCK, first_display, read_desktop_duplication_frame,
    };

    #[test]
    fn outline_is_on_by_default_with_an_escape_hatch() {
        assert!(outline_value_enabled(None));
        assert!(outline_value_enabled(Some("1")));
        assert!(!outline_value_enabled(Some(" off ")));
        assert!(!outline_value_enabled(Some("0")));
    }

    #[test]
    fn outline_thickness_scales_with_the_display() {
        assert_eq!(outline_thickness_px(96), 2);
        assert_eq!(outline_thickness_px(144), 3);
        assert_eq!(outline_thickness_px(192), 4);
        assert_eq!(outline_thickness_px(0), 2);
    }

    #[test]
    fn outline_edges_cover_the_border_once() {
        let display = OutlineRect {
            left: -1920,
            top: 0,
            width: 1920,
            height: 1080,
        };
        let edges = outline_edges(display, 3).expect("edges");
        let mut covered = std::collections::HashMap::new();
        for edge in edges {
            for y in edge.top..edge.top + edge.height {
                for x in edge.left..edge.left + edge.width {
                    *covered.entry((x, y)).or_insert(0) += 1;
                }
            }
        }
        // Every pixel within 3 of an edge, once: no doubled corners, nothing
        // inside the band, nothing outside the display.
        let band = (1920 * 1080) - (1920 - 6) * (1080 - 6);
        assert_eq!(covered.len(), band as usize);
        assert!(covered.values().all(|&count| count == 1));
        assert!(covered.keys().all(|&(x, y)| {
            let inside = (-1920..0).contains(&x) && (0..1080).contains(&y);
            let in_band = !(-1920 + 3..-3).contains(&x) || !(3..1077).contains(&y);
            inside && in_band
        }));
        assert_eq!(
            outline_edges(
                OutlineRect {
                    width: 4,
                    ..display
                },
                3
            ),
            None
        );
        assert_eq!(outline_edges(display, 0), None);
    }

    /// Mean red minus blue over the outer `ring` pixels: amber raises it by
    /// about 80 over any background, so a leaked outline cannot hide in it.
    fn ring_red_minus_blue(bgra: &[u8], width: usize, height: usize, ring: usize) -> f64 {
        let mut count = 0_f64;
        let mut sum = 0_f64;
        for y in 0..height {
            for x in 0..width {
                if x < ring || y < ring || x >= width - ring || y >= height - ring {
                    let at = (y * width + x) * 4;
                    sum += f64::from(bgra[at + 2]) - f64::from(bgra[at]);
                    count += 1.0;
                }
            }
        }
        sum / count.max(1.0)
    }

    fn outline_shift_in_capture(exclude_from_capture: bool) -> f64 {
        let _display = DISPLAY_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (source, adapter) = first_display();
        let window = Duration::from_millis(800);
        let (before, width, height) = read_desktop_duplication_frame(&adapter, window);
        let outline = CaptureOutline::show_with(
            move || crate::windows_graphics_capture::monitor_for_source(source).ok(),
            exclude_from_capture,
        )
        .expect("capture outline");
        std::thread::sleep(Duration::from_millis(300));
        let (after, _, _) = read_desktop_duplication_frame(&adapter, window);
        drop(outline);
        ring_red_minus_blue(&after, width, height, 2)
            - ring_red_minus_blue(&before, width, height, 2)
    }

    /// The streamer sees the outline; Desktop Duplication, which the
    /// recording and stream read, does not. Measured 0.0 on a UHD 620.
    #[test]
    #[ignore = "needs an awake, unlocked Windows display"]
    fn the_capture_outline_never_reaches_the_recording() {
        let shift = outline_shift_in_capture(true);
        assert!(
            shift.abs() < 10.0,
            "the outline moved the captured edge by {shift:.1}"
        );
    }

    /// The control for the test above: the same outline without the capture
    /// exclusion is seen (measured +82 on a UHD 620), so a pass there is the
    /// exclusion at work, not an outline that never drew.
    #[test]
    #[ignore = "needs an awake, unlocked Windows display"]
    fn a_capture_outline_without_the_exclusion_is_seen() {
        let shift = outline_shift_in_capture(false);
        assert!(
            shift > 40.0,
            "the unexcluded outline moved the edge by only {shift:.1}"
        );
    }
}
