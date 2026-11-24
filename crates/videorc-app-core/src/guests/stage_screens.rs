//! Plan 251 (`lib/stage-screens.ts`): which screens the program shows. The
//! host shares their own screen, a guest shares theirs once allowed, and the
//! host puts up to two of them on stage from the Show stage's Screens cards
//! (plan 252). One screen is `screen-people`; two are the two-screens
//! layout.
//!
//! On the wire a stage keeps its one `screen`, and names both in `screens`
//! only when there are two. An older desktop, program page, guest page or
//! runner reads `screen` and shows that one.

use super::wire::{RoomStatus, Stage, StageLayout};

/// The most screens a stage shows at once.
pub const STAGE_MAX_SCREENS: usize = 2;

pub const TWO_SCREENS_AT_MOST: &str = "Two screens are on stage. Take one off first.";
pub const ONE_SCREEN_ON_THIS_SHOW: &str = "This show puts one screen on the program.";

/// The screens a stage shows, in order: its two `screens` when it names two
/// different ones, else its one `screen`, else none (or the one `screens`
/// entry when that is all there is, as the page reads it).
pub fn stage_screens(screen: Option<&str>, screens: &[String]) -> Vec<String> {
    let mut named: Vec<String> = Vec::new();
    for identity in screens {
        if !identity.is_empty() && !named.contains(identity) {
            named.push(identity.clone());
        }
    }
    if named.len() >= STAGE_MAX_SCREENS {
        named.truncate(STAGE_MAX_SCREENS);
        return named;
    }
    match screen.filter(|screen| !screen.is_empty()) {
        Some(screen) => vec![screen.to_string()],
        None => named,
    }
}

/// [`stage_screens`] of a whole stage.
pub fn screens_of(stage: &Stage) -> Vec<String> {
    stage_screens(stage.screen.as_deref(), &stage.screens)
}

/// Two screens, each on its owner's side: the screen of whoever stands first
/// in `order` comes first (left, or on top on a portrait canvas). An owner
/// `order` does not name leaves the pair as it came (the web's
/// `screensByOwner`).
pub fn screens_by_owner(screens: &[String], order: &[String]) -> Vec<String> {
    let (Some(first), Some(second)) = (screens.first(), screens.get(1)) else {
        return screens.to_vec();
    };
    let a = order.iter().position(|identity| identity == first);
    let b = order.iter().position(|identity| identity == second);
    match (a, b) {
        (Some(a), Some(b)) if a > b => vec![second.clone(), first.clone()],
        _ => vec![first.clone(), second.clone()],
    }
}

/// A managed show can show two screens; a node show's runner draws one.
pub fn max_stage_screens(managed: bool) -> usize {
    if managed { STAGE_MAX_SCREENS } else { 1 }
}

/// The stage with its screens put right: each one on stage, each once, at
/// most two; `screen` is the first and `screens` is there only for two. The
/// layout is left alone.
pub fn with_stage_screens(stage: &Stage, chosen: &[String]) -> Stage {
    let mut kept: Vec<String> = Vec::new();
    for identity in chosen {
        if stage.on_stage.contains(identity) && !kept.contains(identity) {
            kept.push(identity.clone());
        }
    }
    kept.truncate(STAGE_MAX_SCREENS);
    Stage {
        screen: kept.first().cloned(),
        screens: if kept.len() == STAGE_MAX_SCREENS {
            kept
        } else {
            Vec::new()
        },
        ..stage.clone()
    }
}

/// A stage whose screens may name someone who left it: the same, put right.
pub fn prune_stage_screens(stage: &Stage) -> Stage {
    if stage.screen.is_none() && stage.screens.is_empty() {
        return stage.clone();
    }
    with_stage_screens(stage, &screens_of(stage))
}

/// The host's pick: these screens on the program. Any screen moves the
/// layout to Screen + people; none moves it back to Side by side.
pub fn show_screens(stage: &Stage, chosen: &[String], max: usize) -> Stage {
    let limited: Vec<String> = chosen.iter().take(max).cloned().collect();
    let next = with_stage_screens(stage, &limited);
    let layout = if next.screen.is_some() {
        StageLayout::ScreenPeople
    } else if stage.layout == StageLayout::ScreenPeople {
        StageLayout::SideBySide
    } else {
        stage.layout
    };
    Stage { layout, ..next }
}

/// One more screen on the stage: beside the one already there while there
/// is room (`max` 2), else in its place (`max` 1).
pub fn add_screen(stage: &Stage, identity: &str, max: usize) -> Stage {
    let current = screens_of(stage);
    if current.iter().any(|screen| screen == identity) {
        return show_screens(stage, &current, max);
    }
    let mut kept: Vec<String> = current.into_iter().take(max.saturating_sub(1)).collect();
    kept.push(identity.to_string());
    show_screens(stage, &kept, max)
}

/// A screen off the stage; the other one, when there is one, stays. Screen +
/// people with no screen left goes back to Side by side.
pub fn remove_screen(stage: &Stage, identity: &str) -> Stage {
    let current = screens_of(stage);
    if !current.iter().any(|screen| screen == identity) {
        return stage.clone();
    }
    let rest: Vec<String> = current
        .into_iter()
        .filter(|screen| screen != identity)
        .collect();
    let next = with_stage_screens(stage, &rest);
    let layout = if stage.layout == StageLayout::ScreenPeople && next.screen.is_none() {
        StageLayout::SideBySide
    } else {
        stage.layout
    };
    Stage { layout, ..next }
}

/// A card's click while the two-screens layout is chosen: a screen on stage
/// comes off; one that is off goes on beside the other while there is room.
/// A third changes nothing (its card says why).
pub fn toggle_stage_screen(stage: &Stage, identity: &str) -> Stage {
    let current = screens_of(stage);
    if current.iter().any(|screen| screen == identity) {
        return remove_screen(stage, identity);
    }
    if current.len() >= STAGE_MAX_SCREENS {
        return stage.clone();
    }
    let mut chosen = current;
    chosen.push(identity.to_string());
    show_screens(stage, &chosen, STAGE_MAX_SCREENS)
}

/// Whether the Two screens layout card is the one chosen: `picked` by the
/// card, kept while Screen + people is up, and read back from a stage that
/// names two.
pub fn two_screens_chosen(stage: Option<&Stage>, picked: bool) -> bool {
    match stage {
        Some(stage) if stage.layout == StageLayout::ScreenPeople => {
            picked || screens_of(stage).len() == STAGE_MAX_SCREENS
        }
        _ => false,
    }
}

/// Who on stage shares a screen now, in stage order.
pub fn stage_sharers(
    room: Option<&RoomStatus>,
    host_identity: Option<&str>,
    host_sharing: bool,
) -> Vec<String> {
    let Some(room) = room else {
        return Vec::new();
    };
    room.stage
        .on_stage
        .iter()
        .filter(|identity| {
            room.participants
                .iter()
                .any(|participant| participant.screen && &participant.identity == *identity)
                || (host_sharing && host_identity == Some(identity.as_str()))
        })
        .cloned()
        .collect()
}

/// The Two screens layout card: the screens the stage already names, then
/// whoever else on stage shares one, up to two. None when there is nothing
/// to show.
pub fn two_screens_stage(stage: &Stage, sharers: &[String]) -> Option<Stage> {
    let named: Vec<String> = screens_of(stage)
        .into_iter()
        .filter(|identity| stage.on_stage.contains(identity))
        .collect();
    let mut picks = named.clone();
    picks.extend(
        sharers
            .iter()
            .filter(|identity| !named.contains(identity))
            .cloned(),
    );
    if picks.is_empty() {
        return None;
    }
    Some(show_screens(stage, &picks, STAGE_MAX_SCREENS))
}

/// The Screen + people layout card: the stage's one screen, never a pair.
pub fn one_screen_stage(stage: &Stage) -> Stage {
    let first: Vec<String> = screens_of(stage).into_iter().take(1).collect();
    Stage {
        layout: StageLayout::ScreenPeople,
        ..with_stage_screens(stage, &first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn stage(layout: StageLayout, on_stage: &[&str]) -> Stage {
        Stage {
            layout,
            on_stage: ids(on_stage),
            ..Stage::default()
        }
    }

    #[test]
    fn a_stage_shows_two_named_screens_else_its_one() {
        assert_eq!(
            stage_screens(Some("a"), &ids(&["b", "c"])),
            ids(&["b", "c"])
        );
        assert_eq!(stage_screens(Some("a"), &ids(&["b", "b"])), ids(&["a"]));
        assert_eq!(stage_screens(None, &ids(&["b"])), ids(&["b"]));
        assert_eq!(stage_screens(Some(""), &[]), Vec::<String>::new());
    }

    #[test]
    fn two_screens_sit_over_their_owners() {
        assert_eq!(
            screens_by_owner(&ids(&["g", "h"]), &ids(&["h", "g"])),
            ids(&["h", "g"])
        );
        assert_eq!(
            screens_by_owner(&ids(&["g", "h"]), &ids(&["x"])),
            ids(&["g", "h"])
        );
        assert_eq!(screens_by_owner(&ids(&["g"]), &ids(&["g"])), ids(&["g"]));
    }

    #[test]
    fn screens_are_put_right_on_the_wire() {
        let base = stage(StageLayout::SideBySide, &["h", "g", "k"]);
        let one = with_stage_screens(&base, &ids(&["g", "g", "gone"]));
        assert_eq!(one.screen.as_deref(), Some("g"));
        assert!(one.screens.is_empty());
        let two = with_stage_screens(&base, &ids(&["g", "h", "k"]));
        assert_eq!(two.screen.as_deref(), Some("g"));
        assert_eq!(two.screens, ids(&["g", "h"]));
        assert_eq!(two.layout, StageLayout::SideBySide);
    }

    #[test]
    fn showing_and_taking_off_screens_moves_the_layout() {
        let base = stage(StageLayout::SideBySide, &["h", "g"]);
        let shown = show_screens(&base, &ids(&["g"]), 1);
        assert_eq!(shown.layout, StageLayout::ScreenPeople);
        assert_eq!(shown.screen.as_deref(), Some("g"));
        let replaced = add_screen(&shown, "h", 1);
        assert_eq!(replaced.screen.as_deref(), Some("h"));
        let both = add_screen(&shown, "h", 2);
        assert_eq!(both.screens, ids(&["g", "h"]));
        let back = remove_screen(&both, "g");
        assert_eq!(back.screen.as_deref(), Some("h"));
        assert!(back.screens.is_empty());
        let none = remove_screen(&back, "h");
        assert_eq!(none.layout, StageLayout::SideBySide);
        assert_eq!(none.screen, None);
        assert_eq!(remove_screen(&none, "h"), none);
    }

    #[test]
    fn a_third_screen_card_changes_nothing() {
        let base = stage(StageLayout::ScreenPeople, &["h", "g", "k"]);
        let two = toggle_stage_screen(&toggle_stage_screen(&base, "g"), "h");
        assert_eq!(two.screens, ids(&["g", "h"]));
        assert_eq!(toggle_stage_screen(&two, "k"), two);
        assert_eq!(toggle_stage_screen(&two, "g").screen.as_deref(), Some("h"));
        assert!(two_screens_chosen(Some(&two), false));
        assert!(!two_screens_chosen(Some(&base), false));
        assert!(two_screens_chosen(Some(&base), true));
        assert!(!two_screens_chosen(None, true));
    }

    #[test]
    fn the_two_screens_card_starts_from_the_sharers() {
        let base = stage(StageLayout::SideBySide, &["h", "g", "k"]);
        assert_eq!(two_screens_stage(&base, &[]), None);
        let picked = two_screens_stage(&base, &ids(&["k", "g", "h"])).unwrap();
        assert_eq!(picked.screens, ids(&["k", "g"]));
        assert_eq!(picked.layout, StageLayout::ScreenPeople);
        let single = one_screen_stage(&picked);
        assert_eq!(single.screen.as_deref(), Some("k"));
        assert!(single.screens.is_empty());
        assert_eq!(max_stage_screens(false), 1);
        assert_eq!(prune_stage_screens(&base), base);
    }
}
