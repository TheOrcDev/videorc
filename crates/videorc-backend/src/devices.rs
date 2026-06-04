use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::audio::{
    AudioProcessingSettings, list_native_microphones, parse_coreaudio_microphone_id,
    sample_native_audio_meter,
};
use crate::camera_capture::list_native_cameras;
use crate::ffmpeg::resolve_ffmpeg_path;
use crate::protocol::{
    AudioMeterParams, AudioMeterResult, AudioMeterStatus, Device, DeviceKind, DeviceList,
    DeviceStatus,
};
use crate::screen_capture::list_native_capture_sources;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvFoundationDevice {
    pub index: usize,
    pub name: String,
    pub kind: AvFoundationDeviceKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvFoundationDeviceKind {
    Video,
    Audio,
}

pub async fn list_devices(ffmpeg_path: &str) -> DeviceList {
    let mut devices = Vec::new();
    let mut warnings = Vec::new();

    if !cfg!(target_os = "macos") {
        devices.extend([
            Device {
                id: "screen:unsupported-platform".to_string(),
                name: "Primary Display".to_string(),
                kind: DeviceKind::Screen,
                status: DeviceStatus::Unavailable,
                detail: Some("This spike only probes macOS devices.".to_string()),
            },
            Device {
                id: "window:unsupported-platform".to_string(),
                name: "Window Capture".to_string(),
                kind: DeviceKind::Window,
                status: DeviceStatus::Unavailable,
                detail: Some("This spike only probes macOS devices.".to_string()),
            },
            system_audio_placeholder(),
        ]);
        warnings.push("Device probing is only implemented for macOS in this spike.".to_string());
        return DeviceList { devices, warnings };
    }

    let native_capture_sources = list_native_capture_sources();
    warnings.extend(native_capture_sources.warnings);
    devices.extend(preview_ready_native_capture_devices(
        native_capture_sources.devices,
    ));

    let native_microphones = list_native_microphones();
    let native_microphone_available = native_microphones
        .iter()
        .any(|device| device.status == DeviceStatus::Available);
    let native_cameras = list_native_cameras();
    let native_camera_permission_required = native_cameras
        .devices
        .iter()
        .any(|device| device.status == DeviceStatus::PermissionRequired);
    warnings.extend(native_cameras.warnings);
    devices.extend(native_cameras.devices);

    match probe_avfoundation_devices(ffmpeg_path).await {
        Ok(av_devices) => {
            let screens = avfoundation_screen_devices(&av_devices);
            if screens.is_empty() {
                devices.push(missing_avfoundation_screen_device());
            } else {
                devices.extend(screens);
            }

            for device in av_devices {
                match device.kind {
                    AvFoundationDeviceKind::Video => {
                        if !device.name.to_lowercase().contains("capture screen") {
                            devices.push(Device {
                                id: format!("camera:avfoundation:{}", device.index),
                                name: format!("FFmpeg fallback - {}", device.name),
                                kind: DeviceKind::Camera,
                                status: if native_camera_permission_required {
                                    DeviceStatus::PermissionRequired
                                } else {
                                    DeviceStatus::Available
                                },
                                detail: Some(if native_camera_permission_required {
                                    "FFmpeg avfoundation fallback camera path; macOS Camera permission is required."
                                        .to_string()
                                } else {
                                    "FFmpeg avfoundation fallback camera path; native AVFoundation camera discovery is preferred."
                                        .to_string()
                                }),
                            });
                        }
                    }
                    AvFoundationDeviceKind::Audio => {
                        if !native_microphone_available {
                            devices.push(Device {
                                id: format!("microphone:avfoundation:{}", device.index),
                                name: device.name,
                                kind: DeviceKind::Microphone,
                                status: DeviceStatus::Available,
                                detail: Some(
                                    "FFmpeg avfoundation fallback; native CoreAudio probe did not return an available input."
                                        .to_string(),
                                ),
                            });
                        }
                    }
                }
            }
        }
        Err(error) => {
            devices.insert(0, avfoundation_probe_failed_screen_device());
            warnings.push(format!("FFmpeg device probe failed: {error}"));
        }
    }

    devices.extend(native_microphones);
    devices.push(system_audio_placeholder());

    DeviceList { devices, warnings }
}

fn preview_ready_native_capture_devices(devices: Vec<Device>) -> Vec<Device> {
    devices
        .into_iter()
        .map(|mut device| {
            if matches!(device.kind, DeviceKind::Screen | DeviceKind::Window)
                && device.status == DeviceStatus::Available
            {
                device.detail = Some(match device.kind {
                    DeviceKind::Screen => {
                        "Native ScreenCaptureKit display is available for native preview. Recording still uses the FFmpeg fallback bridge until the compositor output lands."
                            .to_string()
                    }
                    DeviceKind::Window => {
                        "Native ScreenCaptureKit window is available for native preview. Recording still uses the FFmpeg fallback bridge until the compositor output lands."
                            .to_string()
                    }
                    _ => unreachable!(),
                });
            }
            device
        })
        .collect()
}

fn avfoundation_screen_devices(av_devices: &[AvFoundationDevice]) -> Vec<Device> {
    av_devices
        .iter()
        .filter(|device| {
            device.kind == AvFoundationDeviceKind::Video
                && device.name.to_lowercase().contains("capture screen")
        })
        .map(|device| Device {
            id: format!("screen:avfoundation:{}", device.index),
            name: device.name.clone(),
            kind: DeviceKind::Screen,
            status: DeviceStatus::Available,
            detail: Some(
                "Capturable FFmpeg avfoundation screen source used by current preview and recording."
                    .to_string(),
            ),
        })
        .collect()
}

fn missing_avfoundation_screen_device() -> Device {
    Device {
        id: "screen:avfoundation-missing".to_string(),
        name: "Primary Display".to_string(),
        kind: DeviceKind::Screen,
        status: DeviceStatus::PermissionRequired,
        detail: Some(
            "FFmpeg did not report a screen device. macOS Screen Recording permission may be missing."
                .to_string(),
        ),
    }
}

fn avfoundation_probe_failed_screen_device() -> Device {
    Device {
        id: "screen:probe-failed".to_string(),
        name: "Primary Display".to_string(),
        kind: DeviceKind::Screen,
        status: DeviceStatus::Unavailable,
        detail: Some("FFmpeg avfoundation probing failed.".to_string()),
    }
}

fn system_audio_placeholder() -> Device {
    Device {
        id: "system-audio:native-adapter-pending".to_string(),
        name: "System Audio".to_string(),
        kind: DeviceKind::SystemAudio,
        status: DeviceStatus::Unavailable,
        detail: Some("System audio capture depends on the native macOS adapter.".to_string()),
    }
}

pub async fn find_avfoundation_screen_index(ffmpeg_path: &str) -> Option<usize> {
    probe_avfoundation_devices(ffmpeg_path)
        .await
        .ok()?
        .into_iter()
        .find(|device| {
            device.kind == AvFoundationDeviceKind::Video
                && device.name.to_lowercase().contains("capture screen")
        })
        .map(|device| device.index)
}

pub async fn find_avfoundation_camera_index(ffmpeg_path: &str, camera_name: &str) -> Option<usize> {
    let normalized_camera_name = normalize_device_name(camera_name);
    let video_devices = probe_avfoundation_devices(ffmpeg_path)
        .await
        .ok()?
        .into_iter()
        .filter(|device| {
            device.kind == AvFoundationDeviceKind::Video
                && !device.name.to_lowercase().contains("capture screen")
        })
        .collect::<Vec<_>>();

    video_devices
        .iter()
        .find(|device| normalize_device_name(&device.name) == normalized_camera_name)
        .or_else(|| {
            video_devices.iter().find(|device| {
                let normalized_name = normalize_device_name(&device.name);
                normalized_name.contains(&normalized_camera_name)
                    || normalized_camera_name.contains(&normalized_name)
            })
        })
        .map(|device| device.index)
}

fn normalize_device_name(name: &str) -> String {
    name.trim().to_lowercase()
}

pub async fn sample_audio_meter(params: AudioMeterParams) -> AudioMeterResult {
    if !cfg!(target_os = "macos") {
        return AudioMeterResult {
            status: AudioMeterStatus::Unavailable,
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some(
                "Audio meter sampling is only implemented for macOS in this spike.".to_string(),
            ),
        };
    }

    let Some(microphone_id) = params.microphone_id.as_deref() else {
        return AudioMeterResult {
            status: AudioMeterStatus::Unavailable,
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some("Select a microphone before running the audio check.".to_string()),
        };
    };

    if let Some(device_id) = parse_coreaudio_microphone_id(microphone_id) {
        return sample_native_audio_meter(
            device_id,
            AudioProcessingSettings {
                gain_db: params.microphone_gain_db,
                muted: params.microphone_muted,
            },
        );
    }

    let Some(index) = parse_avfoundation_id(microphone_id) else {
        return AudioMeterResult {
            status: AudioMeterStatus::Unavailable,
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some(
                "Selected microphone is not a native CoreAudio or FFmpeg avfoundation input."
                    .to_string(),
            ),
        };
    };

    let ffmpeg_path = resolve_ffmpeg_path(params.ffmpeg_path);
    let mut command = Command::new(&ffmpeg_path);
    command
        .args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-t",
            "1",
            "-i",
            &format!(":{index}"),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = timeout(Duration::from_secs(6), command.output()).await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return AudioMeterResult {
                status: AudioMeterStatus::Unavailable,
                level: None,
                peak_db: None,
                mean_db: None,
                message: Some(format!("Could not run {ffmpeg_path}: {error}")),
            };
        }
        Err(_) => {
            return AudioMeterResult {
                status: AudioMeterStatus::Unavailable,
                level: None,
                peak_db: None,
                mean_db: None,
                message: Some("Audio meter check timed out.".to_string()),
            };
        }
    };

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    if !output.status.success() {
        return AudioMeterResult {
            status: if text.to_lowercase().contains("permission") {
                AudioMeterStatus::PermissionRequired
            } else {
                AudioMeterStatus::Unavailable
            },
            level: None,
            peak_db: None,
            mean_db: None,
            message: Some(
                first_nonempty_line(&text)
                    .unwrap_or_else(|| "Audio meter check failed.".to_string()),
            ),
        };
    }

    let peak_db = parse_volume_db(&text, "max_volume");
    let mean_db = parse_volume_db(&text, "mean_volume");
    let Some(peak_db) = peak_db else {
        return AudioMeterResult {
            status: AudioMeterStatus::Unavailable,
            level: None,
            peak_db: None,
            mean_db,
            message: Some("FFmpeg did not report audio levels.".to_string()),
        };
    };
    let level = db_to_level(peak_db);
    let silent = peak_db <= -55.0;

    AudioMeterResult {
        status: if silent {
            AudioMeterStatus::Silent
        } else {
            AudioMeterStatus::Ready
        },
        level: Some(level),
        peak_db: Some(peak_db),
        mean_db,
        message: Some(if silent {
            "Microphone signal is very low.".to_string()
        } else {
            "Microphone signal detected.".to_string()
        }),
    }
}

pub async fn probe_avfoundation_devices(
    ffmpeg_path: &str,
) -> Result<Vec<AvFoundationDevice>, String> {
    let mut command = Command::new(ffmpeg_path);
    command
        .args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = timeout(Duration::from_secs(6), command.output())
        .await
        .map_err(|_| "FFmpeg device probe timed out".to_string())?
        .map_err(|error| format!("Could not run {ffmpeg_path}: {error}"))?;

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let parsed = parse_avfoundation_devices(&text);

    if parsed.is_empty() {
        Err(if text.trim().is_empty() {
            "FFmpeg returned no avfoundation device output".to_string()
        } else {
            text.lines()
                .next()
                .unwrap_or("No devices found")
                .to_string()
        })
    } else {
        Ok(parsed)
    }
}

fn parse_avfoundation_id(id: &str) -> Option<usize> {
    id.strip_prefix("microphone:avfoundation:")
        .or_else(|| id.strip_prefix("camera:avfoundation:"))
        .or_else(|| id.strip_prefix("screen:avfoundation:"))?
        .parse()
        .ok()
}

fn parse_volume_db(text: &str, label: &str) -> Option<f64> {
    text.lines().find_map(|line| {
        let (_, value) = line.split_once(label)?;
        let value = value.trim().strip_prefix(':')?.trim();
        value.split_whitespace().next()?.parse().ok()
    })
}

fn db_to_level(db: f64) -> f64 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

fn first_nonempty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn parse_avfoundation_devices(text: &str) -> Vec<AvFoundationDevice> {
    let mut section: Option<AvFoundationDeviceKind> = None;
    let mut devices = Vec::new();

    for line in text.lines() {
        if line.contains("AVFoundation video devices") {
            section = Some(AvFoundationDeviceKind::Video);
            continue;
        }

        if line.contains("AVFoundation audio devices") {
            section = Some(AvFoundationDeviceKind::Audio);
            continue;
        }

        let Some(kind) = section.clone() else {
            continue;
        };

        if let Some((index, name)) = parse_indexed_device_line(line) {
            devices.push(AvFoundationDevice { index, name, kind });
        }
    }

    devices
}

fn parse_indexed_device_line(line: &str) -> Option<(usize, String)> {
    let marker = "] [";
    let after_marker = line.split(marker).nth(1)?;
    let closing_bracket = after_marker.find(']')?;
    let index = after_marker[..closing_bracket].parse().ok()?;
    let name = after_marker[closing_bracket + 1..].trim();

    if name.is_empty() {
        None
    } else {
        Some((index, name.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_avfoundation_device_listing() {
        let text = r#"
[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] [1] Capture screen 0
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] MacBook Pro Microphone
"#;

        let devices = parse_avfoundation_devices(text);

        assert_eq!(
            devices,
            vec![
                AvFoundationDevice {
                    index: 0,
                    name: "FaceTime HD Camera".to_string(),
                    kind: AvFoundationDeviceKind::Video,
                },
                AvFoundationDevice {
                    index: 1,
                    name: "Capture screen 0".to_string(),
                    kind: AvFoundationDeviceKind::Video,
                },
                AvFoundationDevice {
                    index: 0,
                    name: "MacBook Pro Microphone".to_string(),
                    kind: AvFoundationDeviceKind::Audio,
                },
            ]
        );
    }

    #[test]
    fn native_screen_and_window_sources_are_selectable_for_preview() {
        let devices = preview_ready_native_capture_devices(vec![
            Device {
                id: "screen:screencapturekit:1".to_string(),
                name: "Display 1".to_string(),
                kind: DeviceKind::Screen,
                status: DeviceStatus::Available,
                detail: None,
            },
            Device {
                id: "window:screencapturekit:42".to_string(),
                name: "Editor".to_string(),
                kind: DeviceKind::Window,
                status: DeviceStatus::Available,
                detail: None,
            },
            Device {
                id: "camera:native".to_string(),
                name: "Camera".to_string(),
                kind: DeviceKind::Camera,
                status: DeviceStatus::Available,
                detail: None,
            },
        ]);

        assert_eq!(devices[0].status, DeviceStatus::Available);
        assert_eq!(devices[1].status, DeviceStatus::Available);
        assert_eq!(devices[2].status, DeviceStatus::Available);
        assert!(
            devices[0]
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("native preview")
        );
    }

    #[test]
    fn avfoundation_screen_sources_are_selectable() {
        let devices = avfoundation_screen_devices(&[
            AvFoundationDevice {
                index: 1,
                name: "Capture screen 0".to_string(),
                kind: AvFoundationDeviceKind::Video,
            },
            AvFoundationDevice {
                index: 2,
                name: "FaceTime HD Camera".to_string(),
                kind: AvFoundationDeviceKind::Video,
            },
        ]);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "screen:avfoundation:1");
        assert_eq!(devices[0].status, DeviceStatus::Available);
    }

    #[test]
    fn parses_audio_meter_volume_output() {
        let text = r#"
[Parsed_volumedetect_0 @ 0x123] mean_volume: -28.8 dB
[Parsed_volumedetect_0 @ 0x123] max_volume: -9.4 dB
"#;

        assert_eq!(parse_volume_db(text, "mean_volume"), Some(-28.8));
        assert_eq!(parse_volume_db(text, "max_volume"), Some(-9.4));
        assert!(db_to_level(-9.4) > 0.8);
        assert_eq!(db_to_level(-80.0), 0.0);
    }
}
