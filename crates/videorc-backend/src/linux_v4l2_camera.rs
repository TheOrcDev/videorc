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
    Missing,
}

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
        .map(|(_, node, sysfs)| {
            let dev_path = roots.dev.join(&node);
            let device_path = stable_path_for(&roots.by_id, &node).unwrap_or(dev_path.clone());
            let name = read_trimmed(&sysfs.join("name"))
                .map(|name| name.trim_end_matches(':').trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| node.clone());
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
            Device {
                app: None,
                window_title: None,
                id: linux_v4l2_camera_id(&device_path.to_string_lossy()),
                name,
                kind: DeviceKind::Camera,
                status,
                detail: Some(detail),
                width: None,
                height: None,
            }
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

/// FFmpeg args for one preview attempt: V4L2 in, scaled/padded BGRA out on
/// stdout. `request` asks for a size and rate; the driver negotiates the
/// nearest mode it has (a 1080p request on a 720p camera streams 720p), and
/// `None` takes the device default.
pub fn v4l2_preview_ffmpeg_args(
    device_path: &str,
    width: u32,
    height: u32,
    request: Option<(u32, u32, u32)>,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-nostdin".to_string(),
        "-f".to_string(),
        "v4l2".to_string(),
    ];
    if let Some((capture_width, capture_height, fps)) = request {
        args.extend([
            "-framerate".to_string(),
            fps.to_string(),
            "-video_size".to_string(),
            format!("{capture_width}x{capture_height}"),
        ]);
    }
    args.extend([
        "-i".to_string(),
        device_path.to_string(),
        "-an".to_string(),
        "-vf".to_string(),
        format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=bgra"
        ),
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

    #[test]
    fn preview_args_request_then_negotiate() {
        assert_eq!(
            v4l2_preview_ffmpeg_args("/dev/video0", 1280, 720, Some((1920, 1080, 30))),
            [
                "-hide_banner",
                "-loglevel",
                "warning",
                "-nostdin",
                "-f",
                "v4l2",
                "-framerate",
                "30",
                "-video_size",
                "1920x1080",
                "-i",
                "/dev/video0",
                "-an",
                "-vf",
                "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=bgra",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-"
            ]
        );
        let default = v4l2_preview_ffmpeg_args("/dev/video0", 640, 360, None);
        assert!(!default.contains(&"-framerate".to_string()));
        assert!(!default.contains(&"-video_size".to_string()));
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
