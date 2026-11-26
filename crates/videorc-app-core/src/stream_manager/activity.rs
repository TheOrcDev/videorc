//! The Stream Manager's Activity pane projection (`lib/stream-activity.ts`):
//! structured chat events and destination events as rows, never chat text.

use std::sync::Arc;

use serde_json::Value;

use crate::chat::model::LiveChatMessage;
use crate::chat::view::notice_viewer_words;

use super::dashboard::{AudienceSnapshot, DestinationEvent};
use super::format::{group_thousands, plural};

/// `ActivityKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    Follow,
    Subscription,
    Membership,
    Cheer,
    Kicks,
    SuperChat,
    SuperSticker,
    Raid,
    WatchStreak,
    Announcement,
    PowerUp,
    Redemption,
    DestinationFailed,
    DestinationRecovered,
}

/// `ActivityFilter` chip id, or none (announcements under All only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityFilter {
    Follows,
    Support,
    Tips,
    Rewards,
    Raids,
    Streaks,
    Destinations,
}

/// One Activity row (`ActivityItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityItem {
    pub id: String,
    pub kind: ActivityKind,
    pub filter: Option<ActivityFilter>,
    pub platform: String,
    pub name: String,
    pub line: String,
    pub short: String,
    pub message: Option<String>,
    pub at: String,
    pub message_id: Option<String>,
    pub gift: bool,
    pub unnamed: bool,
}

const TIER_LABELS: &[(&str, &str)] = &[("1000", "Tier 1"), ("2000", "Tier 2"), ("3000", "Tier 3")];

fn tier_label(tier: Option<&str>, is_prime: bool) -> &'static str {
    if is_prime {
        return "Prime";
    }
    tier.and_then(|t| TIER_LABELS.iter().find(|(id, _)| *id == t).map(|(_, l)| *l))
        .unwrap_or("a sub")
}

fn str_field<'a>(details: &'a Value, key: &str) -> Option<&'a str> {
    details.get(key).and_then(Value::as_str)
}

fn u64_field(details: &Value, key: &str) -> Option<u64> {
    details
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n as u64)))
}

fn bool_field(details: &Value, key: &str) -> bool {
    details.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn activity_words(message: &LiveChatMessage) -> Option<String> {
    let words: String = message
        .fragments
        .iter()
        .map(|fragment| fragment.text.as_str())
        .collect();
    let words = words.trim();
    (!words.is_empty()).then(|| words.to_string())
}

fn subscription_line(details: &Value) -> String {
    let kind = str_field(details, "subscription").unwrap_or("sub");
    let is_prime = bool_field(details, "isPrime");
    let tier = str_field(details, "tier");
    let tiered = is_prime || tier.is_some();
    let label = tier_label(tier, is_prime);
    let gift_sub = if tiered {
        format!("a {label} sub")
    } else {
        "a sub".into()
    };
    match kind {
        "sub" => {
            if is_prime {
                "Subscribed with Prime".into()
            } else if tiered {
                format!("Subscribed at {label}")
            } else {
                "Subscribed".into()
            }
        }
        "resub" => {
            let months = u64_field(details, "months")
                .map(|n| format!(" for {}", plural(n as i64, "month", "months")))
                .unwrap_or_default();
            let at = if is_prime {
                " with Prime".to_string()
            } else if tiered {
                format!(" at {label}")
            } else {
                String::new()
            };
            format!("Resubscribed{months}{at}")
        }
        "sub-gift" => match str_field(details, "recipientName") {
            Some(name) => format!("Gifted {gift_sub} to {name}"),
            None => format!("Gifted {gift_sub}"),
        },
        "community-sub-gift" => {
            let count = u64_field(details, "giftCount").unwrap_or(1);
            format!("Gifted {}", plural(count as i64, "sub", "subs"))
        }
        "gift-paid-upgrade" => "Continued their gifted sub".into(),
        "prime-paid-upgrade" => format!("Upgraded from Prime to {label}"),
        "pay-it-forward" => "Paid a gifted sub forward".into(),
        _ => "Subscribed".into(),
    }
}

fn subscription_short(details: &Value) -> String {
    let kind = str_field(details, "subscription").unwrap_or("sub");
    let is_prime = bool_field(details, "isPrime");
    let tier = str_field(details, "tier");
    let notable = if is_prime {
        Some("Prime")
    } else {
        tier.filter(|t| *t != "1000")
            .and_then(|t| TIER_LABELS.iter().find(|(id, _)| *id == t).map(|(_, l)| *l))
    };
    let suffix = notable.map(|t| format!(" · {t}")).unwrap_or_default();
    match kind {
        "sub" => {
            if is_prime {
                "Prime sub".into()
            } else {
                format!("New sub{suffix}")
            }
        }
        "resub" => {
            let months = u64_field(details, "months")
                .map(|n| format!(" · {}", plural(n as i64, "month", "months")))
                .unwrap_or_default();
            format!("Resub{months}{suffix}")
        }
        "sub-gift" => match str_field(details, "recipientName") {
            Some(name) => format!("Gift sub → {name}"),
            None => "Gift sub".into(),
        },
        "community-sub-gift" => {
            let count = u64_field(details, "giftCount").unwrap_or(1);
            format!("Gifted {}", plural(count as i64, "sub", "subs"))
        }
        "gift-paid-upgrade" => "Kept a gift sub".into(),
        "prime-paid-upgrade" => format!("Prime → {}", tier_label(tier, false)),
        "pay-it-forward" => "Paid it forward".into(),
        _ => format!("Sub{suffix}"),
    }
}

fn membership_line(details: &Value) -> String {
    let kind = str_field(details, "membership").unwrap_or("new");
    let level = str_field(details, "levelName")
        .map(|name| format!(" {name}"))
        .unwrap_or_default();
    match kind {
        "new" => {
            if level.is_empty() {
                "Became a member".into()
            } else {
                format!("Joined as{level}")
            }
        }
        "upgrade" => {
            if level.is_empty() {
                "Upgraded their membership".into()
            } else {
                format!("Upgraded to{level}")
            }
        }
        "milestone" => match u64_field(details, "months") {
            Some(n) => format!("Member for {}", plural(n as i64, "month", "months")),
            None => "Membership milestone".into(),
        },
        "gift" => {
            let count = u64_field(details, "giftCount").unwrap_or(1);
            format!(
                "Gifted {}",
                plural(count as i64, "membership", "memberships")
            )
        }
        "gift-received" => "Received a gifted membership".into(),
        _ => "Became a member".into(),
    }
}

fn membership_short(details: &Value) -> String {
    let kind = str_field(details, "membership").unwrap_or("new");
    match kind {
        "new" => match str_field(details, "levelName") {
            Some(level) => format!("Member · {level}"),
            None => "New member".into(),
        },
        "upgrade" => match str_field(details, "levelName") {
            Some(level) => format!("Upgraded · {level}"),
            None => "Upgraded".into(),
        },
        "milestone" => match u64_field(details, "months") {
            Some(n) => format!("Member · {}", plural(n as i64, "month", "months")),
            None => "Member milestone".into(),
        },
        "gift" => {
            let count = u64_field(details, "giftCount").unwrap_or(1);
            format!(
                "Gifted {}",
                plural(count as i64, "membership", "memberships")
            )
        }
        "gift-received" => "Gift membership".into(),
        _ => "Member".into(),
    }
}

fn power_up_name(details: &Value) -> String {
    match str_field(details, "powerUp").unwrap_or("custom") {
        "celebration" => "Celebration".into(),
        "gigantify-an-emote" => match str_field(details, "emoteName") {
            Some(name) => format!("Gigantified {name}"),
            None => "Gigantified an emote".into(),
        },
        "message-effect" => "Message effect".into(),
        _ => str_field(details, "title")
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("Power-up")
            .to_string(),
    }
}

fn power_up_line(details: &Value) -> String {
    let bits = plural(
        u64_field(details, "bits").unwrap_or(0) as i64,
        "bit",
        "bits",
    );
    match str_field(details, "powerUp").unwrap_or("custom") {
        "celebration" => format!("Used a Celebration · {bits}"),
        "gigantify-an-emote" => format!("{} · {bits}", power_up_name(details)),
        "message-effect" => format!("Sent a message effect · {bits}"),
        _ => match str_field(details, "title")
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(title) => format!("Used {title} · {bits}"),
            None => format!("Used a Power-up · {bits}"),
        },
    }
}

fn redemption_name(details: &Value) -> String {
    match str_field(details, "reward").unwrap_or("other") {
        "custom" => str_field(details, "title")
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("a reward")
            .to_string(),
        "highlighted-message" => "Highlighted message".into(),
        "sub-only-message" => "Message in sub-only mode".into(),
        "random-emote-unlock" | "chosen-emote-unlock" | "modified-emote-unlock" => {
            match str_field(details, "emoteName") {
                Some(name) => format!("Unlocked {name}"),
                None => "Unlocked an emote".into(),
            }
        }
        _ => "a reward".into(),
    }
}

fn redemption_points(details: &Value) -> Option<String> {
    let points = u64_field(details, "channelPoints").unwrap_or(0);
    if points == 0 {
        return None;
    }
    match str_field(details, "pointsName")
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        Some(currency) => Some(format!("{} {currency}", group_thousands(points as i64))),
        None => Some(plural(points as i64, "point", "points")),
    }
}

fn redemption_line(details: &Value) -> String {
    let name = redemption_name(details);
    let action = if name.starts_with("Unlocked") {
        name.clone()
    } else {
        format!("Redeemed {name}")
    };
    match redemption_points(details) {
        Some(points) => format!("{action} · {points}"),
        None => action,
    }
}

fn redemption_short(details: &Value) -> String {
    match redemption_points(details) {
        Some(points) => format!("{} · {points}", redemption_name(details)),
        None => redemption_name(details),
    }
}

fn item_from_message(message: &LiveChatMessage) -> Option<ActivityItem> {
    let details = message.details.as_ref()?;
    if message.is_deleted {
        return None;
    }
    let kind = str_field(details, "kind")?;
    let viewer_words = if message.event_type == "paid" || kind == "membership" {
        let words = message.message_text.trim();
        (!words.is_empty()).then(|| words.to_string())
    } else if kind == "subscription" || kind == "watch-streak" {
        notice_viewer_words(message)
    } else {
        None
    };
    let base = |activity_kind: ActivityKind,
                filter: Option<ActivityFilter>,
                line: String,
                short: String| {
        ActivityItem {
            id: message.id.clone(),
            kind: activity_kind,
            filter,
            platform: message.platform.clone(),
            name: message.author_name.clone(),
            line,
            short,
            message: viewer_words.clone(),
            at: message.received_at.clone(),
            message_id: Some(message.id.clone()),
            gift: false,
            unnamed: false,
        }
    };
    Some(match kind {
        "follow" => base(
            ActivityKind::Follow,
            Some(ActivityFilter::Follows),
            "Followed".into(),
            "Follow".into(),
        ),
        "subscription" => {
            let gift = matches!(
                str_field(details, "subscription"),
                Some("sub-gift" | "community-sub-gift")
            );
            let mut item = base(
                ActivityKind::Subscription,
                Some(ActivityFilter::Support),
                subscription_line(details),
                subscription_short(details),
            );
            item.gift = gift;
            item
        }
        "membership" => {
            let gift = str_field(details, "membership") == Some("gift");
            let mut item = base(
                ActivityKind::Membership,
                Some(ActivityFilter::Support),
                membership_line(details),
                membership_short(details),
            );
            item.gift = gift;
            item
        }
        "kicks" => {
            let amount = u64_field(details, "amount").unwrap_or(0);
            let gift = str_field(details, "giftName")
                .map(|name| format!(" · {name}"))
                .unwrap_or_default();
            let mut item = base(
                ActivityKind::Kicks,
                Some(ActivityFilter::Tips),
                format!("Sent {}{gift}", plural(amount as i64, "KICK", "KICKs")),
                plural(amount as i64, "KICK", "KICKs"),
            );
            if item.message.is_none() {
                item.message = viewer_words;
            }
            item
        }
        "cheer" => {
            let bits = u64_field(details, "bits").unwrap_or(0);
            let words = message
                .message_text
                .split_whitespace()
                .filter(|word| !word.to_ascii_lowercase().starts_with("cheer"))
                .collect::<Vec<_>>()
                .join(" ");
            let mut item = base(
                ActivityKind::Cheer,
                Some(ActivityFilter::Tips),
                format!("Cheered {}", plural(bits as i64, "bit", "bits")),
                plural(bits as i64, "bit", "bits"),
            );
            let trimmed = words.trim();
            if !trimmed.is_empty() {
                item.message = Some(trimmed.to_string());
            }
            item
        }
        "super-chat" => {
            let amount = str_field(details, "amountDisplay").unwrap_or("Super Chat");
            base(
                ActivityKind::SuperChat,
                Some(ActivityFilter::Tips),
                format!("Super Chat · {amount}"),
                format!("{amount} Super Chat"),
            )
        }
        "super-sticker" => {
            let amount = str_field(details, "amountDisplay").unwrap_or("Super Sticker");
            let mut item = base(
                ActivityKind::SuperSticker,
                Some(ActivityFilter::Tips),
                format!("Super Sticker · {amount}"),
                format!("{amount} Super Sticker"),
            );
            if let Some(alt) = str_field(details, "altText")
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                item.message = Some(alt.to_string());
            }
            item
        }
        "raid" => {
            let viewers = u64_field(details, "viewerCount").unwrap_or(0);
            base(
                ActivityKind::Raid,
                Some(ActivityFilter::Raids),
                format!(
                    "Raided with {}",
                    plural(viewers as i64, "viewer", "viewers")
                ),
                format!("Raid · {}", plural(viewers as i64, "viewer", "viewers")),
            )
        }
        "watch-streak" => {
            let streak = u64_field(details, "streakCount").unwrap_or(0);
            base(
                ActivityKind::WatchStreak,
                Some(ActivityFilter::Streaks),
                format!(
                    "Reached a {}-stream watch streak",
                    group_thousands(streak as i64)
                ),
                format!("Streak · {}", plural(streak as i64, "stream", "streams")),
            )
        }
        "announcement" => {
            let mut item = base(
                ActivityKind::Announcement,
                None,
                "Announcement".into(),
                "Announcement".into(),
            );
            let words = message.message_text.trim();
            if !words.is_empty() {
                item.message = Some(words.to_string());
            }
            item
        }
        "power-up" => {
            let bits = u64_field(details, "bits").unwrap_or(0);
            let mut item = base(
                ActivityKind::PowerUp,
                Some(ActivityFilter::Tips),
                power_up_line(details),
                format!(
                    "{} · {}",
                    power_up_name(details),
                    plural(bits as i64, "bit", "bits")
                ),
            );
            item.message = activity_words(message);
            item
        }
        "redemption" => {
            let mut item = base(
                ActivityKind::Redemption,
                Some(ActivityFilter::Rewards),
                redemption_line(details),
                redemption_short(details),
            );
            item.message = activity_words(message);
            item
        }
        _ => return None,
    })
}

fn item_from_destination(event: &DestinationEvent) -> ActivityItem {
    let failed = event.kind == "failed";
    ActivityItem {
        id: format!("destination:{}", event.id),
        kind: if failed {
            ActivityKind::DestinationFailed
        } else {
            ActivityKind::DestinationRecovered
        },
        filter: Some(ActivityFilter::Destinations),
        platform: event.platform.clone(),
        name: event.label.clone(),
        line: if failed {
            "Destination failed".into()
        } else {
            "Back on air".into()
        },
        short: if failed {
            "Failed".into()
        } else {
            "Back on air".into()
        },
        message: if failed { event.message.clone() } else { None },
        at: event.at.clone(),
        message_id: None,
        gift: false,
        unnamed: false,
    }
}

fn gain_is_named(at: &str, since: Option<&str>, until: Option<&str>) -> bool {
    let Some(since) = since else {
        return false;
    };
    let Ok(read) = chrono::DateTime::parse_from_rfc3339(at) else {
        return false;
    };
    let Ok(since_at) = chrono::DateTime::parse_from_rfc3339(since) else {
        return false;
    };
    if read < since_at {
        return false;
    }
    match until {
        Some(until) => chrono::DateTime::parse_from_rfc3339(until)
            .map(|until_at| read < until_at)
            .unwrap_or(true),
        None => true,
    }
}

fn items_from_follower_gains(audience: Option<&AudienceSnapshot>) -> Vec<ActivityItem> {
    let Some(audience) = audience else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for entry in &audience.platforms {
        if entry.platform == "kick" || entry.metric != "followers" {
            continue;
        }
        for gain in &entry.follower_gains {
            if gain_is_named(
                &gain.at,
                entry.named_follows_since.as_deref(),
                entry.named_follows_until.as_deref(),
            ) {
                continue;
            }
            let name = if gain.count == 1 {
                "New follower".into()
            } else {
                format!("{} new followers", group_thousands(gain.count as i64))
            };
            let why = if entry.platform == "twitch" {
                "Reconnect Twitch to name them from now on."
            } else {
                "X didn't say who followed."
            };
            items.push(ActivityItem {
                id: format!("follower-gain:{}:{}", entry.platform, gain.at),
                kind: ActivityKind::Follow,
                filter: Some(ActivityFilter::Follows),
                platform: entry.platform.clone(),
                name,
                line: format!(
                    "{}. {why}",
                    plural(gain.count as i64, "new follower", "new followers")
                ),
                short: String::new(),
                message: None,
                at: gain.at.clone(),
                message_id: None,
                gift: false,
                unnamed: true,
            });
        }
    }
    items
}

fn parse_at(at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|at| at.timestamp_millis())
        .unwrap_or(0)
}

/// Activity rows, newest first (`activityItems`).
pub fn activity_items(
    messages: &[Arc<LiveChatMessage>],
    destination_events: &[DestinationEvent],
    audience: Option<&AudienceSnapshot>,
) -> Vec<ActivityItem> {
    let mut community_gifts = std::collections::HashSet::new();
    for message in messages {
        let Some(details) = message.details.as_ref() else {
            continue;
        };
        if str_field(details, "kind") == Some("subscription")
            && str_field(details, "subscription") == Some("community-sub-gift")
            && let Some(id) = str_field(details, "communityGiftId")
        {
            community_gifts.insert(id.to_string());
        }
    }
    let mut items = Vec::new();
    for message in messages {
        if let Some(details) = message.details.as_ref()
            && str_field(details, "kind") == Some("subscription")
            && str_field(details, "subscription") == Some("sub-gift")
            && let Some(id) = str_field(details, "communityGiftId")
            && community_gifts.contains(id)
        {
            continue;
        }
        if let Some(item) = item_from_message(message) {
            items.push(item);
        }
    }
    for event in destination_events {
        items.push(item_from_destination(event));
    }
    items.extend(items_from_follower_gains(audience));
    items.sort_by_key(|item| std::cmp::Reverse(parse_at(&item.at)));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream_manager::dashboard::FollowerGain;

    fn message(id: &str, kind: &str, extras: Value) -> Arc<LiveChatMessage> {
        let mut details = extras;
        if let Value::Object(map) = &mut details {
            map.insert("kind".into(), Value::String(kind.into()));
        }
        Arc::new(LiveChatMessage {
            id: id.into(),
            session_id: "s".into(),
            platform: "twitch".into(),
            author_name: "Ada".into(),
            received_at: format!("2026-11-10T10:00:{id}Z"),
            message_text: String::new(),
            event_type: "membership".into(),
            details: Some(details),
            ..LiveChatMessage::default()
        })
    }

    #[test]
    fn follows_subs_and_destinations_become_rows() {
        let follow = message("01", "follow", serde_json::json!({}));
        let sub = message(
            "02",
            "subscription",
            serde_json::json!({"subscription": "sub", "tier": "1000"}),
        );
        let failed = DestinationEvent {
            id: "d1".into(),
            kind: "failed",
            target_id: "t".into(),
            platform: "youtube".into(),
            label: "Main".into(),
            message: Some("timeout".into()),
            at: "2026-11-10T10:00:03Z".into(),
        };
        let items = activity_items(&[follow, sub], &[failed], None);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].line, "Destination failed");
        assert_eq!(items[1].short, "New sub");
        assert_eq!(items[2].line, "Followed");
    }

    #[test]
    fn unnamed_follower_gains_join_the_list() {
        let audience = AudienceSnapshot {
            session_id: "s".into(),
            updated_at: "2026-11-10T10:00:00Z".into(),
            platforms: vec![crate::stream_manager::dashboard::PlatformAudience {
                platform: "x".into(),
                metric: "followers".into(),
                total: Some(10),
                delta: Some(1),
                follower_gains: vec![FollowerGain {
                    at: "2026-11-10T09:59:00Z".into(),
                    count: 2,
                }],
                ..Default::default()
            }],
        };
        let items = activity_items(&[], &[], Some(&audience));
        assert_eq!(items.len(), 1);
        assert!(items[0].unnamed);
        assert!(items[0].line.contains("2 new followers"));
    }
}
