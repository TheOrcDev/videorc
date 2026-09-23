//! Linux VAAPI render-node policy (Plan 052).
//!
//! A multi-GPU Linux box can carry a render node whose driver hangs the whole
//! host when it is asked to encode (ogre's T2 MacBook Pro Radeon, 2026-09-24).
//! The backend must therefore never wander from node to node hoping one works.
//! This module owns the three rules that make probing safe:
//!
//! - an explicit pin (`VIDEORC_LINUX_VAAPI_DEVICE`) limits probing to one node;
//! - a crash-safe sentinel is written before each probe and removed after it
//!   returns, so a probe that never came back (the host hung) quarantines that
//!   node on the next start instead of being tried again; and
//! - the driver behind every node is listed in diagnostics so the evidence says
//!   which GPU encoded, without any driver blocklist in the product.
//!
//! The probe itself runs the session's real encode arguments at 1080p30 through
//! the bridge's own filter chain so a probe pass predicts a session pass.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::protocol::{LinuxRenderNodeDiagnostic, LinuxRenderNodeState, VideoSettings};

pub(crate) const DEVICE_PIN_ENV: &str = "VIDEORC_LINUX_VAAPI_DEVICE";
pub(crate) const QUARANTINE_DIRECTORY_NAME: &str = "linux-vaapi";
const PROBE_IN_PROGRESS_FILE: &str = "probe-in-progress.json";
const QUARANTINED_FILE: &str = "quarantined.json";

/// Frames the real-args probe encodes: one keyframe interval at 30 fps is
/// enough to exercise rate control without stalling startup.
pub(crate) const PROBE_FRAMES: u32 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderNodeCandidate {
    pub(crate) path: PathBuf,
    pub(crate) driver: Option<String>,
}

impl RenderNodeCandidate {
    pub(crate) fn node_name(&self) -> String {
        self.path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    }

    pub(crate) fn report(
        &self,
        state: LinuxRenderNodeState,
        detail: Option<String>,
    ) -> LinuxRenderNodeDiagnostic {
        LinuxRenderNodeDiagnostic {
            node: self.node_name(),
            driver: self.driver.clone(),
            state,
            detail,
        }
    }

    pub(crate) fn describe(&self) -> String {
        format!(
            "{} ({})",
            self.node_name(),
            self.driver.as_deref().unwrap_or("driver unknown")
        )
    }
}

fn is_render_node_name(name: &str) -> bool {
    name.strip_prefix("renderD")
        .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()))
}

/// `VIDEORC_LINUX_VAAPI_DEVICE`: unset or blank means automatic; otherwise it
/// must name a `/dev/dri/renderD*` node by absolute path. A bad value is a
/// typed startup error, never a silent fallback.
pub(crate) fn parse_device_pin(value: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(value);
    let node_ok = path.is_absolute()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_render_node_name);
    if !node_ok {
        return Err(format!(
            "{DEVICE_PIN_ENV} must name a /dev/dri/renderD* node by absolute path; got {value}"
        ));
    }
    Ok(Some(path.to_path_buf()))
}

/// The driver bound to a render node, read from sysfs
/// (`/sys/class/drm/<node>/device/driver` → `.../drivers/<name>`). `None`
/// when sysfs is unreadable; the node is still probed, the evidence just says
/// "driver unknown".
pub(crate) fn driver_for_node(sysfs_drm_directory: &Path, node_name: &str) -> Option<String> {
    let link = sysfs_drm_directory
        .join(node_name)
        .join("device")
        .join("driver");
    std::fs::read_link(link)
        .ok()?
        .file_name()?
        .to_str()
        .map(str::to_string)
}

/// Sorted numbered render nodes with their drivers.
pub(crate) fn render_node_candidates(
    dri_directory: &Path,
    sysfs_drm_directory: &Path,
) -> Vec<RenderNodeCandidate> {
    let mut candidates = std::fs::read_dir(dri_directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            is_render_node_name(name).then(|| RenderNodeCandidate {
                path: entry.path(),
                driver: driver_for_node(sysfs_drm_directory, name),
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    candidates
}

/// Written before a probe starts; removed when the probe returns. If the file
/// survives a restart, the probe never returned and the node is quarantined.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProbeSentinel {
    node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    driver: Option<String>,
    ffmpeg_path: String,
    started_at_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuarantineEntry {
    pub(crate) node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) driver: Option<String>,
    pub(crate) ffmpeg_path: String,
    pub(crate) probe_started_at_unix_secs: u64,
    pub(crate) quarantined_at_unix_secs: u64,
}

impl QuarantineEntry {
    pub(crate) fn detail(&self) -> String {
        format!(
            "quarantined: a VAAPI probe of this node started at unix {} and never returned (delete {} under the app data directory, or pin the node with {}, to try it again)",
            self.probe_started_at_unix_secs, QUARANTINED_FILE, DEVICE_PIN_ENV
        )
    }
}

/// Write via a sibling temp file and rename so a crash mid-write never leaves
/// a half-written sentinel or list (a truncated sentinel would read as "no
/// probe in progress" and forfeit the quarantine).
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes)?;
    let result = crate::atomic_file::replace_file(&temp, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
pub(crate) struct ProbeQuarantine {
    directory: PathBuf,
}

impl ProbeQuarantine {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// Beside the database, so smokes with an isolated
    /// `VIDEORC_DATABASE_PATH` never read or write the owner's quarantine.
    pub(crate) fn default_directory() -> PathBuf {
        let database = crate::storage::default_database_path();
        database
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(QUARANTINE_DIRECTORY_NAME)
    }

    fn sentinel_path(&self) -> PathBuf {
        self.directory.join(PROBE_IN_PROGRESS_FILE)
    }

    fn quarantined_path(&self) -> PathBuf {
        self.directory.join(QUARANTINED_FILE)
    }

    /// A sentinel left over from a previous process means that probe never
    /// returned. Move it into the quarantine list and report it.
    pub(crate) fn adopt_stale_sentinel(&self) -> std::io::Result<Option<QuarantineEntry>> {
        let sentinel_path = self.sentinel_path();
        let raw = match std::fs::read(&sentinel_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let sentinel: ProbeSentinel = serde_json::from_slice(&raw).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unreadable probe sentinel {}: {error}",
                    sentinel_path.display()
                ),
            )
        })?;
        let entry = QuarantineEntry {
            node: sentinel.node,
            driver: sentinel.driver,
            ffmpeg_path: sentinel.ffmpeg_path,
            probe_started_at_unix_secs: sentinel.started_at_unix_secs,
            quarantined_at_unix_secs: unix_now(),
        };
        let mut entries = self.quarantined();
        entries.retain(|existing| existing.node != entry.node);
        entries.push(entry.clone());
        self.write_quarantined(&entries)?;
        std::fs::remove_file(&sentinel_path)?;
        Ok(Some(entry))
    }

    /// Missing or unreadable lists read as empty; an unreadable list is
    /// replaced the next time a node is quarantined.
    pub(crate) fn quarantined(&self) -> Vec<QuarantineEntry> {
        std::fs::read(self.quarantined_path())
            .ok()
            .and_then(|raw| serde_json::from_slice::<Vec<QuarantineEntry>>(&raw).ok())
            .unwrap_or_default()
    }

    fn write_quarantined(&self, entries: &[QuarantineEntry]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        let json = serde_json::to_vec_pretty(entries)?;
        write_atomic(&self.quarantined_path(), &json)
    }

    /// Arm the sentinel for one node. If this fails the caller must not probe:
    /// a probe without a sentinel could hang the host with nothing remembered.
    pub(crate) fn begin_probe(
        &self,
        candidate: &RenderNodeCandidate,
        ffmpeg_path: &str,
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        let sentinel = ProbeSentinel {
            node: candidate.node_name(),
            driver: candidate.driver.clone(),
            ffmpeg_path: ffmpeg_path.to_string(),
            started_at_unix_secs: unix_now(),
        };
        let json = serde_json::to_vec_pretty(&sentinel)?;
        write_atomic(&self.sentinel_path(), &json)
    }

    /// The probe returned (pass or fail): the sentinel no longer means a hang.
    pub(crate) fn finish_probe(&self) -> std::io::Result<()> {
        match std::fs::remove_file(self.sentinel_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

/// Which nodes get probed, and the diagnostics rows for the ones that do not.
/// A pin narrows probing to that one node and overrides its quarantine (the
/// operator asked for it by name); without a pin, quarantined nodes are never
/// touched.
pub(crate) fn plan_probe_order(
    candidates: &[RenderNodeCandidate],
    pin: Option<&Path>,
    quarantined: &[QuarantineEntry],
) -> Result<(Vec<RenderNodeCandidate>, Vec<LinuxRenderNodeDiagnostic>), String> {
    let mut to_probe = Vec::new();
    let mut reports = Vec::new();
    if let Some(pin) = pin {
        let Some(pinned) = candidates.iter().find(|candidate| candidate.path == pin) else {
            return Err(format!(
                "{DEVICE_PIN_ENV} names {}, which is not a render node on this machine (available: {})",
                pin.display(),
                if candidates.is_empty() {
                    "none".to_string()
                } else {
                    candidates
                        .iter()
                        .map(RenderNodeCandidate::describe)
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ));
        };
        for candidate in candidates {
            if candidate.path == pin {
                continue;
            }
            reports.push(candidate.report(
                LinuxRenderNodeState::Skipped,
                Some(format!("not the node pinned by {DEVICE_PIN_ENV}")),
            ));
        }
        to_probe.push(pinned.clone());
        return Ok((to_probe, reports));
    }
    for candidate in candidates {
        let node = candidate.node_name();
        if let Some(entry) = quarantined.iter().find(|entry| entry.node == node) {
            reports.push(candidate.report(LinuxRenderNodeState::Quarantined, Some(entry.detail())));
            continue;
        }
        to_probe.push(candidate.clone());
    }
    Ok((to_probe, reports))
}

/// The profile the probe encodes. 1080p30 at the tutorial bitrate is the
/// contract the L1.5 acceptance measures.
pub(crate) fn probe_video_settings() -> VideoSettings {
    VideoSettings {
        preset: crate::protocol::VideoPreset::Tutorial1080p30,
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate_kbps: 8000,
    }
}

/// The bridge feeds RGBA raw frames and converts to NV12 before `hwupload`
/// (`bridge_recording_video_filter_for_encoder`); the probe mirrors that
/// exactly so the driver sees the same upload path a session uses.
pub(crate) fn probe_filter(video: &VideoSettings) -> String {
    format!(
        "setpts=PTS-STARTPTS,fps={},format=nv12,hwupload",
        video.fps.max(1)
    )
}

/// FFmpeg arguments for a real-args VAAPI probe. `encode_args` are the
/// session's own H.264 arguments for the VAAPI platform, appended verbatim.
pub(crate) fn probe_args(
    device: &Path,
    video: &VideoSettings,
    encode_args: &[String],
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-vaapi_device".to_string(),
        device.display().to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!(
            "color=c=black:s={}x{}:r={},format=rgba",
            video.width,
            video.height,
            video.fps.max(1)
        ),
        "-vf".to_string(),
        probe_filter(video),
        "-frames:v".to_string(),
        PROBE_FRAMES.to_string(),
        "-an".to_string(),
    ];
    args.extend(encode_args.iter().cloned());
    args.extend(["-f".to_string(), "null".to_string(), "-".to_string()]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fixture_directory(label: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("videorc-linux-vaapi-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        directory
    }

    fn candidate(node: &str, driver: Option<&str>) -> RenderNodeCandidate {
        RenderNodeCandidate {
            path: PathBuf::from("/dev/dri").join(node),
            driver: driver.map(str::to_string),
        }
    }

    #[test]
    fn the_quarantine_directory_sits_beside_the_database() {
        let directory = ProbeQuarantine::default_directory();
        assert_eq!(
            directory.file_name().and_then(|name| name.to_str()),
            Some(QUARANTINE_DIRECTORY_NAME)
        );
        assert_eq!(
            directory.parent(),
            crate::storage::default_database_path().parent()
        );
    }

    #[test]
    fn device_pin_is_optional_and_must_name_a_render_node() {
        assert_eq!(parse_device_pin(None), Ok(None));
        assert_eq!(parse_device_pin(Some("  ")), Ok(None));
        assert_eq!(
            parse_device_pin(Some("/dev/dri/renderD128")),
            Ok(Some(PathBuf::from("/dev/dri/renderD128")))
        );
        assert!(parse_device_pin(Some("renderD128")).is_err());
        assert!(parse_device_pin(Some("/dev/dri/card0")).is_err());
        assert!(parse_device_pin(Some("/dev/dri/renderD")).is_err());
    }

    // The sysfs driver link is a symlink; Windows test builds of this module
    // (it is cfg(test) everywhere) have no std::os::unix.
    #[cfg(unix)]
    #[test]
    fn candidates_list_numbered_render_nodes_with_their_sysfs_driver() {
        let dri = fixture_directory("dri");
        let sysfs = fixture_directory("sysfs");
        for name in ["renderD129", "card0", "renderD128", "renderDnope"] {
            std::fs::File::create(dri.join(name)).expect("create render-node fixture");
        }
        let drivers = sysfs.join("drivers");
        std::fs::create_dir_all(drivers.join("i915")).expect("create driver dir");
        std::fs::create_dir_all(sysfs.join("renderD128").join("device")).expect("device dir");
        std::os::unix::fs::symlink(
            drivers.join("i915"),
            sysfs.join("renderD128").join("device").join("driver"),
        )
        .expect("driver symlink");

        let candidates = render_node_candidates(&dri, &sysfs);
        assert_eq!(
            candidates,
            vec![
                RenderNodeCandidate {
                    path: dri.join("renderD128"),
                    driver: Some("i915".to_string()),
                },
                RenderNodeCandidate {
                    path: dri.join("renderD129"),
                    driver: None,
                },
            ]
        );
        assert_eq!(candidates[0].describe(), "renderD128 (i915)");
        assert_eq!(candidates[1].describe(), "renderD129 (driver unknown)");

        std::fs::remove_dir_all(dri).ok();
        std::fs::remove_dir_all(sysfs).ok();
    }

    #[test]
    fn a_leftover_sentinel_quarantines_that_node_and_only_that_node() {
        let directory = fixture_directory("quarantine");
        let quarantine = ProbeQuarantine::new(directory.clone());
        let amd = candidate("renderD129", Some("amdgpu"));
        let intel = candidate("renderD128", Some("i915"));

        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );
        assert!(quarantine.quarantined().is_empty());

        // The probe was armed and the host "hung": finish_probe never ran.
        quarantine
            .begin_probe(&amd, "/opt/ffmpeg")
            .expect("arm the sentinel");
        let adopted = quarantine
            .adopt_stale_sentinel()
            .expect("adopt the sentinel")
            .expect("a stale sentinel is a quarantine");
        assert_eq!(adopted.node, "renderD129");
        assert_eq!(adopted.driver.as_deref(), Some("amdgpu"));
        assert_eq!(adopted.ffmpeg_path, "/opt/ffmpeg");
        assert!(!directory.join(PROBE_IN_PROGRESS_FILE).exists());
        assert_eq!(quarantine.quarantined(), vec![adopted.clone()]);
        // Adopting again is a no-op.
        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );

        let (to_probe, reports) = plan_probe_order(
            &[intel.clone(), amd.clone()],
            None,
            &quarantine.quarantined(),
        )
        .expect("plan");
        assert_eq!(to_probe, vec![intel.clone()]);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].node, "renderD129");
        assert_eq!(reports[0].state, LinuxRenderNodeState::Quarantined);
        assert!(
            reports[0]
                .detail
                .as_deref()
                .is_some_and(|d| d.contains("never returned"))
        );

        // A probe that returns leaves nothing behind.
        quarantine.begin_probe(&intel, "/opt/ffmpeg").expect("arm");
        quarantine.finish_probe().expect("disarm");
        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );
        quarantine.finish_probe().expect("disarming twice is fine");

        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn a_pin_probes_only_that_node_and_overrides_its_quarantine() {
        let intel = candidate("renderD128", Some("i915"));
        let amd = candidate("renderD129", Some("amdgpu"));
        let quarantined = vec![QuarantineEntry {
            node: "renderD129".to_string(),
            driver: Some("amdgpu".to_string()),
            ffmpeg_path: "/opt/ffmpeg".to_string(),
            probe_started_at_unix_secs: 1,
            quarantined_at_unix_secs: 2,
        }];

        let (to_probe, reports) = plan_probe_order(
            &[intel.clone(), amd.clone()],
            Some(Path::new("/dev/dri/renderD128")),
            &quarantined,
        )
        .expect("plan");
        assert_eq!(to_probe, vec![intel.clone()]);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].state, LinuxRenderNodeState::Skipped);

        let (to_probe, reports) = plan_probe_order(
            &[intel.clone(), amd.clone()],
            Some(Path::new("/dev/dri/renderD129")),
            &quarantined,
        )
        .expect("an explicit pin overrides quarantine");
        assert_eq!(to_probe, vec![amd]);
        assert_eq!(reports[0].node, "renderD128");

        let error = plan_probe_order(&[intel], Some(Path::new("/dev/dri/renderD130")), &[])
            .expect_err("a pin must name a real node");
        assert!(error.contains("renderD130"));
        assert!(error.contains("renderD128 (i915)"));
    }

    #[test]
    fn probe_args_mirror_the_bridge_upload_path_and_append_the_real_encode_args() {
        let video = probe_video_settings();
        let encode_args = vec![
            "-c:v".to_string(),
            "h264_vaapi".to_string(),
            "-rc_mode".to_string(),
            "VBR".to_string(),
        ];
        let args = probe_args(Path::new("/dev/dri/renderD128"), &video, &encode_args);
        let joined = args.join(" ");
        assert!(joined.starts_with("-hide_banner -loglevel error -vaapi_device /dev/dri/renderD128 -f lavfi -i color=c=black:s=1920x1080:r=30,format=rgba -vf setpts=PTS-STARTPTS,fps=30,format=nv12,hwupload -frames:v 30 -an -c:v h264_vaapi -rc_mode VBR"));
        assert!(joined.ends_with("-f null -"));
    }
}
