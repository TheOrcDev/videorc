//! Electron's `main/stream-manager-screen.ts`: local display geometry,
//! the safe remote projection, and the Screen key's destination/frame.

use super::remote::{RemoteNamed, RemoteStreamManager};
use crate::desktop::window_frames::Rect;

/// Local facts only. Remote clients receive [`screen_options`], never geometry.
#[derive(Debug, Clone)]
pub struct RemoteDisplay {
    pub id: String,
    /// GPUI has no display labels; an empty label uses Electron's index fallback.
    pub name: String,
    pub bounds: Rect,
    pub work_area: Rect,
    pub primary: bool,
}

/// Electron's getDisplayMatching: largest intersection, primary on no match.
pub fn screen_for_frame(frame: Rect, displays: &[RemoteDisplay]) -> Option<&str> {
    let area = |display: &RemoteDisplay| {
        let b = display.bounds;
        ((frame.x + frame.width).min(b.x + b.width) - frame.x.max(b.x)).max(0.)
            * ((frame.y + frame.height).min(b.y + b.height) - frame.y.max(b.y)).max(0.)
    };
    let best = displays.iter().max_by(|a, b| area(a).total_cmp(&area(b)));
    best.filter(|d| area(d) > 0.)
        .or_else(|| displays.iter().find(|d| d.primary))
        .or(best)
        .map(|d| d.id.as_str())
}

/// Preserve platform order, including when the primary is not first.
pub fn screen_options(displays: &[RemoteDisplay]) -> Vec<RemoteNamed> {
    displays
        .iter()
        .enumerate()
        .map(|(index, display)| {
            let look = |d: &RemoteDisplay| {
                format!("{} ({} × {})", d.name, d.bounds.width, d.bounds.height)
            };
            let same_label = displays.iter().filter(|d| d.name == display.name).count();
            let same_look = displays.iter().filter(|d| look(d) == look(display)).count();
            let name = if display.name.is_empty() {
                format!("Screen {}", index + 1)
            } else if same_label == 1 {
                display.name.clone()
            } else if same_look == 1 {
                look(display)
            } else {
                let ordinal = displays[..=index]
                    .iter()
                    .filter(|d| look(d) == look(display))
                    .count();
                format!(
                    "{} {} ({} × {})",
                    display.name, ordinal, display.bounds.width, display.bounds.height
                )
            };
            RemoteNamed {
                id: display.id.clone(),
                name,
            }
        })
        .collect()
}

/// Closed/minimized/third display goes to Monitor. Only Presenting takes focus.
pub fn destination<'a>(
    place: &RemoteStreamManager,
    presenting: &'a str,
    monitor: &'a str,
) -> (&'a str, bool) {
    if place.visible && place.screen_id.as_deref() == Some(monitor) {
        (presenting, true)
    } else {
        (monitor, false)
    }
}

/// Keep the target's saved frame, or center the current size, inside its work area.
pub fn frame_on_screen(current: Rect, saved: Option<Rect>, work: Rect) -> Rect {
    let source = saved.unwrap_or(current);
    let width = source.width.min(work.width).max(1.);
    let height = source.height.min(work.height).max(1.);
    let x = saved.map_or(work.x + ((work.width - width) / 2.).round(), |r| r.x);
    let y = saved.map_or(work.y + ((work.height - height) / 2.).round(), |r| r.y);
    Rect::new(
        x.clamp(work.x, work.x + work.width - width),
        y.clamp(work.y, work.y + work.height - height),
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn display(id: &str, name: &str, width: f64) -> RemoteDisplay {
        RemoteDisplay {
            id: id.into(),
            name: name.into(),
            bounds: Rect::new(0., 0., width, 900.),
            work_area: Rect::new(0., 25., width, 875.),
            primary: id == "7",
        }
    }

    #[test]
    fn one_display_is_reported_and_geometry_stays_local() {
        assert_eq!(
            serde_json::to_value(screen_options(&[display("7", "", 1440.)])).unwrap(),
            json!([{"id":"7", "name":"Screen 1"}])
        );
        assert!(screen_options(&[]).is_empty());
    }

    #[test]
    fn names_and_order_match_electron_even_with_duplicate_labels() {
        let screens = screen_options(&[
            display("9", "", 1440.),
            display("7", "Studio", 1440.),
            display("5", "Studio", 1920.),
            display("6", "Studio", 1920.),
        ]);
        assert_eq!(
            screens
                .iter()
                .map(|d| (d.id.as_str(), d.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("9", "Screen 1"),
                ("7", "Studio (1440 × 900)"),
                ("5", "Studio 1 (1920 × 900)"),
                ("6", "Studio 2 (1920 × 900)")
            ]
        );
    }

    #[test]
    fn tap_alternates_and_opens_on_monitor_without_focus() {
        let mut place = RemoteStreamManager::default();
        assert_eq!(destination(&place, "1", "2"), ("2", false));
        place.visible = true;
        for (id, expected) in [("1", ("2", false)), ("2", ("1", true)), ("3", ("2", false))] {
            place.screen_id = Some(id.into());
            assert_eq!(destination(&place, "1", "2"), expected);
        }
        place.screen_id = Some("2".into());
        place.visible = false;
        assert_eq!(destination(&place, "1", "2"), ("2", false));
    }

    #[test]
    fn window_display_uses_global_bounds_not_a_cached_display_id() {
        let primary = display("7", "", 1440.);
        let mut left = display("8", "", 1920.);
        left.bounds.x = -1920.;
        let displays = [left, primary];
        assert_eq!(
            screen_for_frame(Rect::new(-1800., 20., 1000., 700.), &displays),
            Some("8")
        );
        assert_eq!(
            screen_for_frame(Rect::new(30., 20., 1000., 700.), &displays),
            Some("7")
        );
        assert_eq!(
            screen_for_frame(Rect::new(9000., 20., 1000., 700.), &displays),
            Some("7")
        );
        assert_eq!(screen_for_frame(Rect::new(0., 0., 10., 10.), &[]), None);
    }

    #[test]
    fn placement_centers_and_clamps_on_negative_coordinate_displays() {
        let work = Rect::new(-1920., 25., 1920., 1055.);
        let current = Rect::new(50., 60., 1120., 720.);
        assert_eq!(
            frame_on_screen(current, None, work),
            Rect::new(-1520., 193., 1120., 720.)
        );
        assert_eq!(
            frame_on_screen(current, Some(Rect::new(-2500., -100., 2000., 1200.)), work),
            work
        );
    }
}
