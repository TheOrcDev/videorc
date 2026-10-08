//! The automatic chat throttle (plan 164 D9): pure and clock-injected.
//!
//! Per destination: at most [`PER_MINUTE_MAX`] automatic sends a minute and
//! never two within [`MIN_GAP`]. Per event kind: a cooldown
//! ([`kind_cooldown`]); same-kind events inside it wait in a bucket, and a
//! bucket of more than [`COLLAPSE_THRESHOLD`] flushes as ONE collapsed
//! greeting (`{names}` / `{others}`). One greeting per (destination, viewer,
//! kind) a session. The YouTube breaker and the failed-destination rule are
//! checked by the sender with live state; this module only keeps time.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::cohost::CohostActivityTemplateKind;
use crate::cohost_greetings::ActivityFacts;

pub(crate) const PER_MINUTE_MAX: usize = 6;
pub(crate) const MIN_GAP: Duration = Duration::from_secs(5);
const MINUTE: Duration = Duration::from_secs(60);
/// More than this many same-kind events inside the cooldown collapse.
pub(crate) const COLLAPSE_THRESHOLD: usize = 3;

/// The cooldown between two greetings of one kind on one destination (D9).
pub(crate) fn kind_cooldown(kind: CohostActivityTemplateKind) -> Duration {
    use CohostActivityTemplateKind as K;
    Duration::from_secs(match kind {
        K::Follow => 10,
        K::Sub | K::Resub | K::SubGift | K::CommunitySubGift | K::Membership => 5,
        K::Cheer | K::Kicks | K::SuperChat | K::SuperSticker => 5,
        K::Raid => 60,
        K::WatchStreak => 15,
        K::PowerUp | K::Redemption => 10,
    })
}

/// What the throttle says about one greeting event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GreetingOffer {
    /// Send one greeting for these events now (one event, or a collapsed
    /// burst the kind cooldown just released).
    SendNow(Vec<ActivityFacts>),
    /// Waiting in the kind's bucket; `drain_due` releases it at `due`.
    Held { due: Instant },
    /// This viewer already got this kind of greeting on this destination.
    Deduped,
}

#[derive(Debug)]
struct Bucket {
    due: Instant,
    events: Vec<ActivityFacts>,
}

type KindKey = (String, CohostActivityTemplateKind);

#[derive(Debug, Default)]
pub(crate) struct AutoChatThrottle {
    /// Automatic sends per destination in the last minute, oldest first.
    sent: HashMap<String, VecDeque<Instant>>,
    /// The last greeting per (destination, kind).
    kind_last: HashMap<KindKey, Instant>,
    /// (destination, viewer, kind) already greeted this session.
    greeted: HashSet<(String, String, CohostActivityTemplateKind)>,
    buckets: HashMap<KindKey, Bucket>,
}

impl AutoChatThrottle {
    /// When the global limiter admits a send on `destination`: `Ok` now,
    /// else the earliest instant it will.
    pub(crate) fn admit(&self, destination: &str, now: Instant) -> Result<(), Instant> {
        let Some(sent) = self.sent.get(destination) else {
            return Ok(());
        };
        let recent: Vec<Instant> = sent
            .iter()
            .copied()
            .filter(|at| now.saturating_duration_since(*at) < MINUTE)
            .collect();
        let mut earliest = now;
        if let Some(last) = recent.last()
            && now.saturating_duration_since(*last) < MIN_GAP
        {
            earliest = earliest.max(*last + MIN_GAP);
        }
        if recent.len() >= PER_MINUTE_MAX
            && let Some(oldest) = recent.first()
        {
            earliest = earliest.max(*oldest + MINUTE);
        }
        if earliest > now {
            Err(earliest)
        } else {
            Ok(())
        }
    }

    /// An automatic send went out on `destination` (reserve the slot before
    /// the network call, so a burst never double-books it).
    pub(crate) fn note_sent(&mut self, destination: &str, now: Instant) {
        let sent = self.sent.entry(destination.to_string()).or_default();
        sent.push_back(now);
        while sent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= MINUTE)
        {
            sent.pop_front();
        }
    }

    /// Offer one greeting event.
    pub(crate) fn offer_greeting(&mut self, facts: ActivityFacts, now: Instant) -> GreetingOffer {
        let dedupe = (
            facts.destination_id.clone(),
            facts.viewer_key.clone(),
            facts.kind,
        );
        if !self.greeted.insert(dedupe) {
            return GreetingOffer::Deduped;
        }
        let key = (facts.destination_id.clone(), facts.kind);
        let cooldown_over = self
            .kind_last
            .get(&key)
            .is_none_or(|last| now.saturating_duration_since(*last) >= kind_cooldown(facts.kind));
        if let Some(bucket) = self.buckets.get_mut(&key) {
            bucket.events.push(facts);
            return GreetingOffer::Held { due: bucket.due };
        }
        if cooldown_over && self.admit(&facts.destination_id, now).is_ok() {
            self.kind_last.insert(key, now);
            self.note_sent(&facts.destination_id, now);
            return GreetingOffer::SendNow(vec![facts]);
        }
        let due = self.hold_due(&key, now);
        self.buckets.insert(
            key,
            Bucket {
                due,
                events: vec![facts],
            },
        );
        GreetingOffer::Held { due }
    }

    fn hold_due(&self, key: &KindKey, now: Instant) -> Instant {
        let cooldown_end = self
            .kind_last
            .get(key)
            .map_or(now, |last| *last + kind_cooldown(key.1));
        let admit_at = self.admit(&key.0, now).err().unwrap_or(now);
        cooldown_end.max(admit_at).max(now)
    }

    /// The earliest instant a held bucket is due, for the pump.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.buckets.values().map(|bucket| bucket.due).min()
    }

    /// Release every bucket whose time came: a bucket over the collapse
    /// threshold goes out as one collapsed greeting; a smaller one sends its
    /// first event and re-arms for the rest. A destination the global
    /// limiter still refuses keeps its bucket, pushed to the admit time.
    pub(crate) fn drain_due(&mut self, now: Instant) -> Vec<Vec<ActivityFacts>> {
        let mut keys: Vec<KindKey> = self
            .buckets
            .iter()
            .filter(|(_, bucket)| bucket.due <= now)
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort_by_key(|key| self.buckets[key].due);
        let mut released = Vec::new();
        for key in keys {
            if let Err(admit_at) = self.admit(&key.0, now) {
                if let Some(bucket) = self.buckets.get_mut(&key) {
                    bucket.due = admit_at;
                }
                continue;
            }
            let Some(mut bucket) = self.buckets.remove(&key) else {
                continue;
            };
            let batch = if bucket.events.len() > COLLAPSE_THRESHOLD {
                std::mem::take(&mut bucket.events)
            } else {
                vec![bucket.events.remove(0)]
            };
            self.kind_last.insert(key.clone(), now);
            self.note_sent(&key.0, now);
            if !bucket.events.is_empty() {
                bucket.due = now + kind_cooldown(key.1);
                self.buckets.insert(key, bucket);
            }
            released.push(batch);
        }
        released
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::StreamPlatform;

    fn follow(viewer: &str) -> ActivityFacts {
        ActivityFacts {
            kind: CohostActivityTemplateKind::Follow,
            platform: StreamPlatform::Twitch,
            destination_id: "twitch:main".to_string(),
            viewer_key: viewer.to_lowercase(),
            message_id: format!("m-{viewer}"),
            name: viewer.to_string(),
            handle: format!("@{}", viewer.to_lowercase()),
            months: None,
            streak: None,
            count: None,
            amount: None,
            reward: None,
        }
    }

    fn cheer(viewer: &str) -> ActivityFacts {
        ActivityFacts {
            kind: CohostActivityTemplateKind::Cheer,
            amount: Some("100 bits".into()),
            ..follow(viewer)
        }
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn a_fifty_follow_burst_sends_one_now_one_collapsed_at_ten_seconds_then_dedupes() {
        let start = Instant::now();
        let mut throttle = AutoChatThrottle::default();
        let names: Vec<String> = (1..=50).map(|n| format!("Fan{n}")).collect();
        let mut sent_now = 0;
        let mut held = 0;
        for (index, name) in names.iter().enumerate() {
            let at = start + Duration::from_millis(index as u64 * 40);
            match throttle.offer_greeting(follow(name), at) {
                GreetingOffer::SendNow(batch) => {
                    assert_eq!(batch.len(), 1);
                    assert_eq!(batch[0].name, "Fan1");
                    sent_now += 1;
                }
                GreetingOffer::Held { due } => {
                    assert_eq!(due, start + secs(10), "held until the follow cooldown ends");
                    held += 1;
                }
                GreetingOffer::Deduped => panic!("distinct viewers never dedupe"),
            }
        }
        assert_eq!((sent_now, held), (1, 49));
        assert!(throttle.drain_due(start + secs(9)).is_empty());
        let released = throttle.drain_due(start + secs(10));
        assert_eq!(released.len(), 1, "one collapsed greeting");
        assert_eq!(released[0].len(), 49);
        assert_eq!(released[0][0].name, "Fan2");
        assert!(throttle.drain_due(start + secs(60)).is_empty());
        // The same viewers again: greeted once per session.
        for name in &names {
            assert_eq!(
                throttle.offer_greeting(follow(name), start + secs(30)),
                GreetingOffer::Deduped
            );
        }
        assert_eq!(throttle.next_due(), None);
    }

    #[test]
    fn two_or_three_same_kind_events_go_out_one_per_cooldown_not_collapsed() {
        let start = Instant::now();
        let mut throttle = AutoChatThrottle::default();
        assert!(matches!(
            throttle.offer_greeting(cheer("A"), start),
            GreetingOffer::SendNow(_)
        ));
        assert!(matches!(
            throttle.offer_greeting(cheer("B"), start + secs(1)),
            GreetingOffer::Held { .. }
        ));
        assert!(matches!(
            throttle.offer_greeting(cheer("C"), start + secs(2)),
            GreetingOffer::Held { .. }
        ));
        let first = throttle.drain_due(start + secs(5));
        assert_eq!(first.len(), 1);
        assert_eq!(
            first[0].iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["B"]
        );
        assert!(throttle.drain_due(start + secs(9)).is_empty());
        let second = throttle.drain_due(start + secs(10));
        assert_eq!(
            second[0]
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["C"]
        );
        assert_eq!(throttle.next_due(), None);
    }

    #[test]
    fn the_global_limiter_caps_six_a_minute_and_five_seconds_apart_per_destination() {
        let start = Instant::now();
        let mut throttle = AutoChatThrottle::default();
        for n in 0..5 {
            throttle.note_sent("twitch:main", start + secs(n * 5));
        }
        let at = start + secs(20);
        // Five sends in: the sixth waits only for the 5 s gap.
        assert_eq!(
            throttle.admit("twitch:main", at + secs(1)),
            Err(at + secs(5))
        );
        assert_eq!(throttle.admit("twitch:main", at + secs(5)), Ok(()));
        throttle.note_sent("twitch:main", at + secs(5));
        // Six in the minute: the seventh waits for the oldest to age out.
        assert_eq!(
            throttle.admit("twitch:main", at + secs(10)),
            Err(start + secs(60))
        );
        assert_eq!(throttle.admit("twitch:main", start + secs(60)), Ok(()));
        assert_eq!(throttle.admit("youtube:other", at), Ok(()));
        // A greeting of a fresh kind waits for the limiter, not the cooldown.
        match throttle.offer_greeting(follow("Zed"), at + secs(10)) {
            GreetingOffer::Held { due } => assert_eq!(due, start + secs(60)),
            other => panic!("{other:?}"),
        }
        assert!(throttle.drain_due(start + secs(59)).is_empty());
        assert_eq!(throttle.drain_due(start + secs(60)).len(), 1);
    }

    #[test]
    fn kinds_and_destinations_keep_separate_cooldowns() {
        let start = Instant::now();
        let mut throttle = AutoChatThrottle::default();
        assert!(matches!(
            throttle.offer_greeting(follow("A"), start),
            GreetingOffer::SendNow(_)
        ));
        // Another kind on the same destination waits only for the 5 s gap.
        match throttle.offer_greeting(cheer("B"), start + secs(1)) {
            GreetingOffer::Held { due } => assert_eq!(due, start + secs(5)),
            other => panic!("{other:?}"),
        }
        let mut other = follow("C");
        other.destination_id = "kick:main".to_string();
        assert!(matches!(
            throttle.offer_greeting(other, start + secs(1)),
            GreetingOffer::SendNow(_)
        ));
        assert_eq!(kind_cooldown(CohostActivityTemplateKind::Raid), secs(60));
        assert_eq!(
            kind_cooldown(CohostActivityTemplateKind::WatchStreak),
            secs(15)
        );
    }
}
