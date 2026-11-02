//! Linux microphones through the PulseAudio protocol (L2 of
//! `docs/linux-port-plan.md`). PipeWire serves it through `pipewire-pulse`,
//! and the bundled FFmpeg is built with `--enable-libpulse`, so FFmpeg both
//! enumerates the sources (`-sources pulse`) and records them (`-f pulse`),
//! the same "FFmpeg owns the device" shape the Windows DirectShow mic uses.
//!
//! A device id carries the hex of the Pulse source NAME (stable across
//! boots); `Device.name` is the source DESCRIPTION, which is also the label
//! Chromium's `getUserMedia` reports, so the renderer's visual meter matches
//! the backend row. Monitor sources (speaker loopback) are not microphones
//! and stay unlisted. Parsing is pure and tested on every platform; the
//! FFmpeg spawn is Linux-only.
// The id parser and input args are reachable on every platform (a stored id
// resolves anywhere); discovery is only called on Linux.
#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]

use crate::protocol::{Device, DeviceKind, DeviceStatus};

pub const LINUX_PULSE_MICROPHONE_PREFIX: &str = "microphone:linux-pulse:";

/// Pulse's 48 kHz stereo matches the session audio bus; 20 ms fragments keep
/// capture latency near the native paths instead of Pulse's default buffer.
const PULSE_SAMPLE_RATE: &str = "48000";
const PULSE_CHANNELS: &str = "2";
const PULSE_FRAGMENT_BYTES: &str = "3840";

/// The environment variable libpulse reads extra stream properties from.
pub const PULSE_STREAM_PROPS_ENV: &str = "PULSE_PROP";
/// Retest 154 (C4): pipewire-pulse attaches a capture whose source is gone
/// to the DEFAULT source, and moves a running capture there when its source
/// disappears, so an unplugged USB mic silently became the laptop's built-in
/// mic in the take. FFmpeg's pulse demuxer has no option for this; libpulse
/// copies `PULSE_PROP` onto every stream of the process. Measured on
/// PipeWire 1.6 with `pactl list source-outputs`: `node.dont-fallback`
/// makes FFmpeg fail to open a missing source and exit ("Error during
/// demuxing") within 3 s of an unplug; `node.dont-move` keeps it off other
/// sources. `node.dont-reconnect` is left out on purpose: it leaves the
/// stream unlinked and FFmpeg blocked forever, with no EOF or error.
pub const PULSE_PINNED_SOURCE_PROPS: &str = "node.dont-fallback=true node.dont-move=true";

/// The child environment every FFmpeg Pulse capture of a chosen source runs
/// with (session worker, direct input, audio meter).
pub fn pulse_pinned_source_env() -> [(&'static str, &'static str); 1] {
    [(PULSE_STREAM_PROPS_ENV, PULSE_PINNED_SOURCE_PROPS)]
}

/// Whether a source listing says the chosen source is plugged in. Monitor
/// sources are never chosen as microphones, so they never count.
pub fn pulse_source_listed(sources: &[PulseSource], source_name: &str) -> bool {
    sources.iter().any(|source| source.name == source_name)
}

/// The capture decision for a chosen source: a listing that succeeded and
/// lacks it means it is unplugged, so nothing is spawned and the session
/// records silence. A listing that failed says nothing about the device, so
/// the capture still opens (pinned, it cannot reach another source).
pub fn pulse_source_missing(listing: Option<&[PulseSource]>, source_name: &str) -> bool {
    listing.is_some_and(|sources| !pulse_source_listed(sources, source_name))
}

pub fn pulse_source_not_connected_message(source_name: &str) -> String {
    format!(
        "The microphone \"{source_name}\" is not connected. Videorc records silence instead of switching to another microphone."
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PulseSource {
    pub name: String,
    pub description: String,
    pub is_default: bool,
}

pub fn linux_pulse_microphone_id(source_name: &str) -> String {
    format!(
        "{LINUX_PULSE_MICROPHONE_PREFIX}{}",
        crate::audio::encode_hex(source_name.as_bytes())
    )
}

pub fn parse_linux_pulse_microphone_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(LINUX_PULSE_MICROPHONE_PREFIX)?;
    let name = String::from_utf8(crate::audio::decode_hex(encoded)?).ok()?;
    (!name.is_empty()).then_some(name)
}

/// Parses `ffmpeg -hide_banner -sources pulse` stdout:
///
/// ```text
/// Auto-detected sources for pulse:
///   alsa_output.….monitor [Monitor of Speakers] (none)
/// * alsa_input.…Mic__source [Internal Microphone] (none)
/// ```
///
/// Monitor sources are dropped: they record what the speakers play.
pub fn parse_pulse_sources(text: &str) -> Vec<PulseSource> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_end();
            let (is_default, rest) = match line.trim_start().strip_prefix('*') {
                Some(rest) => (true, rest.trim_start()),
                None if line.starts_with(' ') => (false, line.trim_start()),
                None => return None,
            };
            let (name, tail) = rest.split_once(" [")?;
            let description = match tail.rfind("] (") {
                Some(end) => &tail[..end],
                None => tail.strip_suffix(']')?,
            };
            let name = name.trim();
            if name.is_empty() || name.contains(char::is_whitespace) || name.ends_with(".monitor") {
                return None;
            }
            Some(PulseSource {
                name: name.to_string(),
                description: description.trim().to_string(),
                is_default,
            })
        })
        .collect()
}

/// A complete `-sources pulse` listing, or `None` when FFmpeg could not
/// reach the Pulse server: it then prints the header, "Cannot list sources"
/// on stderr and still exits 0, which must not read as "no microphones".
pub fn pulse_source_listing(stdout: &str, stderr: &str) -> Option<Vec<PulseSource>> {
    (stdout.contains("Auto-detected sources for pulse") && !stderr.contains("Cannot list sources"))
        .then(|| parse_pulse_sources(stdout))
}

pub fn pulse_microphone_devices(sources: &[PulseSource]) -> Vec<Device> {
    sources
        .iter()
        .map(|source| Device {
            app: None,
            window_title: None,
            id: linux_pulse_microphone_id(&source.name),
            name: if source.description.is_empty() {
                source.name.clone()
            } else {
                source.description.clone()
            },
            kind: DeviceKind::Microphone,
            status: DeviceStatus::Available,
            detail: Some(if source.is_default {
                format!(
                    "PulseAudio/PipeWire source {} (system default)",
                    source.name
                )
            } else {
                format!("PulseAudio/PipeWire source {}", source.name)
            }),
            width: None,
            height: None,
        })
        .collect()
}

/// FFmpeg input options that open one Pulse source for a session.
pub fn pulse_input_args(source_name: &str) -> Vec<String> {
    [
        "-f",
        "pulse",
        "-sample_rate",
        PULSE_SAMPLE_RATE,
        "-channels",
        PULSE_CHANNELS,
        "-fragment_size",
        PULSE_FRAGMENT_BYTES,
        "-thread_queue_size",
        "512",
        "-i",
        source_name,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// A one-second `volumedetect` check of one Pulse source (the audio meter).
pub fn pulse_meter_args(source_name: &str) -> Vec<String> {
    let mut args = vec!["-hide_banner".to_string()];
    args.extend(pulse_input_args(source_name));
    // `-t` belongs before `-i` to bound the capture itself.
    let input_at = args.len() - 2;
    args.splice(input_at..input_at, ["-t".to_string(), "1".to_string()]);
    args.extend(
        ["-af", "volumedetect", "-f", "null", "-"]
            .into_iter()
            .map(str::to_string),
    );
    args
}

/// The current Pulse input sources, or `None` when FFmpeg could not list
/// them in time. Blocking: call it off the async runtime.
#[cfg(target_os = "linux")]
pub fn linux_pulse_sources_blocking(ffmpeg_path: &str) -> Option<Vec<PulseSource>> {
    let output = crate::process_job::output_owned_std_with_timeout(
        std::process::Command::new(ffmpeg_path)
            .args(["-hide_banner", "-sources", "pulse"])
            .stdin(std::process::Stdio::null()),
        std::time::Duration::from_secs(4),
    )
    .ok()?;
    pulse_source_listing(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

/// Microphone rows for `devices.list`, or one unavailable row naming why.
#[cfg(target_os = "linux")]
pub async fn list_linux_microphones(ffmpeg_path: &str) -> Vec<Device> {
    use std::process::Stdio;
    use std::time::Duration;

    let mut command = tokio::process::Command::new(ffmpeg_path);
    command
        .args(["-hide_banner", "-sources", "pulse"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(
        Duration::from_secs(4),
        crate::process_job::output_owned_tokio(&mut command),
    )
    .await;
    let reason = match output {
        Ok(Ok(output)) => {
            let sources = parse_pulse_sources(&String::from_utf8_lossy(&output.stdout));
            if !sources.is_empty() {
                return pulse_microphone_devices(&sources);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            match stderr.lines().map(str::trim).find(|line| !line.is_empty()) {
                Some(line) => format!("FFmpeg found no PulseAudio/PipeWire input source ({line})"),
                None => "FFmpeg found no PulseAudio/PipeWire input source".to_string(),
            }
        }
        Ok(Err(error)) => format!("Could not run {ffmpeg_path} to list microphones: {error}"),
        Err(_) => "Listing PulseAudio/PipeWire microphones timed out".to_string(),
    };
    vec![Device {
        app: None,
        window_title: None,
        id: "microphone:linux-pulse-unavailable".to_string(),
        name: "Microphone".to_string(),
        kind: DeviceKind::Microphone,
        status: DeviceStatus::Unavailable,
        detail: Some(format!(
            "{reason}. Linux microphones need PipeWire (pipewire-pulse) or PulseAudio."
        )),
        width: None,
        height: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_properties_override_conflicting_child_properties_without_changing_parent() {
        let mut command = std::process::Command::new("ffmpeg");
        command.env("PULSE_PROP", "node.dont-reconnect=false");
        let parent = std::env::var_os("PULSE_PROP");
        command.envs(pulse_pinned_source_env());
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == "PULSE_PROP")
                .unwrap()
                .1,
            Some(std::ffi::OsStr::new(PULSE_PINNED_SOURCE_PROPS))
        );
        assert_eq!(std::env::var_os("PULSE_PROP"), parent);
    }

    const OGRE_SOURCES: &str = "Auto-detected sources for pulse:\n  alsa_output.pci-0000_02_00.3.HiFi__Speaker__sink.monitor [Monitor of Apple Audio Device Internal Speakers] (none)\n* alsa_input.pci-0000_02_00.3.HiFi__Mic__source [Apple Audio Device Internal Microphone] (none)\n";

    #[test]
    fn pulse_sources_keep_inputs_and_drop_monitors() {
        assert_eq!(
            parse_pulse_sources(OGRE_SOURCES),
            vec![PulseSource {
                name: "alsa_input.pci-0000_02_00.3.HiFi__Mic__source".to_string(),
                description: "Apple Audio Device Internal Microphone".to_string(),
                is_default: true,
            }]
        );
        let usb = "  alsa_input.usb-Blue_Yeti-00.analog-stereo [Yeti Stereo Microphone [Analog]] (none)\n";
        assert_eq!(
            parse_pulse_sources(usb),
            vec![PulseSource {
                name: "alsa_input.usb-Blue_Yeti-00.analog-stereo".to_string(),
                description: "Yeti Stereo Microphone [Analog]".to_string(),
                is_default: false,
            }]
        );
        assert!(parse_pulse_sources("Auto-detected sources for pulse:\n").is_empty());
        assert!(parse_pulse_sources("").is_empty());
    }

    #[test]
    fn pulse_microphone_ids_round_trip_the_source_name() {
        let name = "alsa_input.pci-0000_02_00.3.HiFi__Mic__source";
        let id = linux_pulse_microphone_id(name);
        assert!(id.starts_with(LINUX_PULSE_MICROPHONE_PREFIX));
        assert_eq!(parse_linux_pulse_microphone_id(&id).as_deref(), Some(name));
        assert_eq!(
            parse_linux_pulse_microphone_id("microphone:linux-pulse:"),
            None
        );
        assert_eq!(
            parse_linux_pulse_microphone_id("microphone:linux-pulse:zz"),
            None
        );
        assert_eq!(
            parse_linux_pulse_microphone_id("microphone:coreaudio:7"),
            None
        );
    }

    #[test]
    fn pulse_rows_use_the_description_chromium_reports() {
        let devices = pulse_microphone_devices(&parse_pulse_sources(OGRE_SOURCES));
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Apple Audio Device Internal Microphone");
        assert_eq!(devices[0].kind, DeviceKind::Microphone);
        assert_eq!(devices[0].status, DeviceStatus::Available);
        assert!(
            devices[0]
                .detail
                .as_deref()
                .unwrap()
                .contains("system default")
        );
    }

    #[test]
    fn pulse_captures_are_pinned_to_the_chosen_source() {
        // Retest 154 (C4): without these, pipewire-pulse attached a capture
        // of an unplugged mic to the default (built-in) source.
        assert_eq!(
            pulse_pinned_source_env(),
            [("PULSE_PROP", "node.dont-fallback=true node.dont-move=true")]
        );
    }

    #[test]
    fn a_source_missing_from_a_complete_listing_is_not_opened() {
        let listing = pulse_source_listing(OGRE_SOURCES, "").unwrap();
        let builtin = "alsa_input.pci-0000_02_00.3.HiFi__Mic__source";
        assert!(!pulse_source_missing(Some(&listing), builtin));
        assert!(pulse_source_missing(Some(&listing), "lanec_hotplug"));
        // A monitor is never a chosen microphone, so it never counts as one.
        assert!(pulse_source_missing(
            Some(&listing),
            "alsa_output.pci-0000_02_00.3.HiFi__Speaker__sink.monitor"
        ));
        // Every source unplugged: a complete, empty listing.
        let empty = pulse_source_listing("Auto-detected sources for pulse:\n", "").unwrap();
        assert!(pulse_source_missing(Some(&empty), builtin));
        // No Pulse server: FFmpeg prints the header, an error, and exits 0.
        // That says nothing about the device, so the pinned capture opens.
        assert_eq!(
            pulse_source_listing(
                "Auto-detected sources for pulse:\n",
                "Cannot list sources: Generic error in an external library\n"
            ),
            None
        );
        assert_eq!(pulse_source_listing("", ""), None);
        assert!(!pulse_source_missing(None, "lanec_hotplug"));
        assert!(
            pulse_source_not_connected_message("lanec_hotplug")
                .contains("\"lanec_hotplug\" is not connected")
        );
    }

    #[test]
    fn pulse_input_and_meter_args_are_exact() {
        assert_eq!(
            pulse_input_args("mic"),
            [
                "-f",
                "pulse",
                "-sample_rate",
                "48000",
                "-channels",
                "2",
                "-fragment_size",
                "3840",
                "-thread_queue_size",
                "512",
                "-i",
                "mic"
            ]
        );
        assert_eq!(
            pulse_meter_args("mic"),
            [
                "-hide_banner",
                "-f",
                "pulse",
                "-sample_rate",
                "48000",
                "-channels",
                "2",
                "-fragment_size",
                "3840",
                "-thread_queue_size",
                "512",
                "-t",
                "1",
                "-i",
                "mic",
                "-af",
                "volumedetect",
                "-f",
                "null",
                "-"
            ]
        );
    }
}
