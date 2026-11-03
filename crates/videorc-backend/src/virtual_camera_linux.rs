//! Videorc Camera on Linux (plan 214, workstream D): v4l2loopback.
//!
//! Linux is a candidate-only Alpha and a Mac cannot compile the
//! `cfg(target_os = "linux")` arm, so the writer's compile gate is the Linux
//! CI job and its behaviour gate is spike P0c on a named Linux box. Until
//! that box passes, [`PROVEN`] is `false`: `platform_sink` answers
//! `VirtualCameraUnavailable::hidden_until_proven("Linux")`, the Output page
//! shows no section, and nothing here runs. Flipping [`PROVEN`] is the one
//! line that turns the camera on.
//!
//! What lives here:
//!
//! - **D1, detect and guide** (pure, every platform, tested on fake sysfs
//!   trees): whether the module is installed (`modinfo v4l2loopback`, behind
//!   [`ModuleInfo`] so tests fake it), whether it is loaded
//!   (`/sys/module/v4l2loopback`), where the Videorc device is (the
//!   `/sys/class/video4linux/videoN/name` equal to the card label), and the
//!   distribution's install command from `/etc/os-release`. The state table
//!   [`LinuxSetupState`] maps to the platform step the status rule reads:
//!   `needs-setup` whose message is the install command alone (the Output
//!   page renders it as one copyable line; absent with no known
//!   distribution), `setting-up` while main loads the module, `ready`, and
//!   `failed` with plain words when the module is loaded under another
//!   app's label. Secure Boot is never in `needs-setup`: the note lives in
//!   `docs/linux-dev-loop.md`, and a load the kernel refuses for it comes
//!   back from main as a `failed` step that says so.
//! - **D2, the writer** (Linux only): open the device found by name for
//!   output, `VIDIOC_S_FMT` YUYV 1920×1080, `write()` one frame per tick
//!   from the CPU I420 frame through `i420_to_yuyv`. `exclusive_caps=1`
//!   makes the device appear to Chrome only while a writer holds it, so
//!   closing on off is what makes it disappear. The V4L2 ABI it needs is
//!   hand-written in [`abi`] (no bindgen, no new crate) and its layouts and
//!   ioctl numbers are checked by tests on every platform.
//!
//! Who reports what: the backend probes the module itself (the supervisor in
//! `virtual_camera_service.rs` runs [`platform_report_now`] once a second
//! until the device is there, then every ten seconds). Electron main only
//! runs the load (`pkexec modprobe …`, see
//! `apps/desktop/src/main/virtual-camera-linux-setup.ts`: polkit's dialog
//! belongs to the app), reports `setting-up` while it runs. When the kernel
//! or polkit refuses, it hands the step back with `needs-setup`, so the next
//! probe takes over and the Load module button stays. The refusal's words
//! show from the action's own result. A `setting-up` or `failed` report from
//! main stands until the box changes ([`ProbeMemory`]): the device appears
//! and the probe says `ready`, or the module goes. No kernel module is bundled,
//! built or signed (D9). Linux has no reader count, so the sink's `viewers`
//! is `None` and the camera writes whenever the switch is on (D13).
// The pure half runs everywhere (its tests run on a Mac); only the writer
// and the real probe are reached on Linux.
#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::linux_v4l2_camera::V4l2Roots;
use crate::protocol::VirtualCameraPlatformStep;
use crate::virtual_camera::{
    VIRTUAL_CAMERA_LINUX_CARD_LABEL, VIRTUAL_CAMERA_LINUX_VIDEO_NR, VirtualCameraSink,
    VirtualCameraUnavailable, is_videorc_camera_linux,
};

/// The one line that turns the Linux camera on once spike P0c has passed on
/// a named Linux box (plan 214 D). While `false`, `platform_sink` hides the
/// camera and the probe never runs.
pub const PROVEN: bool = false;

/// The kernel module (`v4l2loopback-dkms` on apt and pacman distributions).
pub const MODULE_NAME: &str = "v4l2loopback";

/// `modprobe`'s arguments as one argv, never a shell string; main runs them
/// through `pkexec`. kmod quotes a value with a space on its own, so
/// `card_label=Videorc Camera` reaches the kernel as
/// `card_label="Videorc Camera"`.
pub const LOAD_MODULE_ARGS: [&str; 5] = [
    "modprobe",
    MODULE_NAME,
    "exclusive_caps=1",
    "card_label=Videorc Camera",
    "video_nr=42",
];

/// The same load as a terminal line, for copy that names it.
pub fn load_module_terminal_line() -> String {
    format!(
        "sudo modprobe {MODULE_NAME} exclusive_caps=1 card_label=\"{VIRTUAL_CAMERA_LINUX_CARD_LABEL}\" video_nr={VIRTUAL_CAMERA_LINUX_VIDEO_NR}"
    )
}

/// How often the backend re-probes the module (the supervisor's cadence):
/// quick until the device is there, so a load shows up within a second, then
/// slow, to notice an unload.
pub fn next_probe_interval(ready: bool) -> Duration {
    if ready {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(1)
    }
}

// ---------------------------------------------------------------------------
// D1: is the module installed, is it loaded, where is the device
// ---------------------------------------------------------------------------

/// Whether a kernel module is installed for the running kernel: what
/// `modinfo <module>` answers. A trait so tests fake it.
pub trait ModuleInfo: Send + Sync {
    fn installed(&self, module: &str) -> bool;
}

/// The real `modinfo`: exit 0 means installed.
#[derive(Debug, Default, Clone, Copy)]
pub struct Modinfo;

/// Where `modinfo` lives when the app's PATH lacks the sbin folders (a
/// Debian user's PATH does).
const MODINFO_CANDIDATES: [&str; 3] = ["modinfo", "/usr/sbin/modinfo", "/sbin/modinfo"];

impl ModuleInfo for Modinfo {
    fn installed(&self, module: &str) -> bool {
        use std::process::{Command, Stdio};
        for candidate in MODINFO_CANDIDATES {
            match Command::new(candidate)
                .arg(module)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
            {
                Ok(status) => return status.success(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return false,
            }
        }
        false
    }
}

/// Remembers one module's verdict for `ttl`: the probe runs every second
/// while the module is missing, and `modinfo` is a process.
pub struct CachedModuleInfo<M> {
    inner: M,
    ttl: Duration,
    cache: StdMutex<Option<(Instant, bool)>>,
}

impl<M: ModuleInfo> CachedModuleInfo<M> {
    pub const fn new(inner: M, ttl: Duration) -> Self {
        Self {
            inner,
            ttl,
            cache: StdMutex::new(None),
        }
    }
}

impl<M: ModuleInfo> ModuleInfo for CachedModuleInfo<M> {
    fn installed(&self, module: &str) -> bool {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, verdict)) = *cache
            && at.elapsed() < self.ttl
        {
            return verdict;
        }
        let verdict = self.inner.installed(module);
        *cache = Some((Instant::now(), verdict));
        verdict
    }
}

/// The process-wide `modinfo`, asked at most once every ten seconds.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // The supervisor's probe and the writer are Linux-only callers.
static MODINFO: CachedModuleInfo<Modinfo> = CachedModuleInfo::new(Modinfo, Duration::from_secs(10));

/// Where the probe looks; injectable so tests run against a fake tree (the
/// `V4l2Roots` pattern of `linux_v4l2_camera.rs`).
#[derive(Debug, Clone)]
pub struct LinuxCameraRoots {
    pub v4l2: V4l2Roots,
    /// `/sys/module`: a `v4l2loopback` folder means the module is loaded.
    pub sys_module: PathBuf,
    /// `/etc/os-release`: `ID` and `ID_LIKE` pick the install command.
    pub os_release: PathBuf,
}

impl Default for LinuxCameraRoots {
    fn default() -> Self {
        Self {
            v4l2: V4l2Roots::default(),
            sys_module: PathBuf::from("/sys/module"),
            os_release: PathBuf::from("/etc/os-release"),
        }
    }
}

/// Whether the module is loaded: the kernel lists every loaded module under
/// `/sys/module`.
pub fn module_loaded(roots: &LinuxCameraRoots) -> bool {
    roots.sys_module.join(MODULE_NAME).is_dir()
}

/// The loopback node whose sysfs `name` is the card label, as `/dev/videoN`.
/// The fixed number (`video_nr=42`) wins when several carry the label; else
/// the lowest. Never assumed: a box may have loaded it under another number.
pub fn find_videorc_device(roots: &V4l2Roots) -> Option<PathBuf> {
    let entries = std::fs::read_dir(&roots.sysfs_class).ok()?;
    let mut nodes = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let node = entry.file_name().to_string_lossy().into_owned();
            let number = node.strip_prefix("video")?.parse::<u32>().ok()?;
            let name = std::fs::read_to_string(entry.path().join("name")).ok()?;
            is_videorc_camera_linux(&name).then_some((number, node))
        })
        .collect::<Vec<_>>();
    nodes.sort_by_key(|(number, _)| (*number != VIRTUAL_CAMERA_LINUX_VIDEO_NR, *number));
    nodes
        .into_iter()
        .next()
        .map(|(_, node)| roots.dev.join(node))
}

// ---------------------------------------------------------------------------
// D1: the distribution's install command
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Apt,
    Dnf,
    Pacman,
    Unknown,
}

/// `ID` first, then `ID_LIKE` in order, lower-cased and unquoted.
fn os_release_ids(text: &str) -> Vec<String> {
    let mut id = None;
    let mut like = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "ID" => id = Some(value.to_ascii_lowercase()),
            "ID_LIKE" => {
                like = value
                    .split_whitespace()
                    .map(str::to_ascii_lowercase)
                    .collect();
            }
            _ => {}
        }
    }
    id.into_iter().chain(like).collect()
}

/// The package manager for an `/etc/os-release`: the `ID`, then what it is
/// `ID_LIKE` (Pop!_OS and Mint say ubuntu or debian, Omarchy and Manjaro say
/// arch, Rocky says rhel and fedora).
pub fn package_manager_for_os_release(text: &str) -> PackageManager {
    for id in os_release_ids(text) {
        match id.as_str() {
            "debian" | "ubuntu" | "linuxmint" | "pop" | "elementary" | "zorin" | "neon"
            | "raspbian" | "kali" => return PackageManager::Apt,
            "fedora" | "rhel" | "centos" | "rocky" | "almalinux" | "nobara" => {
                return PackageManager::Dnf;
            }
            "arch" | "archlinux" | "manjaro" | "endeavouros" | "cachyos" | "garuda" | "omarchy" => {
                return PackageManager::Pacman;
            }
            _ => {}
        }
    }
    PackageManager::Unknown
}

/// The install command the Output page shows in a copyable line.
pub fn install_command(manager: PackageManager) -> Option<&'static str> {
    match manager {
        PackageManager::Apt => Some("sudo apt install v4l2loopback-dkms"),
        // The package lives in RPM Fusion free; the message says so.
        PackageManager::Dnf => Some("sudo dnf install v4l2loopback"),
        PackageManager::Pacman => Some("sudo pacman -S v4l2loopback-dkms"),
        PackageManager::Unknown => None,
    }
}

fn package_manager_at(roots: &LinuxCameraRoots) -> PackageManager {
    std::fs::read_to_string(&roots.os_release)
        .map(|text| package_manager_for_os_release(&text))
        .unwrap_or(PackageManager::Unknown)
}

// ---------------------------------------------------------------------------
// D1: the state table
// ---------------------------------------------------------------------------

/// Where the module is on this box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxSetupState {
    /// `modinfo` finds no module: the distribution package comes first.
    NeedsInstall { manager: PackageManager },
    /// Installed, not loaded: Load module (`pkexec modprobe`) creates the
    /// device. The page shows the install line for every `needs-setup`, so
    /// this carries the manager too.
    NeedsLoad { manager: PackageManager },
    /// Loaded, but no device carries the card label: another app loaded it
    /// with its own label and parameters.
    LoadedWithoutDevice,
    /// Loaded with the Videorc device at `device`.
    Ready { device: PathBuf },
}

/// The state table against a tree and a `modinfo`. The device wins over
/// everything (a loaded module with the device is ready however `/sys/module`
/// reads), then loaded, then installed.
pub fn probe_setup(roots: &LinuxCameraRoots, modinfo: &dyn ModuleInfo) -> LinuxSetupState {
    if let Some(device) = find_videorc_device(&roots.v4l2) {
        return LinuxSetupState::Ready { device };
    }
    if module_loaded(roots) {
        return LinuxSetupState::LoadedWithoutDevice;
    }
    if modinfo.installed(MODULE_NAME) {
        return LinuxSetupState::NeedsLoad {
            manager: package_manager_at(roots),
        };
    }
    LinuxSetupState::NeedsInstall {
        manager: package_manager_at(roots),
    }
}

/// The real box: `/sys`, `/dev`, `/etc/os-release` and the cached `modinfo`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Reached from the Linux-only supervisor probe.
pub fn probe_now() -> LinuxSetupState {
    probe_setup(&LinuxCameraRoots::default(), &MODINFO)
}

/// Loaded by another app with its own `card_label`: `modprobe` again is a
/// no-op, so the fix is a terminal line, and the step is `failed`.
pub const LOADED_WITHOUT_DEVICE_MESSAGE: &str = "v4l2loopback is loaded without a Videorc Camera device (another app loaded it under its own name). In a terminal: sudo modprobe -r v4l2loopback, then sudo modprobe v4l2loopback exclusive_caps=1 card_label=\"Videorc Camera\" video_nr=42.";

/// The platform step and message for one state. `needs-setup`'s message is
/// the install command alone: the Output page renders it as one copyable
/// line, and says to use the package manager when it is absent. Secure
/// Boot is not mentioned here (`docs/linux-dev-loop.md` has the note; a
/// refused load is a `failed` step from main). `setting-up` is
/// [`setting_up_report`]: only main knows a load is running.
pub fn platform_report(state: &LinuxSetupState) -> (VirtualCameraPlatformStep, Option<String>) {
    match state {
        LinuxSetupState::NeedsInstall { manager } | LinuxSetupState::NeedsLoad { manager } => (
            VirtualCameraPlatformStep::NeedsSetup,
            install_command(*manager).map(str::to_string),
        ),
        LinuxSetupState::LoadedWithoutDevice => (
            VirtualCameraPlatformStep::Failed,
            Some(LOADED_WITHOUT_DEVICE_MESSAGE.to_string()),
        ),
        LinuxSetupState::Ready { .. } => (VirtualCameraPlatformStep::Ready, None),
    }
}

/// The `setting-up` row, while main's `pkexec modprobe` runs. No message:
/// the page knows the step, and a `needs-setup` message is a command line.
pub fn setting_up_report() -> (VirtualCameraPlatformStep, Option<String>) {
    (VirtualCameraPlatformStep::SettingUp, None)
}

/// What the writer says when `connect` finds the module not ready: plain
/// words (the platform step outranks them in the status, so they show only
/// when the device goes between a probe and a connect).
pub fn not_ready_message(state: &LinuxSetupState) -> Option<String> {
    match state {
        LinuxSetupState::NeedsInstall { .. } | LinuxSetupState::NeedsLoad { .. } => {
            Some("v4l2loopback is not loaded. Install it, then choose Load module.".to_string())
        }
        LinuxSetupState::LoadedWithoutDevice => Some(LOADED_WITHOUT_DEVICE_MESSAGE.to_string()),
        LinuxSetupState::Ready { .. } => None,
    }
}

/// The real box's platform report, for the supervisor.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Reached from the Linux-only supervisor probe.
pub fn platform_report_now() -> (VirtualCameraPlatformStep, Option<String>) {
    platform_report(&probe_now())
}

/// What the supervisor remembers between probes, and what a probe does to
/// the platform report the status reads.
#[derive(Debug, Default)]
pub struct ProbeMemory {
    last: Option<(VirtualCameraPlatformStep, Option<String>)>,
}

impl ProbeMemory {
    /// `Some(report)` replaces the current platform report; `None` keeps it.
    /// Main's word (`setting-up` while its load runs, `failed` with a
    /// refusal's words) stands until the box changes: the probe says `ready`,
    /// or its report differs from its last one. A probe's own report is
    /// refreshed whenever it differs; the same again is nothing to republish.
    pub fn merge(
        &mut self,
        current: Option<&(VirtualCameraPlatformStep, Option<String>)>,
        probe: (VirtualCameraPlatformStep, Option<String>),
    ) -> Option<(VirtualCameraPlatformStep, Option<String>)> {
        let box_changed = self.last.as_ref() != Some(&probe);
        self.last = Some(probe.clone());
        match current {
            None => Some(probe),
            Some((VirtualCameraPlatformStep::SettingUp | VirtualCameraPlatformStep::Failed, _)) => {
                (probe.0 == VirtualCameraPlatformStep::Ready || box_changed).then_some(probe)
            }
            Some(current) => (current != &probe).then_some(probe),
        }
    }
}

// ---------------------------------------------------------------------------
// D2: the V4L2 ABI the writer needs
// ---------------------------------------------------------------------------

/// `linux/videodev2.h`, hand-written: the four ioctls and the structs behind
/// them, so no bindgen or crate joins the build. The ioctl numbers use the
/// kernel's generic `_IOC` encoding, which x86_64 and aarch64 share; the
/// tests pin the 64-bit values.
#[allow(dead_code)] // ABI mirrors carry fields the writer never reads.
pub mod abi {
    use std::ffi::c_void;
    use std::mem::size_of;

    pub const V4L2_BUF_TYPE_VIDEO_OUTPUT: u32 = 2;
    pub const V4L2_FIELD_NONE: u32 = 1;
    pub const V4L2_PIX_FMT_YUYV: u32 = fourcc(b'Y', b'U', b'Y', b'V');
    pub const V4L2_COLORSPACE_REC709: u32 = 3;
    pub const V4L2_CAP_VIDEO_OUTPUT: u32 = 0x0000_0002;
    pub const V4L2_CAP_DEVICE_CAPS: u32 = 0x8000_0000;
    pub const V4L2_CAP_TIMEPERFRAME: u32 = 0x1000;

    pub const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
        (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
    }

    /// A fourcc as its four characters, for an error line.
    pub fn fourcc_name(code: u32) -> String {
        code.to_le_bytes()
            .iter()
            .map(|byte| {
                if byte.is_ascii_graphic() || *byte == b' ' {
                    char::from(*byte)
                } else {
                    '?'
                }
            })
            .collect()
    }

    const IOC_WRITE: u32 = 1;
    const IOC_READ: u32 = 2;
    const IOC_NRSHIFT: u32 = 0;
    const IOC_TYPESHIFT: u32 = 8;
    const IOC_SIZESHIFT: u32 = 16;
    const IOC_DIRSHIFT: u32 = 30;

    const fn ioc(dir: u32, kind: u8, nr: u8, size: usize) -> u32 {
        (dir << IOC_DIRSHIFT)
            | ((size as u32) << IOC_SIZESHIFT)
            | ((kind as u32) << IOC_TYPESHIFT)
            | ((nr as u32) << IOC_NRSHIFT)
    }

    const fn ior<T>(kind: u8, nr: u8) -> u32 {
        ioc(IOC_READ, kind, nr, size_of::<T>())
    }

    const fn iowr<T>(kind: u8, nr: u8) -> u32 {
        ioc(IOC_READ | IOC_WRITE, kind, nr, size_of::<T>())
    }

    pub const VIDIOC_QUERYCAP: u32 = ior::<V4l2Capability>(b'V', 0);
    pub const VIDIOC_G_FMT: u32 = iowr::<V4l2Format>(b'V', 4);
    pub const VIDIOC_S_FMT: u32 = iowr::<V4l2Format>(b'V', 5);
    pub const VIDIOC_S_PARM: u32 = iowr::<V4l2Streamparm>(b'V', 22);

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct V4l2Capability {
        pub driver: [u8; 16],
        pub card: [u8; 32],
        pub bus_info: [u8; 32],
        pub version: u32,
        pub capabilities: u32,
        pub device_caps: u32,
        pub reserved: [u32; 3],
    }

    impl V4l2Capability {
        /// The capabilities of this node: `device_caps` when the driver
        /// fills it (every modern one does), else the whole device's.
        pub fn node_caps(&self) -> u32 {
            if self.capabilities & V4L2_CAP_DEVICE_CAPS != 0 {
                self.device_caps
            } else {
                self.capabilities
            }
        }

        /// The driver's card name, for diagnostics.
        pub fn card_name(&self) -> String {
            let end = self
                .card
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(self.card.len());
            String::from_utf8_lossy(&self.card[..end]).into_owned()
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct V4l2PixFormat {
        pub width: u32,
        pub height: u32,
        pub pixelformat: u32,
        pub field: u32,
        pub bytesperline: u32,
        pub sizeimage: u32,
        pub colorspace: u32,
        pub priv_: u32,
        pub flags: u32,
        /// `ycbcr_enc` or `hsv_enc`.
        pub ycbcr_enc: u32,
        pub quantization: u32,
        pub xfer_func: u32,
    }

    /// `v4l2_format`'s union: 200 bytes, pointer-aligned because
    /// `v4l2_window` holds a pointer.
    #[repr(C)]
    pub union V4l2FormatUnion {
        pub pix: V4l2PixFormat,
        pub raw_data: [u8; 200],
        _align: *const c_void,
    }

    #[repr(C)]
    pub struct V4l2Format {
        pub type_: u32,
        pub fmt: V4l2FormatUnion,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct V4l2Fract {
        pub numerator: u32,
        pub denominator: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct V4l2OutputParm {
        pub capability: u32,
        pub outputmode: u32,
        pub timeperframe: V4l2Fract,
        pub extendedmode: u32,
        pub writebuffers: u32,
        pub reserved: [u32; 4],
    }

    #[repr(C)]
    pub union V4l2ParmUnion {
        pub output: V4l2OutputParm,
        pub raw_data: [u8; 200],
    }

    #[repr(C)]
    pub struct V4l2Streamparm {
        pub type_: u32,
        pub parm: V4l2ParmUnion,
    }

    /// One YUYV frame: two bytes a pixel.
    pub const fn yuyv_frame_len(width: u32, height: u32) -> usize {
        width as usize * 2 * height as usize
    }

    /// The pixel format the writer asks for.
    pub fn output_pix_format(width: u32, height: u32) -> V4l2PixFormat {
        V4l2PixFormat {
            width,
            height,
            pixelformat: V4L2_PIX_FMT_YUYV,
            field: V4L2_FIELD_NONE,
            bytesperline: width * 2,
            sizeimage: yuyv_frame_len(width, height) as u32,
            colorspace: V4L2_COLORSPACE_REC709,
            priv_: 0,
            flags: 0,
            ycbcr_enc: 0,
            quantization: 0,
            xfer_func: 0,
        }
    }

    /// What `VIDIOC_S_FMT` handed back, checked against the ask: the bytes
    /// one frame write carries, or why the device is unusable. The driver
    /// may page-align `sizeimage`; it must not shrink it.
    pub fn check_output_format(
        pix: &V4l2PixFormat,
        width: u32,
        height: u32,
    ) -> Result<usize, String> {
        if pix.pixelformat != V4L2_PIX_FMT_YUYV {
            return Err(format!(
                "the device kept {} instead of YUYV",
                fourcc_name(pix.pixelformat)
            ));
        }
        if (pix.width, pix.height) != (width, height) {
            return Err(format!(
                "the device kept {}×{} instead of {width}×{height}",
                pix.width, pix.height
            ));
        }
        let frame_len = yuyv_frame_len(width, height);
        if (pix.sizeimage as usize) < frame_len {
            return Err(format!(
                "the device's frame is {} bytes, one YUYV {width}×{height} frame is {frame_len}",
                pix.sizeimage
            ));
        }
        Ok(frame_len)
    }
}

// ---------------------------------------------------------------------------
// D2: the writer (Linux only)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod writer {
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::path::{Path, PathBuf};

    use super::abi::{
        V4L2_BUF_TYPE_VIDEO_OUTPUT, V4L2_CAP_TIMEPERFRAME, V4L2_CAP_VIDEO_OUTPUT, V4l2Capability,
        V4l2Format, V4l2Fract, V4l2OutputParm, V4l2Streamparm, VIDIOC_G_FMT, VIDIOC_QUERYCAP,
        VIDIOC_S_FMT, VIDIOC_S_PARM, check_output_format, output_pix_format,
    };
    use super::{LinuxCameraRoots, LinuxSetupState, MODINFO, not_ready_message, probe_setup};
    use crate::virtual_camera::{
        VIRTUAL_CAMERA_FPS, VIRTUAL_CAMERA_HEIGHT, VIRTUAL_CAMERA_WIDTH, VirtualCameraFrame,
        VirtualCameraPts, VirtualCameraPush, VirtualCameraSink, VirtualCameraSinkError,
        i420_to_yuyv,
    };

    /// `/dev/video42` (found by name) held open for output while the switch
    /// is on. One `write()` per tick; the file closes on off, and with
    /// `exclusive_caps=1` that is what removes the camera from Chrome's list.
    pub struct V4l2LoopbackSink {
        roots: LinuxCameraRoots,
        device: Option<(PathBuf, File)>,
        yuyv: Vec<u8>,
        frame_len: usize,
    }

    impl V4l2LoopbackSink {
        pub fn new() -> Self {
            Self {
                roots: LinuxCameraRoots::default(),
                device: None,
                yuyv: Vec::new(),
                frame_len: 0,
            }
        }
    }

    fn ioctl<T>(file: &File, request: u32, arg: &mut T) -> std::io::Result<()> {
        loop {
            // SAFETY: `request` is one of the V4L2 ioctls in `abi`, and `T` is
            // the struct that ioctl reads and writes, laid out as
            // `videodev2.h` says (the tests pin the sizes); `arg` outlives
            // the call.
            let result = unsafe { libc::ioctl(file.as_raw_fd(), request as _, arg as *mut T) };
            if result >= 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    /// Open the loopback node for output and set YUYV 1920×1080 at 30 fps:
    /// the file and the bytes one frame write carries.
    fn open_output(path: &Path) -> Result<(File, usize), VirtualCameraSinkError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| {
                let fix = if error.kind() == std::io::ErrorKind::PermissionDenied {
                    " Add your user to the `video` group (sudo usermod -aG video $USER) and log in again."
                } else {
                    ""
                };
                VirtualCameraSinkError::disconnected(format!(
                    "Could not open {} for Videorc Camera: {error}.{fix}",
                    path.display()
                ))
            })?;

        // SAFETY: all-zero bytes are a valid `V4l2Capability` (plain integers
        // and byte arrays).
        let mut capability: V4l2Capability = unsafe { std::mem::zeroed() };
        ioctl(&file, VIDIOC_QUERYCAP, &mut capability).map_err(|error| {
            VirtualCameraSinkError::disconnected(format!(
                "{} is not a V4L2 device (VIDIOC_QUERYCAP: {error}).",
                path.display()
            ))
        })?;
        if capability.node_caps() & V4L2_CAP_VIDEO_OUTPUT == 0 {
            return Err(VirtualCameraSinkError::disconnected(format!(
                "{} ({}) is not a V4L2 output device; Videorc Camera needs the v4l2loopback node.",
                path.display(),
                capability.card_name()
            )));
        }

        // The frame rate is a hint to readers; a driver that refuses it still
        // takes frames, so this is best effort.
        // SAFETY: zero is a valid `V4l2Streamparm` (integers and a byte union).
        let mut parm: V4l2Streamparm = unsafe { std::mem::zeroed() };
        parm.type_ = V4L2_BUF_TYPE_VIDEO_OUTPUT;
        parm.parm.output = V4l2OutputParm {
            capability: V4L2_CAP_TIMEPERFRAME,
            outputmode: 0,
            timeperframe: V4l2Fract {
                numerator: 1,
                denominator: VIRTUAL_CAMERA_FPS,
            },
            extendedmode: 0,
            writebuffers: 0,
            reserved: [0; 4],
        };
        if let Err(error) = ioctl(&file, VIDIOC_S_PARM, &mut parm) {
            tracing::warn!(
                "Videorc Camera: {} refused {} fps (VIDIOC_S_PARM: {error}); writing anyway",
                path.display(),
                VIRTUAL_CAMERA_FPS
            );
        }

        // SAFETY: zero is a valid `V4l2Format` (integers, bytes and a null
        // pointer in the alignment member).
        let mut format: V4l2Format = unsafe { std::mem::zeroed() };
        format.type_ = V4L2_BUF_TYPE_VIDEO_OUTPUT;
        // Read the driver's defaults first (OBS does), then set ours over them.
        let _ = ioctl(&file, VIDIOC_G_FMT, &mut format);
        format.type_ = V4L2_BUF_TYPE_VIDEO_OUTPUT;
        format.fmt.pix = output_pix_format(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT);
        ioctl(&file, VIDIOC_S_FMT, &mut format).map_err(|error| {
            VirtualCameraSinkError::disconnected(format!(
                "{} refused YUYV {}×{} (VIDIOC_S_FMT: {error}). Another writer may hold v4l2loopback.",
                path.display(),
                VIRTUAL_CAMERA_WIDTH,
                VIRTUAL_CAMERA_HEIGHT
            ))
        })?;
        // SAFETY: the driver filled `pix` for a VIDEO_OUTPUT format.
        let pix = unsafe { format.fmt.pix };
        let frame_len = check_output_format(&pix, VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT)
            .map_err(|why| {
                VirtualCameraSinkError::disconnected(format!(
                    "{} cannot carry Videorc Camera: {why}.",
                    path.display()
                ))
            })?;
        Ok((file, frame_len))
    }

    impl VirtualCameraSink for V4l2LoopbackSink {
        fn label(&self) -> &'static str {
            "v4l2loopback"
        }

        fn connect(&mut self) -> Result<(), VirtualCameraSinkError> {
            if self.device.is_some() {
                return Ok(());
            }
            let state = probe_setup(&self.roots, &MODINFO);
            let LinuxSetupState::Ready { device } = state else {
                return Err(VirtualCameraSinkError::disconnected(
                    not_ready_message(&state)
                        .unwrap_or_else(|| "v4l2loopback is not ready.".to_string()),
                ));
            };
            let (file, frame_len) = open_output(&device)?;
            tracing::info!(
                "Videorc Camera writes YUYV {}×{} at {} fps to {}",
                VIRTUAL_CAMERA_WIDTH,
                VIRTUAL_CAMERA_HEIGHT,
                VIRTUAL_CAMERA_FPS,
                device.display()
            );
            self.frame_len = frame_len;
            self.device = Some((device, file));
            Ok(())
        }

        fn disconnect(&mut self) {
            if let Some((device, file)) = self.device.take() {
                drop(file);
                tracing::info!("Videorc Camera closed {}", device.display());
            }
        }

        fn push(
            &mut self,
            frame: &VirtualCameraFrame<'_>,
            _pts: VirtualCameraPts,
        ) -> Result<VirtualCameraPush, VirtualCameraSinkError> {
            let Some((device, file)) = self.device.as_mut() else {
                return Err(VirtualCameraSinkError::disconnected(
                    "Videorc Camera's device is not open.",
                ));
            };
            let VirtualCameraFrame::I420 { planes, .. } = frame else {
                return Err(VirtualCameraSinkError::transient(format!(
                    "Videorc Camera on Linux writes CPU frames only; got {}",
                    frame.kind()
                )));
            };
            i420_to_yuyv(&planes.view(), &mut self.yuyv);
            if self.yuyv.len() != self.frame_len {
                return Err(VirtualCameraSinkError::transient(format!(
                    "Videorc Camera's frame is {} bytes, {} expects {}",
                    self.yuyv.len(),
                    device.display(),
                    self.frame_len
                )));
            }
            match file.write_all(&self.yuyv) {
                Ok(()) => Ok(VirtualCameraPush::Pushed),
                Err(error) => {
                    // The module was unloaded or the node vanished: the
                    // output reconnects once a second, re-finding the device.
                    let message = format!("Videorc Camera lost {}: {error}", device.display());
                    self.device = None;
                    Err(VirtualCameraSinkError::disconnected(message))
                }
            }
        }

        fn viewers(&self) -> Option<u32> {
            // D13: v4l2loopback has no reader count; unknown counts as held.
            None
        }
    }
}

/// The Linux sink. `platform_sink` reaches it only once [`PROVEN`] is true.
pub fn sink() -> Result<Box<dyn VirtualCameraSink>, VirtualCameraUnavailable> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(writer::V4l2LoopbackSink::new()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(VirtualCameraUnavailable::new(
            "Videorc Camera's v4l2loopback writer runs on Linux only.",
        ))
    }
}

/// Keeps `Path` in the pure half's signature set on every platform.
#[allow(dead_code)]
fn _path_marker(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::abi::*;
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct FakeModinfo {
        installed: bool,
        calls: AtomicU32,
    }

    impl FakeModinfo {
        fn new(installed: bool) -> Self {
            Self {
                installed,
                calls: AtomicU32::new(0),
            }
        }
    }

    impl ModuleInfo for FakeModinfo {
        fn installed(&self, module: &str) -> bool {
            assert_eq!(module, "v4l2loopback");
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.installed
        }
    }

    /// A fake box: `sys/class/video4linux/<node>/name` per camera, an
    /// optional `sys/module/v4l2loopback`, an optional `etc/os-release`.
    fn fake_box(
        cameras: &[(&str, &str)],
        loaded: bool,
        os_release: Option<&str>,
    ) -> (PathBuf, LinuxCameraRoots) {
        let root =
            std::env::temp_dir().join(format!("videorc-vcam-linux-{}", uuid::Uuid::new_v4()));
        let sysfs = root.join("sys/class/video4linux");
        let dev = root.join("dev");
        let sys_module = root.join("sys/module");
        for (node, name) in cameras {
            std::fs::create_dir_all(sysfs.join(node)).unwrap();
            std::fs::write(sysfs.join(node).join("name"), format!("{name}\n")).unwrap();
        }
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::create_dir_all(&sys_module).unwrap();
        if loaded {
            std::fs::create_dir_all(sys_module.join("v4l2loopback")).unwrap();
        }
        let os_release_path = root.join("etc/os-release");
        if let Some(text) = os_release {
            std::fs::create_dir_all(root.join("etc")).unwrap();
            std::fs::write(&os_release_path, text).unwrap();
        }
        (
            root.clone(),
            LinuxCameraRoots {
                v4l2: V4l2Roots {
                    sysfs_class: sysfs,
                    dev,
                    by_id: root.join("by-id"),
                },
                sys_module,
                os_release: os_release_path,
            },
        )
    }

    const UBUNTU: &str =
        "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n";
    const FEDORA: &str = "NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=41\n";
    const OMARCHY: &str = "NAME=\"Omarchy\"\nID=omarchy\nID_LIKE=arch\n";

    #[test]
    fn the_camera_is_hidden_until_the_linux_box_proves_it() {
        assert!(
            !PROVEN,
            "flip PROVEN only after spike P0c passes on a named Linux box"
        );
        let hidden = VirtualCameraUnavailable::hidden_until_proven("Linux");
        assert!(hidden.hidden);
        assert!(hidden.reason.contains("Linux"));
        let plain = VirtualCameraUnavailable::new("no");
        assert!(!plain.hidden);
        assert_eq!(plain.reason, "no");
    }

    #[test]
    fn the_load_is_one_argv_with_the_shared_label_and_number() {
        assert_eq!(
            LOAD_MODULE_ARGS,
            [
                "modprobe",
                "v4l2loopback",
                "exclusive_caps=1",
                "card_label=Videorc Camera",
                "video_nr=42"
            ]
        );
        assert_eq!(
            LOAD_MODULE_ARGS[3],
            format!("card_label={VIRTUAL_CAMERA_LINUX_CARD_LABEL}")
        );
        assert_eq!(
            LOAD_MODULE_ARGS[4],
            format!("video_nr={VIRTUAL_CAMERA_LINUX_VIDEO_NR}")
        );
        assert!(
            LOAD_MODULE_ARGS
                .iter()
                .all(|arg| !arg.contains(['"', '\'', ';', '&', '|'])),
            "argv carries no shell quoting"
        );
        assert_eq!(
            load_module_terminal_line(),
            "sudo modprobe v4l2loopback exclusive_caps=1 card_label=\"Videorc Camera\" video_nr=42"
        );
    }

    #[test]
    fn the_device_is_found_by_its_card_label_and_the_fixed_number_wins() {
        let (root, roots) = fake_box(
            &[
                ("video0", "FaceTime HD Camera (Built-in): "),
                ("video5", "Videorc Camera"),
                ("video42", "Videorc Camera:"),
                ("video43", "Videorc Camera 2"),
                ("video44", "OBS Virtual Camera"),
            ],
            true,
            None,
        );
        assert_eq!(
            find_videorc_device(&roots.v4l2),
            Some(roots.v4l2.dev.join("video42"))
        );
        std::fs::remove_dir_all(roots.v4l2.sysfs_class.join("video42")).unwrap();
        assert_eq!(
            find_videorc_device(&roots.v4l2),
            Some(roots.v4l2.dev.join("video5")),
            "another number carries the label too"
        );
        std::fs::remove_dir_all(roots.v4l2.sysfs_class.join("video5")).unwrap();
        assert_eq!(
            find_videorc_device(&roots.v4l2),
            None,
            "a similar name is not ours"
        );
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(
            find_videorc_device(&roots.v4l2),
            None,
            "no sysfs, no device"
        );
    }

    #[test]
    fn the_state_table_reads_the_device_then_the_module_then_modinfo() {
        // Ready: the device is there, whatever else says.
        let (root, roots) = fake_box(&[("video42", "Videorc Camera")], false, Some(UBUNTU));
        let modinfo = FakeModinfo::new(false);
        assert_eq!(
            probe_setup(&roots, &modinfo),
            LinuxSetupState::Ready {
                device: roots.v4l2.dev.join("video42")
            }
        );
        assert_eq!(
            modinfo.calls.load(Ordering::SeqCst),
            0,
            "no process when the device is there"
        );
        let _ = std::fs::remove_dir_all(&root);

        // Loaded without our device: another app's label.
        let (root, roots) = fake_box(&[("video2", "OBS Virtual Camera")], true, Some(UBUNTU));
        assert_eq!(
            probe_setup(&roots, &FakeModinfo::new(true)),
            LinuxSetupState::LoadedWithoutDevice
        );
        let _ = std::fs::remove_dir_all(&root);

        // Installed, not loaded.
        let (root, roots) = fake_box(&[("video0", "USB Cam")], false, Some(UBUNTU));
        assert_eq!(
            probe_setup(&roots, &FakeModinfo::new(true)),
            LinuxSetupState::NeedsLoad {
                manager: PackageManager::Apt
            }
        );
        // Not installed: the distribution picks the command.
        assert_eq!(
            probe_setup(&roots, &FakeModinfo::new(false)),
            LinuxSetupState::NeedsInstall {
                manager: PackageManager::Apt
            }
        );
        let _ = std::fs::remove_dir_all(&root);

        // No os-release at all: the generic guidance.
        let (root, roots) = fake_box(&[], false, None);
        assert_eq!(
            probe_setup(&roots, &FakeModinfo::new(false)),
            LinuxSetupState::NeedsInstall {
                manager: PackageManager::Unknown
            }
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_distribution_comes_from_id_then_id_like() {
        assert_eq!(package_manager_for_os_release(UBUNTU), PackageManager::Apt);
        assert_eq!(
            package_manager_for_os_release("ID=pop\nID_LIKE=\"ubuntu debian\"\n"),
            PackageManager::Apt
        );
        assert_eq!(
            package_manager_for_os_release("ID=linuxmint\nID_LIKE=ubuntu\n"),
            PackageManager::Apt
        );
        assert_eq!(package_manager_for_os_release(FEDORA), PackageManager::Dnf);
        assert_eq!(
            package_manager_for_os_release("ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n"),
            PackageManager::Dnf
        );
        assert_eq!(
            package_manager_for_os_release("ID=arch\n"),
            PackageManager::Pacman
        );
        assert_eq!(
            package_manager_for_os_release(OMARCHY),
            PackageManager::Pacman
        );
        assert_eq!(
            package_manager_for_os_release("ID=manjaro\nID_LIKE=arch\n"),
            PackageManager::Pacman
        );
        assert_eq!(
            package_manager_for_os_release("ID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n"),
            PackageManager::Unknown
        );
        assert_eq!(package_manager_for_os_release(""), PackageManager::Unknown);
        assert_eq!(
            install_command(PackageManager::Apt),
            Some("sudo apt install v4l2loopback-dkms")
        );
        assert_eq!(
            install_command(PackageManager::Dnf),
            Some("sudo dnf install v4l2loopback")
        );
        assert_eq!(
            install_command(PackageManager::Pacman),
            Some("sudo pacman -S v4l2loopback-dkms")
        );
        assert_eq!(install_command(PackageManager::Unknown), None);
    }

    #[test]
    fn the_state_table_copy_is_pinned() {
        // needs-setup: the install command alone, one copyable line.
        for manager in [
            PackageManager::Apt,
            PackageManager::Dnf,
            PackageManager::Pacman,
        ] {
            let command = install_command(manager).unwrap();
            assert!(command.starts_with("sudo "), "{command}");
            assert!(!command.contains("Secure Boot"), "{command}");
            assert_eq!(
                platform_report(&LinuxSetupState::NeedsInstall { manager }),
                (
                    VirtualCameraPlatformStep::NeedsSetup,
                    Some(command.to_string())
                )
            );
            assert_eq!(
                platform_report(&LinuxSetupState::NeedsLoad { manager }),
                (
                    VirtualCameraPlatformStep::NeedsSetup,
                    Some(command.to_string())
                )
            );
        }
        assert_eq!(
            platform_report(&LinuxSetupState::NeedsInstall {
                manager: PackageManager::Apt
            }),
            (
                VirtualCameraPlatformStep::NeedsSetup,
                Some("sudo apt install v4l2loopback-dkms".to_string())
            )
        );
        // No known distribution: absent, and the page names the package manager.
        assert_eq!(
            platform_report(&LinuxSetupState::NeedsInstall {
                manager: PackageManager::Unknown
            }),
            (VirtualCameraPlatformStep::NeedsSetup, None)
        );
        assert_eq!(
            platform_report(&LinuxSetupState::NeedsLoad {
                manager: PackageManager::Unknown
            }),
            (VirtualCameraPlatformStep::NeedsSetup, None)
        );
        // Another app's label: a failed step with the terminal lines.
        assert_eq!(
            platform_report(&LinuxSetupState::LoadedWithoutDevice),
            (
                VirtualCameraPlatformStep::Failed,
                Some("v4l2loopback is loaded without a Videorc Camera device (another app loaded it under its own name). In a terminal: sudo modprobe -r v4l2loopback, then sudo modprobe v4l2loopback exclusive_caps=1 card_label=\"Videorc Camera\" video_nr=42.".to_string())
            )
        );
        assert_eq!(
            setting_up_report(),
            (VirtualCameraPlatformStep::SettingUp, None)
        );
        assert_eq!(
            platform_report(&LinuxSetupState::Ready {
                device: PathBuf::from("/dev/video42")
            }),
            (VirtualCameraPlatformStep::Ready, None)
        );
        // The writer's own words when it finds the module not ready.
        assert_eq!(
            not_ready_message(&LinuxSetupState::NeedsLoad {
                manager: PackageManager::Unknown
            })
            .as_deref(),
            Some("v4l2loopback is not loaded. Install it, then choose Load module.")
        );
        assert_eq!(
            not_ready_message(&LinuxSetupState::LoadedWithoutDevice).as_deref(),
            Some(LOADED_WITHOUT_DEVICE_MESSAGE)
        );
        assert_eq!(
            not_ready_message(&LinuxSetupState::Ready {
                device: PathBuf::from("/dev/video42")
            }),
            None
        );
    }

    #[test]
    fn a_probe_keeps_mains_word_until_the_box_changes() {
        let needs_setup = platform_report(&LinuxSetupState::NeedsLoad {
            manager: PackageManager::Apt,
        });
        let needs_install = platform_report(&LinuxSetupState::NeedsInstall {
            manager: PackageManager::Unknown,
        });
        let ready = (VirtualCameraPlatformStep::Ready, None);
        let loading = setting_up_report();
        let refused = (
            VirtualCameraPlatformStep::Failed,
            Some("Secure Boot refused the unsigned v4l2loopback module.".to_string()),
        );
        let mut memory = ProbeMemory::default();
        // Nothing yet: the probe's word stands.
        assert_eq!(
            memory.merge(None, needs_setup.clone()),
            Some(needs_setup.clone())
        );
        // The same again: nothing to republish.
        assert_eq!(memory.merge(Some(&needs_setup), needs_setup.clone()), None);
        // Main is loading and the box has not changed: keep it.
        assert_eq!(memory.merge(Some(&loading), needs_setup.clone()), None);
        // Main's refusal stands while the box is as it was.
        assert_eq!(memory.merge(Some(&refused), needs_setup.clone()), None);
        // The device appears: ready ends anything.
        assert_eq!(
            memory.merge(Some(&refused), ready.clone()),
            Some(ready.clone())
        );
        // The module goes: back to guidance over the probe's own report.
        assert_eq!(
            memory.merge(Some(&ready), needs_setup.clone()),
            Some(needs_setup.clone())
        );
        // The box changed under main's refusal (the package was removed):
        // the new truth replaces it.
        assert_eq!(
            memory.merge(Some(&refused), needs_install.clone()),
            Some(needs_install.clone())
        );
        // A probe's own report is refreshed whenever it differs.
        assert_eq!(
            memory.merge(Some(&needs_install), needs_setup.clone()),
            Some(needs_setup)
        );
        assert_eq!(next_probe_interval(false), Duration::from_secs(1));
        assert_eq!(next_probe_interval(true), Duration::from_secs(10));
    }

    #[test]
    fn modinfo_is_asked_once_per_ttl() {
        let cached = CachedModuleInfo::new(FakeModinfo::new(false), Duration::from_secs(3600));
        assert!(!cached.installed("v4l2loopback"));
        assert!(!cached.installed("v4l2loopback"));
        assert_eq!(cached.inner.calls.load(Ordering::SeqCst), 1);
        let uncached = CachedModuleInfo::new(FakeModinfo::new(true), Duration::ZERO);
        assert!(uncached.installed("v4l2loopback"));
        assert!(uncached.installed("v4l2loopback"));
        assert_eq!(uncached.inner.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_v4l2_abi_matches_videodev2() {
        assert_eq!(std::mem::size_of::<V4l2Capability>(), 104);
        assert_eq!(std::mem::size_of::<V4l2PixFormat>(), 48);
        assert_eq!(std::mem::size_of::<V4l2Streamparm>(), 204);
        assert_eq!(std::mem::size_of::<V4l2OutputParm>(), 40);
        assert_eq!(V4L2_PIX_FMT_YUYV, 0x5659_5559);
        assert_eq!(fourcc_name(V4L2_PIX_FMT_YUYV), "YUYV");
        assert_eq!(fourcc_name(0x0102_0304), "????");
        assert_eq!(yuyv_frame_len(1920, 1080), 4_147_200);
        #[cfg(target_pointer_width = "64")]
        {
            // `v4l2_format` is 208 bytes on 64-bit (the union is pointer
            // aligned), which is what the ioctl numbers encode.
            assert_eq!(std::mem::size_of::<V4l2Format>(), 208);
            assert_eq!(VIDIOC_QUERYCAP, 0x8068_5600);
            assert_eq!(VIDIOC_G_FMT, 0xC0D0_5604);
            assert_eq!(VIDIOC_S_FMT, 0xC0D0_5605);
            assert_eq!(VIDIOC_S_PARM, 0xC0CC_5616);
        }
        let capability = V4l2Capability {
            driver: [0; 16],
            card: *b"Videorc Camera\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0",
            bus_info: [0; 32],
            version: 0,
            capabilities: V4L2_CAP_DEVICE_CAPS | V4L2_CAP_VIDEO_OUTPUT | 0x1,
            device_caps: V4L2_CAP_VIDEO_OUTPUT,
            reserved: [0; 3],
        };
        assert_eq!(capability.node_caps(), V4L2_CAP_VIDEO_OUTPUT);
        assert_eq!(capability.card_name(), "Videorc Camera");
        let whole_device = V4l2Capability {
            capabilities: V4L2_CAP_VIDEO_OUTPUT,
            device_caps: 0,
            ..capability
        };
        assert_eq!(whole_device.node_caps(), V4L2_CAP_VIDEO_OUTPUT);
    }

    #[test]
    fn the_set_format_answer_is_checked_against_the_ask() {
        let asked = output_pix_format(1920, 1080);
        assert_eq!(asked.pixelformat, V4L2_PIX_FMT_YUYV);
        assert_eq!(asked.field, V4L2_FIELD_NONE);
        assert_eq!(asked.bytesperline, 3840);
        assert_eq!(asked.sizeimage, 4_147_200);
        assert_eq!(asked.colorspace, V4L2_COLORSPACE_REC709);
        assert_eq!(check_output_format(&asked, 1920, 1080), Ok(4_147_200));
        // v4l2loopback page-aligns its buffer: still one frame's bytes to write.
        let aligned = V4l2PixFormat {
            sizeimage: 4_149_248,
            ..asked
        };
        assert_eq!(check_output_format(&aligned, 1920, 1080), Ok(4_147_200));
        let other_format = V4l2PixFormat {
            pixelformat: fourcc(b'Y', b'U', b'1', b'2'),
            ..asked
        };
        assert_eq!(
            check_output_format(&other_format, 1920, 1080),
            Err("the device kept YU12 instead of YUYV".to_string())
        );
        let other_size = V4l2PixFormat {
            width: 1280,
            height: 720,
            ..asked
        };
        assert_eq!(
            check_output_format(&other_size, 1920, 1080),
            Err("the device kept 1280×720 instead of 1920×1080".to_string())
        );
        let short = V4l2PixFormat {
            sizeimage: 100,
            ..asked
        };
        assert_eq!(
            check_output_format(&short, 1920, 1080),
            Err("the device's frame is 100 bytes, one YUYV 1920×1080 frame is 4147200".to_string())
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn off_linux_the_sink_says_so() {
        let refused = sink().err().expect("no writer off Linux");
        assert!(!refused.hidden);
        assert!(refused.reason.contains("Linux only"));
    }
}
