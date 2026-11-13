//! The alert model (plan 223 A1, D2, D3): pure.
//!
//! One alert per open problem. It opens, repeats on its severity's cadence
//! until acknowledged, may be snoozed for ten minutes or for the rest of the
//! stream ("I meant to", which also tells the check and keeps the card in
//! the list, hidden), clears when the signal recovers, and is withdrawn,
//! quietly, when another card carries it (a fold, a replace) or the stream
//! ends with it. The runtime (`mod.rs`) turns every transition into a
//! health event, the `watchdog.alerts` event, a system notification and a
//! phone push; nothing here touches the wire or a clock of its own.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Every check in the catalogue (plan 223, "The check catalogue").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatchdogCheck {
    MicMuted,
    MicSilent,
    NoVoice,
    ProgramSilent,
    PictureBlack,
    PictureStopped,
    DestinationDown,
    PlatformHealth,
    BitrateFloor,
    AvDrift,
    ChatSays,
    BrbLong,
    StillThere,
}

impl WatchdogCheck {
    pub const ALL: [WatchdogCheck; 13] = [
        WatchdogCheck::MicMuted,
        WatchdogCheck::MicSilent,
        WatchdogCheck::NoVoice,
        WatchdogCheck::ProgramSilent,
        WatchdogCheck::PictureBlack,
        WatchdogCheck::PictureStopped,
        WatchdogCheck::DestinationDown,
        WatchdogCheck::PlatformHealth,
        WatchdogCheck::BitrateFloor,
        WatchdogCheck::AvDrift,
        WatchdogCheck::ChatSays,
        WatchdogCheck::BrbLong,
        WatchdogCheck::StillThere,
    ];

    /// The kebab-case id on the wire, in health codes and in the settings.
    pub fn id(self) -> &'static str {
        match self {
            WatchdogCheck::MicMuted => "mic-muted",
            WatchdogCheck::MicSilent => "mic-silent",
            WatchdogCheck::NoVoice => "no-voice",
            WatchdogCheck::ProgramSilent => "program-silent",
            WatchdogCheck::PictureBlack => "picture-black",
            WatchdogCheck::PictureStopped => "picture-stopped",
            WatchdogCheck::DestinationDown => "destination-down",
            WatchdogCheck::PlatformHealth => "platform-health",
            WatchdogCheck::BitrateFloor => "bitrate-floor",
            WatchdogCheck::AvDrift => "av-drift",
            WatchdogCheck::ChatSays => "chat-says",
            WatchdogCheck::BrbLong => "brb-long",
            WatchdogCheck::StillThere => "still-there",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|check| check.id() == id)
    }

    /// The `VIDEORC_WATCHDOG_<CHECK>_AFTER_MS` name (D4; dev builds only).
    pub fn threshold_env(self) -> String {
        format!(
            "VIDEORC_WATCHDOG_{}_AFTER_MS",
            self.id().to_ascii_uppercase().replace('-', "_")
        )
    }
}

/// D3: the severity decides the interruption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertSeverity {
    Critical,
    Warning,
    Notice,
}

impl AlertSeverity {
    /// How often an unacknowledged alert repeats (D3); a notice never does.
    pub fn repeat_every(self) -> Option<Duration> {
        match self {
            AlertSeverity::Critical => Some(Duration::from_secs(5 * 60)),
            AlertSeverity::Warning => Some(Duration::from_secs(10 * 60)),
            AlertSeverity::Notice => None,
        }
    }

    /// Notices and `still-there` never push or notify (D3, D4).
    pub fn interrupts(self) -> bool {
        !matches!(self, AlertSeverity::Notice)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertState {
    Open,
    Acknowledged,
    Snoozed,
}

/// Where the reading came from (plan 223, "Words we use": Source).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlertSource {
    Desktop,
    Cloud,
    Platform,
}

/// The one-tap fixes (D2): every one reuses an existing intent, RPC or page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FixKind {
    Unmute,
    EndTakeover,
    SwitchScene,
    OpenAudio,
    OpenHealth,
    OpenLivestream,
    ReconnectDestination,
    OpenPlatformDashboard,
    ShowBrb,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertFix {
    pub kind: FixKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl AlertFix {
    pub fn new(kind: FixKind, label: impl Into<String>) -> Self {
        Self {
            kind,
            label: label.into(),
            url: None,
        }
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }
}

/// One alert on the wire (`watchdog.alerts`, "Wire shape"). Every optional
/// is skipped when absent: a serialized `null` has broken app load before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogAlert {
    pub id: String,
    pub check: WatchdogCheck,
    pub severity: AlertSeverity,
    pub state: AlertState,
    /// RFC 3339: when it opened.
    pub since: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_repeat_at: Option<String>,
    pub title: String,
    pub detail: String,
    pub source: AlertSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fixes: Vec<AlertFix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meant_to: Option<bool>,
}

/// What a check asks the store to open or refresh. The store adds the id,
/// the state, the clocks and the repeat bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertSpec {
    pub severity: AlertSeverity,
    pub title: String,
    pub detail: String,
    pub source: AlertSource,
    pub platform: Option<String>,
    pub target_id: Option<String>,
    pub fixes: Vec<AlertFix>,
    /// A cadence of the check's own (`brb-long` repeats as a notice).
    pub repeat_every: Option<Duration>,
}

impl AlertSpec {
    pub fn new(
        severity: AlertSeverity,
        title: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            severity,
            title: title.into(),
            detail: detail.into(),
            source: AlertSource::Desktop,
            platform: None,
            target_id: None,
            fixes: Vec::new(),
            repeat_every: None,
        }
    }

    pub fn source(mut self, source: AlertSource) -> Self {
        self.source = source;
        self
    }

    pub fn platform(mut self, platform: Option<String>) -> Self {
        self.platform = platform;
        self
    }

    pub fn target(mut self, target_id: Option<String>) -> Self {
        self.target_id = target_id;
        self
    }

    pub fn fix(mut self, fix: AlertFix) -> Self {
        self.fixes.push(fix);
        self
    }

    pub fn repeat_every(mut self, every: Duration) -> Self {
        self.repeat_every = Some(every);
        self
    }

    fn repeat_interval(&self) -> Option<Duration> {
        self.repeat_every.or_else(|| self.severity.repeat_every())
    }
}

/// `watchdog.alert.snooze { scope }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnoozeScope {
    TenMinutes,
    /// "I meant to": for the rest of this stream, and the check is told.
    Stream,
}

pub const SNOOZE_TEN_MINUTES: Duration = Duration::from_secs(10 * 60);

/// The store's clock: the monotonic instant for cadences and the wall time
/// for the wire's RFC 3339 strings, taken together so they agree.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub now: Instant,
    pub wall: chrono::DateTime<chrono::Utc>,
}

impl Clock {
    pub fn now() -> Self {
        Self {
            now: Instant::now(),
            wall: chrono::Utc::now(),
        }
    }

    pub fn rfc3339(&self) -> String {
        self.wall
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// The same clock, `later` on.
    pub fn plus(self, later: Duration) -> Self {
        Self {
            now: self.now + later,
            wall: self.wall + chrono::Duration::from_std(later).unwrap_or_default(),
        }
    }
}

/// What the runtime does with a change: a health event, the wire, a
/// notification, a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Opened(WatchdogAlert),
    /// The alert's words or severity changed (the clock in its detail does
    /// not count as a change here: the list still carries it).
    Updated(WatchdogAlert),
    Repeated(WatchdogAlert),
    Acknowledged(WatchdogAlert),
    Snoozed(WatchdogAlert),
    /// A snooze ran out: the card is back.
    Unsnoozed(WatchdogAlert),
    /// The signal recovered: "{label} is back".
    Cleared(WatchdogAlert),
    /// The alert left the list without a recovery: it folded into another
    /// card (every destination down), another check explains it now (a
    /// muted microphone owns the silence), a guard took over (a dark
    /// takeover), or the stream ended with it. No "is back" anywhere: an
    /// info health event only, no push, no toast (M2).
    Withdrawn(WatchdogAlert),
}

impl Transition {
    pub fn alert(&self) -> &WatchdogAlert {
        match self {
            Transition::Opened(alert)
            | Transition::Updated(alert)
            | Transition::Repeated(alert)
            | Transition::Acknowledged(alert)
            | Transition::Snoozed(alert)
            | Transition::Unsnoozed(alert)
            | Transition::Cleared(alert)
            | Transition::Withdrawn(alert) => alert,
        }
    }
}

/// One open alert's bookkeeping. `key` is the check plus its scope (a
/// destination id, a chat class, "all" for the fold), stable while it is
/// open, so a check refreshes the same alert every tick.
#[derive(Debug, Clone)]
struct OpenAlert {
    alert: WatchdogAlert,
    last_repeat: Instant,
    repeat_every: Option<Duration>,
    acknowledged: bool,
    snoozed_until: Option<Instant>,
}

/// The per-stream store. `reset` at every session start.
#[derive(Debug, Default)]
pub struct WatchdogState {
    next_seq: u64,
    alerts: BTreeMap<String, OpenAlert>,
    /// "I meant to" (D3): the checks silenced for the rest of this stream.
    meant_to: BTreeSet<WatchdogCheck>,
}

/// The key of a check's alert: `mic-muted`, `destination-down:youtube`,
/// `chat-says:audio`, `destination-down:all`.
pub fn alert_key(check: WatchdogCheck, scope: Option<&str>) -> String {
    match scope {
        Some(scope) => format!("{}:{scope}", check.id()),
        None => check.id().to_string(),
    }
}

impl WatchdogState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every alert, open first, in key order (one stable order for the wire).
    pub fn alerts(&self) -> Vec<WatchdogAlert> {
        self.alerts
            .values()
            .map(|open| open.alert.clone())
            .collect()
    }

    pub fn is_open(&self, key: &str) -> bool {
        self.alerts.contains_key(key)
    }

    #[cfg(test)]
    pub fn open_alert(&self, key: &str) -> Option<&WatchdogAlert> {
        self.alerts.get(key).map(|open| &open.alert)
    }

    /// "I meant to" was clicked on this check this stream.
    #[cfg(test)]
    pub fn meant_to(&self, check: WatchdogCheck) -> bool {
        self.meant_to.contains(&check)
    }

    /// Open the alert under `key`, or refresh an open one with the check's
    /// latest words. A check the streamer silenced ("I meant to") opens
    /// nothing. Returns the transition the runtime should announce.
    pub fn open(
        &mut self,
        check: WatchdogCheck,
        key: &str,
        spec: AlertSpec,
        clock: Clock,
    ) -> Option<Transition> {
        if self.meant_to.contains(&check) {
            return None;
        }
        let repeat_every = spec.repeat_interval();
        if let Some(open) = self.alerts.get_mut(key) {
            let before = open.alert.clone();
            open.alert.severity = spec.severity;
            open.alert.title = spec.title;
            open.alert.detail = spec.detail;
            open.alert.source = spec.source;
            open.alert.platform = spec.platform;
            open.alert.target_id = spec.target_id;
            open.alert.fixes = spec.fixes;
            open.repeat_every = repeat_every;
            let changed = before.severity != open.alert.severity
                || before.source != open.alert.source
                || before.fixes != open.alert.fixes
                || before.platform != open.alert.platform
                || before.target_id != open.alert.target_id
                || !same_words(&before.title, &open.alert.title)
                || !same_words(&before.detail, &open.alert.detail);
            return changed.then(|| Transition::Updated(open.alert.clone()));
        }
        self.next_seq += 1;
        let alert = WatchdogAlert {
            id: format!("watchdog:{key}:{}", self.next_seq),
            check,
            severity: spec.severity,
            state: AlertState::Open,
            since: clock.rfc3339(),
            last_repeat_at: None,
            title: spec.title,
            detail: spec.detail,
            source: spec.source,
            platform: spec.platform,
            target_id: spec.target_id,
            fixes: spec.fixes,
            snoozed_until: None,
            meant_to: None,
        };
        self.alerts.insert(
            key.to_string(),
            OpenAlert {
                alert: alert.clone(),
                last_repeat: clock.now,
                repeat_every,
                acknowledged: false,
                snoozed_until: None,
            },
        );
        Some(Transition::Opened(alert))
    }

    /// The signal recovered: the alert goes, whatever its state.
    pub fn clear(&mut self, key: &str) -> Option<Transition> {
        self.alerts
            .remove(key)
            .map(|open| Transition::Cleared(open.alert))
    }

    /// The alert leaves without a recovery (M2): quietly.
    pub fn withdraw(&mut self, key: &str) -> Option<Transition> {
        self.alerts
            .remove(key)
            .map(|open| Transition::Withdrawn(open.alert))
    }

    /// Clear every alert whose key starts with `prefix` (a check's family).
    pub fn clear_prefix(&mut self, prefix: &str) -> Vec<Transition> {
        let keys = self.family_keys(prefix);
        keys.iter().filter_map(|key| self.clear(key)).collect()
    }

    /// Withdraw a check's family (the check was switched off: nothing
    /// recovered).
    pub fn withdraw_prefix(&mut self, prefix: &str) -> Vec<Transition> {
        let keys = self.family_keys(prefix);
        keys.iter().filter_map(|key| self.withdraw(key)).collect()
    }

    /// Every alert that leaves at once, withdrawn (the session ended).
    pub fn withdraw_all(&mut self) -> Vec<Transition> {
        let keys: Vec<String> = self.alerts.keys().cloned().collect();
        keys.iter().filter_map(|key| self.withdraw(key)).collect()
    }

    fn family_keys(&self, prefix: &str) -> Vec<String> {
        self.alerts
            .keys()
            .filter(|key| key.as_str() == prefix || key.starts_with(&format!("{prefix}:")))
            .cloned()
            .collect()
    }

    /// "I saw it": repeats stop; the card stays until it clears.
    pub fn acknowledge(&mut self, id: &str) -> Option<Transition> {
        let open = self.alerts.values_mut().find(|open| open.alert.id == id)?;
        open.acknowledged = true;
        if open.snoozed_until.is_none() {
            open.alert.state = AlertState::Acknowledged;
        }
        Some(Transition::Acknowledged(open.alert.clone()))
    }

    /// "Not now": hidden for ten minutes, or for the rest of the stream
    /// ("I meant to"), which also silences the check (D3). A meant-to alert
    /// stays in the list as snoozed with `meantTo`, so the renderer hides
    /// it instead of seeing it vanish (M2); it clears when the signal
    /// recovers, like any other.
    pub fn snooze(&mut self, id: &str, scope: SnoozeScope, clock: Clock) -> Option<Transition> {
        let key = self
            .alerts
            .iter()
            .find(|(_, open)| open.alert.id == id)
            .map(|(key, _)| key.clone())?;
        let open = self.alerts.get_mut(&key)?;
        open.acknowledged = true;
        open.alert.state = AlertState::Snoozed;
        match scope {
            SnoozeScope::TenMinutes => {
                open.snoozed_until = Some(clock.now + SNOOZE_TEN_MINUTES);
                open.alert.snoozed_until = Some(clock.plus(SNOOZE_TEN_MINUTES).rfc3339());
            }
            SnoozeScope::Stream => {
                open.snoozed_until = None;
                open.alert.snoozed_until = None;
                open.alert.meant_to = Some(true);
                self.meant_to.insert(open.alert.check);
            }
        }
        Some(Transition::Snoozed(open.alert.clone()))
    }

    /// Once a second: snoozes that ran out and repeats that are due.
    pub fn tick(&mut self, clock: Clock) -> Vec<Transition> {
        let mut transitions = Vec::new();
        for open in self.alerts.values_mut() {
            if let Some(until) = open.snoozed_until
                && clock.now >= until
            {
                open.snoozed_until = None;
                open.alert.snoozed_until = None;
                open.alert.state = AlertState::Acknowledged;
                transitions.push(Transition::Unsnoozed(open.alert.clone()));
            }
            if open.acknowledged || open.snoozed_until.is_some() {
                continue;
            }
            let Some(every) = open.repeat_every else {
                continue;
            };
            if clock.now.duration_since(open.last_repeat) >= every {
                open.last_repeat = clock.now;
                open.alert.last_repeat_at = Some(clock.rfc3339());
                transitions.push(Transition::Repeated(open.alert.clone()));
            }
        }
        transitions
    }
}

/// Two card texts that differ only in their live clock ("0:41" vs "0:42")
/// are the same words: the list re-emits them, the health log does not.
fn same_words(before: &str, after: &str) -> bool {
    strip_clocks(before) == strip_clocks(after)
}

fn strip_clocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_clock = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == ':' {
            if !in_clock {
                out.push('#');
                in_clock = true;
            }
        } else {
            in_clock = false;
            out.push(ch);
        }
    }
    out
}

/// "0:42", "12:04", "1:02:03": the live clock in a card's words.
pub fn format_clock(elapsed: Duration) -> String {
    let total = elapsed.as_secs();
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// The health code for a transition (D13): `watchdog-<check>` on open,
/// `-cleared`, `-acknowledged`, `-snoozed`, `-withdrawn` (info: the card
/// left without a recovery, so the history can close its row); none for a
/// repeat or a refresh.
pub fn health_code(transition: &Transition) -> Option<String> {
    let check = transition.alert().check.id();
    match transition {
        Transition::Opened(_) => Some(format!("watchdog-{check}")),
        Transition::Cleared(_) => Some(format!("watchdog-{check}-cleared")),
        Transition::Acknowledged(_) => Some(format!("watchdog-{check}-acknowledged")),
        Transition::Snoozed(_) => Some(format!("watchdog-{check}-snoozed")),
        Transition::Withdrawn(_) => Some(format!("watchdog-{check}-withdrawn")),
        Transition::Updated(_) | Transition::Repeated(_) | Transition::Unsnoozed(_) => None,
    }
}

/// The success toast when a check clears ("Copy (exact)", the last row).
pub fn cleared_toast(alert: &WatchdogAlert) -> String {
    match alert.check {
        WatchdogCheck::MicMuted => "Microphone unmuted".to_string(),
        WatchdogCheck::MicSilent | WatchdogCheck::NoVoice | WatchdogCheck::ProgramSilent => {
            "Sound is back".to_string()
        }
        WatchdogCheck::PictureBlack | WatchdogCheck::PictureStopped => {
            "Picture is back".to_string()
        }
        WatchdogCheck::DestinationDown | WatchdogCheck::PlatformHealth => {
            match alert.target_id.as_deref() {
                Some("all") | None => "Destinations are back".to_string(),
                Some(_) => format!("{} is back", destination_label(&alert.title)),
            }
        }
        WatchdogCheck::BitrateFloor => "Connection is back to speed".to_string(),
        WatchdogCheck::AvDrift => "Sound and picture are in step again".to_string(),
        WatchdogCheck::ChatSays => "Chat has gone quiet about it".to_string(),
        WatchdogCheck::BrbLong => "Takeover ended".to_string(),
        WatchdogCheck::StillThere => "Welcome back".to_string(),
    }
}

/// The destination's label from a card title ("YouTube has been down for
/// 0:20" → "YouTube"; "Streaming to Twitch (main) stopped" → "Twitch (main)";
/// "Twitch (main) isn't receiving your stream" → "Twitch (main)").
pub(crate) fn destination_label(title: &str) -> String {
    if let Some(rest) = title.strip_prefix("Streaming to ") {
        return rest.trim_end_matches(" stopped").to_string();
    }
    for marker in [
        " has been down",
        " isn't receiving",
        " ended the broadcast",
        " reports ",
        " is back",
    ] {
        if let Some(index) = title.find(marker) {
            return title[..index].to_string();
        }
    }
    title.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> Clock {
        Clock {
            now: Instant::now(),
            wall: chrono::DateTime::parse_from_rfc3339("2026-11-08T12:04:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        }
    }

    fn muted_spec() -> AlertSpec {
        AlertSpec::new(
            AlertSeverity::Critical,
            "Your microphone is muted on the livestream",
            "Muted for 0:30. Viewers hear no voice.",
        )
        .fix(AlertFix::new(FixKind::Unmute, "Unmute"))
    }

    #[test]
    fn opens_once_and_refreshes_in_place() {
        let mut state = WatchdogState::new();
        let now = clock();
        let opened = state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), now)
            .unwrap();
        let Transition::Opened(alert) = opened else {
            panic!("expected an open, got {opened:?}");
        };
        assert_eq!(alert.id, "watchdog:mic-muted:1");
        assert_eq!(alert.since, "2026-11-08T12:04:00.000Z");
        assert_eq!(alert.state, AlertState::Open);
        // The clock moving in the detail is not a change worth a health event.
        let mut later = muted_spec();
        later.detail = "Muted for 0:31. Viewers hear no voice.".to_string();
        assert_eq!(
            state.open(
                WatchdogCheck::MicMuted,
                "mic-muted",
                later,
                now.plus(Duration::from_secs(1))
            ),
            None
        );
        assert_eq!(
            state.alerts()[0].detail,
            "Muted for 0:31. Viewers hear no voice.",
            "the list still carries the newest clock"
        );
        // New words are.
        let mut folded = muted_spec();
        folded.detail =
            "Muted for 0:32. Viewers hear no voice. Nothing else is playing.".to_string();
        assert!(matches!(
            state.open(WatchdogCheck::MicMuted, "mic-muted", folded, now),
            Some(Transition::Updated(_))
        ));
        assert_eq!(state.alerts().len(), 1);
        // A second open after a clear is a new id, so a push replaces nothing.
        assert!(matches!(
            state.clear("mic-muted"),
            Some(Transition::Cleared(_))
        ));
        let Some(Transition::Opened(again)) =
            state.open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), now)
        else {
            panic!("expected a second open");
        };
        assert_eq!(again.id, "watchdog:mic-muted:2");
    }

    #[test]
    fn repeats_on_the_severity_cadence_until_acknowledged() {
        let mut state = WatchdogState::new();
        let start = clock();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), start)
            .unwrap();
        let warning = AlertSpec::new(
            AlertSeverity::Warning,
            "YouTube has been down for 0:20",
            "x",
        );
        state
            .open(
                WatchdogCheck::DestinationDown,
                "destination-down:yt",
                warning,
                start,
            )
            .unwrap();
        let notice = AlertSpec::new(AlertSeverity::Notice, "Still there?", "x");
        state
            .open(WatchdogCheck::StillThere, "still-there", notice, start)
            .unwrap();

        assert!(state.tick(start.plus(Duration::from_secs(299))).is_empty());
        let at_five = state.tick(start.plus(Duration::from_secs(300)));
        assert_eq!(at_five.len(), 1, "only the critical one repeats at 5 min");
        let Transition::Repeated(alert) = &at_five[0] else {
            panic!("expected a repeat, got {at_five:?}");
        };
        assert_eq!(alert.check, WatchdogCheck::MicMuted);
        assert_eq!(
            alert.last_repeat_at.as_deref(),
            Some("2026-11-08T12:09:00.000Z")
        );

        let at_ten = state.tick(start.plus(Duration::from_secs(600)));
        let repeated: Vec<WatchdogCheck> = at_ten
            .iter()
            .map(|transition| transition.alert().check)
            .collect();
        assert_eq!(
            repeated,
            vec![WatchdogCheck::DestinationDown, WatchdogCheck::MicMuted],
            "the warning at 10 min, the critical again; the notice never"
        );

        // Acknowledge stops the repeats; the alerts stay.
        let ids: Vec<String> = state
            .alerts()
            .iter()
            .map(|alert| alert.id.clone())
            .collect();
        for id in &ids {
            assert!(matches!(
                state.acknowledge(id),
                Some(Transition::Acknowledged(_))
            ));
        }
        for seconds in [900, 1200, 1800] {
            let later = state.tick(start.plus(Duration::from_secs(seconds)));
            assert!(
                later.is_empty(),
                "an acknowledged alert never repeats: {later:?}"
            );
        }
        assert!(state.is_open("destination-down:yt"));
        assert!(state.is_open("mic-muted"));
        assert!(
            state
                .alerts()
                .iter()
                .all(|alert| alert.state == AlertState::Acknowledged)
        );
    }

    #[test]
    fn a_checks_own_cadence_lets_a_notice_repeat() {
        let mut state = WatchdogState::new();
        let start = clock();
        let brb = AlertSpec::new(AlertSeverity::Notice, "Be right back for 10 minutes", "x")
            .repeat_every(Duration::from_secs(600));
        state
            .open(WatchdogCheck::BrbLong, "brb-long", brb, start)
            .unwrap();
        assert!(state.tick(start.plus(Duration::from_secs(599))).is_empty());
        assert_eq!(state.tick(start.plus(Duration::from_secs(600))).len(), 1);
    }

    #[test]
    fn snooze_hides_for_ten_minutes_and_returns() {
        let mut state = WatchdogState::new();
        let start = clock();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), start)
            .unwrap();
        let id = state.alerts()[0].id.clone();
        let snoozed = state.snooze(&id, SnoozeScope::TenMinutes, start).unwrap();
        let Transition::Snoozed(alert) = snoozed else {
            panic!("expected a snooze");
        };
        assert_eq!(alert.state, AlertState::Snoozed);
        assert_eq!(
            alert.snoozed_until.as_deref(),
            Some("2026-11-08T12:14:00.000Z")
        );
        assert!(
            state.tick(start.plus(Duration::from_secs(599))).is_empty(),
            "no repeat while snoozed"
        );
        let back = state.tick(start.plus(Duration::from_secs(600)));
        assert!(
            matches!(back.as_slice(), [Transition::Unsnoozed(_)]),
            "{back:?}"
        );
        let alert = &state.alerts()[0];
        assert_eq!(alert.state, AlertState::Acknowledged, "back, and quiet");
        assert_eq!(alert.snoozed_until, None);
        assert!(!state.meant_to(WatchdogCheck::MicMuted));
    }

    #[test]
    fn i_meant_to_holds_for_the_stream() {
        let mut state = WatchdogState::new();
        let start = clock();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), start)
            .unwrap();
        let id = state.alerts()[0].id.clone();
        let snoozed = state.snooze(&id, SnoozeScope::Stream, start).unwrap();
        let Transition::Snoozed(alert) = snoozed else {
            panic!("expected a snooze");
        };
        assert_eq!(alert.meant_to, Some(true));
        assert_eq!(alert.state, AlertState::Snoozed);
        assert_eq!(alert.snoozed_until, None);
        // M2: the card stays in the list, hidden, so the renderer never sees
        // it vanish and never says "Microphone unmuted" while it is muted.
        assert_eq!(state.alerts().len(), 1, "the card stays, snoozed");
        assert_eq!(state.alerts()[0].meant_to, Some(true));
        assert!(state.meant_to(WatchdogCheck::MicMuted));
        assert_eq!(
            state.open(
                WatchdogCheck::MicMuted,
                "mic-muted",
                muted_spec(),
                start.plus(Duration::from_secs(3600))
            ),
            None,
            "the check stays silent for the rest of the stream"
        );
        assert!(
            state.tick(start.plus(Duration::from_secs(3600))).is_empty(),
            "a meant-to alert never repeats"
        );
        // The real recovery still clears it.
        assert!(matches!(
            state.clear("mic-muted"),
            Some(Transition::Cleared(_))
        ));
        assert!(state.alerts().is_empty());
        // Another check is untouched.
        assert!(
            state
                .open(
                    WatchdogCheck::ProgramSilent,
                    "program-silent",
                    AlertSpec::new(AlertSeverity::Critical, "Viewers hear nothing", "x"),
                    start
                )
                .is_some()
        );
        // A new stream forgets it.
        let fresh = WatchdogState::new();
        assert!(!fresh.meant_to(WatchdogCheck::MicMuted));
    }

    #[test]
    fn clear_emits_cleared_and_the_family_clear_takes_every_scope() {
        let mut state = WatchdogState::new();
        let start = clock();
        let spec = |label: &str| {
            AlertSpec::new(
                AlertSeverity::Warning,
                format!("{label} has been down for 0:20"),
                "x",
            )
            .target(Some(label.to_lowercase()))
        };
        state
            .open(
                WatchdogCheck::DestinationDown,
                "destination-down:yt",
                spec("YouTube"),
                start,
            )
            .unwrap();
        state
            .open(
                WatchdogCheck::DestinationDown,
                "destination-down:tw",
                spec("Twitch"),
                start,
            )
            .unwrap();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), start)
            .unwrap();
        assert_eq!(state.clear("missing"), None);
        let cleared = state.clear_prefix("destination-down");
        assert_eq!(cleared.len(), 2);
        assert!(
            cleared
                .iter()
                .all(|transition| matches!(transition, Transition::Cleared(_)))
        );
        assert_eq!(
            health_code(&cleared[0]).as_deref(),
            Some("watchdog-destination-down-cleared")
        );
        assert_eq!(state.alerts().len(), 1, "the mic alert stays");
        // Key order: "destination-down:twitch" clears before ":youtube".
        assert_eq!(cleared_toast(cleared[0].alert()), "Twitch is back");
        assert_eq!(cleared_toast(cleared[1].alert()), "YouTube is back");
    }

    /// M2: a withdrawal is not a recovery: its own transition, its own
    /// info code, and the list simply no longer carries the alert.
    #[test]
    fn withdraw_is_quiet_and_never_reads_as_a_recovery() {
        let mut state = WatchdogState::new();
        let start = clock();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), start)
            .unwrap();
        state
            .open(
                WatchdogCheck::DestinationDown,
                "destination-down:yt",
                AlertSpec::new(
                    AlertSeverity::Warning,
                    "YouTube has been down for 0:20",
                    "x",
                ),
                start,
            )
            .unwrap();
        let withdrawn = state.withdraw("destination-down:yt").unwrap();
        assert!(
            matches!(withdrawn, Transition::Withdrawn(_)),
            "{withdrawn:?}"
        );
        assert_eq!(
            health_code(&withdrawn).as_deref(),
            Some("watchdog-destination-down-withdrawn")
        );
        assert_eq!(state.withdraw("destination-down:yt"), None);
        assert_eq!(state.alerts().len(), 1);
        let all = state.withdraw_all();
        assert_eq!(all.len(), 1);
        assert!(matches!(all[0], Transition::Withdrawn(_)));
        assert!(state.alerts().is_empty());
    }

    #[test]
    fn health_codes_follow_the_transition() {
        let mut state = WatchdogState::new();
        let start = clock();
        let opened = state
            .open(
                WatchdogCheck::ChatSays,
                "chat-says:audio",
                muted_spec(),
                start,
            )
            .unwrap();
        assert_eq!(health_code(&opened).as_deref(), Some("watchdog-chat-says"));
        let id = state.alerts()[0].id.clone();
        let acknowledged = state.acknowledge(&id).unwrap();
        assert_eq!(
            health_code(&acknowledged).as_deref(),
            Some("watchdog-chat-says-acknowledged")
        );
        let snoozed = state.snooze(&id, SnoozeScope::TenMinutes, start).unwrap();
        assert_eq!(
            health_code(&snoozed).as_deref(),
            Some("watchdog-chat-says-snoozed")
        );
        assert_eq!(
            health_code(&Transition::Repeated(snoozed.alert().clone())),
            None
        );
    }

    #[test]
    fn clocks_and_ids_read_as_the_plan_writes_them() {
        assert_eq!(format_clock(Duration::from_secs(42)), "0:42");
        assert_eq!(format_clock(Duration::from_secs(724)), "12:04");
        assert_eq!(format_clock(Duration::from_secs(3723)), "1:02:03");
        assert_eq!(
            WatchdogCheck::MicMuted.threshold_env(),
            "VIDEORC_WATCHDOG_MIC_MUTED_AFTER_MS"
        );
        assert_eq!(
            WatchdogCheck::parse("picture-stopped"),
            Some(WatchdogCheck::PictureStopped)
        );
        assert_eq!(WatchdogCheck::parse("nope"), None);
        assert_eq!(
            alert_key(WatchdogCheck::DestinationDown, Some("all")),
            "destination-down:all"
        );
        assert_eq!(
            serde_json::to_value(WatchdogCheck::AvDrift).unwrap(),
            serde_json::json!("av-drift")
        );
    }

    #[test]
    fn the_wire_shape_skips_every_absent_optional() {
        let mut state = WatchdogState::new();
        state
            .open(WatchdogCheck::MicMuted, "mic-muted", muted_spec(), clock())
            .unwrap();
        let value = serde_json::to_value(&state.alerts()[0]).unwrap();
        let object = value.as_object().unwrap();
        for absent in [
            "lastRepeatAt",
            "platform",
            "targetId",
            "snoozedUntil",
            "meantTo",
        ] {
            assert!(
                !object.contains_key(absent),
                "{absent} must be absent, not null"
            );
        }
        assert_eq!(object["fixes"][0]["kind"], "unmute");
        assert!(!object["fixes"][0].as_object().unwrap().contains_key("url"));
    }
}
