//! What a person's tile and strip thumbnail show (wire contract 5.5,
//! decision 75; `lib/talk-show-tile.ts`). Camera off is a muted camera
//! publication, and it is not away: the tile stays where the layout puts it
//! and draws the camera-off look the program page draws for viewers (the
//! tile's ground, a circle with the name's first letter, the name plate).
//! "Back in a moment" is never drawn over someone whose camera is off.

use super::layout::{StageTile, StageTileKind};
use super::wire::HostShape;

/// Whether a tile draws the person's camera frames: not while it's off.
pub fn shows_camera(has_video: bool, camera_off: bool) -> bool {
    has_video && !camera_off
}

/// Whether the away plate shows: never over someone whose camera is off.
pub fn shows_away(away: bool, camera_off: bool) -> bool {
    away && !camera_off
}

/// The letter the camera-off look shows: the name's first character, in
/// capitals; "?" for an empty name. The program page shows the same letter.
pub fn name_initial(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map_or_else(|| "?".to_string(), |first| first.to_uppercase().collect())
}

/// The circle's diameter, as a share of the tile's short side (the page's).
pub const CAMERA_OFF_CIRCLE: f64 = 0.36;
/// The letter's size, as a share of the circle (the page's).
pub const CAMERA_OFF_INITIAL: f64 = 0.5;

/// `Math.round` for a non-negative value: halves round up.
fn round_half_up(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// The camera-off look for a tile of `w`×`h` canvas pixels, in those pixels:
/// (circle diameter, letter size).
pub fn camera_off_look(w: i64, h: i64) -> (i64, i64) {
    let diameter = 2.max(round_half_up(w.min(h) as f64 * CAMERA_OFF_CIRCLE));
    let font = 8.max(round_half_up(diameter as f64 * CAMERA_OFF_INITIAL));
    (diameter, font)
}

/// The host's circle (plan 247 D-2): the program page clips the host's own
/// person tile to the circle inscribed in it when the stage says
/// `hostShape: circle` and the tile has corners, so never in Solo.
pub fn host_circle(
    tile: &StageTile,
    host_identity: Option<&str>,
    host_shape: Option<HostShape>,
) -> bool {
    tile.kind == StageTileKind::Person
        && host_identity == Some(tile.identity.as_str())
        && host_shape == Some(HostShape::Circle)
        && tile.corner_radius > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guests::layout::StageRect;

    fn tile(identity: &str, kind: StageTileKind, corner_radius: i64) -> StageTile {
        StageTile {
            identity: identity.into(),
            kind,
            rect: StageRect::default(),
            plate: None,
            corner_radius,
        }
    }

    #[test]
    fn camera_off_is_not_away_and_shows_no_frame() {
        assert!(shows_camera(true, false));
        assert!(!shows_camera(true, true));
        assert!(!shows_camera(false, false));
        assert!(shows_away(true, false));
        assert!(!shows_away(true, true));
        assert!(!shows_away(false, false));
    }

    #[test]
    fn the_initial_is_the_names_first_letter_in_capitals() {
        assert_eq!(name_initial("  ada"), "A");
        assert_eq!(name_initial("élodie"), "É");
        assert_eq!(name_initial("ß"), "SS");
        assert_eq!(name_initial("   "), "?");
        assert_eq!(name_initial("😀 smile"), "😀");
    }

    #[test]
    fn the_camera_off_look_scales_with_the_tile() {
        assert_eq!(camera_off_look(1920, 1080), (389, 195));
        assert_eq!(camera_off_look(4, 4), (2, 8));
    }

    #[test]
    fn the_host_circle_needs_the_host_a_circle_and_corners() {
        let host = tile("host:sh", StageTileKind::Person, 20);
        assert!(host_circle(&host, Some("host:sh"), Some(HostShape::Circle)));
        assert!(!host_circle(
            &host,
            Some("host:sh"),
            Some(HostShape::Rounded)
        ));
        assert!(!host_circle(&host, Some("other"), Some(HostShape::Circle)));
        let solo = tile("host:sh", StageTileKind::Person, 0);
        assert!(!host_circle(
            &solo,
            Some("host:sh"),
            Some(HostShape::Circle)
        ));
        let screen = tile("host:sh", StageTileKind::Screen, 20);
        assert!(!host_circle(
            &screen,
            Some("host:sh"),
            Some(HostShape::Circle)
        ));
    }
}
