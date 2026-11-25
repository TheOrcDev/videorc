//! The onboarding's words and rules (plan 170 D14, plan 174 S3.15a), word
//! for word from Electron's `lib/buddy-onboarding-copy.ts` (the shared
//! `docs/buddy-onboarding-copy.md`) and `lib/buddy-library-view.ts`'s
//! onboarding steps. The words the edit dialog shares (Name, Personality,
//! About you) stay in the core's `copy`.

use serde_json::{Map, Value, json};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{
    CONTEXT_MAX_CHARS, DESCRIPTION_MAX_CHARS, PERSONALITY_MAX_CHARS, name_to_send, text_length,
};

/// `BUDDY_ONBOARDING_STEP_TITLES`.
pub const STEP_TITLES: [&str; 4] = [
    "Meet your avatar",
    "Describe it",
    "Give it a personality",
    "Create your avatar",
];
pub const STEP_COUNT: u8 = 4;

/// `BUDDY_ONBOARDING_BUTTONS`.
pub const BACK: &str = "Back";
pub const NEXT: &str = "Next";
pub const SKIP: &str = "Skip for now";

/// `BUDDY_ONBOARDING_STEP1`.
pub const STEP1_LEAD: &str = "Create your own Golem, Orc, Goblin, Pirate, Robot, or anything you can describe, and put it in your live stream.";
pub const DEMO_HEADING: &str = "How it looks on stream";
pub const DEMO_CHIP: &str = "New follower: Mira";
pub const DEMO_BUBBLES: [&str; 3] = [
    "Welcome to the horde, Mira!",
    "We go live every Tuesday at 8, coders_x.",
    "Ha! Good one.",
];
pub const WHAT_IT_DOES_HEADING: &str = "What it does";
pub const WHAT_IT_DOES: [&str; 5] = [
    "Greets followers, subs and raids by name",
    "With Sidekick, answers viewers' questions from what you tell it",
    "Talks in a comic speech bubble, no voice needed",
    "Shows on your stream, in your recordings, or both",
    "Comes alive with Make it Alive",
];
pub const GALLERY_HEADING: &str = "Start from one of ours";
pub const GALLERY_NOTE: &str = "Free for everyone.";
pub const CARD_ACTION: &str = "Use this one";
pub const CREATE_OWN: &str = "Create my own";

/// `BUDDY_ONBOARDING_STEP2`.
pub const DESCRIBE_LABEL: &str = "What does it look like?";
pub const DESCRIBE_PLACEHOLDER: &str = "A grumpy stone golem with a mossy back and a lantern";
pub const DESCRIBE_EXAMPLES: [&str; 3] = [
    "A tiny dragon in a hoodie",
    "A knight made of pizza",
    "A wise old owl with glasses",
];
pub const PICTURE_LABEL: &str = "Add a picture for inspiration (optional)";
pub const PICTURE_HELP: &str = "A pet, a logo, a sketch or a selfie. It becomes a new character drawn in the Videorc style. The picture is used once and not kept.";
pub const PICTURE_CHOOSE: &str = "Choose a picture";
pub const PICTURE_REMOVE: &str = "Remove";
pub const PICTURE_TYPE_ERROR: &str = "Use a PNG, JPEG or WebP picture.";
pub const PICTURE_UNREADABLE: &str = "That picture could not be read. Try another one.";
/// `BUDDY_LOOK_PICTURE_SIZE_ERROR`: over 10 MB, refused before reading.
pub const PICTURE_SIZE_ERROR: &str = "Choose a picture under 10 MB.";
/// The backend's own refusal for a picture over 3 MB
/// (`COHOST_AVATAR_PICTURE_TOO_LARGE`): Electron shrinks it first, this app
/// has no encoder yet.
pub const PICTURE_SEND_TOO_LARGE: &str = "The picture is over 3 MB. Choose a smaller one.";
pub const NEXT_HINT: &str = "Describe it or add a picture to continue.";

/// `BUDDY_ONBOARDING_STEP3`'s own examples (the edit dialog has none).
pub const PERSONALITY_EXAMPLES: [&str; 3] =
    ["Cheerful and loud", "Dry and sarcastic", "Calm and wise"];

/// `BUDDY_ONBOARDING_STEP4`.
pub const SUMMARY_LOOK: &str = "Look";
pub const SUMMARY_NAME: &str = "Name";
pub const SUMMARY_PERSONALITY: &str = "Personality";
pub const SUMMARY_ABOUT: &str = "About you";
pub const NOT_SET: &str = "Not set";
pub const CREATE: &str = "Create my avatar";
pub const WORKING: &str = "Drawing the pictures. This takes one to three minutes.";
pub const POSE_LABELS: [(&str, &str); 4] = [
    ("idle", "Idle"),
    ("talk", "Talk"),
    ("laugh", "Laugh"),
    ("think", "Think"),
];
pub const DONE: &str = "Saved to your library.";
/// Under the draft's living preview.
pub const PREVIEW_LINE: &str = "The new look, alive. Click it to react.";
pub const USE: &str = "Use as my avatar";
pub const MAKE_ALIVE: &str = "Make it Alive";
pub const REDO: &str = "Redo";
pub const POSE_FAILED: &str = "This pose did not come out. Redo it.";
/// The working line's Cancel (`BuddyLookWorkingLine`).
pub const CANCEL: &str = "Cancel";
pub const CANCELING: &str = "Canceling…";

/// `BUDDY_ONBOARDING_GATES.failed`.
pub const FAILED: &str =
    "Couldn't draw the pictures. Nothing was used from your allowance. Try again.";

/// Step 4's footer (plan 174 G-1, G-13).
pub const DELETE: &str = "Delete…";
pub const START_NEW: &str = "Start a new one";
pub const KEEP_IT: &str = "Keep it";

/// The delete confirm's button: "Delete Grum", or "Delete avatar" with no
/// name yet.
pub fn delete_label(name: Option<&str>) -> String {
    name.map_or_else(
        || "Delete avatar".to_string(),
        |name| format!("Delete {name}"),
    )
}

/// Its title: "Delete Grum?", or "Delete this avatar?".
pub fn delete_title(name: Option<&str>) -> String {
    words::library_delete_title(name.unwrap_or("this avatar"))
}

/// `buddyOnboardingProgress`: "Step 2 of 4".
pub fn progress(step: u8) -> String {
    format!("Step {step} of {STEP_COUNT}")
}

/// `buddyOnboardingAllowance`: "Uses 4 of your 20 images left today."
pub fn allowance(remaining: u64) -> String {
    format!("Uses 4 of your {remaining} images left today.")
}

/// `buddyOnboardingAllowanceLine`: the line, when the web reported today's
/// images.
pub fn allowance_line(capabilities: Option<&Value>) -> Option<String> {
    let avatar = capabilities?.pointer("/cohost/avatar")?;
    if avatar.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    avatar
        .get("remainingToday")
        .and_then(Value::as_u64)
        .map(allowance)
}

/// What the streamer has entered (`BuddyOnboardingInput`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Input {
    pub description: String,
    pub has_picture: bool,
    pub name: String,
    pub personality: String,
    pub about: String,
    /// "Skip for now" on step 3.
    pub skip_details: bool,
}

/// `buddyOnboardingName`: trimmed, 1 to 24 characters.
pub fn name(input: &Input) -> Option<String> {
    name_to_send(&input.name)
}

/// `buddyOnboardingHasLook`: a description, a picture, or both.
pub fn has_look(input: &Input) -> bool {
    !input.description.trim().is_empty() || input.has_picture
}

/// `buddyOnboardingCanAdvance`.
pub fn can_advance(step: u8, input: &Input) -> bool {
    match step {
        1 => true,
        2 => has_look(input) && text_length(input.description.trim()) <= DESCRIPTION_MAX_CHARS,
        3 => {
            name(input).is_some()
                && text_length(&input.personality) <= PERSONALITY_MAX_CHARS
                && text_length(&input.about) <= CONTEXT_MAX_CHARS
        }
        _ => false,
    }
}

/// `buddyOnboardingCanSkip`: step 3, once the name is filled.
pub fn can_skip(step: u8, input: &Input) -> bool {
    step == 3 && name(input).is_some()
}

/// `buddyOnboardingReachable`: the furthest step the input allows.
pub fn reachable(target: u8, input: &Input) -> u8 {
    let mut step = 1;
    while step < target && can_advance(step, input) {
        step += 1;
    }
    step
}

/// `buddyOnboardingDraftDirty`: anything typed or chosen.
pub fn dirty(input: &Input) -> bool {
    input.has_picture
        || [
            &input.description,
            &input.name,
            &input.personality,
            &input.about,
        ]
        .iter()
        .any(|value| !value.trim().is_empty())
}

/// `buddyOnboardingCreateParams`: every field filled; empty optional ones
/// left out, and the personality and About you skipped with step 3.
pub fn create_params(input: &Input, inspiration_base64: Option<&str>) -> Value {
    let mut params = Map::new();
    let description = input.description.trim();
    if !description.is_empty() {
        params.insert("description".into(), json!(description));
    }
    if let Some(picture) = inspiration_base64 {
        params.insert("inspirationBase64".into(), json!(picture));
    }
    if let Some(name) = name(input) {
        params.insert("name".into(), json!(name));
    }
    if !input.skip_details {
        let personality = input.personality.trim();
        if !personality.is_empty() {
            params.insert("personality".into(), json!(personality));
        }
        let context = input.about.trim();
        if !context.is_empty() {
            params.insert("context".into(), json!(context));
        }
    }
    Value::Object(params)
}

/// `buddyCreateFailureLine`: the one line for a create that made nothing,
/// by the web's code; a cancel says nothing.
pub fn failure_line(code: &str, limit: u32) -> Option<String> {
    Some(match code {
        "cohost-avatar-cancelled" => return None,
        "buddy-library-full" => words::library_full_line(limit),
        "quota-exhausted" => super::gate::LOOK_ALLOWANCE_USED.to_string(),
        "premium-required" => super::gate::LOOK_PREMIUM.to_string(),
        "unauthorized" => super::gate::LOOK_SIGNED_OUT.to_string(),
        _ => FAILED.to_string(),
    })
}

/// A pose's label ("Idle").
pub fn pose_label(state: &str) -> &'static str {
    POSE_LABELS
        .iter()
        .find(|(id, _)| *id == state)
        .map_or("", |(_, label)| *label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Input {
        Input::default()
    }

    #[test]
    fn the_four_titles_and_the_progress_line() {
        assert_eq!(STEP_TITLES[0], "Meet your avatar");
        assert_eq!(STEP_TITLES[3], "Create your avatar");
        assert_eq!(progress(2), "Step 2 of 4");
        assert_eq!(allowance(20), "Uses 4 of your 20 images left today.");
    }

    #[test]
    fn each_step_needs_the_one_before() {
        let mut typed = input();
        assert!(can_advance(1, &typed));
        assert!(!can_advance(2, &typed));
        assert_eq!(reachable(4, &typed), 2);
        typed.description = "A tiny dragon".into();
        assert!(can_advance(2, &typed));
        assert!(!can_advance(3, &typed));
        assert!(!can_skip(3, &typed));
        typed.name = "  Grum ".into();
        assert!(can_skip(3, &typed));
        assert_eq!(reachable(4, &typed), 4);
        typed.name = "x".repeat(25);
        assert!(!can_advance(3, &typed));
        let picture_only = Input {
            has_picture: true,
            ..input()
        };
        assert!(can_advance(2, &picture_only));
        assert!(!can_advance(4, &picture_only));
    }

    #[test]
    fn a_draft_is_dirty_once_anything_is_typed_or_chosen() {
        assert!(!dirty(&input()));
        assert!(!dirty(&Input {
            name: "   ".into(),
            ..input()
        }));
        assert!(dirty(&Input {
            about: "hi".into(),
            ..input()
        }));
        assert!(dirty(&Input {
            has_picture: true,
            ..input()
        }));
    }

    #[test]
    fn create_sends_only_what_was_filled() {
        let typed = Input {
            description: " A knight made of pizza ".into(),
            name: "Crust".into(),
            personality: "Cheesy".into(),
            about: " ".into(),
            ..input()
        };
        assert_eq!(
            create_params(&typed, Some("AAAA")),
            json!({
                "description": "A knight made of pizza",
                "inspirationBase64": "AAAA",
                "name": "Crust",
                "personality": "Cheesy"
            })
        );
        let skipped = Input {
            skip_details: true,
            ..typed
        };
        assert_eq!(
            create_params(&skipped, None),
            json!({ "description": "A knight made of pizza", "name": "Crust" })
        );
    }

    #[test]
    fn a_failed_create_says_one_line_by_its_code() {
        assert_eq!(failure_line("cohost-avatar-cancelled", 30), None);
        assert_eq!(
            failure_line("buddy-library-full", 30).as_deref(),
            Some("Your library is full (30 avatars). Delete one to make room.")
        );
        assert_eq!(
            failure_line("quota-exhausted", 30).as_deref(),
            Some("You've used today's images. You get more tomorrow.")
        );
        assert_eq!(failure_line("anything", 30).as_deref(), Some(FAILED));
    }

    #[test]
    fn the_allowance_line_shows_only_when_the_web_said() {
        let caps = json!({ "cohost": { "avatar": { "enabled": true, "remainingToday": 12 } } });
        assert_eq!(
            allowance_line(Some(&caps)).as_deref(),
            Some("Uses 4 of your 12 images left today.")
        );
        assert_eq!(
            allowance_line(Some(
                &json!({ "cohost": { "avatar": { "enabled": false } } })
            )),
            None
        );
        assert_eq!(allowance_line(None), None);
    }

    #[test]
    fn the_delete_confirm_names_the_draft() {
        assert_eq!(delete_label(Some("Grum")), "Delete Grum");
        assert_eq!(delete_label(None), "Delete avatar");
        assert_eq!(delete_title(None), "Delete this avatar?");
        assert_eq!(pose_label("laugh"), "Laugh");
    }
}
