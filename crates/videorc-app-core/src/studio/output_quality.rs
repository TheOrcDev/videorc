//! The Output page's recording quality (P656, P657, P659, P660), from
//! `lib/output-quality.ts`, `lib/bridge-envelope.ts`,
//! `videoProfileCompatibility` (`lib/capture.ts`) and
//! `components/settings/encoder-preference-field.tsx`.

use videorc_protocol::{EncoderPreferenceState, VideoSettings, WindowsH264EncoderPreference};

use super::inspector::resolution_name;

// ── The typed fields (plan 174, D-1) ──────────────────────────────────────

/// `OutputNumberField`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Width,
    Height,
    Fps,
    BitrateKbps,
}

/// `OUTPUT_NUMBER_FIELDS`: the four fields in order, with their labels.
pub const FIELDS: [(Field, &str); 4] = [
    (Field::Width, "Width"),
    (Field::Height, "Height"),
    (Field::Fps, "FPS"),
    (Field::BitrateKbps, "Bitrate kbps"),
];

impl Field {
    pub fn of(self, video: &VideoSettings) -> u32 {
        match self {
            Self::Width => video.width,
            Self::Height => video.height,
            Self::Fps => video.fps,
            Self::BitrateKbps => video.bitrate_kbps,
        }
    }

    /// The capture config key the value is saved under.
    pub fn key(self) -> &'static str {
        match self {
            Self::Width => "width",
            Self::Height => "height",
            Self::Fps => "fps",
            Self::BitrateKbps => "bitrateKbps",
        }
    }
}

/// `outputFieldLimits`: (min, max, step). The canvas sides follow the
/// scene's orientation with the bounds the saved settings are clamped to.
pub fn limits(field: Field, vertical: bool) -> (u32, u32, u32) {
    match field {
        Field::Width if vertical => (360, 2160, 1),
        Field::Width => (640, 3840, 1),
        Field::Height if vertical => (640, 3840, 1),
        Field::Height => (360, 2160, 1),
        Field::Fps => (24, 60, 1),
        Field::BitrateKbps => (1000, 50000, 500),
    }
}

pub const LANDSCAPE_CANVAS_RULE: &str =
    "A landscape scene needs a width at least as large as the height.";
pub const VERTICAL_CANVAS_RULE: &str =
    "A vertical scene needs a height at least as large as the width.";

/// `OutputFieldCommit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Commit {
    /// Save this value (the preset becomes Custom).
    Value(u32),
    /// Nothing to save: an empty or unchanged entry.
    Unchanged,
    /// The size would contradict the scene's orientation.
    Refused(&'static str),
}

/// `commitOutputField`: rounded and clamped to the field's bounds; a size
/// against the scene's orientation is refused with the rule, never
/// transposed.
pub fn commit(video: &VideoSettings, field: Field, draft: &str, vertical: bool) -> Commit {
    let typed = draft.trim();
    let Ok(parsed) = typed.parse::<f64>() else {
        return Commit::Unchanged;
    };
    if !parsed.is_finite() {
        return Commit::Unchanged;
    }
    let (min, max, _) = limits(field, vertical);
    let value = parsed.round().clamp(f64::from(min), f64::from(max)) as u32;
    if value == field.of(video) {
        return Commit::Unchanged;
    }
    if matches!(field, Field::Width | Field::Height) {
        let width = if field == Field::Width {
            value
        } else {
            video.width
        };
        let height = if field == Field::Height {
            value
        } else {
            video.height
        };
        if vertical && width > height {
            return Commit::Refused(VERTICAL_CANVAS_RULE);
        }
        if !vertical && height > width {
            return Commit::Refused(LANDSCAPE_CANVAS_RULE);
        }
    }
    Commit::Value(value)
}

/// Only digits (and a decimal point) go into a typed field.
pub fn accepts_char(c: char) -> bool {
    c.is_ascii_digit() || c == '.'
}

// ── Windows' encoder envelope (#1062) and compatibility ───────────────────

/// `RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES`: (long side, short side).
pub const RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES: (u32, u32) = (2560, 1440);
pub const BRIDGE_60FPS_MAX_FPS: u32 = 60;

fn fits_sides(width: u32, height: u32, (long, short): (u32, u32)) -> bool {
    width.max(height) <= long && width.min(height) <= short
}

/// `recordOnlyBridgeEnvelopeFits`: 30 fps anywhere, 60 fps up to 1440p.
pub fn record_only_bridge_fits(video: &VideoSettings) -> bool {
    video.fps <= 30
        || (video.fps <= BRIDGE_60FPS_MAX_FPS
            && fits_sides(
                video.width,
                video.height,
                RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES,
            ))
}

/// "4K", "1440p", or both sides for a portrait canvas.
fn size_name(width: u32, height: u32) -> String {
    if height > width {
        format!("{width} × {height}")
    } else {
        resolution_name(width, height)
    }
}

/// `windowsBridgeEnvelopeRefusal`: why Windows refuses this record-only
/// output, in the backend's words. `os` is Node's name.
pub fn windows_envelope_refusal(
    os: &str,
    record_enabled: bool,
    stream_enabled: bool,
    video: &VideoSettings,
) -> Option<String> {
    if os != "win32" || !record_enabled || stream_enabled || record_only_bridge_fits(video) {
        return None;
    }
    let name = size_name(video.width, video.height);
    let (long, short) = RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES;
    let cap = if video.height > video.width {
        size_name(short, long)
    } else {
        size_name(long, short)
    };
    let fps = video.fps;
    Some(format!(
        "{name} at {fps} fps isn't supported on Windows yet. Choose {name} at 30 fps or {cap} at {fps} fps."
    ))
}

pub const SPLIT_OUTPUT_4K_WARNING: &str = "4K local recording while livestreaming is known to drop recorded video to ~8fps (audio keeps running). Until the split-output fix ships, record at 1080p/2K while streaming, stream without local 4K recording, or record 4K without streaming.";

/// `VideoProfileCompatibility`: a refusal (destructive) or a warning.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Compatibility {
    pub blocking_reason: Option<String>,
    pub warning: Option<String>,
}

impl Compatibility {
    /// The alert's words and whether it is destructive.
    pub fn message(&self) -> Option<(&str, bool)> {
        self.blocking_reason
            .as_deref()
            .map(|reason| (reason, true))
            .or_else(|| self.warning.as_deref().map(|warning| (warning, false)))
    }
}

/// `videoProfileCompatibility`.
pub fn compatibility(
    os: &str,
    record_enabled: bool,
    stream_enabled: bool,
    video: &VideoSettings,
) -> Compatibility {
    if let Some(reason) = windows_envelope_refusal(os, record_enabled, stream_enabled, video) {
        return Compatibility {
            blocking_reason: Some(reason),
            warning: None,
        };
    }
    if record_enabled && stream_enabled && video.width.min(video.height) >= 2160 {
        return Compatibility {
            blocking_reason: None,
            warning: Some(SPLIT_OUTPUT_4K_WARNING.into()),
        };
    }
    Compatibility::default()
}

// ── Fallback video encoder (Windows with Intel graphics, plan 090 C5) ─────

pub mod encoder {
    use super::*;

    pub const GET_METHOD: &str = "encoder.preference.get";
    pub const SET_METHOD: &str = "encoder.preference.set";
    pub const LABEL: &str = "Fallback video encoder";
    pub const BETA: &str = "Beta";
    pub const DESCRIPTION: &str = "Used only when this PC's hardware encoder can't start. Intel Quick Sync encodes on the Intel graphics chip instead of the processor, and falls back to software if its own check fails.";
    pub const ENV_OVERRIDE: &str = "Set by a launch setting for this run.";
    pub const SET_FAILED: &str = "Couldn't change the backup encoder.";

    pub const OPTIONS: [(WindowsH264EncoderPreference, &str, &str); 3] = [
        (WindowsH264EncoderPreference::Auto, "auto", "Automatic"),
        (
            WindowsH264EncoderPreference::QuickSync,
            "quick-sync",
            "Intel Quick Sync",
        ),
        (
            WindowsH264EncoderPreference::Software,
            "software",
            "Software only",
        ),
    ];

    /// The select's value for a preference.
    pub fn wire(preference: WindowsH264EncoderPreference) -> &'static str {
        OPTIONS
            .iter()
            .find(|(value, ..)| *value == preference)
            .map_or("auto", |(_, wire, _)| *wire)
    }

    pub fn of_wire(value: &str) -> Option<WindowsH264EncoderPreference> {
        OPTIONS
            .iter()
            .find(|(_, wire, _)| *wire == value)
            .map(|(preference, ..)| *preference)
    }

    /// Shown only on a PC where Quick Sync is there to choose.
    pub fn shown(state: Option<&EncoderPreferenceState>) -> bool {
        state.is_some_and(|state| state.quick_sync_available)
    }

    pub fn description(state: &EncoderPreferenceState) -> &'static str {
        if state.env_override {
            ENV_OVERRIDE
        } else {
            DESCRIPTION
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(width: u32, height: u32, fps: u32) -> VideoSettings {
        serde_json::from_value(serde_json::json!({
            "preset": "custom",
            "width": width,
            "height": height,
            "fps": fps,
            "bitrateKbps": 8000,
        }))
        .expect("video")
    }

    #[test]
    fn a_typed_value_commits_clamped_or_is_refused_by_orientation() {
        let landscape = video(1920, 1080, 30);
        assert_eq!(
            commit(&landscape, Field::Fps, " 48.4 ", false),
            Commit::Value(48)
        );
        assert_eq!(
            commit(&landscape, Field::Fps, "120", false),
            Commit::Value(60)
        );
        assert_eq!(
            commit(&landscape, Field::Fps, "30", false),
            Commit::Unchanged
        );
        assert_eq!(commit(&landscape, Field::Fps, "", false), Commit::Unchanged);
        assert_eq!(
            commit(&landscape, Field::Fps, "abc", false),
            Commit::Unchanged
        );
        assert_eq!(
            commit(&landscape, Field::Height, "2000", false),
            Commit::Refused(LANDSCAPE_CANVAS_RULE)
        );
        assert_eq!(
            commit(&landscape, Field::Width, "2560", false),
            Commit::Value(2560)
        );
        let portrait = video(1080, 1920, 30);
        assert_eq!(
            commit(&portrait, Field::Width, "2000", true),
            Commit::Refused(VERTICAL_CANVAS_RULE)
        );
        assert_eq!(limits(Field::BitrateKbps, false), (1000, 50000, 500));
    }

    #[test]
    fn windows_refuses_record_only_outside_the_envelope() {
        let k60 = video(3840, 2160, 60);
        assert_eq!(
            windows_envelope_refusal("win32", true, false, &k60).as_deref(),
            Some(
                "4K at 60 fps isn't supported on Windows yet. Choose 4K at 30 fps or 1440p at 60 fps."
            )
        );
        assert_eq!(windows_envelope_refusal("darwin", true, false, &k60), None);
        assert_eq!(windows_envelope_refusal("win32", true, true, &k60), None);
        assert_eq!(
            windows_envelope_refusal("win32", true, false, &video(2560, 1440, 60)),
            None
        );
        let compat = compatibility("win32", true, false, &k60);
        assert!(compat.message().unwrap().1);
    }

    #[test]
    fn four_k_while_streaming_warns() {
        let compat = compatibility("darwin", true, true, &video(3840, 2160, 30));
        assert_eq!(compat.message(), Some((SPLIT_OUTPUT_4K_WARNING, false)));
        assert_eq!(
            compatibility("darwin", true, false, &video(3840, 2160, 30)).message(),
            None
        );
    }

    #[test]
    fn the_encoder_field_shows_only_with_quick_sync() {
        let state = |quick_sync_available: bool, env_override: bool| EncoderPreferenceState {
            preference: WindowsH264EncoderPreference::QuickSync,
            quick_sync_available,
            env_override,
        };
        assert!(!encoder::shown(None));
        assert!(!encoder::shown(Some(&state(false, false))));
        assert!(encoder::shown(Some(&state(true, false))));
        assert_eq!(
            encoder::description(&state(true, true)),
            encoder::ENV_OVERRIDE
        );
        assert_eq!(
            encoder::wire(WindowsH264EncoderPreference::QuickSync),
            "quick-sync"
        );
        assert_eq!(
            encoder::of_wire("software"),
            Some(WindowsH264EncoderPreference::Software)
        );
    }
}
