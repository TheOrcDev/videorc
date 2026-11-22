//! Plan 258 S2: the dev-only fixture camera behind the camera background leak
//! smoke (`pnpm smoke:camera-background`).
//!
//! `VIDEORC_FIXTURE_CAMERA=<dir>` (debug builds only; packaged builds refuse
//! it, like `VIDEORC_YOUTUBE_API_BASE_URL`) adds one camera row, "Fixture
//! camera (dev)", to `devices.list`. Choosing it runs this module on the
//! `videorc-preview-camera` thread instead of AVFoundation, DirectShow or
//! V4L2: it publishes BGRA frames into the camera `FrameStore` exactly as the
//! Linux and Windows readers do, so every consumer (each compositor leg, the
//! recording, the stream legs, Clips, the Camera ISO file, the Preview,
//! Videorc Camera) reads it as a real camera.
//!
//! Each frame is a figure (head, neck and an orange shirt, swaying a little)
//! over a "room" that is a high-frequency magenta/cyan code pattern: the
//! secret background. `scripts/lib/camera-background-leak.mjs` finds that
//! pattern in any output, so with a background effect on, any pattern pixel
//! in any artifact is a leak of the real room. The pattern and colours come
//! from `fixture.json` in the directory (committed under
//! `scripts/fixtures/camera-background/`), shared with the detector.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

/// The variable naming the fixture directory.
pub const FIXTURE_CAMERA_ENV: &str = "VIDEORC_FIXTURE_CAMERA";
/// The fixture camera's AVFoundation-shaped unique id. Its device id is the
/// native camera prefix plus this, hex encoded (`fixture_camera_device_id`).
pub const FIXTURE_CAMERA_UNIQUE_ID: &str = "videorc-fixture-camera";
/// The name the camera row shows.
pub const FIXTURE_CAMERA_NAME: &str = "Fixture camera (dev)";
const FIXTURE_SPEC_FILE: &str = "fixture.json";

/// The shared description of the fixture (`fixture.json`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureSpec {
    pub schema: u32,
    pub room: RoomSpec,
    pub person: PersonSpec,
}

/// The secret background: a code of square cells, each magenta or cyan.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSpec {
    /// Cells across the frame's height (the cell is square).
    pub cells_per_height: u32,
    pub magenta: [u8; 3],
    pub cyan: [u8; 3],
    /// Picks which cells are magenta; any seed gives a non-periodic code.
    pub seed: u32,
}

/// The figure in front of the room. Sizes are fractions of the frame height,
/// so the figure keeps its shape at any capture size.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonSpec {
    /// The figure's centre, as a fraction of the frame width.
    pub centre_x: f64,
    /// The sway's amplitude, as a fraction of the frame height.
    pub sway: f64,
    pub sway_period_seconds: f64,
    pub skin: [u8; 3],
    pub hair: [u8; 3],
    pub shirt: [u8; 3],
}

impl FixtureSpec {
    pub fn parse(text: &str) -> Result<Self, String> {
        let spec: FixtureSpec = serde_json::from_str(text)
            .map_err(|error| format!("{FIXTURE_SPEC_FILE} is not a fixture spec: {error}"))?;
        if spec.schema != 1 {
            return Err(format!(
                "{FIXTURE_SPEC_FILE} has schema {}; this build reads schema 1.",
                spec.schema
            ));
        }
        if !(8..=540).contains(&spec.room.cells_per_height) {
            return Err(format!(
                "{FIXTURE_SPEC_FILE}: room.cellsPerHeight must be 8 to 540, got {}.",
                spec.room.cells_per_height
            ));
        }
        let person = &spec.person;
        if !(0.2..=0.8).contains(&person.centre_x)
            || !(0.0..=0.1).contains(&person.sway)
            || !(person.sway_period_seconds.is_finite() && person.sway_period_seconds > 0.0)
        {
            return Err(format!(
                "{FIXTURE_SPEC_FILE}: person.centreX must be 0.2 to 0.8, sway 0 to 0.1 and swayPeriodSeconds positive."
            ));
        }
        Ok(spec)
    }
}

/// Pure: the fixture directory a build honours for `VIDEORC_FIXTURE_CAMERA`.
/// Release builds refuse any value; debug builds need an absolute directory
/// that holds a readable `fixture.json`.
pub fn resolve_fixture_camera(
    dev_build: bool,
    value: Option<&str>,
) -> Result<Option<(PathBuf, FixtureSpec)>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !dev_build {
        return Err(format!(
            "{FIXTURE_CAMERA_ENV} is refused in packaged builds; only real cameras are listed."
        ));
    }
    let dir = Path::new(value);
    if !dir.is_absolute() {
        return Err(format!(
            "{FIXTURE_CAMERA_ENV} must be an absolute directory, got {value}."
        ));
    }
    let spec_path = dir.join(FIXTURE_SPEC_FILE);
    let text = std::fs::read_to_string(&spec_path).map_err(|error| {
        format!(
            "{FIXTURE_CAMERA_ENV}: cannot read {}: {error}",
            spec_path.display()
        )
    })?;
    let spec = FixtureSpec::parse(&text)?;
    Ok(Some((dir.to_path_buf(), spec)))
}

/// The active fixture, read once per process. A refusal or a broken fixture
/// is logged once and leaves only the real cameras.
pub fn active_fixture() -> Option<&'static (PathBuf, FixtureSpec)> {
    static ACTIVE: OnceLock<Option<(PathBuf, FixtureSpec)>> = OnceLock::new();
    ACTIVE
        .get_or_init(|| {
            let value = std::env::var(FIXTURE_CAMERA_ENV).ok();
            match resolve_fixture_camera(cfg!(debug_assertions), value.as_deref()) {
                Ok(Some(fixture)) => {
                    tracing::warn!(
                        dir = %fixture.0.display(),
                        "{FIXTURE_CAMERA_ENV} is set: the dev fixture camera is listed (plan 258 S2)"
                    );
                    Some(fixture)
                }
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!("{error}");
                    None
                }
            }
        })
        .as_ref()
}

pub fn is_fixture_unique_id(unique_id: &str) -> bool {
    unique_id == FIXTURE_CAMERA_UNIQUE_ID
}

/// `camera:avfoundation-native:<hex>`, the id every platform's
/// `selected_camera_source` already parses.
pub fn fixture_camera_device_id() -> String {
    let hex: String = FIXTURE_CAMERA_UNIQUE_ID
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("camera:avfoundation-native:{hex}")
}

/// The camera row `devices.list` adds while the fixture is active.
pub fn fixture_camera_device() -> Option<crate::protocol::Device> {
    let (dir, _) = active_fixture()?;
    Some(crate::protocol::Device {
        app: None,
        window_title: None,
        display_uuid: None,
        id: fixture_camera_device_id(),
        name: FIXTURE_CAMERA_NAME.to_string(),
        kind: crate::protocol::DeviceKind::Camera,
        status: crate::protocol::DeviceStatus::Available,
        detail: Some(format!(
            "Dev-only fixture camera from {FIXTURE_CAMERA_ENV} ({}): a figure over a magenta/cyan code room (plan 258 S2).",
            dir.display()
        )),
        width: None,
        height: None,
    })
}

/// A splitmix-style hash: which cells of the room are magenta.
fn cell_is_magenta(seed: u32, column: u32, row: u32) -> bool {
    let mut value = u64::from(seed)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(u64::from(column).wrapping_mul(0xBF58_476D_1CE4_E5B9))
        .wrapping_add(u64::from(row).wrapping_mul(0x94D0_49BB_1331_11EB));
    value ^= value >> 31;
    value = value.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    value ^= value >> 32;
    value & 1 == 1
}

/// One horizontal run of the figure on a row: `[start, end)` and its colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub rgb: [u8; 3],
}

/// Renders the fixture's frames. The room is drawn once per size; each frame
/// copies it and paints the figure's spans at the frame's sway.
pub struct FixtureRenderer {
    spec: FixtureSpec,
    width: u32,
    height: u32,
    room: Vec<u8>,
}

impl FixtureRenderer {
    pub fn new(spec: FixtureSpec, width: u32, height: u32) -> Self {
        let width = width.max(2);
        let height = height.max(2);
        let room = render_room_bgra(&spec.room, width, height);
        Self {
            spec,
            width,
            height,
            room,
        }
    }

    pub fn frame_len(&self) -> usize {
        self.room.len()
    }

    /// Writes the frame at `seconds` into `out` (BGRA, `frame_len` bytes).
    pub fn render_into(&self, seconds: f64, out: &mut Vec<u8>) {
        out.clear();
        out.extend_from_slice(&self.room);
        let stride = self.width as usize * 4;
        for row in 0..self.height {
            let base = row as usize * stride;
            for span in person_spans(&self.spec.person, self.width, self.height, row, seconds) {
                let bgra = [span.rgb[2], span.rgb[1], span.rgb[0], 255];
                for pixel in out[base + span.start as usize * 4..base + span.end as usize * 4]
                    .chunks_exact_mut(4)
                {
                    pixel.copy_from_slice(&bgra);
                }
            }
        }
    }
}

fn render_room_bgra(room: &RoomSpec, width: u32, height: u32) -> Vec<u8> {
    let cell = (height / room.cells_per_height).max(1);
    let magenta = [room.magenta[2], room.magenta[1], room.magenta[0], 255];
    let cyan = [room.cyan[2], room.cyan[1], room.cyan[0], 255];
    let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height {
        for x in 0..width {
            let pixel = if cell_is_magenta(room.seed, x / cell, y / cell) {
                magenta
            } else {
                cyan
            };
            bytes.extend_from_slice(&pixel);
        }
    }
    bytes
}

/// Pure: the figure's spans on `row`. Head (hair on its top third), neck,
/// then shoulders widening into a torso down to the bottom edge. Spans are
/// painted in order, so a later span covers an earlier one.
pub fn person_spans(
    person: &PersonSpec,
    width: u32,
    height: u32,
    row: u32,
    seconds: f64,
) -> Vec<Span> {
    let h = f64::from(height);
    let y = f64::from(row) + 0.5;
    let phase = std::f64::consts::TAU * seconds / person.sway_period_seconds;
    let centre = person.centre_x * f64::from(width) + person.sway * h * phase.sin();
    let mut spans = Vec::with_capacity(2);
    let mut push = |half_width: f64, rgb: [u8; 3]| {
        if half_width <= 0.0 {
            return;
        }
        let start = (centre - half_width).round().clamp(0.0, f64::from(width)) as u32;
        let end = (centre + half_width).round().clamp(0.0, f64::from(width)) as u32;
        if end > start {
            spans.push(Span { start, end, rgb });
        }
    };

    // Neck, then torso: shoulders round off over their first 0.08 h.
    if (0.38 * h..0.52 * h).contains(&y) {
        push(0.045 * h, person.skin);
    }
    let shoulders = 0.47 * h;
    if y >= shoulders {
        let into = ((y - shoulders) / (0.08 * h)).min(1.0);
        let round = (1.0 - (1.0 - into) * (1.0 - into)).sqrt();
        let widen = ((y - shoulders - 0.08 * h).max(0.0)) * 0.12;
        push(0.24 * h * round + widen, person.shirt);
    }
    // Head: a slightly tall ellipse.
    let (head_y, radius_x, radius_y) = (0.29 * h, 0.105 * h, 0.125 * h);
    let dy = (y - head_y) / radius_y;
    if dy.abs() < 1.0 {
        let half = radius_x * (1.0 - dy * dy).sqrt();
        let rgb = if y < head_y - 0.45 * radius_y {
            person.hair
        } else {
            person.skin
        };
        push(half, rgb);
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = include_str!("../../../scripts/fixtures/camera-background/fixture.json");

    fn spec() -> FixtureSpec {
        FixtureSpec::parse(SPEC).expect("the committed fixture spec parses")
    }

    #[test]
    fn packaged_builds_refuse_the_fixture_camera() {
        let error = resolve_fixture_camera(false, Some("/tmp/anything")).unwrap_err();
        assert!(error.contains("refused in packaged builds"), "{error}");
        assert_eq!(resolve_fixture_camera(false, None).unwrap(), None);
        assert_eq!(resolve_fixture_camera(true, Some("  ")).unwrap(), None);
    }

    #[test]
    fn dev_builds_need_an_absolute_directory_with_a_spec() {
        let relative = resolve_fixture_camera(true, Some("fixtures/camera")).unwrap_err();
        assert!(relative.contains("absolute"), "{relative}");
        let dir = crate::test_temp_dir::TestTempDir::new("camera-fixture-missing");
        let missing = resolve_fixture_camera(true, dir.to_str()).unwrap_err();
        assert!(missing.contains("cannot read"), "{missing}");

        let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/fixtures/camera-background")
            .canonicalize()
            .unwrap();
        let (resolved, parsed) = resolve_fixture_camera(true, fixture_dir.to_str())
            .unwrap()
            .expect("the committed fixture resolves");
        assert_eq!(resolved, fixture_dir);
        assert_eq!(parsed, spec());
    }

    #[test]
    fn spec_rejects_an_unknown_schema_and_out_of_range_values() {
        let newer = SPEC.replace("\"schema\": 1", "\"schema\": 2");
        assert!(FixtureSpec::parse(&newer).unwrap_err().contains("schema 2"));
        let coarse = SPEC.replace("\"cellsPerHeight\": 54", "\"cellsPerHeight\": 2");
        assert!(
            FixtureSpec::parse(&coarse)
                .unwrap_err()
                .contains("cellsPerHeight")
        );
    }

    #[test]
    fn the_fixture_device_id_parses_back_to_its_unique_id() {
        assert_eq!(
            crate::camera_capture::parse_native_camera_id(&fixture_camera_device_id()).as_deref(),
            Some(FIXTURE_CAMERA_UNIQUE_ID)
        );
        assert!(is_fixture_unique_id(FIXTURE_CAMERA_UNIQUE_ID));
        assert!(!is_fixture_unique_id("0x1420000005ac8600"));
    }

    #[test]
    fn the_room_is_only_magenta_and_cyan_in_a_mixed_code() {
        let spec = spec();
        let renderer = FixtureRenderer::new(spec.clone(), 192, 108);
        let (mut magenta, mut cyan) = (0, 0);
        for pixel in renderer.room.chunks_exact(4) {
            let rgb = [pixel[2], pixel[1], pixel[0]];
            if rgb == spec.room.magenta {
                magenta += 1;
            } else if rgb == spec.room.cyan {
                cyan += 1;
            } else {
                panic!("the room holds a colour that is neither magenta nor cyan: {rgb:?}");
            }
        }
        let total = f64::from(magenta + cyan);
        assert!(
            (0.3..0.7).contains(&(f64::from(magenta) / total)),
            "the code should be close to half magenta, got {magenta}/{total}"
        );
        // Not a plain checker: some neighbouring cells share a colour.
        let same_neighbours = (0..53)
            .filter(|column| {
                cell_is_magenta(spec.room.seed, *column, 0)
                    == cell_is_magenta(spec.room.seed, column + 1, 0)
            })
            .count();
        assert!(
            same_neighbours > 5,
            "a checker would have none: {same_neighbours}"
        );
    }

    #[test]
    fn the_figure_stands_in_its_band_and_sways() {
        let spec = spec();
        let (width, height) = (1920, 1080);
        let shirt_row = (0.9 * f64::from(height)) as u32;
        let still = person_spans(&spec.person, width, height, shirt_row, 0.0);
        let shirt = still.last().expect("a torso span near the bottom");
        assert_eq!(shirt.rgb, spec.person.shirt);
        let centre = f64::from(shirt.start + shirt.end) / 2.0;
        assert!(
            (centre - 960.0).abs() <= 1.0,
            "centred at rest, got {centre}"
        );
        // The whole figure stays inside centre ± 0.32 h at any sway.
        for row in (0..height).step_by(7) {
            for quarter in 0..4 {
                let seconds = spec.person.sway_period_seconds * f64::from(quarter) / 4.0;
                for span in person_spans(&spec.person, width, height, row, seconds) {
                    assert!(f64::from(span.start) >= 960.0 - 0.32 * 1080.0, "{span:?}");
                    assert!(f64::from(span.end) <= 960.0 + 0.32 * 1080.0, "{span:?}");
                }
            }
        }
        let swayed = person_spans(
            &spec.person,
            width,
            height,
            shirt_row,
            spec.person.sway_period_seconds / 4.0,
        );
        assert_ne!(
            swayed.last().unwrap().start,
            shirt.start,
            "the figure moves"
        );
        // Above the head there is only room.
        assert!(person_spans(&spec.person, width, height, 20, 0.0).is_empty());
    }

    #[test]
    fn a_rendered_frame_is_the_room_with_the_figure_painted_over_it() {
        let spec = spec();
        let renderer = FixtureRenderer::new(spec.clone(), 320, 180);
        let mut frame = Vec::new();
        renderer.render_into(0.0, &mut frame);
        assert_eq!(frame.len(), renderer.frame_len());
        assert_eq!(frame.len(), 320 * 180 * 4);
        let pixel = |x: usize, y: usize| {
            let i = (y * 320 + x) * 4;
            [frame[i + 2], frame[i + 1], frame[i]]
        };
        assert_eq!(
            pixel(160, 170),
            spec.person.shirt,
            "the shirt at the bottom centre"
        );
        assert_eq!(pixel(160, 56), spec.person.skin, "the face");
        let corner = pixel(2, 2);
        assert!(corner == spec.room.magenta || corner == spec.room.cyan);
    }
}
