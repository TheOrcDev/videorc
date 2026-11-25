//! Buddy → Chat (plan 220 S3.10b): Greetings, Replies and Moderation
//! (`buddy-greetings-section.tsx`, `cohost-settings-section.tsx`, the
//! greetings half of `lib/buddy-auto-chat-view.ts`). Pure: every edit is
//! one settings patch the Studio saves (`Studio::patch_cohost_settings`).
//!
//! Features work with their defaults: every greeting kind has a built-in
//! line until the streamer writes their own, and an empty list never means
//! silence (`resolveGreetingLine`).

use serde_json::{Value, json};
use videorc_protocol::cohost::{
    CohostActivityTemplateKind as Kind, CohostAutoChat, CohostGreetingPlatform as Platform,
    CohostGreetingTemplate, CohostGreetingsSettings, CohostUtteranceState, WelcomeLine,
};

use crate::stream_manager::send::platform_max_chars;

/// `BUDDY_TEMPLATE_TEXT_MAX_CHARS` and `BUDDY_TEMPLATES_MAX`.
pub const TEMPLATE_TEXT_MAX_CHARS: usize = 200;
pub const TEMPLATES_MAX: usize = 60;
/// `COHOST_RULES_MAX` and `COHOST_RULE_MAX_CHARS`.
pub const RULES_MAX: usize = 10;
pub const RULE_MAX_CHARS: usize = 120;

/// `COHOST_ACTIVITY_TEMPLATE_KINDS`, in the order Activity lists them.
pub const ACTIVITY_KINDS: [Kind; 14] = [
    Kind::Follow,
    Kind::Sub,
    Kind::Resub,
    Kind::SubGift,
    Kind::CommunitySubGift,
    Kind::Membership,
    Kind::Cheer,
    Kind::Kicks,
    Kind::SuperChat,
    Kind::SuperSticker,
    Kind::Raid,
    Kind::WatchStreak,
    Kind::PowerUp,
    Kind::Redemption,
];

/// A greeting kind: an Activity kind or one of the five welcomes
/// (`CohostWelcomeKind`: first-time, returning, and plan 225 D9's regular,
/// comeback and milestone arrivals).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GreetingKind {
    FirstTime,
    Returning,
    Regular,
    Comeback,
    Milestone,
    Activity(Kind),
}

impl GreetingKind {
    /// A welcome (a chat row's arrival), not an Activity kind.
    pub fn is_welcome(self) -> bool {
        !matches!(self, GreetingKind::Activity(_))
    }

    /// `isArrivalWelcomeKind`: the welcomes that carry the arrival fields.
    pub fn is_arrival(self) -> bool {
        matches!(
            self,
            GreetingKind::Regular | GreetingKind::Comeback | GreetingKind::Milestone
        )
    }

    /// The wire id (`first-time`, `returning`, `sub-gift`, …).
    pub fn id(self) -> String {
        match self {
            GreetingKind::FirstTime => "first-time".into(),
            GreetingKind::Returning => "returning".into(),
            GreetingKind::Regular => "regular".into(),
            GreetingKind::Comeback => "comeback".into(),
            GreetingKind::Milestone => "milestone".into(),
            GreetingKind::Activity(kind) => serde_json::to_value(kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default(),
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "first-time" => Some(GreetingKind::FirstTime),
            "returning" => Some(GreetingKind::Returning),
            "regular" => Some(GreetingKind::Regular),
            "comeback" => Some(GreetingKind::Comeback),
            "milestone" => Some(GreetingKind::Milestone),
            other => serde_json::from_value::<Kind>(Value::String(other.into()))
                .ok()
                .map(GreetingKind::Activity),
        }
    }
}

/// `BUDDY_TEMPLATE_KIND_TITLES`.
pub fn kind_title(kind: Kind) -> &'static str {
    match kind {
        Kind::Follow => "Follow",
        Kind::Sub => "Sub",
        Kind::Resub => "Resub",
        Kind::SubGift => "Gifted sub",
        Kind::CommunitySubGift => "Community gift",
        Kind::Membership => "Membership",
        Kind::Cheer => "Cheer",
        Kind::Kicks => "KICKs",
        Kind::SuperChat => "Super Chat",
        Kind::SuperSticker => "Super Sticker",
        Kind::Raid => "Raid",
        Kind::WatchStreak => "Watch streak",
        Kind::PowerUp => "Power-up",
        Kind::Redemption => "Redemption",
    }
}

/// `BUDDY_WELCOME_TITLES` and the kind titles together.
pub fn title(kind: GreetingKind) -> &'static str {
    match kind {
        GreetingKind::FirstTime => "First-time chatters",
        GreetingKind::Returning => "Returning chatters",
        GreetingKind::Regular => "Regulars",
        GreetingKind::Comeback => "Back after a while",
        GreetingKind::Milestone => "Milestones",
        GreetingKind::Activity(kind) => kind_title(kind),
    }
}

/// `BUDDY_TEMPLATE_KIND_PLATFORMS`.
pub fn kind_platforms(kind: GreetingKind) -> &'static [Platform] {
    use Platform::*;
    match kind {
        GreetingKind::Activity(kind) => match kind {
            Kind::Follow => &[Twitch, Kick, X],
            Kind::Membership | Kind::SuperChat | Kind::SuperSticker => &[Youtube],
            Kind::Kicks => &[Kick],
            _ => &[Twitch],
        },
        _ => &[Twitch, Youtube, Kick, X],
    }
}

/// `BUDDY_GREETING_PLATFORM_LABELS`.
pub fn platform_label(platform: Platform) -> &'static str {
    match platform {
        Platform::Twitch => "Twitch",
        Platform::Youtube => "YouTube",
        Platform::Kick => "Kick",
        Platform::X => "X",
    }
}

pub fn platform_id(platform: Platform) -> &'static str {
    match platform {
        Platform::Twitch => "twitch",
        Platform::Youtube => "youtube",
        Platform::Kick => "kick",
        Platform::X => "x",
    }
}

/// `BUDDY_BUILTIN_GREETINGS`: every kind's line until you write your own.
pub fn builtin(kind: GreetingKind) -> (&'static str, CohostUtteranceState) {
    use CohostUtteranceState::{Laugh, Talk};
    match kind {
        GreetingKind::FirstTime => ("Hi {name}, welcome to the stream!", Talk),
        GreetingKind::Returning => ("Welcome back, {name}!", Talk),
        GreetingKind::Regular => ("Welcome back, {name}!", Talk),
        GreetingKind::Comeback => ("Look who's back! Good to see you, {name}.", Talk),
        GreetingKind::Milestone => ("{name}'s {nth} stream with us! Thank you!", Laugh),
        GreetingKind::Activity(kind) => match kind {
            Kind::Follow => ("Welcome, {name}! Thanks for the follow.", Talk),
            Kind::Sub => ("{name} joined the ranks. Thank you!", Laugh),
            Kind::Resub => ("{name} is back in the ranks. Thank you!", Laugh),
            Kind::SubGift => ("Thanks for the gift sub, {name}!", Laugh),
            Kind::CommunitySubGift => ("{name} gifted subs to the chat. Thank you!", Laugh),
            Kind::Membership => ("Welcome to the members, {name}!", Laugh),
            Kind::Cheer => ("Thanks for the bits, {name}!", Talk),
            Kind::Kicks => ("Thanks for the Kicks, {name}!", Talk),
            Kind::SuperChat => ("Thanks for the Super Chat, {name}!", Talk),
            Kind::SuperSticker => ("Thanks for the Super Sticker, {name}!", Talk),
            Kind::Raid => ("{name} is raiding! Welcome, everyone!", Laugh),
            Kind::WatchStreak => ("{name}, thanks for the watch streak!", Talk),
            Kind::PowerUp => ("Thanks for the power-up, {name}!", Talk),
            Kind::Redemption => ("Thanks for redeeming, {name}!", Talk),
        },
    }
}

/// `BUDDY_TEMPLATE_FIELDS`: (field, hint), in the order the Fields popover
/// lists them.
pub const TEMPLATE_FIELDS: [(&str, &str); 15] = [
    ("name", "Display name"),
    ("handle", "@login where the platform has one"),
    ("platform", "Twitch, YouTube, Kick or X"),
    ("months", "Months subscribed"),
    ("streak", "Streams in a row"),
    ("count", "Gifts, bits, raid viewers"),
    ("amount", "Money, bits, KICKs or points"),
    ("reward", "Reward or Power-up title"),
    ("names", "Everyone in a burst"),
    ("others", "How many more in a burst"),
    // Plan 225 D9: what an arrival knows about the person.
    ("nth", "Their stream count, as \"10th\""),
    ("streams", "Streams chatted in"),
    ("row", "Streams in a row"),
    ("away", "How long they were away, as \"3 weeks\""),
    ("since", "Their first chat, as \"March 2026\""),
];

/// `BUDDY_WELCOME_FIELDS` and `BUDDY_ARRIVAL_FIELDS`: a first-time or
/// returning welcome takes the chatter's own three, an arrival adds what the
/// community store knows about the person, and an Activity line takes them
/// all.
pub fn fields_for(kind: GreetingKind) -> Vec<(&'static str, &'static str)> {
    let only = |fields: &[&str]| -> Vec<(&'static str, &'static str)> {
        TEMPLATE_FIELDS
            .iter()
            .copied()
            .filter(|(field, _)| fields.contains(field))
            .collect()
    };
    match kind {
        GreetingKind::Activity(_) => TEMPLATE_FIELDS.to_vec(),
        kind if kind.is_arrival() => only(&[
            "name", "handle", "platform", "nth", "streams", "row", "away", "since",
        ]),
        _ => only(&["name", "handle", "platform"]),
    }
}

/// `BUDDY_SAMPLE_FIELDS`: name, handle, platform, months, streak, count,
/// amount, reward, and an arrival's facts.
struct Sample {
    name: &'static str,
    handle: &'static str,
    platform: &'static str,
    months: Option<u32>,
    streak: Option<u32>,
    count: Option<u32>,
    amount: Option<&'static str>,
    reward: Option<&'static str>,
    nth: Option<&'static str>,
    streams: Option<u32>,
    row: Option<u32>,
    away: Option<&'static str>,
    since: Option<&'static str>,
}

fn sample(kind: GreetingKind) -> Sample {
    let base = |name: &'static str, handle: &'static str, platform: &'static str| Sample {
        name,
        handle,
        platform,
        months: None,
        streak: None,
        count: None,
        amount: None,
        reward: None,
        nth: None,
        streams: None,
        row: None,
        away: None,
        since: None,
    };
    match kind {
        GreetingKind::FirstTime => base("first_timer", "@first_timer", "Twitch"),
        GreetingKind::Returning => base("regular", "@regular", "YouTube"),
        GreetingKind::Regular => Sample {
            nth: Some("14th"),
            streams: Some(14),
            row: Some(5),
            since: Some("March 2026"),
            ..base("Ada", "@ada", "Twitch")
        },
        GreetingKind::Comeback => Sample {
            nth: Some("7th"),
            streams: Some(7),
            row: Some(1),
            away: Some("3 weeks"),
            since: Some("May 2026"),
            ..base("Bo", "@bo", "Kick")
        },
        GreetingKind::Milestone => Sample {
            nth: Some("10th"),
            streams: Some(10),
            row: Some(3),
            since: Some("February 2026"),
            ..base("Kim", "@kim", "Twitch")
        },
        GreetingKind::Activity(kind) => match kind {
            Kind::Follow => base("new_friend", "@new_friend", "Twitch"),
            Kind::Sub => base("morgaesis", "morgaesis", "Twitch"),
            Kind::Resub => Sample {
                months: Some(8),
                ..base("morgaesis", "morgaesis", "Twitch")
            },
            Kind::SubGift => Sample {
                count: Some(1),
                ..base("generous", "generous", "Twitch")
            },
            Kind::CommunitySubGift => Sample {
                count: Some(5),
                ..base("generous", "generous", "Twitch")
            },
            Kind::Membership => base("Newbie", "Newbie", "YouTube"),
            Kind::Cheer => Sample {
                count: Some(1500),
                amount: Some("1,500 bits"),
                ..base("sarzdotmd", "sarzdotmd", "Twitch")
            },
            Kind::Kicks => Sample {
                count: Some(500),
                amount: Some("500 KICKs"),
                ..base("kick_tipper", "kick_tipper", "Kick")
            },
            Kind::SuperChat => Sample {
                amount: Some("$5.00"),
                ..base("Maria", "Maria", "YouTube")
            },
            Kind::SuperSticker => Sample {
                amount: Some("€2.00"),
                ..base("Jonas", "Jonas", "YouTube")
            },
            Kind::Raid => Sample {
                count: Some(234),
                ..base("raider42", "raider42", "Twitch")
            },
            Kind::WatchStreak => Sample {
                streak: Some(20),
                ..base("loyal_lurker", "loyal_lurker", "Twitch")
            },
            Kind::PowerUp => Sample {
                count: Some(300),
                amount: Some("300 bits"),
                ..base("party_starter", "party_starter", "Twitch")
            },
            Kind::Redemption => Sample {
                count: Some(500),
                amount: Some("500 Diamonds"),
                reward: Some("Hydrate"),
                ..base("hydration_hero", "hydration_hero", "Twitch")
            },
        },
    }
}

/// `toLocaleString('en-US')` for a count.
fn grouped(value: u32) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn field_value(sample: &Sample, field: &str) -> Option<String> {
    Some(match field {
        "name" | "names" => sample.name.to_string(),
        "handle" => sample.handle.to_string(),
        "platform" => sample.platform.to_string(),
        "months" => sample.months.map(|v| v.to_string()).unwrap_or_default(),
        "streak" => sample.streak.map(|v| v.to_string()).unwrap_or_default(),
        "count" => sample.count.map(grouped).unwrap_or_default(),
        "amount" => sample.amount.unwrap_or_default().to_string(),
        "reward" => sample.reward.unwrap_or_default().to_string(),
        "others" => String::new(),
        "nth" => sample.nth.unwrap_or_default().to_string(),
        "streams" => sample.streams.map(|v| v.to_string()).unwrap_or_default(),
        "row" => sample.row.map(|v| v.to_string()).unwrap_or_default(),
        "away" => sample.away.unwrap_or_default().to_string(),
        "since" => sample.since.unwrap_or_default().to_string(),
        _ => return None,
    })
}

/// `resolveGreetingPreview`: the line with the sample's fields, and the
/// fields it does not know.
pub fn preview(text: &str, kind: GreetingKind) -> (String, Vec<String>) {
    let sample = sample(kind);
    let mut unknown: Vec<String> = Vec::new();
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find(['{', '}']) {
            Some(close) if after.as_bytes()[close] == b'}' => {
                let raw = &after[..close];
                let field = raw.trim();
                match field_value(&sample, field) {
                    Some(value) => out.push_str(&value),
                    None => {
                        if !unknown.iter().any(|known| known == field) {
                            unknown.push(field.to_string());
                        }
                        out.push('{');
                        out.push_str(raw);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    (collapsed, unknown)
}

/// `greetingTemplateWarnings`: too long for a platform's chat (where the
/// line goes to chat), and fields it does not know.
pub fn warnings(
    kind: GreetingKind,
    platform: Option<Platform>,
    text: &str,
    chat_caps: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let (resolved, unknown) = preview(text, kind);
    if chat_caps {
        let platforms: Vec<Platform> = match platform {
            Some(platform) => vec![platform],
            None => kind_platforms(kind).to_vec(),
        };
        let length = resolved.chars().count();
        for platform in platforms {
            let cap = platform_max_chars(platform_id(platform));
            if length > cap {
                out.push(format!(
                    "{} takes {cap} characters; this one is {length}.",
                    platform_label(platform)
                ));
            }
        }
    }
    if !unknown.is_empty() {
        let fields = unknown
            .iter()
            .map(|field| format!("{{{field}}}"))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(if unknown.len() == 1 {
            format!("{fields} isn't a field and stays as written.")
        } else {
            format!("{fields} aren't fields and stay as written.")
        });
    }
    out
}

/// One greeting row as the Chat tab lists it: a template of yours, the
/// built-in line of a kind you have none of, or a welcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GreetingRow {
    /// The template's id, `default:<kind>` or `welcome:<kind>`.
    pub key: String,
    pub kind: GreetingKind,
    pub title: &'static str,
    /// The line as it reads in the row (yours, or the built-in one).
    pub text: String,
    pub default: bool,
    pub enabled: bool,
    pub platform: Option<Platform>,
    pub state: CohostUtteranceState,
    pub warnings: Vec<String>,
}

/// `greetingWelcomes`, in `COHOST_WELCOME_KINDS` order.
pub fn welcomes(greetings: &CohostGreetingsSettings) -> [(GreetingKind, WelcomeLine); 5] {
    let welcomes = &greetings.welcomes;
    [
        (GreetingKind::FirstTime, welcomes.first_time.clone()),
        (GreetingKind::Returning, welcomes.returning.clone()),
        (GreetingKind::Regular, welcomes.regular.clone()),
        (GreetingKind::Comeback, welcomes.comeback.clone()),
        (GreetingKind::Milestone, welcomes.milestone.clone()),
    ]
}

/// The welcomes' rows, in `COHOST_WELCOME_KINDS` order.
pub fn welcome_rows(greetings: &CohostGreetingsSettings, chat_caps: bool) -> Vec<GreetingRow> {
    welcomes(greetings)
        .into_iter()
        .map(|(kind, welcome)| {
            let (builtin_text, builtin_state) = builtin(kind);
            let own = welcome
                .text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            let text = own.unwrap_or(builtin_text).to_string();
            GreetingRow {
                key: format!("welcome:{}", kind.id()),
                kind,
                title: title(kind),
                warnings: warnings(kind, None, &text, chat_caps),
                text,
                default: own.is_none(),
                enabled: welcome.enabled,
                platform: None,
                state: if own.is_some() {
                    welcome.state
                } else {
                    builtin_state
                },
            }
        })
        .collect()
}

/// Activity's rows: per kind in order, your lines for it, or its built-in
/// line as a Default row.
pub fn activity_rows(greetings: &CohostGreetingsSettings, chat_caps: bool) -> Vec<GreetingRow> {
    let mut rows = Vec::new();
    for kind in ACTIVITY_KINDS {
        let of_kind: Vec<&CohostGreetingTemplate> = greetings
            .templates
            .iter()
            .filter(|template| template.kind == kind)
            .collect();
        let greeting = GreetingKind::Activity(kind);
        if of_kind.is_empty() {
            let (text, state) = builtin(greeting);
            rows.push(GreetingRow {
                key: format!("default:{}", greeting.id()),
                kind: greeting,
                title: kind_title(kind),
                warnings: Vec::new(),
                text: text.to_string(),
                default: true,
                enabled: true,
                platform: None,
                state,
            });
            continue;
        }
        for template in of_kind {
            rows.push(GreetingRow {
                key: template.id.clone(),
                kind: greeting,
                title: kind_title(kind),
                warnings: warnings(greeting, template.platform, &template.text, chat_caps),
                text: template.text.clone(),
                default: false,
                enabled: template.enabled,
                platform: template.platform,
                state: template.state,
            });
        }
    }
    rows
}

/// `newGreetingTemplate`: the kind's built-in line, on.
pub fn new_template(kind: Kind, id: String) -> CohostGreetingTemplate {
    let (text, state) = builtin(GreetingKind::Activity(kind));
    CohostGreetingTemplate {
        id,
        kind,
        platform: None,
        text: text.to_string(),
        state,
        enabled: true,
        reaction: None,
    }
}

/// `withWelcomeText`: an empty line falls back to the built-in one.
pub fn with_welcome_text(mut welcome: WelcomeLine, text: &str) -> WelcomeLine {
    let trimmed = text.trim();
    welcome.text = (!trimmed.is_empty()).then(|| trimmed.to_string());
    welcome
}

/// The `autoChat` patch with the greetings replaced.
pub fn auto_chat_patch(auto_chat: &CohostAutoChat, greetings: CohostGreetingsSettings) -> Value {
    let mut next = auto_chat.clone();
    next.greetings = greetings;
    json!({ "autoChat": next })
}

/// "Remove a line first: there can be 60."
pub fn templates_full_line() -> String {
    format!("Remove a line first: there can be {TEMPLATES_MAX}.")
}

/// `AVATAR_TAB_LABEL` (`lib/avatar-tabs.ts`): the Avatar page's name in
/// the lines below.
pub const AVATAR_PAGE: &str = "Avatar";

/// "In Flint's voice. Your line on Avatar → Greetings is the example and
/// the fallback." (`cohost-settings-section.tsx`).
pub fn ai_description(name: &str) -> String {
    format!(
        "In {name}'s voice. Your line on {AVATAR_PAGE} → Greetings is the example and the fallback."
    )
}

/// Replies' description (`cohost-settings-section.tsx`): Sidekick writes,
/// the avatar says it.
pub fn replies_description(name: &str) -> String {
    format!(
        "How Sidekick writes what {name} says. It answers from About you, on the {AVATAR_PAGE} page. In Bubble, {name} says it on stream; in Suggest, you post it."
    )
}

/// `BUDDY_POSTS_PROMISE`, in Moderation's description (the Stream
/// Manager's `POSTS_PROMISE` is the same words).
pub const POSTS_PROMISE: &str = "Sidekick never posts in your chat on its own.";

/// `buddyDisplayName`: the persona's name, or the default avatar's
/// (`DEFAULT_AVATAR_NAME`, Flint).
pub fn display_name(name: Option<&str>) -> String {
    name.map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(super::DEFAULT_AVATAR_NAME)
        .to_string()
}

/// Moderation's description.
pub fn moderation_description() -> String {
    format!("What Sidekick flags for you, and what it may put on stream. {POSTS_PROMISE}")
}

/// The platform picker's first choice (`PLATFORM_ITEMS.any`).
pub const ANY_PLATFORM: &str = "Any";

/// One Fields menu entry: the field as it is typed, and what it holds.
pub fn field_entry(field: &str, hint: &str) -> String {
    format!("{{{field}}}  {hint}")
}

/// One Add a greeting choice: the kind and its platforms.
pub fn add_option_label(kind: Kind) -> String {
    let platforms = kind_platforms(GreetingKind::Activity(kind))
        .iter()
        .map(|platform| platform_label(*platform))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{}  {platforms}", kind_title(kind))
}

/// `cooldownLabel`.
pub fn cooldown_label(seconds: u32) -> String {
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let (minutes, rest) = (seconds / 60, seconds % 60);
    if rest == 0 {
        format!("{minutes} min")
    } else {
        format!("{minutes} min {rest} s")
    }
}

/// `TONE_OPTIONS`: (value, label).
pub const TONES: [(&str, &str); 3] = [
    ("friendly", "Friendly"),
    ("short", "Short"),
    ("professional", "Professional"),
];

/// `COHOST_SHOW_ON_STREAM_MODES`: (label, autoHighlight, voiceHighlight).
pub const SHOW_ON_STREAM: [(&str, bool, bool); 3] = [
    ("Off", false, false),
    ("What I talk about", false, true),
    ("What I talk about and Sidekick's picks", true, true),
];

/// `cohostShowOnStreamMode`.
pub fn show_on_stream_index(auto_highlight: bool, voice_highlight: bool) -> usize {
    if auto_highlight {
        2
    } else if voice_highlight {
        1
    } else {
        0
    }
}

/// `COHOST_SENSITIVITY_LABELS`, in order.
pub const SENSITIVITIES: [(&str, &str); 3] = [
    ("relaxed", "Relaxed"),
    ("balanced", "Balanced"),
    ("strict", "Strict"),
];

/// A rule as saved: trimmed, at most 120 characters.
pub fn rule_to_save(draft: &str) -> Option<String> {
    let rule = draft.trim();
    (!rule.is_empty()).then(|| rule.chars().take(RULE_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sidekick writes, the avatar says it (#1356, #1372): the lines are
    /// Electron's, with its `${…}` where Rust takes a name.
    #[test]
    fn the_chat_lines_are_electrons() {
        const SETTINGS: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/cohost-settings-section.tsx"
        );
        const GREETINGS: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/buddy-greetings-section.tsx"
        );
        const AUTO_CHAT: &str =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts");
        const TABS: &str =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/avatar-tabs.ts");
        let electron = |line: String| {
            line.replace("Flint", "${name}")
                .replace(AVATAR_PAGE, "${AVATAR_TAB_LABEL}")
        };
        assert!(SETTINGS.contains(&electron(replies_description("Flint"))));
        assert!(SETTINGS.contains(&electron(ai_description("Flint"))));
        assert!(SETTINGS.contains(
            "What Sidekick flags for you, and what it may put on stream. ${BUDDY_POSTS_PROMISE}"
        ));
        assert!(SETTINGS.contains("\"What I talk about and Sidekick's picks\""));
        assert!(GREETINGS.contains("Remove a line first: there can be ${BUDDY_TEMPLATES_MAX}."));
        assert!(AUTO_CHAT.contains(&format!("BUDDY_POSTS_PROMISE = '{POSTS_PROMISE}'")));
        assert!(TABS.contains(&format!("AVATAR_TAB_LABEL = '{AVATAR_PAGE}'")));
        assert_eq!(display_name(None), "Flint");
    }

    #[test]
    fn the_page_and_the_pane_say_the_same_words() {
        assert_eq!(POSTS_PROMISE, crate::stream_manager::buddy::POSTS_PROMISE);
        for name in [None, Some(""), Some("  "), Some(" Grum ")] {
            assert_eq!(
                display_name(name),
                crate::stream_manager::buddy::display_name(name)
            );
        }
    }

    #[test]
    fn every_kind_has_a_line_until_you_write_your_own() {
        let greetings = CohostGreetingsSettings::default();
        let rows = activity_rows(&greetings, true);
        assert_eq!(rows.len(), 14);
        assert!(rows.iter().all(|row| row.default && row.enabled));
        assert_eq!(rows[0].text, "Welcome, {name}! Thanks for the follow.");
        let welcomes = welcome_rows(&greetings, true);
        assert_eq!(welcomes[0].title, "First-time chatters");
        assert_eq!(welcomes[0].text, "Hi {name}, welcome to the stream!");
        assert!(welcomes[0].default);
        // Electron's five welcomes, in its order, each on its built-in line
        // and none warning about its own fields.
        let titles: Vec<&str> = welcomes.iter().map(|row| row.title).collect();
        assert_eq!(
            titles,
            [
                "First-time chatters",
                "Returning chatters",
                "Regulars",
                "Back after a while",
                "Milestones"
            ]
        );
        assert!(welcomes.iter().all(|row| row.default && row.enabled));
        assert!(welcomes.iter().all(|row| row.warnings.is_empty()));
        assert_eq!(
            welcomes[4].text,
            "{name}'s {nth} stream with us! Thank you!"
        );
        assert_eq!(welcomes[2].key, "welcome:regular");
    }

    #[test]
    fn an_arrival_offers_what_the_community_knows() {
        let fields = |kind: GreetingKind| -> Vec<&'static str> {
            fields_for(kind)
                .into_iter()
                .map(|(field, _)| field)
                .collect()
        };
        assert_eq!(
            fields(GreetingKind::FirstTime),
            ["name", "handle", "platform"]
        );
        assert_eq!(
            fields(GreetingKind::Milestone),
            [
                "name", "handle", "platform", "nth", "streams", "row", "away", "since"
            ]
        );
        assert_eq!(fields(GreetingKind::Activity(Kind::Follow)).len(), 15);
        assert_eq!(
            preview(
                "{name}'s {nth} stream with us! Thank you!",
                GreetingKind::Milestone
            )
            .0,
            "Kim's 10th stream with us! Thank you!"
        );
        assert_eq!(
            preview("Back after {away}, {name}", GreetingKind::Comeback).0,
            "Back after 3 weeks, Bo"
        );
        assert_eq!(
            GreetingKind::parse("comeback"),
            Some(GreetingKind::Comeback)
        );
        assert!(GreetingKind::Regular.is_welcome() && GreetingKind::Regular.is_arrival());
        assert!(!GreetingKind::Returning.is_arrival());
    }

    #[test]
    fn previews_fill_the_sample_and_name_unknown_fields() {
        let cheer = GreetingKind::Activity(Kind::Cheer);
        assert_eq!(
            preview("Thanks {name} for {amount}!", cheer).0,
            "Thanks sarzdotmd for 1,500 bits!"
        );
        let (text, unknown) = preview("Hi {nmae}  and {nmae}", cheer);
        assert_eq!(text, "Hi {nmae} and {nmae}");
        assert_eq!(unknown, vec!["nmae".to_string()]);
        assert_eq!(
            warnings(cheer, None, "Hi {nmae}", false),
            vec!["{nmae} isn't a field and stays as written.".to_string()]
        );
        let long = "x".repeat(150);
        assert_eq!(
            warnings(
                GreetingKind::Activity(Kind::Follow),
                Some(Platform::X),
                &long,
                true
            ),
            vec!["X takes 140 characters; this one is 150.".to_string()]
        );
    }

    #[test]
    fn labels_read_as_electron_says_them() {
        assert_eq!(cooldown_label(45), "45 s");
        assert_eq!(cooldown_label(120), "2 min");
        assert_eq!(cooldown_label(90), "1 min 30 s");
        assert_eq!(show_on_stream_index(true, false), 2);
        assert_eq!(
            GreetingKind::parse("sub-gift"),
            Some(GreetingKind::Activity(Kind::SubGift))
        );
        assert_eq!(
            GreetingKind::Activity(Kind::CommunitySubGift).id(),
            "community-sub-gift"
        );
        assert_eq!(rule_to_save("  no spoilers "), Some("no spoilers".into()));
        assert_eq!(
            templates_full_line(),
            "Remove a line first: there can be 60."
        );
    }
}
