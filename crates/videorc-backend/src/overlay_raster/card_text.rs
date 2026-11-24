//! What the highlight card says for a chat message, `commentHighlightCardText`
//! in `caption-overlay.ts` over `itemFromMessage` in `stream-activity.ts`: an
//! activity event (a sub, a gift, a raid, a Super Chat) leads with what
//! happened, then the viewer's own words; plain chat is the message. An
//! activity card stays text: its emotes are never drawn.

use crate::live_chat::{
    LiveChatEventDetails, LiveChatEventType, LiveChatMessage, LiveChatMessageFragment,
    MembershipKind, PowerUpKind, RedemptionKind, SubscriptionKind,
};

/// The card's text for `message`.
pub(crate) fn card_text(message: &LiveChatMessage) -> String {
    match activity(message) {
        Some((line, Some(words))) => format!("{line}: {words}"),
        Some((line, None)) => line,
        None => message.message_text.clone(),
    }
}

/// The fragments the card draws emotes from: none for an activity card,
/// which leads with the event line (plan 095, S4).
pub(crate) fn card_fragments(message: &LiveChatMessage) -> Option<&[LiveChatMessageFragment]> {
    if message.details.is_some() {
        None
    } else {
        Some(&message.fragments)
    }
}

/// `Number.prototype.toLocaleString()` in the app's en-US locale: 1,500.
fn locale_number(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// `plural`: "1 bit", "1,500 bits".
fn plural(count: u64, one: &str, many: &str) -> String {
    format!(
        "{} {}",
        locale_number(count),
        if count == 1 { one } else { many }
    )
}

/// A JavaScript-truthy string: present and not empty.
fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

/// Present after trimming.
fn trimmed(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn fragment_words(message: &LiveChatMessage) -> Option<String> {
    let words: String = message
        .fragments
        .iter()
        .map(|fragment| fragment.text.as_str())
        .collect();
    non_empty(&words)
}

/// `noticeViewerWords`: a Twitch notice's own words, when they differ from
/// Twitch's system text.
fn notice_viewer_words(message: &LiveChatMessage) -> Option<String> {
    if !message
        .raw_provider_type
        .as_deref()
        .is_some_and(|kind| kind.starts_with("channel.chat.notification"))
    {
        return None;
    }
    if matches!(
        message.details,
        Some(LiveChatEventDetails::Announcement { .. })
    ) {
        return None;
    }
    let words = fragment_words(message)?;
    (words != message.message_text.trim()).then_some(words)
}

fn tier_label(tier: Option<&str>, is_prime: bool) -> &'static str {
    if is_prime {
        return "Prime";
    }
    match tier {
        Some("1000") => "Tier 1",
        Some("2000") => "Tier 2",
        Some("3000") => "Tier 3",
        _ => "a sub",
    }
}

/// Removes every `Cheer<digits>` word, any case (`/\bCheer\d+\b/gi`).
fn strip_cheers(text: &str) -> String {
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut copied = 0;
    while at < bytes.len() {
        let boundary_before = at == 0 || !word(bytes[at - 1]);
        if boundary_before
            && bytes.len() - at > 5
            && bytes[at..at + 5].eq_ignore_ascii_case(b"cheer")
            && bytes[at + 5].is_ascii_digit()
        {
            let mut end = at + 5;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end == bytes.len() || !word(bytes[end]) {
                out.push_str(&text[copied..at]);
                copied = end;
                at = end;
                continue;
            }
        }
        at += 1;
    }
    out.push_str(&text[copied..]);
    out
}

fn subscription_line(
    subscription: SubscriptionKind,
    tier: Option<&str>,
    is_prime: bool,
    months: Option<u32>,
    gift_count: Option<u32>,
    recipient_name: Option<&str>,
) -> String {
    let label = tier_label(tier, is_prime);
    // Kick subs have no tier (plan 066): "Subscribed", never "at a sub".
    let tiered = is_prime || tier.is_some();
    let gift_sub = if tiered {
        format!("a {label} sub")
    } else {
        "a sub".to_string()
    };
    match subscription {
        SubscriptionKind::Sub if is_prime => "Subscribed with Prime".to_string(),
        SubscriptionKind::Sub if tiered => format!("Subscribed at {label}"),
        SubscriptionKind::Sub => "Subscribed".to_string(),
        SubscriptionKind::Resub => {
            let months = months
                .filter(|months| *months > 0)
                .map(|months| format!(" for {}", plural(months.into(), "month", "months")))
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
        SubscriptionKind::SubGift => match recipient_name {
            Some(name) => format!("Gifted {gift_sub} to {name}"),
            None => format!("Gifted {gift_sub}"),
        },
        SubscriptionKind::CommunitySubGift => {
            format!(
                "Gifted {}",
                plural(gift_count.unwrap_or(1).into(), "sub", "subs")
            )
        }
        SubscriptionKind::GiftPaidUpgrade => "Continued their gifted sub".to_string(),
        SubscriptionKind::PrimePaidUpgrade => format!("Upgraded from Prime to {label}"),
        SubscriptionKind::PayItForward => "Paid a gifted sub forward".to_string(),
    }
}

fn membership_line(
    membership: MembershipKind,
    level_name: Option<&str>,
    months: Option<u32>,
    gift_count: Option<u32>,
) -> String {
    match membership {
        MembershipKind::New => match level_name {
            Some(level) => format!("Joined as {level}"),
            None => "Became a member".to_string(),
        },
        MembershipKind::Upgrade => match level_name {
            Some(level) => format!("Upgraded to {level}"),
            None => "Upgraded their membership".to_string(),
        },
        MembershipKind::Milestone => match months.filter(|months| *months > 0) {
            Some(months) => format!("Member for {}", plural(months.into(), "month", "months")),
            None => "Membership milestone".to_string(),
        },
        MembershipKind::Gift => format!(
            "Gifted {}",
            plural(gift_count.unwrap_or(1).into(), "membership", "memberships")
        ),
        MembershipKind::GiftReceived => "Received a gifted membership".to_string(),
    }
}

fn power_up_name(power_up: PowerUpKind, emote_name: Option<&str>, title: Option<&str>) -> String {
    match power_up {
        PowerUpKind::Celebration => "Celebration".to_string(),
        PowerUpKind::GigantifyAnEmote => match emote_name {
            Some(emote) => format!("Gigantified {emote}"),
            None => "Gigantified an emote".to_string(),
        },
        PowerUpKind::MessageEffect => "Message effect".to_string(),
        PowerUpKind::Custom => title.unwrap_or("Power-up").to_string(),
    }
}

fn power_up_line(
    power_up: PowerUpKind,
    bits: u64,
    emote_name: Option<&str>,
    title: Option<&str>,
) -> String {
    let bits = plural(bits, "bit", "bits");
    match power_up {
        PowerUpKind::Celebration => format!("Used a Celebration · {bits}"),
        PowerUpKind::GigantifyAnEmote => {
            format!("{} · {bits}", power_up_name(power_up, emote_name, title))
        }
        PowerUpKind::MessageEffect => format!("Sent a message effect · {bits}"),
        PowerUpKind::Custom => match title {
            Some(title) => format!("Used {title} · {bits}"),
            None => format!("Used a Power-up · {bits}"),
        },
    }
}

fn redemption_line(
    reward: RedemptionKind,
    channel_points: u64,
    title: Option<&str>,
    emote_name: Option<&str>,
    points_name: Option<&str>,
) -> String {
    let name = match reward {
        RedemptionKind::Custom => title.unwrap_or("a reward").to_string(),
        RedemptionKind::HighlightedMessage => "Highlighted message".to_string(),
        RedemptionKind::SubOnlyMessage => "Message in sub-only mode".to_string(),
        RedemptionKind::RandomEmoteUnlock
        | RedemptionKind::ChosenEmoteUnlock
        | RedemptionKind::ModifiedEmoteUnlock => match emote_name {
            Some(emote) => format!("Unlocked {emote}"),
            None => "Unlocked an emote".to_string(),
        },
        RedemptionKind::Other => "a reward".to_string(),
    };
    let action = if name.starts_with("Unlocked") {
        name
    } else {
        format!("Redeemed {name}")
    };
    let points = (channel_points > 0).then(|| match points_name {
        Some(currency) => format!("{} {currency}", locale_number(channel_points)),
        None => plural(channel_points, "point", "points"),
    });
    match points {
        Some(points) => format!("{action} · {points}"),
        None => action,
    }
}

/// `itemFromMessage`'s line and words, or None for plain chat (and a deleted
/// event).
fn activity(message: &LiveChatMessage) -> Option<(String, Option<String>)> {
    let details = message.details.as_ref()?;
    if message.is_deleted {
        return None;
    }
    let viewer_words = || {
        if message.event_type == LiveChatEventType::Paid
            || matches!(details, LiveChatEventDetails::Membership { .. })
        {
            non_empty(&message.message_text)
        } else if matches!(
            details,
            LiveChatEventDetails::Subscription { .. } | LiveChatEventDetails::WatchStreak { .. }
        ) {
            notice_viewer_words(message)
        } else {
            None
        }
    };
    Some(match details {
        LiveChatEventDetails::Follow { .. } => ("Followed".to_string(), None),
        LiveChatEventDetails::Subscription {
            subscription,
            tier,
            is_prime,
            months,
            gift_count,
            recipient_name,
            ..
        } => (
            subscription_line(
                *subscription,
                tier.as_deref(),
                *is_prime,
                *months,
                *gift_count,
                present(recipient_name),
            ),
            viewer_words(),
        ),
        LiveChatEventDetails::Membership {
            membership,
            level_name,
            months,
            gift_count,
        } => (
            membership_line(*membership, present(level_name), *months, *gift_count),
            viewer_words(),
        ),
        LiveChatEventDetails::Kicks { amount, gift_name } => (
            match present(gift_name) {
                Some(gift) => format!("Sent {} · {gift}", plural(*amount, "KICK", "KICKs")),
                None => format!("Sent {}", plural(*amount, "KICK", "KICKs")),
            },
            viewer_words(),
        ),
        LiveChatEventDetails::Cheer { bits } => (
            format!("Cheered {}", plural(*bits, "bit", "bits")),
            non_empty(&strip_cheers(&message.message_text)),
        ),
        LiveChatEventDetails::SuperChat { amount_display, .. } => {
            (format!("Super Chat · {amount_display}"), viewer_words())
        }
        LiveChatEventDetails::SuperSticker {
            amount_display,
            alt_text,
            ..
        } => (
            format!("Super Sticker · {amount_display}"),
            present(alt_text).map(str::to_string),
        ),
        LiveChatEventDetails::Raid { viewer_count } => (
            format!("Raided with {}", plural(*viewer_count, "viewer", "viewers")),
            None,
        ),
        LiveChatEventDetails::WatchStreak { streak_count, .. } => (
            format!(
                "Reached a {}-stream watch streak",
                locale_number((*streak_count).into())
            ),
            viewer_words(),
        ),
        LiveChatEventDetails::Announcement { .. } => {
            ("Announcement".to_string(), non_empty(&message.message_text))
        }
        LiveChatEventDetails::PowerUp {
            bits,
            power_up,
            emote_name,
            title,
        } => (
            power_up_line(*power_up, *bits, present(emote_name), trimmed(title)),
            fragment_words(message),
        ),
        LiveChatEventDetails::Redemption {
            reward,
            channel_points,
            title,
            emote_name,
            points_name,
        } => (
            redemption_line(
                *reward,
                *channel_points,
                trimmed(title),
                present(emote_name),
                trimmed(points_name),
            ),
            fragment_words(message),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::StreamPlatform;

    fn base(event_type: LiveChatEventType, text: &str) -> LiveChatMessage {
        LiveChatMessage {
            id: "s:twitch:1".to_string(),
            provider_message_id: "1".to_string(),
            platform: StreamPlatform::Twitch,
            target_id: None,
            session_id: "s".to_string(),
            author_id: None,
            author_name: "morgaesis".to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_affiliation: None,
            author_verified: None,
            author_roles: Vec::new(),
            published_at: "2026-09-24T10:00:00Z".to_string(),
            received_at: "2026-09-24T10:00:00Z".to_string(),
            message_text: text.to_string(),
            fragments: Vec::new(),
            event_type,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: None,
            details: None,
            reply: None,
            first_message: false,
            first_in_session: false,
            author_handle: None,
            arrival: None,
        }
    }

    // The cases of `commentHighlightCardText` in caption-overlay.test.ts.
    #[test]
    fn an_activity_card_leads_with_what_happened() {
        let mut resub = base(
            LiveChatEventType::Membership,
            "morgaesis subscribed at Tier 1. They've subscribed for 8 months!",
        );
        resub.details = Some(LiveChatEventDetails::Subscription {
            subscription: SubscriptionKind::Resub,
            tier: Some("1000".to_string()),
            is_prime: false,
            months: Some(8),
            streak_months: None,
            gift_count: None,
            recipient_name: None,
            community_gift_id: None,
        });
        assert_eq!(card_text(&resub), "Resubscribed for 8 months at Tier 1");
        assert!(card_fragments(&resub).is_none());

        let mut cheer = base(LiveChatEventType::Paid, "Cheer1500 amazing setup");
        cheer.details = Some(LiveChatEventDetails::Cheer { bits: 1500 });
        assert_eq!(card_text(&cheer), "Cheered 1,500 bits: amazing setup");
    }

    #[test]
    fn a_watch_streak_leads_with_its_length_then_the_words() {
        let mut streak = base(
            LiveChatEventType::System,
            "Snowy77x watched 20 consecutive streams and sparked a watch streak!",
        );
        streak.author_name = "Snowy77x".to_string();
        streak.raw_provider_type = Some("channel.chat.notification:watch_streak".to_string());
        streak.details = Some(LiveChatEventDetails::WatchStreak {
            streak_count: 20,
            channel_points_awarded: None,
        });
        assert_eq!(card_text(&streak), "Reached a 20-stream watch streak");
        streak.fragments = vec![LiveChatMessageFragment {
            fragment_type: "text".to_string(),
            text: "welcome back hands <3".to_string(),
            image_url: None,
            zero_width: false,
        }];
        assert_eq!(
            card_text(&streak),
            "Reached a 20-stream watch streak: welcome back hands <3"
        );
    }

    #[test]
    fn plain_chat_is_the_message_itself() {
        let message = base(LiveChatEventType::Message, "hi");
        assert_eq!(card_text(&message), "hi");
        assert!(card_fragments(&message).is_some());
    }

    #[test]
    fn the_other_events_read_as_the_activity_pane_does() {
        let line = |details: LiveChatEventDetails, event_type, text: &str| {
            let mut message = base(event_type, text);
            message.details = Some(details);
            card_text(&message)
        };
        assert_eq!(
            line(
                LiveChatEventDetails::Raid { viewer_count: 1 },
                LiveChatEventType::System,
                "x"
            ),
            "Raided with 1 viewer"
        );
        assert_eq!(
            line(
                LiveChatEventDetails::SuperChat {
                    amount_micros: 5_000_000,
                    currency: "USD".to_string(),
                    amount_display: "$5.00".to_string(),
                    tier: None,
                },
                LiveChatEventType::Paid,
                "  great stream "
            ),
            "Super Chat · $5.00: great stream"
        );
        assert_eq!(
            line(
                LiveChatEventDetails::Subscription {
                    subscription: SubscriptionKind::CommunitySubGift,
                    tier: Some("1000".to_string()),
                    is_prime: false,
                    months: None,
                    streak_months: None,
                    gift_count: Some(1200),
                    recipient_name: None,
                    community_gift_id: None,
                },
                LiveChatEventType::System,
                "x"
            ),
            "Gifted 1,200 subs"
        );
        assert_eq!(
            line(
                LiveChatEventDetails::Subscription {
                    subscription: SubscriptionKind::Sub,
                    tier: None,
                    is_prime: false,
                    months: None,
                    streak_months: None,
                    gift_count: None,
                    recipient_name: None,
                    community_gift_id: None,
                },
                LiveChatEventType::System,
                "x"
            ),
            "Subscribed"
        );
        assert_eq!(
            line(
                LiveChatEventDetails::Redemption {
                    reward: RedemptionKind::Custom,
                    channel_points: 500,
                    title: Some(" Hydrate ".to_string()),
                    emote_name: None,
                    points_name: Some("Orc Gold".to_string()),
                },
                LiveChatEventType::Redemption,
                ""
            ),
            "Redeemed Hydrate · 500 Orc Gold"
        );
        assert_eq!(
            line(
                LiveChatEventDetails::Membership {
                    membership: MembershipKind::New,
                    level_name: Some(String::new()),
                    months: None,
                    gift_count: None,
                },
                LiveChatEventType::Membership,
                ""
            ),
            "Became a member"
        );
    }

    #[test]
    fn cheer_words_lose_their_cheermotes_only() {
        assert_eq!(
            strip_cheers("Cheer100 hi cheer5 Cheerful Cheer10x"),
            " hi  Cheerful Cheer10x"
        );
        assert_eq!(locale_number(1_234_567), "1,234,567");
        assert_eq!(locale_number(999), "999");
    }
}
