//! The arrival chip on a returning person's chat row (plan 225 C1, D11;
//! Electron's `arrivalChip` in `lib/community-view.ts`): one quiet chip,
//! drawn from `message.arrival` alone, with no fetch per row. The Stream
//! Manager's rows and the Studio's Chat rows both carry it.

use super::model::{ViewerArrival, ViewerMilestone};
use super::view::platform_label;
use crate::stream_manager::format::group_thousands;

/// `ArrivalChipKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrivalChipKind {
    Milestone,
    Back,
    Regular,
}

/// `ArrivalChip`: the chip's words and its hover line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArrivalChip {
    pub kind: ArrivalChipKind,
    /// "10th stream", "Back · 3 wk", "Regular · 14".
    pub label: String,
    /// "14 streams · since March 2026 · Twitch · YouTube".
    pub hint: String,
}

/// `ordinal`: "1st", "2nd", "3rd", "10th", "11th", "22nd".
pub fn ordinal(value: u32) -> String {
    let suffix = match (value % 100, value % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{value}{suffix}")
}

/// `awayLabel(days, 'short')`: weeks under 8 ("3 wk"), then months ("3 mo").
pub fn away_label_short(days: u32) -> String {
    let weeks = (days / 7).max(1);
    if weeks < 8 {
        return format!("{weeks} wk");
    }
    format!("{} mo", (days / 30).max(2))
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// `sinceLabel`: "2026-03" or an RFC 3339 time → "March 2026"; none when
/// unreadable.
pub fn since_label(value: Option<&str>) -> Option<String> {
    let value = value?;
    let year = value
        .get(0..4)
        .filter(|year| year.chars().all(|c| c.is_ascii_digit()))?;
    if value.get(4..5) != Some("-") {
        return None;
    }
    let month: usize = value
        .get(5..7)
        .filter(|m| m.chars().all(|c| c.is_ascii_digit()))?
        .parse()
        .ok()?;
    let name = MONTHS.get(month.checked_sub(1)?)?;
    Some(format!("{name} {year}"))
}

/// `milestoneLabel`: "10th stream", "5 in a row", "1 year".
pub fn milestone_label(milestone: &ViewerMilestone) -> String {
    match milestone.kind.as_str() {
        "streams" => format!("{} stream", ordinal(milestone.value)),
        "row" => format!("{} in a row", milestone.value),
        "anniversary" => "1 year".to_owned(),
        // A kind a newer backend sends: its number, never a dropped chip.
        other => format!("{} {other}", milestone.value),
    }
}

/// `platformsLine`: "Twitch · YouTube".
pub fn platforms_line(platforms: Option<&[String]>) -> String {
    platforms
        .unwrap_or_default()
        .iter()
        .map(|platform| platform_label(platform))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// `arrivalChip`: the one chip an arrival row carries, in priority order:
/// the milestone, then Back, then Regular; none for a returning person who
/// is none of the three.
pub fn arrival_chip(arrival: Option<&ViewerArrival>) -> Option<ArrivalChip> {
    let arrival = arrival?;
    let count = i64::from(arrival.streams);
    let mut parts = vec![if count == 1 {
        "1 stream".to_owned()
    } else {
        format!("{} streams", group_thousands(count))
    }];
    if let Some(since) = since_label(arrival.since.as_deref()) {
        parts.push(format!("since {since}"));
    }
    let platforms = platforms_line(arrival.platforms.as_deref());
    if !platforms.is_empty() {
        parts.push(platforms);
    }
    let hint = parts.join(" · ");
    let (kind, label) = if let Some(milestone) = &arrival.milestone {
        (ArrivalChipKind::Milestone, milestone_label(milestone))
    } else if let Some(days) = arrival.away_days {
        (
            ArrivalChipKind::Back,
            format!("Back · {}", away_label_short(days)),
        )
    } else if arrival.regular {
        (
            ArrivalChipKind::Regular,
            format!("Regular · {}", group_thousands(count)),
        )
    } else {
        return None;
    };
    Some(ArrivalChip { kind, label, hint })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regular() -> ViewerArrival {
        ViewerArrival {
            streams: 14,
            regular: true,
            in_a_row: 2,
            platforms: Some(vec!["twitch".into(), "youtube".into()]),
            since: Some("2026-03".into()),
            ..ViewerArrival::default()
        }
    }

    /// Electron's "picks one chip per arrival: milestone, then Back, then Regular (D11)".
    #[test]
    fn one_chip_per_arrival_milestone_then_back_then_regular() {
        assert_eq!(
            arrival_chip(Some(&regular())),
            Some(ArrivalChip {
                kind: ArrivalChipKind::Regular,
                label: "Regular · 14".into(),
                hint: "14 streams · since March 2026 · Twitch · YouTube".into(),
            })
        );
        let back = ViewerArrival {
            away_days: Some(21),
            ..regular()
        };
        assert_eq!(arrival_chip(Some(&back)).unwrap().label, "Back · 3 wk");
        let milestone = ViewerArrival {
            milestone: Some(ViewerMilestone {
                kind: "streams".into(),
                value: 10,
            }),
            ..back
        };
        assert_eq!(arrival_chip(Some(&milestone)).unwrap().label, "10th stream");
        let quiet = ViewerArrival {
            streams: 2,
            in_a_row: 1,
            ..ViewerArrival::default()
        };
        assert_eq!(arrival_chip(Some(&quiet)), None);
        assert_eq!(arrival_chip(None), None);
        let one = ViewerArrival {
            streams: 3,
            regular: true,
            in_a_row: 1,
            ..ViewerArrival::default()
        };
        assert_eq!(arrival_chip(Some(&one)).unwrap().hint, "3 streams");
    }

    #[test]
    fn the_small_labels_read_as_electrons() {
        assert_eq!(
            [1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal),
            [
                "1st", "2nd", "3rd", "4th", "10th", "11th", "12th", "13th", "21st", "22nd", "23rd",
                "101st", "111th"
            ]
        );
        assert_eq!(away_label_short(3), "1 wk");
        assert_eq!(away_label_short(55), "7 wk");
        assert_eq!(away_label_short(56), "2 mo");
        assert_eq!(away_label_short(95), "3 mo");
        assert_eq!(
            since_label(Some("2026-11-24T10:00:00Z")).as_deref(),
            Some("November 2026")
        );
        assert_eq!(since_label(Some("2026-13")), None);
        assert_eq!(since_label(Some("soon")), None);
        let row = ViewerMilestone {
            kind: "row".into(),
            value: 5,
        };
        assert_eq!(milestone_label(&row), "5 in a row");
        let year = ViewerMilestone {
            kind: "anniversary".into(),
            value: 2027,
        };
        assert_eq!(milestone_label(&year), "1 year");
    }
}
