//! Name and personality (`buddy-persona-section.tsx`,
//! `lib/buddy-persona-view.ts`): the rules the fields save by. Pure.

use videorc_protocol::buddy_pet::{BuddyAvatar, BuddyMotionSettings};
use videorc_protocol::cohost::{CohostBubbleStyle, CohostPersona, CohostPersonaSource};

use super::library::text_length;
use super::pet::DEFAULT_BUNDLED_PACK;

/// `BUDDY_NAME_MAX_CHARS` and `BUDDY_PERSONALITY_MAX_CHARS`.
pub const NAME_MAX_CHARS: usize = 24;
pub const PERSONALITY_MAX_CHARS: usize = 1200;

/// `buddyNameToSave`: trimmed, 1 to 24 characters; None never saves.
pub fn name_to_save(draft: &str) -> Option<String> {
    let name = draft.trim();
    (!name.is_empty() && text_length(name) <= NAME_MAX_CHARS).then(|| name.to_string())
}

/// `freshBuddyPersona`: Start over's new avatar, Flint (the official
/// default's pack ships, so it starts Alive in it).
pub fn fresh_persona(id: String) -> CohostPersona {
    CohostPersona {
        id,
        name: super::DEFAULT_AVATAR_NAME.into(),
        personality: String::new(),
        bubble_style: CohostBubbleStyle::Speech,
        images: Default::default(),
        source: CohostPersonaSource::Default,
        avatar: BuddyAvatar::Alive {
            pack_id: DEFAULT_BUNDLED_PACK.into(),
        },
        motion: BuddyMotionSettings::default(),
        reactions: Default::default(),
        library_avatar_id: None,
    }
}

/// The bubble style's index in `BUDDY_BUBBLE_STYLES`.
pub fn bubble_index(style: CohostBubbleStyle) -> usize {
    match style {
        CohostBubbleStyle::Speech => 0,
        CohostBubbleStyle::Thought => 1,
        CohostBubbleStyle::Shout => 2,
    }
}

pub fn bubble_style(index: usize) -> CohostBubbleStyle {
    match index {
        1 => CohostBubbleStyle::Thought,
        2 => CohostBubbleStyle::Shout,
        _ => CohostBubbleStyle::Speech,
    }
}

/// The wire word (`speech`, `thought`, `shout`).
pub fn bubble_word(style: CohostBubbleStyle) -> &'static str {
    super::copy::BUBBLE_STYLES[bubble_index(style)].0
}

/// A field's draft against what is saved: what Save sends, if anything.
/// The personality saves whatever it holds (an empty one too); About you
/// only within its bound.
pub fn about_to_save(draft: &str, saved: &str) -> Option<String> {
    (draft != saved && text_length(draft) <= super::library::CONTEXT_MAX_CHARS)
        .then(|| draft.to_string())
}

/// `BuddyExampleChips`: a chip fills an empty field at once (or the one
/// that already says it) and asks over typed text.
pub fn chip_fills_at_once(value: &str, example: &str) -> bool {
    value.trim().is_empty() || value == example
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_trim_and_stay_within_24() {
        assert_eq!(name_to_save(" Grum "), Some("Grum".into()));
        assert_eq!(name_to_save(""), None);
        assert_eq!(name_to_save(&"é".repeat(24)), Some("é".repeat(24)));
        assert_eq!(name_to_save(&"é".repeat(25)), None);
    }

    #[test]
    fn a_fresh_buddy_is_the_default_one_alive() {
        let persona = fresh_persona("x".into());
        assert_eq!(persona.name, "Flint");
        assert_eq!(
            persona.avatar,
            BuddyAvatar::Alive {
                pack_id: "bundled:buddy".into()
            }
        );
        assert_eq!(bubble_word(persona.bubble_style), "speech");
        assert_eq!(bubble_style(2), CohostBubbleStyle::Shout);
    }

    #[test]
    fn chips_ask_over_typed_text() {
        assert!(chip_fills_at_once("  ", "Cheerful goblin merchant"));
        assert!(chip_fills_at_once(
            "Cheerful goblin merchant",
            "Cheerful goblin merchant"
        ));
        assert!(!chip_fills_at_once("my own", "Cheerful goblin merchant"));
        assert_eq!(about_to_save("a", "a"), None);
        assert_eq!(about_to_save("b", "a"), Some("b".into()));
    }
}
