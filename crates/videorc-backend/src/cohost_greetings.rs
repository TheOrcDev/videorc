//! Greetings (plan 164 S-D1, plan 192): the lines, no model here.
//!
//! An Activity event (a follow, a sub, a cheer, a raid, ...) becomes
//! [`ActivityFacts`]: the greeting kind it answers, the destination it came
//! from and the fields a line may name in braces. A chatter's first message
//! (ever, or this stream) becomes the same facts through [`welcome_facts`]
//! (plan 192 S1.2). [`resolve_line`] picks the user's enabled template for
//! that kind and platform, else the built-in line (D1; a kind the user
//! switched off stays off), [`resolve_template`] fills the braces, and
//! [`collapse`] folds a burst of same-kind events into one `{names}` /
//! `{others}` message (D9). Everything here is pure; the throttle
//! (`cohost_throttle`) decides when, the engine (`cohost`) decides whether,
//! and `live_chat` sends.

use crate::cohost::{
    CohostActivityTemplateKind, CohostGreetingPlatform, CohostGreetingTemplate,
    CohostGreetingsSettings, CohostUtteranceState, WelcomeLine, truncate_utf16,
};
use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, MembershipKind, SubscriptionKind,
    comments_destination_id,
};
use crate::streaming::{StreamPlatform, stream_platform_label};

/// Names listed before "and N others" in a collapsed greeting.
pub(crate) const COLLAPSE_NAMED_MAX: usize = 3;

/// The longest first message a welcome carries to the AI (plan 192, the
/// greet route's `firstMessageText` cap).
pub(crate) const FIRST_MESSAGE_TEXT_MAX_UNITS: usize = 200;

/// Chat bots that never get a welcome (plan 192 S1.2), matched on the
/// lowercased name.
pub(crate) const KNOWN_BOTS: [&str; 9] = [
    "nightbot",
    "streamelements",
    "streamlabs",
    "moobot",
    "fossabot",
    "sery_bot",
    "wizebot",
    "botrixoficial",
    "kickbot",
];

/// Every kind a greeting answers (plan 192): the Activity kinds a template
/// may be written for, plus the two welcomes, which live in
/// `greetings.welcomes` and never in `templates[]` (S1.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum GreetingKind {
    Activity(CohostActivityTemplateKind),
    /// The author's first message in the channel.
    FirstTime,
    /// The author's first message this stream, having chatted on an
    /// earlier one.
    Returning,
}

impl GreetingKind {
    /// Every kind, in the order of the shared fixture
    /// (`protocol-fixtures/buddy-builtin-greetings.json`); the fixture test
    /// walks it.
    #[cfg(test)]
    pub(crate) const ALL: [GreetingKind; 16] = {
        use CohostActivityTemplateKind as K;
        [
            GreetingKind::FirstTime,
            GreetingKind::Returning,
            GreetingKind::Activity(K::Follow),
            GreetingKind::Activity(K::Sub),
            GreetingKind::Activity(K::Resub),
            GreetingKind::Activity(K::SubGift),
            GreetingKind::Activity(K::CommunitySubGift),
            GreetingKind::Activity(K::Membership),
            GreetingKind::Activity(K::Cheer),
            GreetingKind::Activity(K::Kicks),
            GreetingKind::Activity(K::SuperChat),
            GreetingKind::Activity(K::SuperSticker),
            GreetingKind::Activity(K::Raid),
            GreetingKind::Activity(K::WatchStreak),
            GreetingKind::Activity(K::PowerUp),
            GreetingKind::Activity(K::Redemption),
        ]
    };

    /// The kind as the wire and the fixture spell it (the template kind's
    /// own kebab-case name, `first-time`, `returning`).
    pub(crate) fn wire(self) -> &'static str {
        use CohostActivityTemplateKind as K;
        match self {
            Self::FirstTime => "first-time",
            Self::Returning => "returning",
            Self::Activity(kind) => match kind {
                K::Follow => "follow",
                K::Sub => "sub",
                K::Resub => "resub",
                K::SubGift => "sub-gift",
                K::CommunitySubGift => "community-sub-gift",
                K::Membership => "membership",
                K::Cheer => "cheer",
                K::Kicks => "kicks",
                K::SuperChat => "super-chat",
                K::SuperSticker => "super-sticker",
                K::Raid => "raid",
                K::WatchStreak => "watch-streak",
                K::PowerUp => "power-up",
                K::Redemption => "redemption",
            },
        }
    }
}

/// One built-in line (plan 192 D1): what a kind says when the user wrote
/// nothing for it. Short and plain, `{name}` only, so it reads right whatever
/// optional fields a platform leaves empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BuiltinGreeting {
    pub(crate) kind: GreetingKind,
    pub(crate) text: &'static str,
    pub(crate) state: CohostUtteranceState,
}

/// The runtime copy of `protocol-fixtures/buddy-builtin-greetings.json`; a
/// test asserts they are equal, and the TS `BUDDY_BUILTIN_GREETINGS` asserts
/// the same, so the two never drift.
pub(crate) const BUILTIN_GREETINGS: [BuiltinGreeting; 16] = {
    use CohostActivityTemplateKind as K;
    use CohostUtteranceState::{Laugh, Talk};
    const fn line(
        kind: GreetingKind,
        text: &'static str,
        state: CohostUtteranceState,
    ) -> BuiltinGreeting {
        BuiltinGreeting { kind, text, state }
    }
    [
        line(
            GreetingKind::FirstTime,
            "Hi {name}, welcome to the stream!",
            Talk,
        ),
        line(GreetingKind::Returning, "Welcome back, {name}!", Talk),
        line(
            GreetingKind::Activity(K::Follow),
            "Welcome, {name}! Thanks for the follow.",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::Sub),
            "{name} joined the ranks. Thank you!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::Resub),
            "{name} is back in the ranks. Thank you!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::SubGift),
            "Thanks for the gift sub, {name}!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::CommunitySubGift),
            "{name} gifted subs to the chat. Thank you!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::Membership),
            "Welcome to the members, {name}!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::Cheer),
            "Thanks for the bits, {name}!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::Kicks),
            "Thanks for the Kicks, {name}!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::SuperChat),
            "Thanks for the Super Chat, {name}!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::SuperSticker),
            "Thanks for the Super Sticker, {name}!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::Raid),
            "{name} is raiding! Welcome, everyone!",
            Laugh,
        ),
        line(
            GreetingKind::Activity(K::WatchStreak),
            "{name}, thanks for the watch streak!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::PowerUp),
            "Thanks for the power-up, {name}!",
            Talk,
        ),
        line(
            GreetingKind::Activity(K::Redemption),
            "Thanks for redeeming, {name}!",
            Talk,
        ),
    ]
};

/// The built-in line of a kind (every kind has one).
pub(crate) fn builtin_greeting(kind: GreetingKind) -> &'static BuiltinGreeting {
    BUILTIN_GREETINGS
        .iter()
        .find(|line| line.kind == kind)
        .expect("every greeting kind has a built-in line")
}

/// One Activity event (or a chatter's first message) as a greeting sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActivityFacts {
    pub(crate) kind: GreetingKind,
    pub(crate) platform: StreamPlatform,
    /// The comments destination the event came from: the greeting goes there
    /// and nowhere else (D8).
    pub(crate) destination_id: String,
    /// Dedupe key for the viewer on that platform (the author id, else the
    /// lowercased name).
    pub(crate) viewer_key: String,
    pub(crate) message_id: String,
    pub(crate) name: String,
    /// The @-mentionable login where the platform has one, else the name.
    pub(crate) handle: String,
    pub(crate) months: Option<u32>,
    pub(crate) streak: Option<u32>,
    pub(crate) count: Option<u64>,
    pub(crate) amount: Option<String>,
    pub(crate) reward: Option<String>,
    /// A welcome's first message, trimmed to what the greet route takes
    /// (plan 192 S2.2); never set on an Activity row.
    pub(crate) first_message_text: Option<String>,
}

/// The greeting platform a chat platform maps to; `None` for platforms a
/// template cannot be limited to (custom RTMP, TikTok, Instagram).
pub(crate) fn greeting_platform(platform: StreamPlatform) -> Option<CohostGreetingPlatform> {
    match platform {
        StreamPlatform::Twitch => Some(CohostGreetingPlatform::Twitch),
        StreamPlatform::Youtube => Some(CohostGreetingPlatform::Youtube),
        StreamPlatform::Kick => Some(CohostGreetingPlatform::Kick),
        StreamPlatform::X => Some(CohostGreetingPlatform::X),
        StreamPlatform::Facebook
        | StreamPlatform::Tiktok
        | StreamPlatform::Instagram
        | StreamPlatform::Custom => None,
    }
}

/// The facts of an Activity row, or `None` for anything a greeting never
/// answers: plain chat, tombstones, announcements, the single gift rows inside
/// a community gift (the gifter gets the one greeting, D9), and the
/// subscription upgrades Twitch reports without a viewer action worth a
/// greeting.
pub(crate) fn activity_facts(message: &LiveChatMessage) -> Option<ActivityFacts> {
    if message.is_deleted || message.event_type == LiveChatEventType::Deleted {
        return None;
    }
    let details = message.details.as_ref()?;
    let name = message.author_name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let mut facts = base_facts(message, name);
    use CohostActivityTemplateKind as K;
    match details {
        LiveChatEventDetails::Follow { handle } => {
            facts.kind = GreetingKind::Activity(K::Follow);
            if let Some(handle) = handle.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
                facts.handle = format!("@{}", handle.trim_start_matches('@'));
            }
        }
        LiveChatEventDetails::Subscription {
            subscription,
            months,
            gift_count,
            community_gift_id,
            ..
        } => {
            facts.kind = GreetingKind::Activity(match subscription {
                SubscriptionKind::Sub => K::Sub,
                SubscriptionKind::Resub => K::Resub,
                SubscriptionKind::SubGift => {
                    if community_gift_id.is_some() {
                        return None;
                    }
                    K::SubGift
                }
                SubscriptionKind::CommunitySubGift => K::CommunitySubGift,
                SubscriptionKind::GiftPaidUpgrade
                | SubscriptionKind::PrimePaidUpgrade
                | SubscriptionKind::PayItForward => return None,
            });
            facts.months = *months;
            facts.count = gift_count.map(u64::from);
        }
        LiveChatEventDetails::Membership {
            membership,
            months,
            gift_count,
            ..
        } => {
            if *membership == MembershipKind::GiftReceived {
                return None;
            }
            facts.kind = GreetingKind::Activity(K::Membership);
            facts.months = *months;
            facts.count = gift_count.map(u64::from);
        }
        LiveChatEventDetails::Cheer { bits } => {
            facts.kind = GreetingKind::Activity(K::Cheer);
            facts.count = Some(*bits);
            facts.amount = Some(format!("{} bits", group_thousands(*bits)));
        }
        LiveChatEventDetails::Kicks { amount, .. } => {
            facts.kind = GreetingKind::Activity(K::Kicks);
            facts.count = Some(*amount);
            facts.amount = Some(format!("{} KICKs", group_thousands(*amount)));
        }
        LiveChatEventDetails::SuperChat { amount_display, .. }
        | LiveChatEventDetails::SuperSticker { amount_display, .. } => {
            facts.kind = if matches!(details, LiveChatEventDetails::SuperChat { .. }) {
                GreetingKind::Activity(K::SuperChat)
            } else {
                GreetingKind::Activity(K::SuperSticker)
            };
            facts.amount = Some(amount_display.clone());
        }
        LiveChatEventDetails::Raid { viewer_count } => {
            facts.kind = GreetingKind::Activity(K::Raid);
            facts.count = Some(*viewer_count);
        }
        LiveChatEventDetails::WatchStreak { streak_count, .. } => {
            facts.kind = GreetingKind::Activity(K::WatchStreak);
            facts.streak = Some(*streak_count);
        }
        LiveChatEventDetails::PowerUp { bits, title, .. } => {
            facts.kind = GreetingKind::Activity(K::PowerUp);
            facts.count = Some(*bits);
            facts.amount = Some(format!("{} bits", group_thousands(*bits)));
            facts.reward = title.clone();
        }
        LiveChatEventDetails::Redemption {
            channel_points,
            title,
            points_name,
            ..
        } => {
            facts.kind = GreetingKind::Activity(K::Redemption);
            facts.count = Some(*channel_points);
            // Plan 163: the channel's own name for its points.
            let points = points_name.as_deref().unwrap_or("channel points");
            facts.amount = Some(format!("{} {points}", group_thousands(*channel_points)));
            facts.reward = title.clone();
        }
        LiveChatEventDetails::Announcement { .. } => return None,
    }
    Some(facts)
}

/// The facts every row shares: a follow kind placeholder, the destination,
/// the viewer key (the author id, else the lowercased name) and the name.
fn base_facts(message: &LiveChatMessage, name: String) -> ActivityFacts {
    ActivityFacts {
        kind: GreetingKind::Activity(CohostActivityTemplateKind::Follow),
        platform: message.platform,
        destination_id: comments_destination_id(message.platform, message.target_id.as_deref()),
        viewer_key: message
            .author_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| name.to_lowercase()),
        message_id: message.id.clone(),
        handle: name.clone(),
        name,
        months: None,
        streak: None,
        count: None,
        amount: message.amount_text.clone(),
        reward: None,
        first_message_text: None,
    }
}

/// The facts of a chatter's first message (plan 192 S1.2): first-time when
/// `first_message` (new to the channel, by local history), returning when it
/// is their first row this stream and they chatted on an earlier one. `None`
/// for everything else: later messages, tombstones, notices, the streamer's
/// own rows, known bots and names that carry a URL.
pub(crate) fn welcome_facts(message: &LiveChatMessage) -> Option<ActivityFacts> {
    if message.is_deleted
        || !matches!(
            message.event_type,
            LiveChatEventType::Message | LiveChatEventType::Paid
        )
        || message.details.is_some()
    {
        return None;
    }
    let kind = if message.first_message {
        GreetingKind::FirstTime
    } else if message.first_in_session {
        GreetingKind::Returning
    } else {
        return None;
    };
    if is_owner_row(message) {
        return None;
    }
    let name = message.author_name.trim().to_string();
    if name.is_empty() || is_known_bot(&name) || name_has_url(&name) {
        return None;
    }
    let mut facts = base_facts(message, name);
    facts.kind = kind;
    let text = truncate_utf16(message.message_text.trim(), FIRST_MESSAGE_TEXT_MAX_UNITS);
    facts.first_message_text = (!text.trim().is_empty()).then(|| text.trim_end().to_string());
    Some(facts)
}

/// The streamer's own row: an owner or broadcaster role, as the connectors
/// label it.
fn is_owner_row(message: &LiveChatMessage) -> bool {
    message.author_roles.iter().any(|role| {
        matches!(
            role.trim().to_ascii_lowercase().as_str(),
            "owner" | "broadcaster"
        )
    })
}

/// A known chat bot, by name (case-insensitive, a leading `@` ignored).
pub(crate) fn is_known_bot(name: &str) -> bool {
    let name = name.trim().trim_start_matches('@').to_lowercase();
    KNOWN_BOTS.contains(&name.as_str())
}

/// A display name that carries a link: a scheme, `www.`, or a domain-shaped
/// token (letters or digits, a dot, then two or more letters).
pub(crate) fn name_has_url(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.contains("://") || lower.contains("www.") {
        return true;
    }
    let bytes = lower.as_bytes();
    bytes.iter().enumerate().any(|(index, byte)| {
        *byte == b'.'
            && index > 0
            && bytes[index - 1].is_ascii_alphanumeric()
            && bytes[index + 1..]
                .iter()
                .take_while(|b| b.is_ascii_alphabetic())
                .count()
                >= 2
    })
}

fn group_thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// The enabled template for `kind` on `platform`, picked by `choice` among
/// the matching ones (the caller passes something random; it is reduced
/// modulo the count). A template limited to another platform never matches.
pub(crate) fn pick_template(
    templates: &[CohostGreetingTemplate],
    kind: CohostActivityTemplateKind,
    platform: StreamPlatform,
    choice: usize,
) -> Option<&CohostGreetingTemplate> {
    let platform = greeting_platform(platform);
    let matching: Vec<&CohostGreetingTemplate> = templates
        .iter()
        .filter(|template| template.enabled && template.kind == kind)
        .filter(|template| template.platform.is_none() || template.platform == platform)
        .collect();
    if matching.is_empty() {
        return None;
    }
    Some(matching[choice % matching.len()])
}

/// The line a greeting kind resolves to (plan 192 D1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GreetingLine {
    pub(crate) text: String,
    pub(crate) state: CohostUtteranceState,
    /// The reaction the user's line names (plan 168 D14); built-in lines
    /// name none.
    pub(crate) reaction: Option<String>,
    /// The user wrote it (the AI's style example), else it is built in.
    pub(crate) user_written: bool,
}

/// What `kind` says on `platform` (plan 192 D1), in this order: the user's
/// enabled template for the kind and platform (`choice` picks among them);
/// off (`None`) when the user has templates of that kind and switched every
/// one of them off; else the built-in line. A welcome kind reads its own
/// switch and text in `greetings.welcomes`. An empty list never means
/// silence.
pub(crate) fn resolve_line(
    settings: &CohostGreetingsSettings,
    kind: GreetingKind,
    platform: StreamPlatform,
    choice: usize,
) -> Option<GreetingLine> {
    let builtin = || {
        let line = builtin_greeting(kind);
        GreetingLine {
            text: line.text.to_string(),
            state: line.state,
            reaction: None,
            user_written: false,
        }
    };
    let welcome = |line: &WelcomeLine| {
        if !line.enabled {
            return None;
        }
        Some(
            match line
                .text
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                Some(text) => GreetingLine {
                    text: text.to_string(),
                    state: line.state,
                    reaction: line.reaction.clone(),
                    user_written: true,
                },
                None => GreetingLine {
                    state: line.state,
                    reaction: line.reaction.clone(),
                    ..builtin()
                },
            },
        )
    };
    match kind {
        GreetingKind::FirstTime => welcome(&settings.welcomes.first_time),
        GreetingKind::Returning => welcome(&settings.welcomes.returning),
        GreetingKind::Activity(template_kind) => {
            if let Some(template) =
                pick_template(&settings.templates, template_kind, platform, choice)
            {
                return Some(GreetingLine {
                    text: template.text.clone(),
                    state: template.state,
                    reaction: template.reaction.clone(),
                    user_written: true,
                });
            }
            let of_kind: Vec<&CohostGreetingTemplate> = settings
                .templates
                .iter()
                .filter(|template| template.kind == template_kind)
                .collect();
            if !of_kind.is_empty() && of_kind.iter().all(|template| !template.enabled) {
                return None;
            }
            Some(builtin())
        }
    }
}

/// The fields of one event, or of a collapsed burst (`{names}` /
/// `{others}` set, the singular fields from the first event).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TemplateFields {
    pub(crate) name: String,
    pub(crate) handle: String,
    pub(crate) platform: String,
    pub(crate) months: Option<u32>,
    pub(crate) streak: Option<u32>,
    pub(crate) count: Option<u64>,
    pub(crate) amount: Option<String>,
    pub(crate) reward: Option<String>,
    pub(crate) names: String,
    pub(crate) others: usize,
}

impl TemplateFields {
    pub(crate) fn from_facts(facts: &ActivityFacts) -> Self {
        Self {
            name: facts.name.clone(),
            handle: facts.handle.clone(),
            platform: stream_platform_label(facts.platform).to_string(),
            months: facts.months,
            streak: facts.streak,
            count: facts.count,
            amount: facts.amount.clone(),
            reward: facts.reward.clone(),
            names: facts.name.clone(),
            others: 0,
        }
    }

    fn value(&self, field: &str) -> Option<String> {
        match field {
            "name" => Some(self.name.clone()),
            "handle" => Some(self.handle.clone()),
            "platform" => Some(self.platform.clone()),
            "months" => Some(self.months.map_or_else(String::new, |v| v.to_string())),
            "streak" => Some(self.streak.map_or_else(String::new, |v| v.to_string())),
            "count" => Some(self.count.map_or_else(String::new, group_thousands)),
            "amount" => Some(self.amount.clone().unwrap_or_default()),
            "reward" => Some(self.reward.clone().unwrap_or_default()),
            "names" => Some(self.names.clone()),
            "others" => Some(if self.others == 0 {
                String::new()
            } else {
                self.others.to_string()
            }),
            _ => None,
        }
    }
}

/// The distinct names of a burst, first seen first (case-insensitive).
pub(crate) fn distinct_names(events: &[ActivityFacts]) -> Vec<&str> {
    let mut names: Vec<&str> = Vec::new();
    for event in events {
        if !names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&event.name))
        {
            names.push(&event.name);
        }
    }
    names
}

/// One event's fields, or a burst's: `{names}` lists the first three
/// distinct names ("Ana, Bo and Cy"), `{others}` counts the rest, the
/// singular fields come from the first event (D9). With more than one
/// distinct name, `{name}` and `{handle}` resolve to that list too (plan
/// 192), so a line written with `{name}` never greets only the first viewer
/// of a burst. An empty slice gives the default fields.
pub(crate) fn collapse(events: &[ActivityFacts]) -> TemplateFields {
    let Some(first) = events.first() else {
        return TemplateFields::default();
    };
    let mut fields = TemplateFields::from_facts(first);
    let names = distinct_names(events);
    let named: Vec<&str> = names.iter().copied().take(COLLAPSE_NAMED_MAX).collect();
    fields.others = names.len().saturating_sub(named.len());
    fields.names = match named.as_slice() {
        [] => String::new(),
        [one] => (*one).to_string(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    };
    if fields.others > 0 {
        fields.names = format!(
            "{} and {} other{}",
            named.join(", "),
            fields.others,
            if fields.others == 1 { "" } else { "s" }
        );
    }
    if names.len() > 1 {
        fields.name = fields.names.clone();
        fields.handle = fields.names.clone();
    }
    fields
}

/// Fill the braces in `text`. Unknown fields stay literal and come back in
/// the second value, so the editor can warn (plan 164 Wire shape). Doubled
/// spaces left by an empty field are collapsed.
pub(crate) fn resolve_template(text: &str, fields: &TemplateFields) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut unknown: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if !after[..close].contains('{') => {
                let field = after[..close].trim();
                match fields.value(field) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push_str(&rest[open..open + 1 + close + 1]);
                        if !unknown.iter().any(|known| known == field) {
                            unknown.push(field.to_string());
                        }
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
    let resolved = out.split_whitespace().collect::<Vec<_>>().join(" ");
    (resolved, unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohost::CohostUtteranceState;
    use crate::live_chat::fake_events_for_tests;

    fn template(kind: CohostActivityTemplateKind, text: &str) -> CohostGreetingTemplate {
        CohostGreetingTemplate {
            id: format!("t-{text}"),
            kind,
            platform: None,
            text: text.to_string(),
            state: CohostUtteranceState::Talk,
            enabled: true,
            reaction: None,
        }
    }

    fn facts_of(platform: StreamPlatform, raw_kind: &str) -> ActivityFacts {
        let events = fake_events_for_tests("session-1", platform, Some("target"));
        let message = events
            .iter()
            .find(|message| message.raw_provider_type.as_deref() == Some(raw_kind))
            .unwrap_or_else(|| panic!("no fake {raw_kind} event"));
        activity_facts(message).unwrap_or_else(|| panic!("{raw_kind} has no facts"))
    }

    fn resolved(platform: StreamPlatform, raw_kind: &str, text: &str) -> String {
        let facts = facts_of(platform, raw_kind);
        let (line, unknown) = resolve_template(text, &TemplateFields::from_facts(&facts));
        assert!(unknown.is_empty(), "{text}: {unknown:?}");
        line
    }

    #[test]
    fn every_template_kind_resolves_against_the_fake_activity_shapes() {
        // The fake connector's rows are shaped as the real connectors
        // normalize them (plan 055); the parsers' own tests pin the raw
        // payloads under scripts/fixtures/stream-manager.
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "follow",
                "Welcome {name} ({handle}) from {platform}!"
            ),
            "Welcome new_friend (@new_friend) from Twitch!"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "resub",
                "{name} joined the ranks ({months} months)"
            ),
            "morgaesis joined the ranks (8 months)"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "community-sub-gift",
                "{name} gifted {count} subs"
            ),
            "generous gifted 5 subs"
        );
        assert_eq!(
            resolved(StreamPlatform::Twitch, "cheer", "{amount} from {name}"),
            "1,500 bits from sarzdotmd"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "raid",
                "{name} brings {count} warriors."
            ),
            "raider42 brings 234 warriors."
        );
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "channel.chat.notification:watch_streak",
                "{name}, {streak} streams strong"
            ),
            "loyal_lurker, 20 streams strong"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "channel.bits.use:power_up",
                "{amount} power-up from {name}"
            ),
            "300 bits power-up from party_starter"
        );
        // Plan 163: `{reward}` is the reward's title, `{amount}` uses the
        // channel's points name.
        assert_eq!(
            resolved(
                StreamPlatform::Twitch,
                "channel.channel_points_custom_reward_redemption.add",
                "{name} redeemed {reward} for {amount}"
            ),
            "hydration_hero redeemed Hydrate for 500 Diamonds"
        );
        assert_eq!(
            resolved(StreamPlatform::Kick, "kicks.gifted", "{amount} from {name}"),
            "500 KICKs from kick_tipper"
        );
        assert_eq!(
            resolved(StreamPlatform::Kick, "channel.followed", "Hi {handle}"),
            "Hi @kick_fan"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Youtube,
                "super-chat",
                "{amount} from {name}, thanks"
            ),
            "$5.00 from Maria, thanks"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Youtube,
                "super-sticker",
                "{name} sent {amount}"
            ),
            "Jonas sent €2.00"
        );
        assert_eq!(
            resolved(
                StreamPlatform::Youtube,
                "membership",
                "Welcome member {name}"
            ),
            "Welcome member Newbie"
        );
        let kinds: Vec<GreetingKind> = [
            (StreamPlatform::Twitch, "follow"),
            (StreamPlatform::Twitch, "resub"),
            (StreamPlatform::Twitch, "community-sub-gift"),
            (StreamPlatform::Twitch, "cheer"),
            (StreamPlatform::Twitch, "raid"),
            (
                StreamPlatform::Twitch,
                "channel.chat.notification:watch_streak",
            ),
            (StreamPlatform::Twitch, "channel.bits.use:power_up"),
            (
                StreamPlatform::Twitch,
                "channel.channel_points_custom_reward_redemption.add",
            ),
            (StreamPlatform::Kick, "kicks.gifted"),
            (StreamPlatform::Youtube, "super-chat"),
            (StreamPlatform::Youtube, "super-sticker"),
            (StreamPlatform::Youtube, "membership"),
        ]
        .into_iter()
        .map(|(platform, raw)| facts_of(platform, raw).kind)
        .collect();
        assert_eq!(
            kinds,
            [
                CohostActivityTemplateKind::Follow,
                CohostActivityTemplateKind::Resub,
                CohostActivityTemplateKind::CommunitySubGift,
                CohostActivityTemplateKind::Cheer,
                CohostActivityTemplateKind::Raid,
                CohostActivityTemplateKind::WatchStreak,
                CohostActivityTemplateKind::PowerUp,
                CohostActivityTemplateKind::Redemption,
                CohostActivityTemplateKind::Kicks,
                CohostActivityTemplateKind::SuperChat,
                CohostActivityTemplateKind::SuperSticker,
                CohostActivityTemplateKind::Membership,
            ]
            .map(GreetingKind::Activity)
            .to_vec()
        );
    }

    #[test]
    fn sub_and_single_gift_resolve_and_a_gift_inside_a_community_gift_is_skipped() {
        let mut events = fake_events_for_tests("session-1", StreamPlatform::Twitch, None);
        let resub = events
            .iter_mut()
            .find(|message| message.raw_provider_type.as_deref() == Some("resub"))
            .unwrap();
        resub.details = Some(LiveChatEventDetails::Subscription {
            subscription: SubscriptionKind::Sub,
            tier: Some("1000".into()),
            is_prime: false,
            months: None,
            streak_months: None,
            gift_count: None,
            recipient_name: None,
            community_gift_id: None,
        });
        let sub = activity_facts(resub).unwrap();
        assert_eq!(
            sub.kind,
            GreetingKind::Activity(CohostActivityTemplateKind::Sub)
        );
        assert_eq!(
            resolve_template("{name} subscribed", &TemplateFields::from_facts(&sub)).0,
            "morgaesis subscribed"
        );
        resub.details = Some(LiveChatEventDetails::Subscription {
            subscription: SubscriptionKind::SubGift,
            tier: Some("1000".into()),
            is_prime: false,
            months: None,
            streak_months: None,
            gift_count: Some(1),
            recipient_name: Some("lucky".into()),
            community_gift_id: None,
        });
        let gift = activity_facts(resub).unwrap();
        assert_eq!(
            gift.kind,
            GreetingKind::Activity(CohostActivityTemplateKind::SubGift)
        );
        assert_eq!(gift.count, Some(1));
        resub.details = Some(LiveChatEventDetails::Subscription {
            subscription: SubscriptionKind::SubGift,
            tier: Some("1000".into()),
            is_prime: false,
            months: None,
            streak_months: None,
            gift_count: Some(1),
            recipient_name: Some("lucky".into()),
            community_gift_id: Some("fake-gift".into()),
        });
        assert_eq!(
            activity_facts(resub),
            None,
            "a gift row inside a community gift"
        );
    }

    #[test]
    fn plain_chat_tombstones_and_announcements_have_no_facts() {
        let mut events = fake_events_for_tests("session-1", StreamPlatform::Twitch, None);
        let raid = events
            .iter_mut()
            .find(|message| message.raw_provider_type.as_deref() == Some("raid"))
            .unwrap();
        raid.is_deleted = true;
        assert_eq!(activity_facts(raid), None);
        raid.is_deleted = false;
        raid.details = Some(LiveChatEventDetails::Announcement { color: None });
        assert_eq!(activity_facts(raid), None);
        raid.details = None;
        assert_eq!(activity_facts(raid), None);
    }

    #[test]
    fn pick_template_respects_enabled_kind_platform_and_the_choice() {
        let mut any = template(CohostActivityTemplateKind::Follow, "a");
        let mut twitch_only = template(CohostActivityTemplateKind::Follow, "b");
        twitch_only.platform = Some(CohostGreetingPlatform::Twitch);
        let mut off = template(CohostActivityTemplateKind::Follow, "c");
        off.enabled = false;
        let raid = template(CohostActivityTemplateKind::Raid, "d");
        let templates = vec![any.clone(), twitch_only.clone(), off, raid];
        let kind = CohostActivityTemplateKind::Follow;
        assert_eq!(
            pick_template(&templates, kind, StreamPlatform::Twitch, 0).map(|t| t.text.as_str()),
            Some("a")
        );
        assert_eq!(
            pick_template(&templates, kind, StreamPlatform::Twitch, 1).map(|t| t.text.as_str()),
            Some("b")
        );
        assert_eq!(
            pick_template(&templates, kind, StreamPlatform::Twitch, 2).map(|t| t.text.as_str()),
            Some("a")
        );
        assert_eq!(
            pick_template(&templates, kind, StreamPlatform::Kick, 1).map(|t| t.text.as_str()),
            Some("a")
        );
        assert_eq!(
            pick_template(
                &templates,
                CohostActivityTemplateKind::Cheer,
                StreamPlatform::Twitch,
                0
            ),
            None
        );
        any.enabled = false;
        twitch_only.enabled = false;
        assert_eq!(
            pick_template(&[any, twitch_only], kind, StreamPlatform::Twitch, 0),
            None
        );
    }

    #[test]
    fn unknown_fields_stay_literal_and_are_reported_once() {
        let facts = facts_of(StreamPlatform::Twitch, "follow");
        let (line, unknown) = resolve_template(
            "Hi {name}, {nope} and {nope} {",
            &TemplateFields::from_facts(&facts),
        );
        assert_eq!(line, "Hi new_friend, {nope} and {nope} {");
        assert_eq!(unknown, vec!["nope".to_string()]);
        let (empty, unknown) =
            resolve_template("{months} months", &TemplateFields::from_facts(&facts));
        assert_eq!(empty, "months");
        assert!(unknown.is_empty());
    }

    #[test]
    fn collapse_names_three_and_counts_the_others() {
        let base = facts_of(StreamPlatform::Twitch, "follow");
        let named = |name: &str| ActivityFacts {
            name: name.to_string(),
            viewer_key: name.to_lowercase(),
            ..base.clone()
        };
        let one = collapse(&[named("Ana")]);
        assert_eq!(one.names, "Ana");
        assert_eq!(one.others, 0);
        let two = collapse(&[named("Ana"), named("Bo")]);
        assert_eq!(two.names, "Ana and Bo");
        let three = collapse(&[named("Ana"), named("Bo"), named("Cy")]);
        assert_eq!(three.names, "Ana, Bo and Cy");
        let seven = collapse(&[
            named("Ana"),
            named("Bo"),
            named("Cy"),
            named("Di"),
            named("Ed"),
            named("Fay"),
            named("ana"),
        ]);
        assert_eq!(seven.names, "Ana, Bo, Cy and 3 others");
        assert_eq!(seven.others, 3);
        let four = collapse(&[named("Ana"), named("Bo"), named("Cy"), named("Di")]);
        assert_eq!(four.names, "Ana, Bo, Cy and 1 other");
        assert_eq!(
            resolve_template("Welcome {names}!", &seven).0,
            "Welcome Ana, Bo, Cy and 3 others!"
        );
        assert_eq!(collapse(&[]), TemplateFields::default());
    }

    #[test]
    fn x_text_is_not_clipped_here() {
        let facts = facts_of(StreamPlatform::Twitch, "follow");
        let long = "x".repeat(300);
        let (line, _) = resolve_template(&long, &TemplateFields::from_facts(&facts));
        assert_eq!(line.len(), 300, "the caller clips to the platform cap");
    }

    // --- Plan 192: built-in lines, the resolver and welcomes ---------------------

    /// The runtime table equals the shared fixture, row for row, in order.
    #[test]
    fn builtin_greetings_equal_the_shared_fixture() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            version: u32,
            lines: Vec<FixtureLine>,
        }
        #[derive(serde::Deserialize)]
        struct FixtureLine {
            kind: String,
            text: String,
            state: CohostUtteranceState,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/buddy-builtin-greetings.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);
        assert_eq!(fixture.lines.len(), BUILTIN_GREETINGS.len());
        for (line, builtin) in fixture.lines.iter().zip(BUILTIN_GREETINGS.iter()) {
            assert_eq!(line.kind, builtin.kind.wire());
            assert_eq!(line.text, builtin.text, "{}", line.kind);
            assert_eq!(line.state, builtin.state, "{}", line.kind);
        }
        // Every kind has exactly one line, and the table is in `ALL` order.
        for (kind, builtin) in GreetingKind::ALL.iter().zip(BUILTIN_GREETINGS.iter()) {
            assert_eq!(*kind, builtin.kind);
            assert_eq!(builtin_greeting(*kind).kind, *kind);
        }
        // The wire name of an Activity kind is its serde name.
        for kind in GreetingKind::ALL {
            if let GreetingKind::Activity(template_kind) = kind {
                assert_eq!(
                    serde_json::to_value(template_kind).unwrap(),
                    serde_json::Value::String(kind.wire().to_string())
                );
            }
        }
        // Built-in lines use `{name}` only.
        for builtin in BUILTIN_GREETINGS {
            let (_, unknown) = resolve_template(builtin.text, &TemplateFields::default());
            assert!(unknown.is_empty(), "{}", builtin.text);
            assert!(!builtin.text.contains("{names}") && !builtin.text.contains("{handle}"));
        }
    }

    /// D1: the user's enabled line wins, an all-off kind is off, and an
    /// empty list (or a kind without a template) gets the built-in line.
    #[test]
    fn resolve_line_prefers_the_user_line_then_off_then_the_builtin() {
        let follow = GreetingKind::Activity(CohostActivityTemplateKind::Follow);
        let cheer = GreetingKind::Activity(CohostActivityTemplateKind::Cheer);
        let mut settings = CohostGreetingsSettings::default();
        let built_in = resolve_line(&settings, follow, StreamPlatform::Twitch, 0).unwrap();
        assert_eq!(built_in.text, "Welcome, {name}! Thanks for the follow.");
        assert!(!built_in.user_written);
        assert_eq!(built_in.state, CohostUtteranceState::Talk);

        settings.templates = vec![template(CohostActivityTemplateKind::Follow, "Yo {name}")];
        let user = resolve_line(&settings, follow, StreamPlatform::Twitch, 0).unwrap();
        assert_eq!(user.text, "Yo {name}");
        assert!(user.user_written);
        // The cheer has no template: built in.
        assert_eq!(
            resolve_line(&settings, cheer, StreamPlatform::Twitch, 0)
                .unwrap()
                .text,
            "Thanks for the bits, {name}!"
        );
        // Every follow template off: the kind is off.
        settings.templates[0].enabled = false;
        assert_eq!(
            resolve_line(&settings, follow, StreamPlatform::Twitch, 0),
            None
        );
        // One on but limited to Twitch: Kick gets the built-in line, Twitch
        // the user's.
        settings.templates[0].enabled = true;
        settings.templates[0].platform = Some(CohostGreetingPlatform::Twitch);
        assert_eq!(
            resolve_line(&settings, follow, StreamPlatform::Kick, 0)
                .unwrap()
                .text,
            "Welcome, {name}! Thanks for the follow."
        );
        assert_eq!(
            resolve_line(&settings, follow, StreamPlatform::Twitch, 0)
                .unwrap()
                .text,
            "Yo {name}"
        );

        // Welcomes: their own switch, their own text, else the built-in
        // line with the state and reaction the user set.
        let first = resolve_line(
            &settings,
            GreetingKind::FirstTime,
            StreamPlatform::Youtube,
            0,
        )
        .unwrap();
        assert_eq!(first.text, "Hi {name}, welcome to the stream!");
        assert!(!first.user_written);
        settings.welcomes.returning.text = Some("  Yo {name}!  ".to_string());
        settings.welcomes.returning.state = CohostUtteranceState::Laugh;
        settings.welcomes.returning.reaction = Some("wave".to_string());
        let returning =
            resolve_line(&settings, GreetingKind::Returning, StreamPlatform::Kick, 0).unwrap();
        assert_eq!(returning.text, "Yo {name}!");
        assert_eq!(returning.state, CohostUtteranceState::Laugh);
        assert_eq!(returning.reaction.as_deref(), Some("wave"));
        assert!(returning.user_written);
        settings.welcomes.returning.text = Some("   ".to_string());
        let blank =
            resolve_line(&settings, GreetingKind::Returning, StreamPlatform::Kick, 0).unwrap();
        assert_eq!(blank.text, "Welcome back, {name}!");
        assert_eq!(blank.state, CohostUtteranceState::Laugh);
        settings.welcomes.returning.enabled = false;
        assert_eq!(
            resolve_line(&settings, GreetingKind::Returning, StreamPlatform::Kick, 0),
            None
        );
    }

    fn chat_row(name: &str, text: &str) -> LiveChatMessage {
        let mut row = fake_events_for_tests("session-1", StreamPlatform::Twitch, Some("main"))
            .into_iter()
            .find(|message| message.raw_provider_type.as_deref() == Some("follow"))
            .unwrap();
        row.details = None;
        row.event_type = LiveChatEventType::Message;
        row.raw_provider_type = Some("twitch".to_string());
        row.author_id = Some(format!("id-{}", name.to_lowercase()));
        row.author_name = name.to_string();
        row.message_text = text.to_string();
        row.first_message = true;
        row.first_in_session = true;
        row
    }

    /// S1.2: a first message is a first-time or returning welcome; later
    /// messages, the streamer, bots, links, tombstones and Activity rows
    /// never are.
    #[test]
    fn welcome_facts_read_first_messages_and_skip_the_rest() {
        let first = welcome_facts(&chat_row("Ana", "  hey everyone!  ")).unwrap();
        assert_eq!(first.kind, GreetingKind::FirstTime);
        assert_eq!(first.name, "Ana");
        assert_eq!(first.handle, "Ana");
        assert_eq!(first.viewer_key, "id-ana");
        assert_eq!(first.destination_id, "main");
        assert_eq!(first.first_message_text.as_deref(), Some("hey everyone!"));
        let mut returning = chat_row("Bo", "");
        returning.first_message = false;
        let facts = welcome_facts(&returning).unwrap();
        assert_eq!(facts.kind, GreetingKind::Returning);
        assert_eq!(facts.first_message_text, None);
        // A long first message is cut to the route's cap, in UTF-16 units.
        let long = chat_row("Cy", &"é".repeat(250));
        assert_eq!(
            welcome_facts(&long)
                .unwrap()
                .first_message_text
                .unwrap()
                .chars()
                .count(),
            200
        );
        // Not a first message this session: nothing.
        let mut later = chat_row("Di", "again");
        later.first_message = false;
        later.first_in_session = false;
        assert_eq!(welcome_facts(&later), None);
        // Twitch's own first-chat flag counts even without the session mark.
        let mut intro = chat_row("Ed", "hi");
        intro.first_in_session = false;
        assert_eq!(welcome_facts(&intro).unwrap().kind, GreetingKind::FirstTime);
        // The streamer, bots and links.
        let mut owner = chat_row("Streamer", "hi");
        owner.author_roles = vec!["Broadcaster".to_string()];
        assert_eq!(welcome_facts(&owner), None);
        assert_eq!(welcome_facts(&chat_row("NightBot", "hi")), None);
        assert_eq!(welcome_facts(&chat_row("@StreamElements", "hi")), None);
        assert_eq!(welcome_facts(&chat_row("buy.cheap.tld", "hi")), None);
        assert_eq!(welcome_facts(&chat_row("http://x", "hi")), None);
        assert_eq!(welcome_facts(&chat_row("www.site", "hi")), None);
        assert!(welcome_facts(&chat_row("J. Doe", "hi")).is_some());
        assert!(welcome_facts(&chat_row("Dr.", "hi")).is_some());
        // Tombstones, notices and Activity rows.
        let mut deleted = chat_row("Fay", "hi");
        deleted.is_deleted = true;
        assert_eq!(welcome_facts(&deleted), None);
        let mut system = chat_row("Gus", "hi");
        system.event_type = LiveChatEventType::System;
        assert_eq!(welcome_facts(&system), None);
        let follow = fake_events_for_tests("session-1", StreamPlatform::Twitch, Some("main"))
            .into_iter()
            .find(|message| message.raw_provider_type.as_deref() == Some("follow"))
            .unwrap();
        assert_eq!(welcome_facts(&follow), None);
        assert!(activity_facts(&chat_row("Hal", "hi")).is_none());
        for bot in KNOWN_BOTS {
            assert!(is_known_bot(bot));
            assert!(is_known_bot(&bot.to_uppercase()));
        }
        assert!(!is_known_bot("nightbot_fan"));
    }

    /// Plan 192: a burst resolves `{name}` to the names list, never to the
    /// first viewer alone.
    #[test]
    fn collapse_resolves_name_and_handle_to_the_list_for_a_burst() {
        let base = facts_of(StreamPlatform::Twitch, "follow");
        let named = |name: &str| ActivityFacts {
            name: name.to_string(),
            handle: format!("@{}", name.to_lowercase()),
            viewer_key: name.to_lowercase(),
            ..base.clone()
        };
        let one = collapse(&[named("Ana")]);
        assert_eq!(one.name, "Ana");
        assert_eq!(one.handle, "@ana");
        let burst = collapse(&[
            named("Ana"),
            named("Bo"),
            named("Cy"),
            named("Di"),
            named("Ed"),
        ]);
        assert_eq!(burst.name, "Ana, Bo, Cy and 2 others");
        assert_eq!(burst.handle, "Ana, Bo, Cy and 2 others");
        assert_eq!(
            resolve_template("Welcome, {name}! Thanks for the follow.", &burst).0,
            "Welcome, Ana, Bo, Cy and 2 others! Thanks for the follow."
        );
        assert_eq!(
            distinct_names(&[named("Ana"), named("ana"), named("Bo")]),
            ["Ana", "Bo"]
        );
    }
}
