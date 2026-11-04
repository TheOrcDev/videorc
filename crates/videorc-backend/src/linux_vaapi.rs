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
//!   node on the next start instead of being tried again; a probe that times
//!   out in-process quarantines its node on the spot; and
//! - the driver behind every node is listed in diagnostics so the evidence says
//!   which GPU encoded, without any driver blocklist in the product.
//!
//! The probe itself runs the session's real encode arguments at 1080p30 through
//! the bridge's own filter chain so a probe pass predicts a session pass.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    // A Linux device path: a leading slash rather than `Path::is_absolute`,
    // which is false for `/dev/dri/...` on Windows test builds of this module.
    let node_ok = value.starts_with('/')
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

/// Stable material for the performance-check capability key. The previous
/// Linux identity was a constant (`platform=linux;windows-adapter-driver=not-
/// applicable`), so a poisoned `belowFloor` result never went stale across
/// GPU or driver changes (ogre, 2026-09-28).
pub(crate) fn linux_graphics_adapter_driver_identity(
    dri_directory: &Path,
    sysfs_drm_directory: &Path,
) -> String {
    let listed = render_node_candidates(dri_directory, sysfs_drm_directory)
        .into_iter()
        .map(|candidate| {
            format!(
                "{}={}",
                candidate.node_name(),
                candidate.driver.as_deref().unwrap_or("unknown")
            )
        })
        .collect::<Vec<_>>();
    if listed.is_empty() {
        return "linux-render-nodes=none".to_string();
    }
    format!("linux-render-nodes={}", listed.join(","))
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
    /// Set when the probe was still running at its deadline and the backend
    /// quarantined the node itself; absent when a stale sentinel was adopted
    /// after the process died mid-probe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) timed_out_after_secs: Option<u64>,
}

impl QuarantineEntry {
    pub(crate) fn detail(&self) -> String {
        let outcome = match self.timed_out_after_secs {
            Some(secs) => format!("did not return within {secs} s"),
            None => "never returned".to_string(),
        };
        format!(
            "quarantined: a VAAPI probe of this node started at unix {} and {outcome} (delete {} under the app data directory, or pin the node with {}, to try it again)",
            self.probe_started_at_unix_secs, QUARANTINED_FILE, DEVICE_PIN_ENV
        )
    }

    /// Whether this entry quarantines `node` (`renderD129`). The backend writes
    /// the bare name, but an entry planted by hand after a host hang may name
    /// the node by path (`/dev/dri/renderD129`, the form the pin takes);
    /// ignoring it probed the node that hung the host again.
    pub(crate) fn names(&self, node: &str) -> bool {
        Path::new(&self.node)
            .file_name()
            .is_some_and(|name| name == node)
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
        // A unit test that resolves the encoder without isolating the
        // database must never read or write the developer's real quarantine
        // (the secret store makes the same promise, #974): `cargo test` on
        // the Arch T2 box quarantined its healthy Intel node (#1027).
        #[cfg(test)]
        if std::env::var_os("VIDEORC_DATABASE_PATH").is_none() {
            return unit_test_directory();
        }
        directory_beside(&crate::storage::default_database_path())
    }

    fn sentinel_path(&self) -> PathBuf {
        self.directory.join(PROBE_IN_PROGRESS_FILE)
    }

    fn quarantined_path(&self) -> PathBuf {
        self.directory.join(QUARANTINED_FILE)
    }

    /// A sentinel left over from a previous process means that process died
    /// mid-probe without running destructors: the host hung or was rebooted,
    /// or the backend was killed or aborted. Move the node into the
    /// quarantine list and report it. (A probe future dropped in-process
    /// clears its own sentinel, see [`ArmedProbe`].)
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
            timed_out_after_secs: None,
        };
        self.add_quarantined(entry.clone())?;
        std::fs::remove_file(&sentinel_path)?;
        Ok(Some(entry))
    }

    fn add_quarantined(&self, entry: QuarantineEntry) -> std::io::Result<()> {
        let mut entries = self.quarantined();
        entries.retain(|existing| !existing.names(&entry.node));
        entries.push(entry);
        self.write_quarantined(&entries)
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
    ) -> std::io::Result<ArmedProbe<'_>> {
        std::fs::create_dir_all(&self.directory)?;
        let sentinel = ProbeSentinel {
            node: candidate.node_name(),
            driver: candidate.driver.clone(),
            ffmpeg_path: ffmpeg_path.to_string(),
            started_at_unix_secs: unix_now(),
        };
        let json = serde_json::to_vec_pretty(&sentinel)?;
        write_atomic(&self.sentinel_path(), &json)?;
        Ok(ArmedProbe {
            quarantine: self,
            sentinel,
            disarmed: false,
        })
    }

    fn remove_sentinel(&self) -> std::io::Result<()> {
        match std::fs::remove_file(self.sentinel_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

/// The sentinel armed for one probe, held for as long as the probe runs.
///
/// Two ways a probe can end without returning look alike from the outside
/// and must not be treated alike:
///
/// - The future was dropped in-process (a test runtime ended, a `timeout`
///   around the session start fired, the runtime shut down at quit). This
///   process is still running Rust code, so the GPU did not take the host
///   down; `Drop` clears the sentinel and the node is simply unproven. Any
///   FFmpeg still running is killed by its own `kill_on_drop`.
/// - The process died without running destructors (the host hung or was
///   rebooted, the backend was SIGKILLed or aborted). No `Drop` runs, the
///   sentinel survives, and the next start adopts it as a quarantine: that
///   is the hang the sentinel exists for.
///
/// A probe that is still running at its deadline is the hang seen from
/// inside the process: [`ArmedProbe::quarantine_timed_out`] writes the
/// quarantine entry before the sentinel is cleared, so a crash between the
/// two still leaves the node remembered.
#[must_use = "dropping the armed probe clears its sentinel"]
pub(crate) struct ArmedProbe<'a> {
    quarantine: &'a ProbeQuarantine,
    sentinel: ProbeSentinel,
    disarmed: bool,
}

impl ArmedProbe<'_> {
    /// The probe returned (pass or reject): the sentinel no longer means a
    /// hang.
    pub(crate) fn finish(mut self) -> std::io::Result<()> {
        self.disarmed = true;
        self.quarantine.remove_sentinel()
    }

    /// The probe was still running `after` its start: quarantine the node
    /// now, then clear the sentinel. The entry carries the deadline so the
    /// diagnostics say "did not return within 20 s" rather than "never
    /// returned".
    pub(crate) fn quarantine_timed_out(
        mut self,
        after: Duration,
    ) -> std::io::Result<QuarantineEntry> {
        let entry = QuarantineEntry {
            node: self.sentinel.node.clone(),
            driver: self.sentinel.driver.clone(),
            ffmpeg_path: self.sentinel.ffmpeg_path.clone(),
            probe_started_at_unix_secs: self.sentinel.started_at_unix_secs,
            quarantined_at_unix_secs: unix_now(),
            timed_out_after_secs: Some(after.as_secs()),
        };
        self.quarantine.add_quarantined(entry.clone())?;
        self.disarmed = true;
        self.quarantine.remove_sentinel()?;
        Ok(entry)
    }
}

impl Drop for ArmedProbe<'_> {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        // Best effort: a sentinel that cannot be removed here is reported by
        // the next start as a quarantine, the conservative reading.
        let _ = self.quarantine.remove_sentinel();
    }
}

/// `<database directory>/linux-vaapi`.
fn directory_beside(database: &Path) -> PathBuf {
    database
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(QUARANTINE_DIRECTORY_NAME)
}

/// One throwaway quarantine per test process, outside every real profile.
#[cfg(test)]
fn unit_test_directory() -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "videorc-unit-test-linux-vaapi-{}",
            std::process::id()
        ))
        .join(QUARANTINE_DIRECTORY_NAME)
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
        if let Some(entry) = quarantined.iter().find(|entry| entry.names(&node)) {
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

/// The bridge feeds RGBA raw frames, stamps BT.709 video-range on them and
/// converts to NV12 before `hwupload`
/// (`bridge_recording_video_filter_for_encoder`); the probe mirrors that
/// exactly so the driver sees the same upload path a session uses.
pub(crate) fn probe_filter(video: &VideoSettings) -> String {
    format!(
        "setpts=PTS-STARTPTS,fps={},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=nv12,hwupload",
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
        let directory = directory_beside(Path::new("/profile/videorc.sqlite3"));
        assert_eq!(directory, PathBuf::from("/profile/linux-vaapi"));
        assert_eq!(
            directory.file_name().and_then(|name| name.to_str()),
            Some(QUARANTINE_DIRECTORY_NAME)
        );
    }

    #[test]
    fn a_unit_test_never_sees_the_real_quarantine() {
        let directory = ProbeQuarantine::default_directory();
        let database = crate::storage::default_database_path();
        if std::env::var_os("VIDEORC_DATABASE_PATH").is_some() {
            // The test run isolated its database by hand; the quarantine
            // follows it.
            assert_eq!(directory, directory_beside(&database));
            return;
        }
        assert_eq!(directory, unit_test_directory());
        assert!(directory.starts_with(std::env::temp_dir()));
        assert_ne!(directory, directory_beside(&database));
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
        assert_eq!(
            linux_graphics_adapter_driver_identity(&dri, &sysfs),
            "linux-render-nodes=renderD128=i915,renderD129=unknown"
        );

        std::fs::remove_dir_all(dri).ok();
        std::fs::remove_dir_all(sysfs).ok();
    }

    #[test]
    fn linux_gpu_identity_is_none_when_there_are_no_render_nodes() {
        let dri = fixture_directory("empty-dri");
        let sysfs = fixture_directory("empty-sysfs");
        assert_eq!(
            linux_graphics_adapter_driver_identity(&dri, &sysfs),
            "linux-render-nodes=none"
        );
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

        // The probe was armed and the host "hung": no destructor ran, so the
        // armed probe is forgotten rather than dropped.
        std::mem::forget(
            quarantine
                .begin_probe(&amd, "/opt/ffmpeg")
                .expect("arm the sentinel"),
        );
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
        quarantine
            .begin_probe(&intel, "/opt/ffmpeg")
            .expect("arm")
            .finish()
            .expect("disarm");
        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );

        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn a_probe_dropped_in_process_leaves_no_sentinel_to_adopt() {
        // The resolve future was cancelled (a test runtime ended, a timeout
        // around start_session fired): this process is alive, so the node
        // did not hang the host and must not be quarantined at the next
        // start. The Arch T2 box lost its healthy Intel node this way.
        let directory = fixture_directory("cancelled");
        let quarantine = ProbeQuarantine::new(directory.clone());
        let intel = candidate("renderD128", Some("i915"));

        let armed = quarantine
            .begin_probe(&intel, "/opt/ffmpeg")
            .expect("arm the sentinel");
        assert!(directory.join(PROBE_IN_PROGRESS_FILE).exists());
        drop(armed);
        assert!(!directory.join(PROBE_IN_PROGRESS_FILE).exists());
        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );
        assert!(quarantine.quarantined().is_empty());

        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn a_timed_out_probe_is_quarantined_on_the_spot_and_says_so() {
        let directory = fixture_directory("timed-out");
        let quarantine = ProbeQuarantine::new(directory.clone());
        let amd = candidate("renderD129", Some("amdgpu"));
        let intel = candidate("renderD128", Some("i915"));

        let entry = quarantine
            .begin_probe(&amd, "/opt/ffmpeg")
            .expect("arm the sentinel")
            .quarantine_timed_out(Duration::from_secs(20))
            .expect("quarantine the node");
        assert_eq!(entry.node, "renderD129");
        assert_eq!(entry.timed_out_after_secs, Some(20));
        assert!(entry.detail().contains("did not return within 20 s"));
        assert!(!directory.join(PROBE_IN_PROGRESS_FILE).exists());
        assert_eq!(quarantine.quarantined(), vec![entry.clone()]);
        // Nothing is left for the next start to adopt; the list already
        // carries the node.
        assert_eq!(
            quarantine.adopt_stale_sentinel().expect("no sentinel"),
            None
        );

        // The next start plans around it without a pin.
        let (to_probe, reports) = plan_probe_order(
            &[intel.clone(), amd.clone()],
            None,
            &quarantine.quarantined(),
        )
        .expect("plan");
        assert_eq!(to_probe, vec![intel]);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].state, LinuxRenderNodeState::Quarantined);

        // An entry written by an older backend (no timeout field) still
        // reads, and a second quarantine of the same node replaces it.
        std::fs::write(
            directory.join(QUARANTINED_FILE),
            r#"[{"node": "renderD129", "ffmpegPath": "/opt/ffmpeg", "probeStartedAtUnixSecs": 1, "quarantinedAtUnixSecs": 2}]"#,
        )
        .expect("plant the older entry");
        let older = quarantine.quarantined();
        assert_eq!(older.len(), 1);
        assert_eq!(older[0].timed_out_after_secs, None);
        assert!(older[0].detail().contains("never returned"));
        quarantine
            .begin_probe(&amd, "/opt/ffmpeg")
            .expect("arm")
            .quarantine_timed_out(Duration::from_secs(20))
            .expect("quarantine again");
        assert_eq!(quarantine.quarantined().len(), 1);
        assert_eq!(quarantine.quarantined()[0].timed_out_after_secs, Some(20));

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
            timed_out_after_secs: None,
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
    fn a_quarantine_planted_by_hand_with_the_node_path_is_never_probed() {
        // docs/linux-dev-loop.md: after a host hang, plant the entry by hand.
        // This is the file an operator wrote on the Arch T2 box; the AMD node
        // was probed anyway and hung the GPU again (retest 153, 2026-11-02).
        let directory = fixture_directory("planted");
        std::fs::write(
            directory.join(QUARANTINED_FILE),
            r#"[{"node": "/dev/dri/renderD129", "driver": "amdgpu", "ffmpegPath": "/opt/ffmpeg", "probeStartedAtUnixSecs": 1, "quarantinedAtUnixSecs": 2}]"#,
        )
        .expect("plant the entry");
        let quarantined = ProbeQuarantine::new(directory.clone()).quarantined();
        std::fs::remove_dir_all(directory).ok();
        let intel = candidate("renderD128", Some("i915"));
        let amd = candidate("renderD129", Some("amdgpu"));

        let (to_probe, reports) =
            plan_probe_order(&[intel.clone(), amd], None, &quarantined).expect("plan");
        assert_eq!(to_probe, vec![intel]);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].node, "renderD129");
        assert_eq!(reports[0].state, LinuxRenderNodeState::Quarantined);
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
        assert!(joined.starts_with("-hide_banner -loglevel error -vaapi_device /dev/dri/renderD128 -f lavfi -i color=c=black:s=1920x1080:r=30,format=rgba -vf setpts=PTS-STARTPTS,fps=30,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=nv12,hwupload -frames:v 30 -an -c:v h264_vaapi -rc_mode VBR"));
        assert!(joined.ends_with("-f null -"));
    }
}
