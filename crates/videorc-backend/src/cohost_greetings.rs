//! Greetings written by the user (plan 164 S-D1): no model, no network.
//!
//! An Activity event (a follow, a sub, a cheer, a raid, ...) becomes
//! [`ActivityFacts`]: the template kind it answers, the destination it came
//! from and the fields a template may name in braces. [`pick_template`] picks
//! the user's enabled template for that kind and platform,
//! [`resolve_template`] fills the braces, and [`collapse`] folds a burst of
//! same-kind events into one `{names}` / `{others}` message (D9). Everything
//! here is pure; the throttle (`cohost_throttle`) decides when, the engine
//! (`cohost`) decides whether, and `live_chat` sends.

use crate::cohost::{CohostActivityTemplateKind, CohostGreetingPlatform, CohostGreetingTemplate};
use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, MembershipKind, SubscriptionKind,
    comments_destination_id,
};
use crate::streaming::{StreamPlatform, stream_platform_label};

/// Names listed before "and N others" in a collapsed greeting.
pub(crate) const COLLAPSE_NAMED_MAX: usize = 3;

/// One Activity event as a greeting sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActivityFacts {
    pub(crate) kind: CohostActivityTemplateKind,
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
}

/// The greeting platform a chat platform maps to; `None` for platforms a
/// template cannot be limited to (custom RTMP, TikTok, Instagram).
pub(crate) fn greeting_platform(platform: StreamPlatform) -> Option<CohostGreetingPlatform> {
    match platform {
        StreamPlatform::Twitch => Some(CohostGreetingPlatform::Twitch),
        StreamPlatform::Youtube => Some(CohostGreetingPlatform::Youtube),
        StreamPlatform::Kick => Some(CohostGreetingPlatform::Kick),
        StreamPlatform::X => Some(CohostGreetingPlatform::X),
        StreamPlatform::Tiktok | StreamPlatform::Instagram | StreamPlatform::Custom => None,
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
    let mut facts = ActivityFacts {
        kind: CohostActivityTemplateKind::Follow,
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
    };
    match details {
        LiveChatEventDetails::Follow { handle } => {
            facts.kind = CohostActivityTemplateKind::Follow;
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
            facts.kind = match subscription {
                SubscriptionKind::Sub => CohostActivityTemplateKind::Sub,
                SubscriptionKind::Resub => CohostActivityTemplateKind::Resub,
                SubscriptionKind::SubGift => {
                    if community_gift_id.is_some() {
                        return None;
                    }
                    CohostActivityTemplateKind::SubGift
                }
                SubscriptionKind::CommunitySubGift => CohostActivityTemplateKind::CommunitySubGift,
                SubscriptionKind::GiftPaidUpgrade
                | SubscriptionKind::PrimePaidUpgrade
                | SubscriptionKind::PayItForward => return None,
            };
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
            facts.kind = CohostActivityTemplateKind::Membership;
            facts.months = *months;
            facts.count = gift_count.map(u64::from);
        }
        LiveChatEventDetails::Cheer { bits } => {
            facts.kind = CohostActivityTemplateKind::Cheer;
            facts.count = Some(*bits);
            facts.amount = Some(format!("{} bits", group_thousands(*bits)));
        }
        LiveChatEventDetails::Kicks { amount, .. } => {
            facts.kind = CohostActivityTemplateKind::Kicks;
            facts.count = Some(*amount);
            facts.amount = Some(format!("{} KICKs", group_thousands(*amount)));
        }
        LiveChatEventDetails::SuperChat { amount_display, .. }
        | LiveChatEventDetails::SuperSticker { amount_display, .. } => {
            facts.kind = if matches!(details, LiveChatEventDetails::SuperChat { .. }) {
                CohostActivityTemplateKind::SuperChat
            } else {
                CohostActivityTemplateKind::SuperSticker
            };
            facts.amount = Some(amount_display.clone());
        }
        LiveChatEventDetails::Raid { viewer_count } => {
            facts.kind = CohostActivityTemplateKind::Raid;
            facts.count = Some(*viewer_count);
        }
        LiveChatEventDetails::WatchStreak { streak_count, .. } => {
            facts.kind = CohostActivityTemplateKind::WatchStreak;
            facts.streak = Some(*streak_count);
        }
        LiveChatEventDetails::PowerUp { bits, title, .. } => {
            facts.kind = CohostActivityTemplateKind::PowerUp;
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
            facts.kind = CohostActivityTemplateKind::Redemption;
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

/// One event's fields, or a burst's: `{names}` lists the first three
/// distinct names ("Ana, Bo and Cy"), `{others}` counts the rest, the
/// singular fields come from the first event (D9). An empty slice gives the
/// default fields.
pub(crate) fn collapse(events: &[ActivityFacts]) -> TemplateFields {
    let Some(first) = events.first() else {
        return TemplateFields::default();
    };
    let mut fields = TemplateFields::from_facts(first);
    let mut names: Vec<&str> = Vec::new();
    for event in events {
        if !names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&event.name))
        {
            names.push(&event.name);
        }
    }
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
        let kinds: Vec<CohostActivityTemplateKind> = [
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
            vec![
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
        assert_eq!(sub.kind, CohostActivityTemplateKind::Sub);
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
        assert_eq!(gift.kind, CohostActivityTemplateKind::SubGift);
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
}
