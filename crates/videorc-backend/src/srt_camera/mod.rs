//! Plan 250: the SRT Camera. A generic SRT input that shows up as one more
//! camera (D1, D3). Videorc only listens (D2), and only while a scene in use
//! holds the camera (D16).
//!
//! Everything here is shared code except `apple_decode`, the one place that
//! turns an access unit into a frame in the camera frame store (D9).

// D9: off macOS only the setting's shape is used; the camera's parts wait
// for the Windows and Linux plan.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod annexb;
#[cfg(target_os = "macos")]
pub mod apple_decode;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod camera;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
// Development builds only: a release build leaves the tap out entirely.
#[cfg(debug_assertions)]
pub mod frame_tap;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod libsrt;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod listener;
pub mod settings;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod signal;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod still;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod ts_demux;

use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Instant;

use crate::protocol::{SrtCameraStatus, SrtInputState};
use settings::{SrtInputSettings, camera_name, connection_latency_ms};

pub const SRT_CAMERA_ID: &str = "camera:srt-input";
pub const SRT_INPUT_CHANGED_EVENT: &str = "srtInput.changed";

pub fn is_srt_camera_id(camera_id: &str) -> bool {
    camera_id == SRT_CAMERA_ID
}

/// D9: the setting exists on macOS only in this plan.
pub const fn supported() -> bool {
    cfg!(target_os = "macos")
}

/// What the listener needs, as the setting stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenConfig {
    pub enabled: bool,
    pub port: u16,
    pub latency_ms: u32,
    pub passphrase: String,
}

type ChangeListener = Box<dyn Fn(SrtInputState) + Send + Sync>;

struct Service {
    settings: SrtInputSettings,
    passphrase: String,
    /// Bumped on every setting change, so a running camera rebinds.
    generation: u64,
    status: SrtCameraStatus,
    listener: Option<ChangeListener>,
}

fn service() -> &'static Mutex<Service> {
    static SERVICE: OnceLock<Mutex<Service>> = OnceLock::new();
    SERVICE.get_or_init(|| {
        Mutex::new(Service {
            settings: SrtInputSettings::default(),
            passphrase: String::new(),
            generation: 0,
            status: signal::SignalTracker::new().status(Instant::now(), false),
            listener: None,
        })
    })
}

fn notify(service: &Service) {
    if let Some(listener) = service.listener.as_ref() {
        listener(state_of(service));
    }
}

fn state_of(service: &Service) -> SrtInputState {
    let settings = service.settings;
    SrtInputState {
        supported: supported(),
        enabled: settings.enabled && supported(),
        port: settings.port,
        connection: settings.connection,
        latency_ms: connection_latency_ms(settings.connection),
        passphrase: service.passphrase.clone(),
        camera_id: SRT_CAMERA_ID.to_string(),
        camera_name: camera_name(settings.port),
        status: service.status.clone(),
    }
}

/// Where `srtInput.changed` goes: the app's event stream.
pub fn set_change_listener(listener: impl Fn(SrtInputState) + Send + Sync + 'static) {
    service()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .listener = Some(Box::new(listener));
}

/// The saved setting and passphrase, at start and after every change.
pub fn configure(settings: SrtInputSettings, passphrase: String) -> SrtInputState {
    let mut service = service().lock().unwrap_or_else(PoisonError::into_inner);
    if service.settings != settings || service.passphrase != passphrase {
        service.settings = settings;
        service.passphrase = passphrase;
        service.generation = service.generation.wrapping_add(1);
        notify(&service);
    }
    state_of(&service)
}

pub fn current_state() -> SrtInputState {
    state_of(&service().lock().unwrap_or_else(PoisonError::into_inner))
}

pub fn listen_config() -> (u64, ListenConfig) {
    let service = service().lock().unwrap_or_else(PoisonError::into_inner);
    (
        service.generation,
        ListenConfig {
            enabled: service.settings.enabled && supported(),
            port: service.settings.port,
            latency_ms: connection_latency_ms(service.settings.connection),
            passphrase: service.passphrase.clone(),
        },
    )
}

/// The pacer's newest decoded frame and the camera's rate, so the canvas
/// tick can follow the camera (`canvas_pace.rs`). Held frames and stills
/// never count. A watch keeps the news for a compositor that was busy rendering.
pub static NEW_FRAME: std::sync::LazyLock<
    tokio::sync::watch::Sender<Option<crate::canvas_pace::FrameNews>>,
> = std::sync::LazyLock::new(|| tokio::sync::watch::channel(None).0);

/// The scene's camera mirror, as the compositor's scene commit last set it.
/// The still is flipped to match, so it reads the right way once mirrored.
static SCENE_MIRRORS_CAMERA: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn set_scene_mirrors_camera(mirrored: bool) {
    SCENE_MIRRORS_CAMERA.store(mirrored, std::sync::atomic::Ordering::Relaxed);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn scene_mirrors_camera() -> bool {
    SCENE_MIRRORS_CAMERA.load(std::sync::atomic::Ordering::Relaxed)
}

/// The camera's status changed: tell the Studio (D17).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn publish_status(status: SrtCameraStatus) {
    let mut service = service().lock().unwrap_or_else(PoisonError::into_inner);
    let announce = worth_announcing(&service.status, &status);
    service.status = status;
    if announce {
        notify(&service);
    }
}

/// The camera session ended (the input off, another camera picked): the
/// status says nothing listens and nothing shows, keeping only the counters
/// pollers read.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn camera_session_ended() {
    let last = current_state().status;
    publish_status(ended_status(&last, Instant::now()));
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn ended_status(last: &SrtCameraStatus, now: Instant) -> SrtCameraStatus {
    SrtCameraStatus {
        sender_session: last.sender_session,
        frames_decoded: last.frames_decoded,
        ..signal::SignalTracker::new().status(now, false)
    }
}

/// A change the Studio should hear about: anything but the frame count,
/// which moves every frame and is read with `srtInput.get` instead.
fn worth_announcing(old: &SrtCameraStatus, new: &SrtCameraStatus) -> bool {
    let counted = SrtCameraStatus {
        frames_decoded: new.frames_decoded,
        ..old.clone()
    };
    counted != *new
}

/// The saved setting, loaded at start. Off macOS the passphrase is never
/// made: the setting does not exist there (D9).
pub fn load_saved(
    database: &crate::storage::Database,
    vault: &impl settings::PassphraseVault,
) -> anyhow::Result<SrtInputState> {
    let saved = settings::load_settings(database)?;
    if !supported() {
        return Ok(configure(saved, String::new()));
    }
    match settings::passphrase(vault) {
        Ok(passphrase) => Ok(configure(saved, passphrase)),
        // The setting stays as saved. With no passphrase the receiver does
        // not listen, and its state says so, until a setting change, a
        // renewal or a restart reads the passphrase again.
        Err(error) => {
            configure(saved, String::new());
            Err(error.context("the SRT input passphrase did not load"))
        }
    }
}

/// `srtInput.set`.
pub fn apply(
    database: &crate::storage::Database,
    vault: &impl settings::PassphraseVault,
    params: &crate::protocol::SrtInputSetParams,
) -> anyhow::Result<SrtInputState> {
    if !supported() {
        anyhow::bail!("The SRT input isn't available on this computer yet.");
    }
    let next = settings::load_settings(database)?.with(params)?;
    // The passphrase first: a setting that could not get one is never saved.
    // Turning the input off needs none, so a failing secret store can't keep
    // it on.
    let passphrase = match settings::passphrase(vault) {
        Ok(passphrase) => passphrase,
        Err(_) if !next.enabled => String::new(),
        Err(error) => return Err(error),
    };
    settings::save_settings(database, &next)?;
    Ok(configure(next, passphrase))
}

/// `srtInput.renewPassphrase`: every sender needs the new one (D4).
pub fn renew(
    database: &crate::storage::Database,
    vault: &impl settings::PassphraseVault,
) -> anyhow::Result<SrtInputState> {
    if !supported() {
        anyhow::bail!("The SRT input isn't available on this computer yet.");
    }
    let saved = settings::load_settings(database)?;
    Ok(configure(saved, settings::renew_passphrase(vault)?))
}

/// D3: the camera entry, only while the setting is on (macOS only, D9).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn camera_device(state: &SrtInputState) -> Option<crate::protocol::Device> {
    (state.supported && state.enabled).then(|| crate::protocol::Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: state.camera_id.clone(),
        name: state.camera_name.clone(),
        kind: crate::protocol::DeviceKind::Camera,
        status: crate::protocol::DeviceStatus::Available,
        detail: Some(state.status.detail.clone()),
        width: None,
        height: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SrtInputConnection;

    fn state(enabled: bool, supported: bool) -> SrtInputState {
        SrtInputState {
            supported,
            enabled,
            port: 9100,
            connection: SrtInputConnection::Cable,
            latency_ms: 40,
            passphrase: "p".repeat(32),
            camera_id: SRT_CAMERA_ID.to_string(),
            camera_name: camera_name(9100),
            status: signal::SignalTracker::new().status(Instant::now(), false),
        }
    }

    #[test]
    fn srt_camera_entry_shows_only_when_on_and_supported() {
        let device = camera_device(&state(true, true)).expect("listed");
        assert_eq!(device.id, "camera:srt-input");
        assert_eq!(device.name, "SRT Camera (port 9100)");
        assert_eq!(device.detail.as_deref(), Some("Waiting"));
        assert!(camera_device(&state(false, true)).is_none());
        assert!(camera_device(&state(true, false)).is_none());
    }

    /// One test owns the process-wide service, so the steps run in order.
    #[test]
    fn srt_service_load_apply_renew_round_trip() {
        let database = crate::storage::Database::open_in_memory_for_tests();
        let vault = settings::tests::MemoryVault::default();
        let loaded = load_saved(&database, &vault).unwrap();
        assert!(!loaded.enabled);
        assert_eq!(loaded.port, 9000);
        assert_eq!(loaded.camera_name, "SRT Camera (port 9000)");
        let params = crate::protocol::SrtInputSetParams {
            enabled: Some(true),
            port: Some(9123),
            connection: Some(crate::protocol::SrtInputConnection::Internet),
        };
        if !supported() {
            assert!(loaded.passphrase.is_empty());
            assert!(apply(&database, &vault, &params).is_err());
            assert!(renew(&database, &vault).is_err());
            return;
        }
        assert_eq!(loaded.passphrase.len(), 32);
        let generation_before = listen_config().0;
        let applied = apply(&database, &vault, &params).unwrap();
        assert!(applied.enabled);
        assert_eq!(applied.port, 9123);
        assert_eq!(applied.latency_ms, 500);
        assert_eq!(applied.passphrase, loaded.passphrase);
        assert_ne!(
            listen_config().0,
            generation_before,
            "a running camera rebinds"
        );
        let (_, config) = listen_config();
        assert_eq!(
            config,
            ListenConfig {
                enabled: true,
                port: 9123,
                latency_ms: 500,
                passphrase: loaded.passphrase.clone()
            }
        );
        let renewed = renew(&database, &vault).unwrap();
        assert_ne!(renewed.passphrase, loaded.passphrase);
        assert_eq!(listen_config().1.passphrase, renewed.passphrase);
        assert_eq!(
            settings::load_settings(&database).unwrap().port,
            9123,
            "saved"
        );
        assert!(
            apply(
                &database,
                &vault,
                &crate::protocol::SrtInputSetParams {
                    port: Some(22),
                    ..Default::default()
                }
            )
            .is_err()
        );
        // A secret store that fails can't keep the input on.
        struct LockedVault;
        impl settings::PassphraseVault for LockedVault {
            fn load(&self) -> anyhow::Result<Option<String>> {
                anyhow::bail!("the secret store is locked")
            }
            fn save(&self, _: &str) -> anyhow::Result<()> {
                anyhow::bail!("the secret store is locked")
            }
        }
        let on = crate::protocol::SrtInputSetParams {
            enabled: Some(true),
            ..Default::default()
        };
        assert!(apply(&database, &LockedVault, &on).is_err());
        let off = crate::protocol::SrtInputSetParams {
            enabled: Some(false),
            ..Default::default()
        };
        let state = apply(&database, &LockedVault, &off).expect("turns off");
        assert!(!state.enabled);
        assert!(
            !settings::load_settings(&database).unwrap().enabled,
            "saved"
        );
        configure(settings::SrtInputSettings::default(), String::new());
    }

    #[test]
    fn srt_status_a_frame_count_alone_is_not_announced() {
        let base = signal::SignalTracker::new().status(Instant::now(), true);
        let counted = SrtCameraStatus {
            frames_decoded: base.frames_decoded + 25,
            ..base.clone()
        };
        assert!(!worth_announcing(&base, &counted));
        let moved = SrtCameraStatus {
            detail: "Receiving".to_string(),
            ..base.clone()
        };
        assert!(worth_announcing(&base, &moved));
    }

    /// The camera session ended (the input off, another camera picked):
    /// nothing listens and nothing shows. The status said "holding" for
    /// as long as the input stayed off (memory probe, 2026-11-14).
    #[test]
    fn srt_status_after_the_camera_session_ends_is_waiting() {
        let now = Instant::now();
        let mut tracker = signal::SignalTracker::new();
        tracker.on_sender_accepted();
        tracker.on_frame(now, 1920, 1080);
        let holding = tracker.status(now + std::time::Duration::from_millis(1500), true);
        assert_eq!(holding.signal, crate::protocol::SrtCameraSignal::Holding);
        let ended = ended_status(&holding, now + std::time::Duration::from_secs(60));
        assert_eq!(ended.signal, crate::protocol::SrtCameraSignal::Waiting);
        assert!(!ended.listening);
        assert!(!ended.sender_connected);
        assert_eq!(ended.width, None);
        assert_eq!(ended.fps, None);
        assert_eq!(ended.detail, "Waiting");
        assert_eq!(ended.sender_session, holding.sender_session);
        assert_eq!(ended.frames_decoded, holding.frames_decoded);
    }

    #[test]
    fn srt_camera_id_is_recognised() {
        assert!(is_srt_camera_id("camera:srt-input"));
        assert!(!is_srt_camera_id("camera:avfoundation-native:00"));
    }
}
