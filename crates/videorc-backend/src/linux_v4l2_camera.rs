//! Linux cameras through V4L2 (L3 of `docs/linux-port-plan.md`).
//!
//! Discovery reads sysfs (`/sys/class/video4linux/videoN`) and keeps the
//! capture node of each device (`index == 0`; UVC cameras also expose a
//! metadata node at index 1 that cannot stream). The device path in the id
//! prefers the stable `/dev/v4l/by-id/*-video-index0` link, so a camera keeps
//! its identity when USB enumeration order changes. Capture is the Windows
//! DirectShow shape: an owned FFmpeg child (`-f v4l2`) writes scaled BGRA to
//! the preview camera frame store, and recording composes from that store.
//!
//! Access needs `video` group membership; a node the user cannot open is
//! listed as permission-required with the fix named, never hidden.
// The id parser is reachable on every platform (a stored id resolves
// anywhere); discovery and capture are only called on Linux.
#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]

use std::path::{Path, PathBuf};

use crate::protocol::{Device, DeviceKind, DeviceStatus};

pub const LINUX_V4L2_CAMERA_PREFIX: &str = "camera:linux-v4l2:";

pub fn linux_v4l2_camera_id(device_path: &str) -> String {
    format!(
        "{LINUX_V4L2_CAMERA_PREFIX}{}",
        crate::audio::encode_hex(device_path.as_bytes())
    )
}

pub fn parse_linux_v4l2_camera_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(LINUX_V4L2_CAMERA_PREFIX)?;
    let path = String::from_utf8(crate::audio::decode_hex(encoded)?).ok()?;
    path.starts_with("/dev/").then_some(path)
}

/// Where discovery looks; injectable so tests run against a fake tree.
#[derive(Debug, Clone)]
pub struct V4l2Roots {
    pub sysfs_class: PathBuf,
    pub dev: PathBuf,
    pub by_id: PathBuf,
}

impl Default for V4l2Roots {
    fn default() -> Self {
        Self {
            sysfs_class: PathBuf::from("/sys/class/video4linux"),
            dev: PathBuf::from("/dev"),
            by_id: PathBuf::from("/dev/v4l/by-id"),
        }
    }
}

/// How an openable check turned out, so the row can name the fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeAccess {
    Ok,
    PermissionDenied,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))] // only node_access reports it
    Missing,
}

#[cfg(target_os = "linux")]
pub fn node_access(path: &Path) -> NodeAccess {
    // Opening a V4L2 node does not start streaming, so this never contends
    // with a running capture.
    match std::fs::File::open(path) {
        Ok(_) => NodeAccess::Ok,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            NodeAccess::PermissionDenied
        }
        Err(_) => NodeAccess::Missing,
    }
}

/// Camera rows for every V4L2 capture node under `roots`.
pub fn list_v4l2_cameras(roots: &V4l2Roots, access: impl Fn(&Path) -> NodeAccess) -> Vec<Device> {
    let Ok(entries) = std::fs::read_dir(&roots.sysfs_class) else {
        return Vec::new();
    };
    let mut nodes = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let node = entry.file_name().to_string_lossy().into_owned();
            let number = node.strip_prefix("video")?.parse::<u32>().ok()?;
            let sysfs = entry.path();
            let index = read_trimmed(&sysfs.join("index")).unwrap_or_else(|| "0".to_string());
            (index == "0").then_some((number, node, sysfs))
        })
        .collect::<Vec<_>>();
    nodes.sort_by_key(|(number, ..)| *number);

    nodes
        .into_iter()
        .filter_map(|(_, node, sysfs)| {
            let dev_path = roots.dev.join(&node);
            let device_path = stable_path_for(&roots.by_id, &node).unwrap_or(dev_path.clone());
            let name = read_trimmed(&sysfs.join("name"))
                .map(|name| name.trim_end_matches(':').trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| node.clone());
            // Plan 214 A5: never list Videorc Camera (the loopback device,
            // by its card_label) as a source of itself.
            if crate::virtual_camera::is_videorc_camera_linux(&name) {
                return None;
            }
            let (status, detail) = match access(&dev_path) {
                NodeAccess::Ok => (
                    DeviceStatus::Available,
                    format!("V4L2 {}", dev_path.display()),
                ),
                NodeAccess::PermissionDenied => (
                    DeviceStatus::PermissionRequired,
                    format!(
                        "Cannot open {}: add your user to the `video` group (sudo usermod -aG video $USER) and log in again.",
                        dev_path.display()
                    ),
                ),
                NodeAccess::Missing => (
                    DeviceStatus::Unavailable,
                    format!("{} is listed in sysfs but cannot be opened.", dev_path.display()),
                ),
            };
            Some(Device {
                app: None,
                window_title: None,
                display_uuid: None,
                id: linux_v4l2_camera_id(&device_path.to_string_lossy()),
                name,
                kind: DeviceKind::Camera,
                status,
                detail: Some(detail),
                width: None,
                height: None,
            })
        })
        .collect()
}

/// The `/dev/v4l/by-id` link that resolves to `node` (e.g. `video0`).
fn stable_path_for(by_id: &Path, node: &str) -> Option<PathBuf> {
    let mut links = std::fs::read_dir(by_id)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|link| {
            std::fs::read_link(link)
                .ok()
                .and_then(|target| target.file_name().map(|name| name == node))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    links.sort();
    links.into_iter().next()
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
}

/// One capture mode a V4L2 node advertises: a pixel format at one size,
/// with the frame-rate range the driver lists for it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct V4l2Mode {
    pub fourcc: u32,
    pub width: u32,
    pub height: u32,
    pub min_fps: f64,
    pub max_fps: f64,
}

/// A V4L2 fourcc (`v4l2_fourcc(a, b, c, d)` is little-endian).
pub const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*code)
}

const FOURCC_MJPG: u32 = fourcc(b"MJPG");
const FOURCC_JPEG: u32 = fourcc(b"JPEG");
const FOURCC_NV12: u32 = fourcc(b"NV12");
const FOURCC_YU12: u32 = fourcc(b"YU12");
const FOURCC_YUYV: u32 = fourcc(b"YUYV");
const FOURCC_UYVY: u32 = fourcc(b"UYVY");

/// The fourcc as Health shows it (`NV12`, `MJPG`, `YUYV`).
pub fn fourcc_label(code: u32) -> String {
    String::from_utf8_lossy(&code.to_le_bytes())
        .trim_end_matches([' ', '\0'])
        .to_string()
}

/// FFmpeg's `-input_format` name for the formats Videorc asks for by name.
/// Anything else (H.264, Bayer, vendor formats) is never chosen: it is
/// either a heavy decode or a conversion FFmpeg's V4L2 input lacks.
pub fn ffmpeg_input_format(code: u32) -> Option<&'static str> {
    match code {
        FOURCC_MJPG | FOURCC_JPEG => Some("mjpeg"),
        FOURCC_NV12 => Some("nv12"),
        FOURCC_YU12 => Some("yuv420p"),
        FOURCC_YUYV => Some("yuyv422"),
        FOURCC_UYVY => Some("uyvy422"),
        _ => None,
    }
}

/// Above this many pixels a USB camera's raw modes usually starve the bus
/// (1080p YUYV runs at 5 fps on USB 2), so MJPEG wins; at or below it raw
/// wins, because it skips a JPEG decode.
const MJPEG_PREFERRED_ABOVE_PIXELS: u64 = 1280 * 720;

fn format_rank(code: u32, pixels: u64) -> u8 {
    let raw_rank = match code {
        FOURCC_NV12 => 0,
        FOURCC_YU12 => 1,
        FOURCC_YUYV => 2,
        FOURCC_UYVY => 3,
        _ => 4,
    };
    let compressed = matches!(code, FOURCC_MJPG | FOURCC_JPEG);
    match (pixels > MJPEG_PREFERRED_ABOVE_PIXELS, compressed) {
        (true, true) => 0,
        (true, false) => 1 + raw_rank,
        (false, false) => raw_rank,
        (false, true) => 5,
    }
}

fn mode_reaches(mode: &V4l2Mode, fps: u32) -> bool {
    // 29.97 counts as 30.
    mode.max_fps + 0.5 >= f64::from(fps)
}

/// The camera's own mode for a session: one that reaches the session rate,
/// the most picture that still fits the canvas (by pixel count, so a
/// portrait canvas keeps a landscape camera's full mode), then the format
/// the cost rule above prefers. The compositor scales the result, so the
/// camera is never asked for more than it has.
pub fn choose_v4l2_mode(modes: &[V4l2Mode], target: (u32, u32), fps: u32) -> Option<V4l2Mode> {
    let target_pixels = u64::from(target.0) * u64::from(target.1);
    modes
        .iter()
        .filter(|mode| ffmpeg_input_format(mode.fourcc).is_some())
        .filter(|mode| mode.width > 0 && mode.height > 0)
        .min_by(|a, b| {
            let pixels = |mode: &V4l2Mode| u64::from(mode.width) * u64::from(mode.height);
            let size_rank = |mode: &V4l2Mode| {
                let pixels = pixels(mode);
                // Fitting modes first, biggest first; then the smallest
                // oversized one.
                if pixels <= target_pixels {
                    (0, u64::MAX - pixels)
                } else {
                    (1, pixels)
                }
            };
            mode_reaches(b, fps)
                .cmp(&mode_reaches(a, fps))
                .then_with(|| {
                    if mode_reaches(a, fps) {
                        std::cmp::Ordering::Equal
                    } else {
                        // Nothing reaches the rate: the fastest mode first.
                        b.max_fps.total_cmp(&a.max_fps)
                    }
                })
                .then_with(|| size_rank(a).cmp(&size_rank(b)))
                .then_with(|| {
                    format_rank(a.fourcc, pixels(a)).cmp(&format_rank(b.fourcc, pixels(b)))
                })
        })
        .copied()
}

/// The largest size any listed mode has, for fallbacks that cannot name a
/// mode but must not pipe more than the camera has.
pub fn largest_v4l2_size(modes: &[V4l2Mode]) -> Option<(u32, u32)> {
    modes
        .iter()
        .map(|mode| (mode.width, mode.height))
        .max_by_key(|(width, height)| u64::from(*width) * u64::from(*height))
}

/// One row per size for the camera capability matrix: the widest frame-rate
/// range any format offers at that size, biggest size first.
pub fn v4l2_size_summary(modes: &[V4l2Mode]) -> Vec<V4l2Mode> {
    let mut sizes: Vec<V4l2Mode> = Vec::new();
    for mode in modes {
        match sizes
            .iter_mut()
            .find(|size| size.width == mode.width && size.height == mode.height)
        {
            Some(size) => {
                size.min_fps = size.min_fps.min(mode.min_fps);
                size.max_fps = size.max_fps.max(mode.max_fps);
            }
            None => sizes.push(*mode),
        }
    }
    sizes.sort_by_key(|size| std::cmp::Reverse(u64::from(size.width) * u64::from(size.height)));
    sizes
}

/// How one preview attempt asks the camera for frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum V4l2CaptureRequest {
    /// One of the camera's listed modes, by format, size and rate.
    Mode(V4l2Mode),
    /// A size and rate; the driver negotiates its nearest mode.
    Size { width: u32, height: u32, fps: u32 },
    /// Whatever the device opens with.
    DeviceDefault,
}

/// FFmpeg args for one preview attempt: V4L2 in, BGRA out on stdout at
/// `output`. A listed mode whose size is the output is only converted (the
/// scale to its own size is a no-op that keeps every frame that size: the
/// raw pipe has no frame header, so a camera that changed size mid-stream
/// must not misalign it); anything else is fitted and padded to the box.
///
/// Every input goes through planar 4:2:0 first: swscale has a SIMD
/// YUV-to-RGB path for `yuv420p` but converts NV12 and YUYV to BGRA in its
/// generic scaler. On ogre's FaceTime HD camera (720p30) that is 23 % CPU
/// against 70 % (`~/linux-beta/s2`, plan 257 S2).
pub fn v4l2_preview_ffmpeg_args(
    device_path: &str,
    (width, height): (u32, u32),
    fps: u32,
    request: &V4l2CaptureRequest,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-nostdin".to_string(),
        "-f".to_string(),
        "v4l2".to_string(),
    ];
    let mut native_size = false;
    match request {
        V4l2CaptureRequest::Mode(mode) => {
            let input_format = ffmpeg_input_format(mode.fourcc).unwrap_or("nv12");
            // Ask no faster than the mode lists; the driver rounds to its
            // nearest interval.
            let rate = if mode.max_fps >= 1.0 {
                fps.min(mode.max_fps.round() as u32).max(1)
            } else {
                fps
            };
            args.extend([
                "-input_format".to_string(),
                input_format.to_string(),
                "-framerate".to_string(),
                rate.to_string(),
                "-video_size".to_string(),
                format!("{}x{}", mode.width, mode.height),
            ]);
            native_size = (mode.width, mode.height) == (width, height);
        }
        V4l2CaptureRequest::Size {
            width: capture_width,
            height: capture_height,
            fps,
        } => {
            args.extend([
                "-framerate".to_string(),
                fps.to_string(),
                "-video_size".to_string(),
                format!("{capture_width}x{capture_height}"),
            ]);
        }
        V4l2CaptureRequest::DeviceDefault => {}
    }
    let filter = if native_size {
        format!("format=yuv420p,scale={width}:{height},format=bgra")
    } else {
        // Pad after the BGRA conversion: 4:2:0 cannot pad to an odd size.
        format!(
            "format=yuv420p,scale={width}:{height}:force_original_aspect_ratio=decrease,format=bgra,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        )
    };
    args.extend([
        "-i".to_string(),
        device_path.to_string(),
        "-an".to_string(),
        "-vf".to_string(),
        filter,
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "bgra".to_string(),
        "-".to_string(),
    ]);
    args
}

/// Modes per device path, probed once (plan 257 S2). A device change or a
/// failed start forgets them, so a replugged camera is probed again.
#[cfg(target_os = "linux")]
fn mode_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<V4l2Mode>>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Vec<V4l2Mode>>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The modes `device_path` advertises, from the cache or a fresh probe.
#[cfg(target_os = "linux")]
pub fn cached_v4l2_modes(device_path: &str) -> Result<Vec<V4l2Mode>, String> {
    if let Some(modes) = mode_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(device_path)
    {
        return Ok(modes.clone());
    }
    let modes = ioctl::probe_v4l2_modes(Path::new(device_path))?;
    if modes.is_empty() {
        return Err(format!("{device_path} lists no capture mode."));
    }
    mode_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(device_path.to_string(), modes.clone());
    Ok(modes)
}

/// Forget one device's modes, or every device's (`None`, on a device change).
#[cfg(target_os = "linux")]
pub fn forget_v4l2_modes(device_path: Option<&str>) {
    let mut cache = mode_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match device_path {
        Some(path) => {
            cache.remove(path);
        }
        None => cache.clear(),
    }
}

/// Sizes a stepwise or continuous camera is offered at: its largest, plus
/// the common sizes its range and step allow.
fn stepwise_sizes(
    (min_width, max_width, step_width): (u32, u32, u32),
    (min_height, max_height, step_height): (u32, u32, u32),
) -> Vec<(u32, u32)> {
    let fits = |value: u32, min: u32, max: u32, step: u32| {
        value >= min && value <= max && (step <= 1 || (value - min).is_multiple_of(step))
    };
    let mut sizes = vec![(max_width, max_height)];
    for (width, height) in [
        (3840, 2160),
        (2560, 1440),
        (1920, 1080),
        (1280, 720),
        (960, 540),
        (640, 480),
        (640, 360),
    ] {
        if fits(width, min_width, max_width, step_width)
            && fits(height, min_height, max_height, step_height)
            && !sizes.contains(&(width, height))
        {
            sizes.push((width, height));
        }
    }
    sizes
}

/// V4L2 enumeration (`VIDIOC_ENUM_FMT`, `VIDIOC_ENUM_FRAMESIZES`,
/// `VIDIOC_ENUM_FRAMEINTERVALS`). Enumerating never starts streaming, so it
/// is safe while another process captures from the node. Only Linux runs
/// the probe; tests elsewhere check the ABI mirror.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod ioctl {
    #[cfg(target_os = "linux")]
    use std::path::Path;

    #[cfg(target_os = "linux")]
    use super::V4l2Mode;

    const V4L2_BUF_TYPE_VIDEO_CAPTURE: u32 = 1;
    const V4L2_FRMSIZE_TYPE_DISCRETE: u32 = 1;
    const V4L2_FRMIVAL_TYPE_DISCRETE: u32 = 1;

    #[repr(C)]
    pub(super) struct FmtDesc {
        pub index: u32,
        pub kind: u32,
        pub flags: u32,
        pub description: [u8; 32],
        pub pixelformat: u32,
        pub mbus_code: u32,
        pub reserved: [u32; 3],
    }

    #[repr(C)]
    pub(super) struct FrmSizeEnum {
        pub index: u32,
        pub pixel_format: u32,
        pub kind: u32,
        /// `discrete {width, height}` or `stepwise {min_width, max_width,
        /// step_width, min_height, max_height, step_height}`.
        pub data: [u32; 6],
        pub reserved: [u32; 2],
    }

    #[repr(C)]
    pub(super) struct FrmIvalEnum {
        pub index: u32,
        pub pixel_format: u32,
        pub width: u32,
        pub height: u32,
        pub kind: u32,
        /// `discrete {numerator, denominator}` or `stepwise {min, max, step}`
        /// as three fractions.
        pub data: [u32; 6],
        pub reserved: [u32; 2],
    }

    const _: () = assert!(std::mem::size_of::<FmtDesc>() == 64);
    const _: () = assert!(std::mem::size_of::<FrmSizeEnum>() == 44);
    const _: () = assert!(std::mem::size_of::<FrmIvalEnum>() == 52);

    /// `_IOWR('V', nr, size)` in the generic Linux ioctl encoding.
    pub(super) const fn iowr(nr: u32, size: usize) -> u32 {
        (3 << 30) | ((size as u32) << 16) | ((b'V' as u32) << 8) | nr
    }

    pub(super) const VIDIOC_ENUM_FMT: u32 = iowr(2, std::mem::size_of::<FmtDesc>());
    pub(super) const VIDIOC_ENUM_FRAMESIZES: u32 = iowr(74, std::mem::size_of::<FrmSizeEnum>());
    pub(super) const VIDIOC_ENUM_FRAMEINTERVALS: u32 = iowr(75, std::mem::size_of::<FrmIvalEnum>());

    /// Frames per second for `numerator/denominator` seconds per frame.
    pub(super) fn fps(numerator: u32, denominator: u32) -> Option<f64> {
        (numerator > 0 && denominator > 0).then(|| f64::from(denominator) / f64::from(numerator))
    }

    /// `(min_fps, max_fps)` from enumerated intervals.
    pub(super) fn fps_range(intervals: &[FrmIvalEnum]) -> Option<(f64, f64)> {
        let mut range: Option<(f64, f64)> = None;
        for interval in intervals {
            let rates: Vec<f64> = if interval.kind == V4L2_FRMIVAL_TYPE_DISCRETE {
                fps(interval.data[0], interval.data[1])
                    .into_iter()
                    .collect()
            } else {
                // Stepwise/continuous: the shortest interval is the fastest.
                [
                    fps(interval.data[0], interval.data[1]),
                    fps(interval.data[2], interval.data[3]),
                ]
                .into_iter()
                .flatten()
                .collect()
            };
            for rate in rates {
                range = Some(match range {
                    Some((min, max)) => (min.min(rate), max.max(rate)),
                    None => (rate, rate),
                });
            }
        }
        range
    }

    pub(super) fn sizes_of(size: &FrmSizeEnum) -> Vec<(u32, u32)> {
        if size.kind == V4L2_FRMSIZE_TYPE_DISCRETE {
            vec![(size.data[0], size.data[1])]
        } else {
            super::stepwise_sizes(
                (size.data[0], size.data[1], size.data[2]),
                (size.data[3], size.data[4], size.data[5]),
            )
        }
    }

    #[cfg(target_os = "linux")]
    fn enumerate<T>(fd: i32, request: u32, mut make: impl FnMut(u32) -> T, cap: u32) -> Vec<T> {
        let mut entries = Vec::new();
        for index in 0..cap {
            let mut entry = make(index);
            let result = loop {
                // SAFETY: `entry` is the repr(C) struct this request reads and
                // writes, sized into the request number; it outlives the call.
                let result = unsafe {
                    libc::ioctl(fd, request as _, &mut entry as *mut T as *mut libc::c_void)
                };
                if result == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                {
                    continue;
                }
                break result;
            };
            if result == -1 {
                // EINVAL past the last entry, or any other error: stop.
                break;
            }
            entries.push(entry);
        }
        entries
    }

    #[cfg(target_os = "linux")]
    pub fn probe_v4l2_modes(device_path: &Path) -> Result<Vec<V4l2Mode>, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(device_path)
            .map_err(|error| format!("Cannot open {}: {error}", device_path.display()))?;
        let fd = file.as_raw_fd();
        let formats = enumerate(
            fd,
            VIDIOC_ENUM_FMT,
            |index| FmtDesc {
                index,
                kind: V4L2_BUF_TYPE_VIDEO_CAPTURE,
                flags: 0,
                description: [0; 32],
                pixelformat: 0,
                mbus_code: 0,
                reserved: [0; 3],
            },
            64,
        );
        let mut modes = Vec::new();
        for format in &formats {
            let sizes = enumerate(
                fd,
                VIDIOC_ENUM_FRAMESIZES,
                |index| FrmSizeEnum {
                    index,
                    pixel_format: format.pixelformat,
                    kind: 0,
                    data: [0; 6],
                    reserved: [0; 2],
                },
                256,
            );
            for (width, height) in sizes.iter().flat_map(sizes_of) {
                let intervals = enumerate(
                    fd,
                    VIDIOC_ENUM_FRAMEINTERVALS,
                    |index| FrmIvalEnum {
                        index,
                        pixel_format: format.pixelformat,
                        width,
                        height,
                        kind: 0,
                        data: [0; 6],
                        reserved: [0; 2],
                    },
                    256,
                );
                // A size with no listed rate keeps 0: never preferred, still
                // shown.
                let (min_fps, max_fps) = fps_range(&intervals).unwrap_or((0.0, 0.0));
                modes.push(V4l2Mode {
                    fourcc: format.pixelformat,
                    width,
                    height,
                    min_fps,
                    max_fps,
                });
            }
        }
        Ok(modes)
    }
}

/// Why a V4L2 preview produced no frame, from FFmpeg's stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V4l2StartFailure {
    PermissionNeeded(String),
    DeviceMissing(String),
    Failed(String),
}

pub fn classify_v4l2_failure(device_path: &str, stderr: &str) -> V4l2StartFailure {
    let detail = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("FFmpeg ended before the first frame");
    let lower = stderr.to_lowercase();
    if lower.contains("permission denied") {
        V4l2StartFailure::PermissionNeeded(format!(
            "Cannot open camera {device_path}: add your user to the `video` group and log in again ({detail})."
        ))
    } else if lower.contains("no such file or directory") || lower.contains("no such device") {
        V4l2StartFailure::DeviceMissing(format!(
            "Camera {device_path} is not connected ({detail})."
        ))
    } else if lower.contains("device or resource busy") {
        V4l2StartFailure::Failed(format!(
            "Camera {device_path} is in use by another application ({detail})."
        ))
    } else {
        V4l2StartFailure::Failed(format!(
            "Linux V4L2 camera preview ended before the first frame: {detail}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_tree() -> (PathBuf, V4l2Roots) {
        let root = std::env::temp_dir().join(format!("videorc-v4l2-{}", uuid::Uuid::new_v4()));
        let sysfs = root.join("sys");
        let dev = root.join("dev");
        let by_id = root.join("by-id");
        for (node, name, index) in [
            ("video0", "FaceTime HD Camera (Built-in): ", "0"),
            ("video1", "FaceTime HD Camera (Built-in): ", "1"),
            ("video2", "USB Cam", "0"),
            // Plan 214 A5: Videorc Camera's own loopback device, never listed.
            ("video42", "Videorc Camera", "0"),
        ] {
            std::fs::create_dir_all(sysfs.join(node)).unwrap();
            std::fs::write(sysfs.join(node).join("name"), format!("{name}\n")).unwrap();
            std::fs::write(sysfs.join(node).join("index"), format!("{index}\n")).unwrap();
        }
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::create_dir_all(&by_id).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            "../../video0",
            by_id.join("usb-Apple_FaceTime-video-index0"),
        )
        .unwrap();
        (
            root,
            V4l2Roots {
                sysfs_class: sysfs,
                dev,
                by_id,
            },
        )
    }

    #[test]
    fn v4l2_ids_round_trip_device_paths() {
        let id = linux_v4l2_camera_id("/dev/v4l/by-id/usb-cam-video-index0");
        assert!(id.starts_with(LINUX_V4L2_CAMERA_PREFIX));
        assert_eq!(
            parse_linux_v4l2_camera_id(&id).as_deref(),
            Some("/dev/v4l/by-id/usb-cam-video-index0")
        );
        assert_eq!(
            parse_linux_v4l2_camera_id(&linux_v4l2_camera_id("video0")),
            None
        );
        assert_eq!(parse_linux_v4l2_camera_id("camera:linux-v4l2:zz"), None);
        assert_eq!(parse_linux_v4l2_camera_id("camera:windows-dshow:00"), None);
    }

    #[test]
    fn discovery_keeps_capture_nodes_names_them_and_prefers_stable_links() {
        let (root, roots) = fake_tree();
        let devices = list_v4l2_cameras(&roots, |path| {
            if path.ends_with("video2") {
                NodeAccess::PermissionDenied
            } else {
                NodeAccess::Ok
            }
        });
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(devices.len(), 2, "{devices:?}");
        assert!(
            devices.iter().all(|device| device.name != "Videorc Camera"),
            "Videorc Camera is never a source of itself (plan 214 A5): {devices:?}"
        );
        assert_eq!(devices[0].name, "FaceTime HD Camera (Built-in)");
        assert_eq!(devices[0].kind, DeviceKind::Camera);
        assert_eq!(devices[0].status, DeviceStatus::Available);
        // The fake tree lives under the temp dir, so compare whole ids (the
        // parser only accepts real `/dev/` paths).
        #[cfg(unix)]
        let stable = roots.by_id.join("usb-Apple_FaceTime-video-index0");
        #[cfg(not(unix))]
        let stable = roots.dev.join("video0");
        assert_eq!(
            devices[0].id,
            linux_v4l2_camera_id(&stable.to_string_lossy())
        );
        assert_eq!(devices[1].name, "USB Cam");
        assert_eq!(devices[1].status, DeviceStatus::PermissionRequired);
        assert!(
            devices[1]
                .detail
                .as_deref()
                .unwrap()
                .contains("`video` group")
        );
        assert_eq!(
            devices[1].id,
            linux_v4l2_camera_id(&roots.dev.join("video2").to_string_lossy())
        );
    }

    #[test]
    fn missing_sysfs_lists_nothing() {
        let roots = V4l2Roots {
            sysfs_class: PathBuf::from("/nonexistent/videorc/sysfs"),
            ..V4l2Roots::default()
        };
        assert!(list_v4l2_cameras(&roots, |_| NodeAccess::Ok).is_empty());
    }

    fn mode(code: &[u8; 4], width: u32, height: u32, max_fps: f64) -> V4l2Mode {
        V4l2Mode {
            fourcc: fourcc(code),
            width,
            height,
            min_fps: 1.0,
            max_fps,
        }
    }

    /// The lid camera on ogre (FaceTime HD over the T2): NV12 and YUYV at
    /// 1280x720 and 640x480, 1-30 fps (`v4l2-ctl --list-formats-ext`).
    fn facetime_hd() -> Vec<V4l2Mode> {
        vec![
            mode(b"NV12", 1280, 720, 30.0),
            mode(b"NV12", 640, 480, 30.0),
            mode(b"YUYV", 1280, 720, 30.0),
            mode(b"YUYV", 640, 480, 30.0),
        ]
    }

    /// A typical USB 2 webcam: raw 1080p crawls, MJPEG does 30 everywhere.
    fn usb_webcam() -> Vec<V4l2Mode> {
        vec![
            mode(b"YUYV", 1920, 1080, 5.0),
            mode(b"YUYV", 1280, 720, 10.0),
            mode(b"YUYV", 640, 480, 30.0),
            mode(b"MJPG", 1920, 1080, 30.0),
            mode(b"MJPG", 1280, 720, 30.0),
            mode(b"MJPG", 640, 480, 30.0),
            mode(b"H264", 1920, 1080, 30.0),
        ]
    }

    #[test]
    fn fourccs_label_and_map_to_ffmpeg_input_formats() {
        assert_eq!(fourcc(b"NV12"), 0x3231_564e);
        assert_eq!(fourcc_label(fourcc(b"NV12")), "NV12");
        assert_eq!(fourcc_label(fourcc(b"Y16 ")), "Y16");
        assert_eq!(ffmpeg_input_format(fourcc(b"MJPG")), Some("mjpeg"));
        assert_eq!(ffmpeg_input_format(fourcc(b"YUYV")), Some("yuyv422"));
        assert_eq!(ffmpeg_input_format(fourcc(b"NV12")), Some("nv12"));
        assert_eq!(ffmpeg_input_format(fourcc(b"H264")), None);
    }

    #[test]
    fn the_facetime_camera_gets_its_native_720p_nv12_on_a_1080p_canvas() {
        // The plan 257 evidence: the old path asked this camera for 1080p
        // and scaled 720p up on the CPU (~180 % CPU).
        assert_eq!(
            choose_v4l2_mode(&facetime_hd(), (1920, 1080), 30),
            Some(mode(b"NV12", 1280, 720, 30.0))
        );
        // A 480p canvas takes the camera's 480p mode, not a downscale.
        assert_eq!(
            choose_v4l2_mode(&facetime_hd(), (640, 480), 30),
            Some(mode(b"NV12", 640, 480, 30.0))
        );
    }

    #[test]
    fn usb_cameras_take_mjpeg_above_720p_and_raw_at_or_below() {
        assert_eq!(
            choose_v4l2_mode(&usb_webcam(), (1920, 1080), 30),
            Some(mode(b"MJPG", 1920, 1080, 30.0))
        );
        // At 720p raw would win, but it only does 10 fps here.
        assert_eq!(
            choose_v4l2_mode(&usb_webcam(), (1280, 720), 30),
            Some(mode(b"MJPG", 1280, 720, 30.0))
        );
        assert_eq!(
            choose_v4l2_mode(&usb_webcam(), (640, 480), 30),
            Some(mode(b"YUYV", 640, 480, 30.0))
        );
        // A raw 720p30 mode beats MJPEG at 720p: no JPEG decode.
        let mut fast_raw = usb_webcam();
        fast_raw.push(mode(b"YUYV", 1280, 720, 30.0));
        assert_eq!(
            choose_v4l2_mode(&fast_raw, (1280, 720), 30),
            Some(mode(b"YUYV", 1280, 720, 30.0))
        );
        // A portrait canvas compares by pixels, so it keeps 1080p.
        assert_eq!(
            choose_v4l2_mode(&usb_webcam(), (1080, 1920), 30),
            Some(mode(b"MJPG", 1920, 1080, 30.0))
        );
    }

    #[test]
    fn rate_then_size_decides_when_modes_fall_short() {
        // Nothing fits a 360p canvas: the smallest oversized mode.
        assert_eq!(
            choose_v4l2_mode(&facetime_hd(), (640, 360), 30),
            Some(mode(b"NV12", 640, 480, 30.0))
        );
        // 60 fps asked, nothing reaches it: the fastest mode wins over size.
        let modes = vec![
            mode(b"YUYV", 1280, 720, 10.0),
            mode(b"YUYV", 640, 480, 30.0),
        ];
        assert_eq!(
            choose_v4l2_mode(&modes, (1280, 720), 60),
            Some(mode(b"YUYV", 640, 480, 30.0))
        );
        // 29.97 counts as 30.
        let ntsc = vec![
            mode(b"NV12", 1280, 720, 29.97),
            mode(b"NV12", 640, 480, 60.0),
        ];
        assert_eq!(
            choose_v4l2_mode(&ntsc, (1920, 1080), 30),
            Some(mode(b"NV12", 1280, 720, 29.97))
        );
        // Only formats FFmpeg is asked for by name are ever chosen.
        assert_eq!(
            choose_v4l2_mode(&[mode(b"H264", 1920, 1080, 30.0)], (1920, 1080), 30),
            None
        );
        assert_eq!(choose_v4l2_mode(&[], (1920, 1080), 30), None);
    }

    #[test]
    fn size_summary_merges_formats_per_size_biggest_first() {
        let summary = v4l2_size_summary(&usb_webcam());
        let sizes: Vec<_> = summary
            .iter()
            .map(|size| (size.width, size.height, size.max_fps))
            .collect();
        assert_eq!(
            sizes,
            [(1920, 1080, 30.0), (1280, 720, 30.0), (640, 480, 30.0)]
        );
        assert_eq!(largest_v4l2_size(&facetime_hd()), Some((1280, 720)));
        assert_eq!(largest_v4l2_size(&[]), None);
    }

    #[test]
    fn stepwise_cameras_offer_their_largest_and_the_common_sizes_they_allow() {
        assert_eq!(
            stepwise_sizes((160, 1920, 16), (120, 1080, 8)),
            [(1920, 1080), (1280, 720), (640, 480), (640, 360)]
        );
        assert_eq!(
            stepwise_sizes((320, 800, 0), (240, 600, 0)),
            [(800, 600), (640, 480), (640, 360)]
        );
    }

    #[test]
    fn ioctl_numbers_and_rates_match_the_kernel_headers() {
        // videodev2.h on x86_64 and aarch64.
        assert_eq!(ioctl::VIDIOC_ENUM_FMT, 0xC040_5602);
        assert_eq!(ioctl::VIDIOC_ENUM_FRAMESIZES, 0xC02C_564A);
        assert_eq!(ioctl::VIDIOC_ENUM_FRAMEINTERVALS, 0xC034_564B);
        let interval = |kind, data| ioctl::FrmIvalEnum {
            index: 0,
            pixel_format: 0,
            width: 0,
            height: 0,
            kind,
            data,
            reserved: [0; 2],
        };
        assert_eq!(
            ioctl::fps_range(&[
                interval(1, [1, 30, 0, 0, 0, 0]),
                interval(1, [1001, 30000, 0, 0, 0, 0]),
                interval(1, [1, 5, 0, 0, 0, 0]),
            ]),
            Some((5.0, 30.0))
        );
        // Stepwise: 1/60 s to 1/2 s.
        assert_eq!(
            ioctl::fps_range(&[interval(3, [1, 60, 1, 2, 1, 1])]),
            Some((2.0, 60.0))
        );
        assert_eq!(ioctl::fps_range(&[interval(1, [0, 0, 0, 0, 0, 0])]), None);
        let discrete = ioctl::FrmSizeEnum {
            index: 0,
            pixel_format: 0,
            kind: 1,
            data: [1280, 720, 0, 0, 0, 0],
            reserved: [0; 2],
        };
        assert_eq!(ioctl::sizes_of(&discrete), [(1280, 720)]);
    }

    #[test]
    fn a_native_mode_is_converted_never_scaled() {
        let args = v4l2_preview_ffmpeg_args(
            "/dev/video0",
            (1280, 720),
            30,
            &V4l2CaptureRequest::Mode(mode(b"NV12", 1280, 720, 30.0)),
        );
        assert_eq!(
            args,
            [
                "-hide_banner",
                "-loglevel",
                "warning",
                "-nostdin",
                "-f",
                "v4l2",
                "-input_format",
                "nv12",
                "-framerate",
                "30",
                "-video_size",
                "1280x720",
                "-i",
                "/dev/video0",
                "-an",
                "-vf",
                "format=yuv420p,scale=1280:720,format=bgra",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-"
            ]
        );
        // A mode bigger than the canvas is scaled down to the fitted box,
        // and never asked faster than it lists.
        let args = v4l2_preview_ffmpeg_args(
            "/dev/video2",
            (1920, 1080),
            60,
            &V4l2CaptureRequest::Mode(mode(b"MJPG", 3840, 2160, 30.0)),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-input_format mjpeg -framerate 30 -video_size 3840x2160"));
        assert!(joined.contains(
            "format=yuv420p,scale=1920:1080:force_original_aspect_ratio=decrease,format=bgra,pad=1920:1080:"
        ));
    }

    #[test]
    fn fallback_args_request_then_negotiate() {
        let joined = v4l2_preview_ffmpeg_args(
            "/dev/video0",
            (1280, 720),
            30,
            &V4l2CaptureRequest::Size {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        )
        .join(" ");
        assert!(joined.contains("-f v4l2 -framerate 30 -video_size 1920x1080 -i /dev/video0"));
        assert!(!joined.contains("-input_format"));
        assert!(joined.contains(
            "format=yuv420p,scale=1280:720:force_original_aspect_ratio=decrease,format=bgra,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
        ));
        let default = v4l2_preview_ffmpeg_args(
            "/dev/video0",
            (640, 360),
            30,
            &V4l2CaptureRequest::DeviceDefault,
        );
        assert!(!default.contains(&"-framerate".to_string()));
        assert!(!default.contains(&"-video_size".to_string()));
    }

    /// Reads the real cameras' modes on a Linux box (evidence for plan 257
    /// S2): `cargo test ... v4l2_probe_reads_real_cameras -- --ignored
    /// --nocapture`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a real V4L2 camera"]
    fn v4l2_probe_reads_real_cameras() {
        let cameras = list_v4l2_cameras(&V4l2Roots::default(), node_access);
        assert!(!cameras.is_empty(), "no V4L2 camera on this box");
        for camera in cameras {
            let path = parse_linux_v4l2_camera_id(&camera.id).unwrap();
            let modes = ioctl::probe_v4l2_modes(Path::new(&path)).unwrap();
            println!("{} ({path}):", camera.name);
            for mode in &modes {
                println!(
                    "  {} {}x{} {:.0}-{:.0} fps",
                    fourcc_label(mode.fourcc),
                    mode.width,
                    mode.height,
                    mode.min_fps,
                    mode.max_fps
                );
            }
            let chosen = choose_v4l2_mode(&modes, (1920, 1080), 30).unwrap();
            println!(
                "  chosen for 1920x1080@30: {} {}x{} up to {:.0} fps",
                fourcc_label(chosen.fourcc),
                chosen.width,
                chosen.height,
                chosen.max_fps
            );
            assert!(!modes.is_empty());
        }
    }

    #[test]
    fn v4l2_failures_name_the_fix() {
        assert!(matches!(
            classify_v4l2_failure("/dev/video0", "[video4linux2] Cannot open video device /dev/video0: Permission denied\n"),
            V4l2StartFailure::PermissionNeeded(message) if message.contains("`video` group")
        ));
        assert!(matches!(
            classify_v4l2_failure("/dev/video9", "/dev/video9: No such file or directory"),
            V4l2StartFailure::DeviceMissing(_)
        ));
        assert!(matches!(
            classify_v4l2_failure("/dev/video0", "ioctl(VIDIOC_STREAMON): Device or resource busy"),
            V4l2StartFailure::Failed(message) if message.contains("in use")
        ));
        assert!(matches!(
            classify_v4l2_failure("/dev/video0", ""),
            V4l2StartFailure::Failed(message) if message.contains("before the first frame")
        ));
    }
}
