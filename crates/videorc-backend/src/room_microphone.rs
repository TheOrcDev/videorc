//! Opt-in capture-only room speech. Never creates a recording or camera session.
use crate::audio::AudioProcessingSettings;
use crate::protocol::MicrophoneNoiseSuppression;
use crate::session_audio::room_tap::RoomMicrophoneTap;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static CLAIMED: AtomicBool = AtomicBool::new(false);
struct Claim;
impl Drop for Claim {
    fn drop(&mut self) {
        CLAIMED.store(false, Ordering::Release);
    }
}
pub(crate) fn claimed() -> bool {
    CLAIMED.load(Ordering::Acquire)
}

// Transport callers cannot bypass the device picker with a Pulse default alias
// or speaker-monitor source. No implicit source is permitted on this lane.
fn exact_microphone_id(id: &str) -> bool {
    if let Some(id) = crate::audio::parse_coreaudio_microphone_id(id) {
        return id != 0;
    }
    if let Some(name) = crate::audio::parse_windows_dshow_microphone_id(id) {
        return !name.is_empty() && !name.contains(['\0', '\r', '\n']);
    }
    crate::linux_pulse_audio::parse_linux_pulse_microphone_id(id).is_some_and(|name| {
        !name.starts_with(['@', '-'])
            && name != "default"
            && !name.ends_with(".monitor")
            && !name.contains(['\0', '\r', '\n'])
    })
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub device_id: String,
    pub gain_db: f32,
    pub muted: bool,
    pub noise: MicrophoneNoiseSuppression,
    pub offset_ms: u32,
}
impl Settings {
    fn valid(&self) -> bool {
        !self.device_id.is_empty()
            && self.device_id.len() <= 512
            && exact_microphone_id(&self.device_id)
            && self.gain_db.is_finite()
            && (-24.0..=24.0).contains(&self.gain_db)
            && self.offset_ms <= 1000
    }
    fn processing(&self) -> AudioProcessingSettings {
        AudioProcessingSettings {
            noise_suppression: self.noise,
            gain_db: self.gain_db,
            muted: self.muted,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Command {
    pub action: String,
    pub generation: u64,
    pub role: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub frames: u32,
    pub show_id: String,
    pub settings: Option<Settings>,
}
impl Command {
    fn valid(&self) -> bool {
        self.generation > 0
            && self.generation <= 9_007_199_254_740_991
            && self.role == "host-microphone"
            && self.sample_rate == 48000
            && self.channels == 1
            && self.frames == 480
            && !self.show_id.is_empty()
            && self.show_id.len() <= 128
            && match self.action.as_str() {
                "open" | "update" => self.settings.as_ref().is_some_and(Settings::valid),
                "pull" | "close" | "disconnect-test" | "starve-test" | "resume-test" => {
                    self.settings.is_none()
                }
                _ => false,
            }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    generation: u64,
    sequence: u64,
    first_sample: u64,
    first_sample_us: u64,
    observed_at_us: u64,
    sample_rate: u32,
    channels: u32,
    frames: u32,
    dropped_frames: u64,
    samples: Vec<f32>,
}
#[derive(Default)]
pub(crate) struct Bridge {
    claim: Option<Claim>,
    tap: Option<RoomMicrophoneTap>,
    generation: u64,
    show_id: String,
    settings: Option<Settings>,
}
impl Bridge {
    pub(crate) async fn command(
        &mut self,
        state: &AppState,
        command: Command,
    ) -> anyhow::Result<Option<Frame>> {
        anyhow::ensure!(command.valid(), "Invalid room microphone contract");
        if command.action == "close" {
            anyhow::ensure!(
                self.generation == command.generation && self.show_id == command.show_id,
                "Stale microphone owner"
            );
            if let Some(mut tap) = self.tap.take() {
                tap.close().await?;
            }
            anyhow::ensure!(
                crate::session_audio::room_microphone_producers() == 0,
                "Microphone producer cleanup still pending"
            );
            self.claim.take();
            return Ok(None);
        }
        anyhow::ensure!(
            crate::cloud_show::lock(&state.cloud_show)
                .talk_show_room_show_id()
                .as_deref()
                == Some(command.show_id.as_str()),
            "Room microphone owner is no longer current"
        );
        if command.action == "open" {
            anyhow::ensure!(
                self.tap.is_none() && command.generation > self.generation,
                "Stale microphone generation"
            );
            anyhow::ensure!(
                CLAIMED
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok(),
                "Room microphone already owned"
            );
            let claim = Claim;
            let work = state.ffmpeg_work.snapshot();
            anyhow::ensure!(
                !work.capture_active
                    && work.capture_waiting == 0
                    && state.capture_interruption.capture_admission_is_idle(),
                "Native capture owns microphone"
            );
            // Fence warm opens first, then await their actual release. Never open
            // a second physical producer beside a delayed warm/session cleanup.
            state.warm_microphone.disarm();
            anyhow::ensure!(
                state.warm_microphone.wait_for_open().await,
                "Warm microphone opening did not settle"
            );
            let ready = tokio::task::spawn_blocking(|| {
                super::session_audio::room_microphone_cleanup_ready()
            })
            .await?;
            anyhow::ensure!(ready, "Microphone producer cleanup still pending");
            let settings = command.settings.as_ref().expect("validated settings");
            if settings.noise == MicrophoneNoiseSuppression::Rnnoise {
                tokio::task::spawn_blocking(crate::microphone_denoise::prewarm).await?;
            }
            let source = if let Some(id) =
                crate::audio::parse_coreaudio_microphone_id(&settings.device_id)
            {
                crate::session_audio::prepare_initial_native(id).await?
            } else {
                // Existing capture-only adapter validates exact platform ids;
                // it has no implicit default-device or recording-output path.
                crate::session_audio::prepare_initial_adapter(
                    settings.device_id.clone(),
                    crate::ffmpeg::default_ffmpeg_path(),
                )
                .await?
            };
            anyhow::ensure!(
                crate::cloud_show::lock(&state.cloud_show)
                    .talk_show_room_show_id()
                    .as_deref()
                    == Some(command.show_id.as_str()),
                "Room closed during microphone acquisition"
            );
            self.tap = Some(RoomMicrophoneTap::new(
                source,
                settings.processing(),
                settings.offset_ms,
            )?);
            self.settings = command.settings;
            self.generation = command.generation;
            self.show_id = command.show_id;
            self.claim = Some(claim);
            return Ok(None);
        }
        anyhow::ensure!(
            self.generation == command.generation && self.show_id == command.show_id,
            "Stale microphone owner"
        );
        let tap = self
            .tap
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Room microphone closed"))?;
        if matches!(command.action.as_str(), "starve-test" | "resume-test") {
            #[cfg(debug_assertions)]
            {
                tap.starve_fixture(command.action == "starve-test")?;
                return Ok(None);
            }
            #[cfg(not(debug_assertions))]
            anyhow::bail!("Fixture unavailable");
        }
        if command.action == "disconnect-test" {
            #[cfg(debug_assertions)]
            {
                tap.disconnect_fixture()?;
                return Ok(None);
            }
            #[cfg(not(debug_assertions))]
            anyhow::bail!("Fixture unavailable");
        }
        if command.action == "update" {
            let next = command.settings.expect("validated settings");
            let current = self.settings.as_ref().expect("opened settings");
            anyhow::ensure!(
                current.device_id == next.device_id && current.offset_ms == next.offset_ms,
                "Device or offset changes require a new generation"
            );
            if next.noise == MicrophoneNoiseSuppression::Rnnoise {
                tokio::task::spawn_blocking(crate::microphone_denoise::prewarm).await?;
            }
            tap.update(next.processing());
            self.settings = Some(next);
            return Ok(None);
        }
        Ok(tap.pull(Instant::now())?.map(|chunk| Frame {
            generation: self.generation,
            sequence: chunk.sequence,
            first_sample: chunk.sequence * 480,
            first_sample_us: chunk.sequence * 10000,
            observed_at_us: chunk.observed_at_us,
            sample_rate: 48000,
            channels: 1,
            frames: 480,
            dropped_frames: chunk.dropped_frames,
            samples: chunk.samples,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_default_aliases_and_speaker_monitor_identities() {
        assert!(!exact_microphone_id("microphone:coreaudio:0"));
        for name in [
            "default",
            "@DEFAULT_SOURCE@",
            "alsa_output.speakers.monitor",
        ] {
            assert!(!exact_microphone_id(
                &crate::linux_pulse_audio::linux_pulse_microphone_id(name)
            ));
        }
        assert!(exact_microphone_id(
            &crate::linux_pulse_audio::linux_pulse_microphone_id("alsa_input.exact-microphone")
        ));
    }
    #[test]
    fn shared_fixture_matches_native_transport_and_processing_bounds() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/room-microphone.json"
        ))
        .unwrap();
        let mut command: Command = serde_json::from_value(serde_json::json!({
            "action":"open", "generation":1, "role":fixture["role"],
            "sampleRate":fixture["sampleRate"], "channels":fixture["channels"], "frames":fixture["frames"],
            "showId":"show", "settings":{"deviceId":"microphone:coreaudio:7","gainDb":fixture["gainDb"]["max"],
                "muted":false,"noise":"rnnoise","offsetMs":fixture["offsetMs"]["max"]}
        })).unwrap();
        assert!(command.valid());
        command.settings.as_mut().unwrap().offset_ms += 1;
        assert!(!command.valid());
        command.settings.as_mut().unwrap().offset_ms = 0;
        command.settings.as_mut().unwrap().gain_db += 1.0;
        assert!(!command.valid());
        for id in fixture["rejectedDeviceIds"].as_array().unwrap() {
            assert!(!exact_microphone_id(id.as_str().unwrap()));
        }
        assert_eq!(fixture["queueFrames"], 1920);
        assert_eq!(fixture["nativeProductionQualified"], false);
    }
    #[test]
    fn rejects_unknown_devices_lengths_and_controls_before_capture() {
        let value = serde_json::json!({"action":"open","generation":1,"role":"host-microphone","sampleRate":48000,"channels":1,"frames":480,"showId":"show","settings":{"deviceId":"microphone:coreaudio:7","gainDb":0,"muted":false,"noise":"rnnoise","offsetMs":0}});
        let mut c: Command = serde_json::from_value(value.clone()).unwrap();
        assert!(c.valid());
        c.frames = 481;
        assert!(!c.valid());
        let mut c: Command = serde_json::from_value(value).unwrap();
        c.settings.as_mut().unwrap().device_id.clear();
        assert!(!c.valid());
    }
}
