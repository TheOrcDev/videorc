//! The Sidekick and Avatar pages' words, Electron's byte for byte. Since
//! Electron's #1356 and #1372 the AI co-host is "Sidekick" (its page,
//! `components/tabs/buddy-tab.tsx`, ⌘9) and the character on stream is "the
//! avatar" (its own page, `components/tabs/avatar-tab.tsx`, ⌘8). Sources:
//! `lib/buddy-tabs.ts`, `lib/avatar-tabs.ts`, `lib/buddy-tab-view.ts`,
//! `lib/buddy-onboarding-copy.ts`, `lib/buddy-library-view.ts`,
//! `lib/buddy-persona-view.ts`, `lib/buddy-create-gate.ts`,
//! `lib/cohost-view.ts` and the `components/buddy-*.tsx` sections. The tests
//! below read those files and hold the words to them.

/// `BUDDY_TAB_LABEL` (`lib/buddy-tabs.ts`): the Sidekick page.
pub const PAGE_TITLE: &str = "Sidekick";

/// The Sidekick strip's accessible name (`PageTabs label`, `buddy-tab.tsx`).
pub const TABS_LABEL: &str = "Sidekick sections";

/// `BUDDY_TABS` (`lib/buddy-tabs.ts`): the ids the store, links and smokes
/// use, and their labels. The first tab is Overview since plan 239 (it was
/// Profile, plan 174 D7); its `live` id stays.
pub const TABS: [(&str, &str); 6] = [
    ("live", "Overview"),
    ("chat", "Chat"),
    ("community", "Community"),
    ("voice", "Voice"),
    ("reports", "Reports"),
    ("clean-cut", "Clean cut"),
];

/// `AVATAR_TAB_LABEL` (`lib/avatar-tabs.ts`): the Avatar page (plan 239).
pub const AVATAR_PAGE_TITLE: &str = "Avatar";

/// The Avatar strip's accessible name (`PageTabs label`, `avatar-tab.tsx`).
pub const AVATAR_TABS_LABEL: &str = "Avatar sections";

/// `AVATAR_TABS` (`lib/avatar-tabs.ts`): the Avatar page's tabs, in strip
/// order. Profile holds My avatars, name and personality, the look,
/// reactions and motion; Greetings what it says when someone arrives.
pub const AVATAR_TABS: [(&str, &str); 2] = [("profile", "Profile"), ("greetings", "Greetings")];

/// `buddyTabLabel`: a tab's label on either page (the two pages' ids never
/// overlap), else the id itself.
pub fn tab_label(id: &str) -> &str {
    TABS.iter()
        .chain(AVATAR_TABS.iter())
        .find(|(tab, _)| *tab == id)
        .map_or(id, |(_, label)| label)
}

// --- Sidekick Live (`lib/buddy-tab-view.ts`) ----------------------------

pub const STATUS_OFF: &str = "Off";
pub const STATUS_ON: &str = "On";
pub const STATUS_LIVE: &str = "Reading chat";
pub const STATUS_ATTENTION: &str = "Needs attention";

/// `BUDDY_LIVE_ON_REASON`: what On means before a stream.
pub const LIVE_ON_REASON: &str = "Joins your next stream";

/// `BUDDY_SIGNED_OUT_REASON`.
pub const SIGNED_OUT_REASON: &str = "Sign in to use Sidekick Live, part of Videorc Premium.";

/// `BUDDY_LIVE_PREMIUM_REASON`: the lock names what it locks (plan 174 F-19).
pub const LIVE_PREMIUM_REASON: &str = "Sidekick Live is part of Videorc Premium.";

/// `BUDDY_CHAT_FREE_NOTE`: the Chat tab's lock adds what stays free; the
/// greetings live on the Avatar page since plan 239, so it names their home.
pub const CHAT_FREE_NOTE: &str = "Greetings are free on Avatar → Greetings.";

/// `BUDDY_CONSENT_OFF_REASON`.
pub const CONSENT_OFF_REASON: &str =
    "Cloud AI isn't allowed, so Sidekick can't read chat or hear you. Allow it under Cloud AI.";

/// `BUDDY_LIVE_LOADING_REASON`.
pub const LIVE_LOADING_REASON: &str = "Loading your Sidekick settings…";

/// The switch beside the status (`BuddyLiveSwitch`, `cohost-status.tsx`).
pub const LIVE_SWITCH_LABEL: &str = "Sidekick Live";

/// `LockAlert`'s actions (`components/lock-alert.tsx`).
pub const SIGN_IN: &str = "Sign in";
pub const VIEW_PREMIUM: &str = "View Premium";

/// The Overview status row's door (`buddy-tab.tsx`).
pub const OPEN_STREAM_MANAGER: &str = "Open Stream Manager";

/// "{name} isn't on stream yet. In Stream Manager, turn on “{name} on
/// stream” to show it." (plan 174 G-2). On the Avatar page's status row
/// since plan 239 (`avatar-tab.tsx`, `AvatarStatus`).
pub fn on_stream_note(name: &str) -> String {
    format!("{name} isn't on stream yet. In Stream Manager, turn on “{name} on stream” to show it.")
}

/// Sidekick Live's details (`BuddyLiveSection`, `buddy-tab.tsx`).
pub const LIVE_SECTION_TITLE: &str = "Sidekick Live";
pub const LIVE_SECTION_BADGE: &str = "Alpha";

/// `BUDDY_POSTS_PROMISE` (`lib/buddy-auto-chat-view.ts`).
pub const POSTS_PROMISE: &str = "Sidekick never posts in your chat on its own.";

/// "Sidekick reads your chat while you stream. Sidekick never posts in your
/// chat on its own."
pub fn live_section_description() -> String {
    format!("Sidekick reads your chat while you stream. {POSTS_PROMISE}")
}

/// `CohostListenField` (`components/cohost-settings-section.tsx`).
pub const LISTEN_LABEL: &str = "Sidekick hears you while you're live";

/// `COHOST_LISTEN_CONSENT_SENTENCE` (`lib/cohost-view.ts`).
pub fn listen_consent_sentence() -> String {
    format!(
        "While you're live, {}, even with live captions off. {}",
        "your microphone audio goes to Videorc's cloud speech-to-text and comes back as text",
        "Videorc servers don't keep it. The transcript is saved with your recording on this computer."
    )
}

/// `BuddyLivePowers`'s title (`buddy-tab.tsx`).
pub const POWERS_TITLE: &str = "What Sidekick does";

/// `BUDDY_LIVE_POWERS`: each row names the tab that holds its settings.
pub const POWERS: [(&str, &str, &str); 4] = [
    (
        "Never miss a question",
        "Questions from every platform, grouped, each with a drafted reply you approve. Answer out loud and Sidekick clears it.",
        "chat",
    ),
    (
        "Chat stays safe",
        "Spam, scams and abuse are flagged against your own rules. Sidekick removes a comment only when you tell it to.",
        "chat",
    ),
    (
        "The room, handled",
        "Sidekick points out first-timers, reminds you of your promises, nudges you in dead air, tells you when viewers say your audio broke, and can put the comment you're talking about on screen.",
        "chat",
    ),
    (
        "Talk to Sidekick",
        "Ask Sidekick to put a comment on stream, take it down, or remove it from chat.",
        "voice",
    ),
];

/// "Open Chat settings for Never miss a question" (`buddy-tab.tsx`).
pub fn power_button_label(tab_label: &str, title: &str) -> String {
    format!("Open {tab_label} settings for {title}")
}

/// `CloudAiSection` (`buddy-tab.tsx`).
pub const CLOUD_AI_TITLE: &str = "Cloud AI";
pub const CLOUD_AI_DESCRIPTION: &str =
    "What Sidekick, creating avatars and Clean cut send to Videorc's cloud, and what is kept.";

/// `ALLOW_CLOUD_AI_LABEL` (`components/cloud-ai-consent-dialog.tsx`).
pub const ALLOW_CLOUD_AI: &str = "Allow cloud AI";

// --- The consent (`components/buddy-consent-dialog.tsx`) ----------------

pub const CONSENT_TITLE: &str = "Turn on Sidekick Live?";
pub const CONSENT_DESCRIPTION: &str = "Sidekick uses Videorc's cloud AI while you're live.";
pub const CONSENT_DECLINE: &str = "Not now";
pub const CONSENT_ACCEPT: &str = "Allow and turn on";
/// A failed turn-on after the consent offers it again (`buddy-tab.tsx`).
pub const RETRY: &str = "Retry";

// --- My avatars (`BUDDY_LIBRARY_COPY`, `lib/buddy-onboarding-copy.ts`) ---
// On the Avatar page's Profile tab since plan 239.

pub const LIBRARY_TITLE: &str = "My avatars";
pub const LIBRARY_OFFICIAL: &str = "Official";
pub const LIBRARY_MINE: &str = "Made by you";
pub const LIBRARY_ACTIVE: &str = "Active";
pub const LIBRARY_USE: &str = "Use";
pub const LIBRARY_RENAME: &str = "Rename";
pub const LIBRARY_EDIT_PERSONALITY: &str = "Edit personality";
pub const LIBRARY_DELETE: &str = "Delete";
pub const LIBRARY_MAKE_ALIVE: &str = "Make it Alive";
pub const LIBRARY_NEW_BUDDY: &str = "New avatar…";
pub const LIBRARY_EMPTY_MINE: &str =
    "Avatars you create show up here, on videorc.com and in the app.";
pub const LIBRARY_DELETE_BODY: &str = "Its pictures are removed from your Videorc account.";
pub const LIBRARY_CANCEL: &str = "Cancel";
pub const LIBRARY_SIGNED_OUT: &str = "Sign in to see the avatars you made on videorc.com.";
pub const LIBRARY_INVITATION: &str = "Make this avatar your own, or pick another.";
pub const LIBRARY_INVITATION_ACTION: &str = "Start";
pub const LIBRARY_ALIVE: &str = "Alive";
pub const LIBRARY_SAVE_TO_LIBRARY: &str = "Save to my library";
/// The sync spinner's and the invitation's labels (`buddy-library-section.tsx`).
pub const LIBRARY_SYNCING: &str = "Syncing";
pub const LIBRARY_DISMISS: &str = "Dismiss";

/// `BUDDY_LIBRARY_UNAVAILABLE` (`lib/buddy-library-view.ts`).
pub const LIBRARY_UNAVAILABLE: &str = "The avatar library is not available right now.";

/// "More for Grum" (`buddy-library-section.tsx`).
pub fn library_more_label(name: &str) -> String {
    format!("More for {name}")
}

/// `buddyLibraryDeleteTitle`.
pub fn library_delete_title(name: &str) -> String {
    format!("Delete {name}?")
}

/// `buddyLibraryPickedElsewhere`.
pub fn library_picked_elsewhere(name: &str) -> String {
    format!("{name} was picked on videorc.com.")
}

/// `buddyLibraryLocalOnly`.
pub fn library_local_only(name: &str) -> String {
    format!("{name} is only on this computer.")
}

/// `buddyLibraryAliveDownloading`.
pub fn library_alive_downloading(name: &str) -> String {
    format!("Downloading {name}'s moves.")
}

/// `buddyLibraryAliveUploading`.
pub fn library_alive_uploading(name: &str) -> String {
    format!("Saving {name}'s moves to your library.")
}

/// `buddyLibraryImporting`.
pub fn library_importing(name: &str) -> String {
    format!("Saving {name} to your library.")
}

/// `buddyLibraryFullLine`.
pub fn library_full_line(limit: u32) -> String {
    format!("Your library is full ({limit} avatars). Delete one to make room.")
}

/// `buddyOnboardingCounter`: "12/600".
pub fn counter(count: usize, max: usize) -> String {
    format!("{count}/{max}")
}

/// The edit dialog's words (`BUDDY_ONBOARDING_STEP3`). The name's
/// placeholder is `DEFAULT_AVATAR_NAME` (`shared/avatar-name.ts`).
pub const NAME_LABEL: &str = "Name";
pub const NAME_PLACEHOLDER: &str = super::DEFAULT_AVATAR_NAME;
pub const NAME_HELP: &str = "1 to 24 characters.";
pub const PERSONALITY_LABEL: &str = "Personality";
pub const PERSONALITY_PLACEHOLDER: &str = "Grumpy but kind. Calls viewers pebbles.";
pub const ABOUT_LABEL: &str = "About you (optional)";
pub const ABOUT_PLACEHOLDER: &str =
    "I stream indie games on Tuesdays and Fridays at 8 pm. My shop is at example.com/shop.";
pub const ABOUT_HELP: &str = "Sidekick answers viewers' questions from this.";
/// The edit dialog's and delete confirm's buttons (`buddy-library-section.tsx`).
pub const SAVE: &str = "Save";
pub const SAVING: &str = "Saving…";
pub const DELETING: &str = "Deleting…";

// --- Name and personality (`buddy-persona-section.tsx`) ------------------
// On the Avatar page's Profile tab since plan 239.

pub const PERSONA_TITLE: &str = "Name and personality";
pub const PERSONA_DESCRIPTION: &str = "Name it, give it a personality and tell it about you. With Sidekick, it answers viewers who ask it by name; Stream Manager runs it while you're live.";
pub const START_OVER: &str = "Start over";
pub const START_OVER_TITLE: &str = "Start over with a new avatar?";

/// "Keep Grum".
pub fn start_over_keep(name: &str) -> String {
    format!("Keep {name}")
}

/// The Start over confirm's body.
pub fn start_over_description(name: &str) -> String {
    format!(
        "{name}'s name, personality, pictures and moves are deleted from this computer. Your greetings and chat settings stay."
    )
}

/// `BUDDY_NAME_REQUIRED` (`lib/buddy-persona-view.ts`).
pub const NAME_REQUIRED: &str = "It needs a name.";

/// "Who Grum is. Its answers and remarks are written in this voice."
pub fn personality_description(name: &str) -> String {
    format!("Who {name} is. Its answers and remarks are written in this voice.")
}

pub const PERSONALITY_FIELD_PLACEHOLDER: &str = "Grumpy, loyal, loves bad puns…";

/// `BUDDY_PERSONALITY_EXAMPLES` (`lib/buddy-persona-view.ts`).
pub const PERSONALITY_EXAMPLES: [&str; 3] = [
    "Grumpy old orc who secretly loves chat",
    "Cheerful goblin merchant",
    "Deadpan stone golem",
];

pub const UNSAVED: &str = "Unsaved. Click away to save.";
pub const ABOUT_FIELD_LABEL: &str = "About you";

pub const BUBBLE_LABEL: &str = "Bubble";

/// "How Grum talks on stream: no voice, a comic bubble above it."
pub fn bubble_description(name: &str) -> String {
    format!("How {name} talks on stream: no voice, a comic bubble above it.")
}

/// The zoom's description.
pub fn bubble_zoom_description(name: &str) -> String {
    format!("How {name} talks on stream, drawn the way your stream gets it.")
}

pub const BUBBLE_ZOOM: &str = "Zoom in on the bubble";
pub const BUBBLE_ZOOM_HINT: &str = "Zoom in";
pub const BUBBLE_STYLE_LABEL: &str = "Bubble style";

/// `BUDDY_BUBBLE_LABELS`, in `BUDDY_BUBBLE_STYLES` order (`lib/buddy-persona-view.ts`).
pub const BUBBLE_STYLES: [(&str, &str); 3] = [
    ("speech", "Speech"),
    ("thought", "Thought"),
    ("shout", "Shout"),
];

/// The bubble sample's line (`components/buddy-bubble-sample.tsx`).
pub fn bubble_sample_line(name: &str) -> String {
    format!("Welcome to the horde, {name} says hi.")
}

/// The example chips' ask (`BuddyExampleChips`, `buddy-example-chips.tsx`).
pub fn replace_title(what: &str) -> String {
    format!("Replace your {what}?")
}

pub fn replace_description(example: &str) -> String {
    format!("What you wrote is replaced with \"{example}\".")
}

pub const REPLACE_KEEP: &str = "Keep mine";
pub const REPLACE_CONFIRM: &str = "Replace";

// --- Look, Reactions, Motion (`buddy-pet-settings.tsx`) -----------------
// On the Avatar page's Profile tab since plan 239.

/// The Look section's title and its Still/Alive control's accessible name
/// (`buddy-avatar-section.tsx`; the section was "Avatar" before plan 239).
pub const LOOK_TITLE: &str = "Look";
pub const LOOK_LABEL: &str = "Look";

/// The Look section's description (`buddy-avatar-section.tsx`).
pub fn look_description(name: &str) -> String {
    format!(
        "How {name} looks on stream and here. Still is your four pictures. Alive moves: it looks around and reacts. Importing moves is free; creating them is part of Videorc Premium."
    )
}

/// `BUDDY_AVATAR_KIND_LABELS` (`lib/buddy-pet-view.ts`).
pub const AVATAR_STILL: &str = "Still";
pub const AVATAR_ALIVE: &str = "Alive";

pub fn look_working(name: &str) -> String {
    format!("A new look for {name} is being drawn under Still.")
}

pub fn look_waiting(name: &str) -> String {
    format!("A new look for {name} is waiting under Still.")
}

pub const SWITCH_TO_STILL: &str = "Switch to Still";

pub const CURRENT_LOOK: &str = "Current look";
pub const DEFAULT_LOOK_DESCRIPTION: &str = "The default avatar until you create your own.";

pub fn own_look_description(name: &str) -> String {
    format!("What {name} wears on stream.")
}

/// `BUDDY_ONBOARDING_STEP4.poseLabels`, in `COHOST_AVATAR_STATES` order.
pub const POSE_LABELS: [(&str, &str); 4] = [
    ("idle", "Idle"),
    ("talk", "Talk"),
    ("laugh", "Laugh"),
    ("think", "Think"),
];

pub const POSE_DEFAULT: &str = "Default";
pub const POSE_USES_IDLE: &str = "Uses idle";
pub const MAKE_IT_ALIVE_HINT: &str = "The same character, moving: it looks around and reacts.";

pub const MOVES_LABEL: &str = "Your moves";
pub const MOVES_GROUP: &str = "Moves";
pub const MOVES_LOADING: &str = "Loading your moves…";
pub const MOVES_LIST_FAILED: &str = "Couldn't list your moves";
pub const MOVES_EMPTY: &str =
    "No moves yet. Import them from a page-pet folder, or create them from a picture.";
pub const MOVES_WEARING: &str = "Wearing";
pub const CREATE: &str = "Create";
pub const IMPORT_MOVES: &str = "Import moves…";
pub const IMPORTING: &str = "Importing…";
pub const REMOVE: &str = "Remove";
pub const IMPORT_FAILED: &str = "Couldn't import those moves";

/// "Remove Grum's moves?"
pub fn remove_pack_title(name: Option<&str>) -> String {
    format!("Remove {}?", name.unwrap_or("these moves"))
}

pub const REMOVE_KEEP: &str = "Keep it";

/// The pack Remove confirm's body.
pub fn remove_pack_description(
    in_account: bool,
    made_in_videorc: bool,
    worn_by: Option<&str>,
) -> String {
    let mut text = if in_account {
        "Its files are deleted from this computer and from your Videorc library, so no other computer gets them.".to_string()
    } else {
        "Its files are deleted from this computer.".to_string()
    };
    text.push_str(if made_in_videorc {
        " Making it again uses one of your creations."
    } else {
        " You can import it again from its folder."
    });
    if let Some(name) = worn_by {
        text.push_str(&format!(" {name} goes back to Still."));
    }
    text
}

pub const REACTIONS_TITLE: &str = "Reactions";

pub fn reactions_description(name: &str) -> String {
    format!("What {name} does on stream when something happens. Try plays it here.")
}

pub const TRY: &str = "Try";

pub const MOTION_TITLE: &str = "Motion";

pub fn motion_description(name: &str) -> String {
    format!("How {name} moves on stream and here. Off keeps its poses and drops the bounce.")
}

pub const MOTION_LABEL: &str = "Motion";
pub const SLEEP_LABEL: &str = "Sleep after";
pub const SLEEP_DESCRIPTION: &str =
    "With no chat, activity or lines for this long. Anything wakes it.";
pub const BREATHING_LABEL: &str = "Breathing";
pub const BREATHING_DESCRIPTION: &str = "A slow breath between events, so it never looks frozen.";

/// The Alive creator's gate (`lib/buddy-create-gate.ts`).
pub const ALIVE_SIGNED_OUT: &str = "Sign in to create an Alive avatar.";
pub const ALIVE_PREMIUM: &str = "Creating an Alive avatar is part of Videorc Premium.";
pub const ALIVE_CONSENT_OFF: &str = "Allow cloud AI to create an Alive avatar.";
pub const ALIVE_NONE_LEFT: &str = "This month's creations are used up.";
/// `BUDDY_GENERATE_NOT_AVAILABLE` (`lib/buddy-persona-view.ts`).
pub const GENERATE_NOT_AVAILABLE: &str = "Creating isn't available right now.";

#[cfg(test)]
mod tests {
    use super::*;

    const ELECTRON_BUDDY_TABS: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-tabs.ts");
    const ELECTRON_AVATAR_TABS: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/avatar-tabs.ts");
    const ELECTRON_TAB_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-tab-view.ts");
    const ELECTRON_AUTO_CHAT_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts");
    const ELECTRON_COHOST_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/cohost-view.ts");
    const ELECTRON_ONBOARDING_COPY: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-onboarding-copy.ts");
    const ELECTRON_LIBRARY_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-library-view.ts");
    const ELECTRON_PERSONA_VIEW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-persona-view.ts");
    const ELECTRON_CREATE_GATE: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-create-gate.ts");
    const ELECTRON_AVATAR_NAME: &str =
        include_str!("../../../../apps/desktop/src/shared/avatar-name.ts");
    const ELECTRON_BUDDY_TAB: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/tabs/buddy-tab.tsx");
    const ELECTRON_AVATAR_TAB: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/tabs/avatar-tab.tsx");
    const ELECTRON_CONSENT_DIALOG: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/buddy-consent-dialog.tsx"
    );
    const ELECTRON_SETTINGS_SECTION: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/cohost-settings-section.tsx"
    );
    const ELECTRON_COHOST_STATUS: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/cohost-status.tsx");
    const ELECTRON_PERSONA_SECTION: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/buddy-persona-section.tsx"
    );
    const ELECTRON_AVATAR_SECTION: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/buddy-avatar-section.tsx"
    );
    const ELECTRON_LOOK_SECTION: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/buddy-look-section.tsx");
    const ELECTRON_MOTION_SECTION: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/buddy-motion-section.tsx"
    );
    const ELECTRON_LIBRARY_SECTION: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/buddy-library-section.tsx"
    );

    /// The source as a reader sees it: JSX entities decoded and every run of
    /// whitespace (a JSX line break and its indent) one space.
    fn shown(source: &str) -> String {
        source
            .replace("&apos;", "'")
            .replace("&ldquo;", "“")
            .replace("&rdquo;", "”")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[track_caller]
    fn in_electron(source: &str, text: &str) {
        assert!(
            shown(source).contains(&shown(text)),
            "not in Electron's source: {text:?}"
        );
    }

    #[test]
    fn the_tabs_are_electrons_and_overview_leads() {
        assert_eq!(TABS[0], ("live", "Overview"));
        assert_eq!(tab_label("clean-cut"), "Clean cut");
        assert_eq!(tab_label("greetings"), "Greetings");
        assert_eq!(tab_label("nope"), "nope");
        let source = shown(ELECTRON_BUDDY_TABS);
        let mut at = 0;
        for (id, label) in TABS {
            let entry = format!("{{ id: '{id}', label: '{label}' }}");
            let found = source[at..]
                .find(&entry)
                .unwrap_or_else(|| panic!("{entry} is not next in BUDDY_TABS"));
            at += found + entry.len();
        }
        assert_eq!(source.matches("{ id: '").count(), TABS.len());
        in_electron(
            ELECTRON_BUDDY_TABS,
            &format!("BUDDY_TAB_LABEL = '{PAGE_TITLE}'"),
        );
        in_electron(ELECTRON_BUDDY_TAB, &format!("label=\"{TABS_LABEL}\""));

        let source = shown(ELECTRON_AVATAR_TABS);
        let mut at = 0;
        for (id, label) in AVATAR_TABS {
            let entry = format!("{{ id: '{id}', label: '{label}' }}");
            let found = source[at..]
                .find(&entry)
                .unwrap_or_else(|| panic!("{entry} is not next in AVATAR_TABS"));
            at += found + entry.len();
        }
        assert_eq!(source.matches("{ id: '").count(), AVATAR_TABS.len());
        in_electron(
            ELECTRON_AVATAR_TABS,
            &format!("AVATAR_TAB_LABEL = '{AVATAR_PAGE_TITLE}'"),
        );
        in_electron(
            ELECTRON_AVATAR_TAB,
            &format!("label=\"{AVATAR_TABS_LABEL}\""),
        );
    }

    #[test]
    fn sidekick_live_words_are_electrons() {
        for text in [
            STATUS_OFF,
            STATUS_LIVE,
            STATUS_ATTENTION,
            LIVE_ON_REASON,
            SIGNED_OUT_REASON,
            LIVE_PREMIUM_REASON,
            CHAT_FREE_NOTE,
            CONSENT_OFF_REASON,
            LIVE_LOADING_REASON,
        ] {
            in_electron(ELECTRON_TAB_VIEW, text);
        }
        for (title, description, tab) in POWERS {
            in_electron(ELECTRON_TAB_VIEW, title);
            in_electron(ELECTRON_TAB_VIEW, description);
            in_electron(ELECTRON_TAB_VIEW, &format!("tab: '{tab}'"));
        }
        in_electron(ELECTRON_AUTO_CHAT_VIEW, POSTS_PROMISE);
        in_electron(ELECTRON_BUDDY_TAB, LIVE_SECTION_TITLE);
        in_electron(ELECTRON_BUDDY_TAB, POWERS_TITLE);
        in_electron(ELECTRON_BUDDY_TAB, CLOUD_AI_DESCRIPTION);
        in_electron(ELECTRON_BUDDY_TAB, OPEN_STREAM_MANAGER);
        in_electron(
            ELECTRON_BUDDY_TAB,
            "Sidekick reads your chat while you stream. ${BUDDY_POSTS_PROMISE}",
        );
        in_electron(
            ELECTRON_BUDDY_TAB,
            &power_button_label("${label}", "${power.title}"),
        );
        in_electron(ELECTRON_COHOST_STATUS, LIVE_SWITCH_LABEL);
        in_electron(ELECTRON_SETTINGS_SECTION, LISTEN_LABEL);
        in_electron(
            ELECTRON_COHOST_VIEW,
            "While you're live, ${MIC_TO_TEXT}, even with live captions off. ${MIC_KEPT}",
        );
        for text in [
            CONSENT_TITLE,
            CONSENT_DESCRIPTION,
            CONSENT_DECLINE,
            CONSENT_ACCEPT,
        ] {
            in_electron(ELECTRON_CONSENT_DIALOG, text);
        }
    }

    #[test]
    fn the_avatar_pages_words_are_electrons() {
        in_electron(ELECTRON_AVATAR_TAB, &on_stream_note("{name}"));
        for text in [
            LIBRARY_TITLE,
            LIBRARY_NEW_BUDDY,
            LIBRARY_EMPTY_MINE,
            LIBRARY_SIGNED_OUT,
            LIBRARY_INVITATION,
            ABOUT_HELP,
            ALIVE_SIGNED_OUT,
        ] {
            in_electron(
                &format!("{ELECTRON_ONBOARDING_COPY}{ELECTRON_CREATE_GATE}{ELECTRON_LIBRARY_VIEW}"),
                text,
            );
        }
        in_electron(
            ELECTRON_ONBOARDING_COPY,
            &library_full_line(0).replace('0', "${limit}"),
        );
        in_electron(
            ELECTRON_AVATAR_NAME,
            &format!("DEFAULT_AVATAR_NAME = '{NAME_PLACEHOLDER}'"),
        );
        in_electron(ELECTRON_LIBRARY_VIEW, LIBRARY_UNAVAILABLE);
        in_electron(
            ELECTRON_LIBRARY_SECTION,
            &library_more_label("${card.name}"),
        );
        in_electron(ELECTRON_CREATE_GATE, ALIVE_PREMIUM);
        in_electron(ELECTRON_CREATE_GATE, ALIVE_CONSENT_OFF);
        in_electron(ELECTRON_PERSONA_VIEW, NAME_REQUIRED);
        in_electron(ELECTRON_PERSONA_VIEW, GENERATE_NOT_AVAILABLE);
        for (_, label) in BUBBLE_STYLES {
            in_electron(ELECTRON_PERSONA_VIEW, label);
        }
        for text in [
            PERSONA_DESCRIPTION,
            START_OVER_TITLE,
            PERSONALITY_FIELD_PLACEHOLDER,
            UNSAVED,
        ] {
            in_electron(ELECTRON_PERSONA_SECTION, text);
        }
        in_electron(
            ELECTRON_PERSONA_SECTION,
            &start_over_keep("${persona.name}"),
        );
        in_electron(
            ELECTRON_PERSONA_SECTION,
            &start_over_description("${persona.name}"),
        );
        in_electron(
            ELECTRON_PERSONA_SECTION,
            &personality_description("{persona.name}"),
        );
        in_electron(
            ELECTRON_PERSONA_SECTION,
            &bubble_description("{persona.name}"),
        );
        in_electron(
            ELECTRON_PERSONA_SECTION,
            &bubble_zoom_description("{persona.name}"),
        );
        in_electron(ELECTRON_AVATAR_SECTION, &format!("title=\"{LOOK_TITLE}\""));
        in_electron(
            ELECTRON_AVATAR_SECTION,
            &format!("aria-label=\"{LOOK_LABEL}\""),
        );
        in_electron(
            ELECTRON_AVATAR_SECTION,
            &look_description("${buddyDisplayName(persona.name)}"),
        );
        in_electron(ELECTRON_AVATAR_SECTION, &look_working("${persona.name}"));
        in_electron(ELECTRON_AVATAR_SECTION, MOVES_EMPTY);
        in_electron(ELECTRON_AVATAR_SECTION, MOVES_LIST_FAILED);
        in_electron(ELECTRON_LOOK_SECTION, DEFAULT_LOOK_DESCRIPTION);
        in_electron(ELECTRON_LOOK_SECTION, MAKE_IT_ALIVE_HINT);
        in_electron(
            ELECTRON_MOTION_SECTION,
            &motion_description("${persona.name}"),
        );
        in_electron(ELECTRON_MOTION_SECTION, SLEEP_DESCRIPTION);
        in_electron(ELECTRON_MOTION_SECTION, BREATHING_DESCRIPTION);
    }

    #[test]
    fn the_sentences_name_sidekick_and_the_avatar() {
        assert_eq!(
            on_stream_note("Flint"),
            "Flint isn't on stream yet. In Stream Manager, turn on “Flint on stream” to show it."
        );
        assert_eq!(
            live_section_description(),
            "Sidekick reads your chat while you stream. Sidekick never posts in your chat on its own."
        );
        assert_eq!(
            remove_pack_description(true, true, Some("Grum")),
            "Its files are deleted from this computer and from your Videorc library, so no other computer gets them. Making it again uses one of your creations. Grum goes back to Still."
        );
        assert_eq!(counter(12, 600), "12/600");
    }
}
