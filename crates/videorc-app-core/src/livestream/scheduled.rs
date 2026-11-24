//! S3.5d: Destinations → Upcoming and the Schedule dialog as data
//! (`components/scheduled-streams.tsx`, `schedule-stream-dialog.tsx`,
//! `lib/scheduled-streams.ts`, `lib/schedule-time.ts`).
//!
//! The backend owns every saved stream (`scheduledStreams.list`,
//! `scheduledStreams.changed`) and every change to one (an action returns an
//! operation the Studio follows to its end); nothing is created on a
//! platform unless the streamer schedules it.
//!
//! Times read as Electron's ICU writes them under en-US (`Intl` with the
//! system's locale there; the core has none of its own yet).

use chrono::{DateTime, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::scheduled_copy as copy;

/// `ScheduledEventMetadata` (what the dialog edits and the event requested).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Requested {
    pub title: String,
    pub description: String,
    pub privacy: String,
    pub made_for_kids: bool,
    pub local_start: String,
    pub time_zone: String,
    pub offset_choice: Option<String>,
    pub thumbnail_asset_id: Option<String>,
    pub planned_end_local: Option<String>,
    pub available_for_replay: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EventError {
    pub code: Option<String>,
    pub message: String,
}

/// `ScheduledStreamEvent` (the fields Upcoming reads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Event {
    pub id: String,
    pub provider: Option<String>,
    pub revision: Value,
    pub schema_version: u32,
    pub lifecycle: String,
    pub operation_state: Option<String>,
    pub create_uncertain: bool,
    pub preparation: Option<Value>,
    pub provider_event_id: Option<String>,
    pub account_id: Option<String>,
    pub account_label: String,
    pub start_utc: String,
    pub requested: Requested,
    pub watch_url: Option<String>,
    pub thumbnail_state: Option<String>,
    pub error: Option<EventError>,
    pub last_synced_at: Option<String>,
}

impl Event {
    pub fn provider(&self) -> &str {
        self.provider.as_deref().unwrap_or("youtube")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub account_id: String,
    pub account_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderCapability {
    pub provider: String,
    pub available: bool,
    pub reason: Option<String>,
    pub accounts: Vec<Account>,
}

/// `ScheduledStreamCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub available: bool,
    pub reason: Option<String>,
    pub accounts: Vec<Account>,
    pub providers: Vec<ProviderCapability>,
}

impl Capabilities {
    /// The provider's capability (`providerCapability`), or the whole one's.
    pub fn provider(&self, provider: &str) -> ProviderCapability {
        self.providers
            .iter()
            .find(|p| p.provider == provider)
            .cloned()
            .unwrap_or_else(|| ProviderCapability {
                provider: provider.to_string(),
                available: self.available,
                reason: self.reason.clone(),
                accounts: self.accounts.clone(),
            })
    }
}

/// `scheduledProviderLabel`.
pub fn provider_label(provider: &str) -> &'static str {
    if provider == "x" { "X" } else { "YouTube" }
}

/// `scheduledProviderNoun`.
pub fn provider_noun(provider: &str) -> &'static str {
    if provider == "x" {
        "broadcast"
    } else {
        "event"
    }
}

/// `scheduledProviderSite`.
pub fn provider_site(provider: &str) -> &'static str {
    if provider == "x" {
        "X"
    } else {
        "YouTube Studio"
    }
}

/// `ScheduledProviderSection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub provider: String,
    pub available: bool,
    pub reason: Option<String>,
    pub events: Vec<Event>,
}

/// `scheduledProviderSections`: YouTube, then X, each kept even when empty;
/// Past holds the ended and canceled ones.
pub fn sections(
    events: &[Event],
    capabilities: Option<&Capabilities>,
    history: bool,
) -> Vec<Section> {
    ["youtube", "x"]
        .iter()
        .map(|provider| {
            let capability =
                capabilities.and_then(|c| c.providers.iter().find(|p| p.provider == *provider));
            Section {
                provider: provider.to_string(),
                available: capability
                    .map(|c| c.available)
                    .or(capabilities.map(|c| c.available))
                    .unwrap_or(false),
                reason: match capability {
                    Some(c) => c.reason.clone(),
                    None => capabilities.and_then(|c| c.reason.clone()),
                },
                events: events
                    .iter()
                    .filter(|e| {
                        e.provider() == *provider
                            && matches!(e.lifecycle.as_str(), "completed" | "canceled") == history
                    })
                    .cloned()
                    .collect(),
            }
        })
        .collect()
}

/// `ScheduledLifecycleChip`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chip {
    Tag(String),
    Live(String),
    /// Words and a tone (`good`, `warn`, `neutral`).
    Status(String, &'static str),
}

/// `scheduledLifecycleChip`.
pub fn lifecycle_chip(event: &Event) -> Chip {
    if event.create_uncertain || event.operation_state.as_deref() == Some("needs-reconciliation") {
        return Chip::Status(copy::NEEDS_REVIEW.into(), "warn");
    }
    match event.lifecycle.as_str() {
        "draft" => Chip::Tag(copy::DRAFT.into()),
        "scheduled" => Chip::Status(copy::SCHEDULED.into(), "good"),
        "preparing" => Chip::Status(copy::PREPARING.into(), "neutral"),
        "live" => Chip::Live(copy::ON_AIR.into()),
        "completed" => Chip::Status(copy::ENDED.into(), "neutral"),
        "canceled" => Chip::Status(copy::CANCELED.into(), "neutral"),
        "missing" => Chip::Status(copy::deleted_on(provider_label(event.provider())), "warn"),
        _ => Chip::Status(copy::NEEDS_REVIEW.into(), "warn"),
    }
}

/// `scheduledPrivacyLabel`: X broadcasts carry none.
pub fn privacy_label(event: &Event) -> Option<&'static str> {
    if event.provider() == "x" {
        return None;
    }
    Some(match event.requested.privacy.as_str() {
        "public" => copy::PUBLIC,
        "unlisted" => copy::UNLISTED,
        _ => copy::PRIVATE,
    })
}

/// `eventCanEdit`.
pub fn can_edit(event: &Event) -> bool {
    event.schema_version == 1
        && event.preparation.is_none()
        && event.operation_state.as_deref() != Some("pending")
        && matches!(event.lifecycle.as_str(), "draft" | "scheduled" | "unknown")
}

/// The row offers Recover.
pub fn needs_recovery(event: &Event) -> bool {
    event.create_uncertain
        || event.preparation.is_some()
        || event.operation_state.as_deref() == Some("needs-reconciliation")
}

// --- Times (`lib/schedule-time.ts`) --------------------------------------

fn zone(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

/// `zoneOffsetMinutes`: the zone's UTC offset at an instant, in minutes.
pub fn zone_offset_minutes(at: DateTime<Utc>, time_zone: &str) -> Option<i32> {
    let tz = zone(time_zone)?;
    Some(
        tz.offset_from_utc_datetime(&at.naive_utc())
            .fix()
            .local_minus_utc()
            / 60,
    )
}

/// `formatGmtOffset`: "GMT+2", "GMT-5:30", "GMT".
pub fn format_gmt_offset(minutes: i32) -> String {
    if minutes == 0 {
        return "GMT".into();
    }
    let sign = if minutes > 0 { '+' } else { '-' };
    let hours = minutes.abs() / 60;
    let rest = minutes.abs() % 60;
    if rest == 0 {
        format!("GMT{sign}{hours}")
    } else {
        format!("GMT{sign}{hours}:{rest:02}")
    }
}

/// `timeZoneLabel`: "Madrid (GMT+2)", "UTC".
pub fn time_zone_label(time_zone: &str, at: DateTime<Utc>) -> String {
    if time_zone == "UTC" {
        return "UTC".into();
    }
    let city = time_zone
        .rsplit('/')
        .next()
        .unwrap_or(time_zone)
        .replace('_', " ");
    match zone_offset_minutes(at, time_zone) {
        Some(offset) => format!("{city} ({})", format_gmt_offset(offset)),
        None => city,
    }
}

fn parse_local(local: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(local, "%Y-%m-%dT%H:%M").ok()
}

/// `localTimeOffsets`: every offset at which the wall time happens in the
/// zone, earlier first (two when the clocks go back over it).
pub fn local_time_offsets(local_start: &str, time_zone: &str) -> Vec<i32> {
    let (Some(wall), Some(tz)) = (parse_local(local_start), zone(time_zone)) else {
        return Vec::new();
    };
    match tz.from_local_datetime(&wall) {
        chrono::LocalResult::Single(at) => vec![at.offset().fix().local_minus_utc() / 60],
        chrono::LocalResult::Ambiguous(a, b) => {
            let mut offsets = vec![
                a.offset().fix().local_minus_utc() / 60,
                b.offset().fix().local_minus_utc() / 60,
            ];
            offsets.sort_by(|x, y| y.cmp(x));
            offsets
        }
        chrono::LocalResult::None => Vec::new(),
    }
}

/// `resolveLocalTimeMs`: the instant a `datetime-local` value is in the zone,
/// as the backend resolves it. `None` when the clocks jump over it, or when it
/// happens twice and no `"earlier"` or `"later"` choice was made.
pub fn resolve_local_time(
    local_time: &str,
    time_zone: &str,
    choice: Option<&str>,
) -> Option<DateTime<Utc>> {
    let wall = parse_local(local_time)?;
    let offsets = local_time_offsets(local_time, time_zone);
    // The larger offset is the earlier instant.
    let offset = match (offsets.as_slice(), choice) {
        ([only], _) => *only,
        ([earlier, _], Some("earlier")) => *earlier,
        ([_, later], Some("later")) => *later,
        _ => return None,
    };
    Some(wall.and_utc() - chrono::Duration::minutes(i64::from(offset)))
}

/// A wall time in `zone` as JavaScript's `new Date(local)` reads it: the
/// earlier instant when the clocks go back over it, and, when they jump over
/// it, the offset in force before the jump (so 02:30 becomes 03:30).
fn local_instant<Z: TimeZone>(wall: NaiveDateTime, zone: &Z) -> DateTime<Utc> {
    match zone.from_local_datetime(&wall) {
        chrono::LocalResult::Single(at) => at.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(a, b) => a.with_timezone(&Utc).min(b.with_timezone(&Utc)),
        chrono::LocalResult::None => {
            let before = zone
                .from_local_datetime(&(wall - chrono::Duration::hours(3)))
                .earliest()
                .map_or(0, |at| at.offset().fix().local_minus_utc());
            wall.and_utc() - chrono::Duration::seconds(i64::from(before))
        }
    }
}

fn wall_time<Z: TimeZone>(at: DateTime<Utc>, zone: &Z) -> String {
    at.with_timezone(zone)
        .naive_local()
        .format("%Y-%m-%dT%H:%M")
        .to_string()
}

/// `defaultPlannedEnd`: two hours of real time after the start, read as this
/// computer's local time (`datetime-local`) and written back as its wall clock.
pub fn default_planned_end(local_start: &str) -> String {
    default_planned_end_in(local_start, &chrono::Local)
}

fn default_planned_end_in<Z: TimeZone>(local_start: &str, zone: &Z) -> String {
    let Some(start) = parse_local(local_start) else {
        return String::new();
    };
    wall_time(
        local_instant(start, zone) + chrono::Duration::hours(2),
        zone,
    )
}

/// `timeZoneName: 'short'` under en-US: "EST" where the zone has a US name,
/// else "GMT+1".
fn zone_name(at: &DateTime<Tz>) -> String {
    let offset = at.offset().fix().local_minus_utc() / 60;
    let zone = at.timezone().name();
    super::time_zones::en_us_short_name(zone, offset)
        .map_or_else(|| format_gmt_offset(offset), str::to_string)
}

/// `formatScheduledStart`: "Sat, Oct 12, 9:00 PM GMT+2", the year only when
/// it isn't this one.
pub fn format_scheduled_start(start_utc: &str, time_zone: &str, now: DateTime<Utc>) -> String {
    let (Ok(start), Some(tz)) = (DateTime::parse_from_rfc3339(start_utc), zone(time_zone)) else {
        return String::new();
    };
    let local = start.with_timezone(&tz);
    let now_local = now.with_timezone(&tz);
    let offset = zone_name(&local);
    let same_year = chrono::Datelike::year(&local) == chrono::Datelike::year(&now_local);
    let date = if same_year {
        local.format("%a, %b %-d").to_string()
    } else {
        local.format("%a, %b %-d, %Y").to_string()
    };
    format!("{date}, {} {offset}", local.format("%-I:%M %p"))
}

/// `scheduledWhenLabel`: when the stream airs, in its own zone ("Mon, Jan 1,
/// 2035, 12:00 PM GMT+1"). An X broadcast shows its planned end as a range
/// ("12:00 – 2:00 PM GMT+1"): the end is a wall time in the start's zone,
/// resolved on its own (#1479), so a DST change between them shows the real
/// end. ICU's range drops the hour's leading zero, says the shared date and
/// AM/PM once, names the end's zone, and puts thin spaces around the dash.
pub fn when_label(event: &Event) -> String {
    let requested = &event.requested;
    let (Ok(start), Some(tz)) = (
        DateTime::parse_from_rfc3339(&event.start_utc),
        zone(&requested.time_zone),
    ) else {
        return requested.local_start.replace('T', " ");
    };
    let start = start.with_timezone(&Utc);
    let local = start.with_timezone(&tz);
    let end = (event.provider() == "x")
        .then_some(requested.planned_end_local.as_deref())
        .flatten()
        .filter(|end| !end.is_empty())
        .and_then(|end| {
            resolve_local_time(
                end,
                &requested.time_zone,
                requested.offset_choice.as_deref(),
            )
        })
        .filter(|end| *end > start);
    let date = |at: &DateTime<Tz>| at.format("%a, %b %-d, %Y").to_string();
    let Some(end) = end else {
        return format!(
            "{}, {} {}",
            date(&local),
            local.format("%I:%M %p"),
            zone_name(&local)
        );
    };
    let end = end.with_timezone(&tz);
    if local.date_naive() != end.date_naive() {
        return format!(
            "{}, {} {}\u{2009}–\u{2009}{}, {} {}",
            date(&local),
            local.format("%-I:%M %p"),
            zone_name(&local),
            date(&end),
            end.format("%-I:%M %p"),
            zone_name(&end)
        );
    }
    let start_time = if local.format("%p").to_string() == end.format("%p").to_string() {
        local.format("%-I:%M").to_string()
    } else {
        local.format("%-I:%M %p").to_string()
    };
    format!(
        "{}, {start_time}\u{2009}–\u{2009}{} {}",
        date(&local),
        end.format("%-I:%M %p"),
        zone_name(&end)
    )
}

/// `lastCheckedLabel`: "Last checked 5m ago", "Last checked just now", or
/// nothing before any check.
pub fn last_checked_label(at: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let relative = super::format::format_relative_time(at?, now);
    if relative.is_empty() {
        return None;
    }
    if relative == "now" {
        return Some(copy::LAST_CHECKED_JUST_NOW.to_string());
    }
    let (number, unit) = relative.split_at(relative.len() - 1);
    Some(
        if !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
            && matches!(unit, "m" | "h" | "d")
        {
            copy::last_checked_ago(&relative)
        } else {
            copy::last_checked(&relative)
        },
    )
}

/// `scheduleBlockedReason`: why the form can't be sent yet, in field order.
pub struct ScheduleForm<'a> {
    pub provider: &'a str,
    pub account_id: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub audience: &'a str,
    pub planned_end_error: Option<&'a str>,
    pub time_error: Option<&'a str>,
    pub resolving: bool,
}

pub fn schedule_blocked_reason(form: &ScheduleForm<'_>) -> Option<String> {
    if form.account_id.is_empty() {
        return Some(
            if form.provider == "x" {
                copy::CHOOSE_X_ACCOUNT
            } else {
                copy::CHOOSE_YOUTUBE_CHANNEL
            }
            .into(),
        );
    }
    let (title, description) = super::details::info_issues(form.title, form.description, true);
    if let Some(title_issue) = title {
        return Some(if form.title.trim().is_empty() {
            copy::ADD_A_TITLE.into()
        } else {
            title_issue
        });
    }
    if let Some(description) = description {
        return Some(description);
    }
    if let Some(error) = form.time_error {
        return Some(error.into());
    }
    if let Some(error) = form.planned_end_error {
        return Some(error.into());
    }
    if form.provider != "x" && form.audience.is_empty() {
        return Some(copy::CHOOSE_AUDIENCE.into());
    }
    form.resolving.then(|| copy::CHECKING_THE_TIME.to_string())
}

/// The planned end's issue (X needs one, after the start).
pub fn planned_end_error(
    provider: &str,
    local_start: &str,
    planned_end: Option<&str>,
) -> Option<&'static str> {
    if provider != "x" {
        return None;
    }
    match planned_end.filter(|end| !end.is_empty()) {
        None => Some(copy::CHOOSE_PLANNED_END),
        Some(end) if end <= local_start => Some(copy::END_AFTER_START),
        Some(_) => None,
    }
}

/// `freshMetadata`: an hour of real time from now, in this computer's zone;
/// X gets its planned end and replay.
pub fn fresh_metadata(provider: &str, now: DateTime<Utc>, time_zone: &str) -> Requested {
    fresh_metadata_in(provider, now, time_zone, &chrono::Local)
}

fn fresh_metadata_in<Z: TimeZone>(
    provider: &str,
    now: DateTime<Utc>,
    time_zone: &str,
    zone: &Z,
) -> Requested {
    let local = wall_time(now + chrono::Duration::hours(1), zone);
    Requested {
        privacy: "private".into(),
        planned_end_local: (provider == "x").then(|| default_planned_end_in(&local, zone)),
        local_start: local,
        time_zone: time_zone.to_string(),
        available_for_replay: Some(true),
        ..Requested::default()
    }
}

/// `selectScheduledStreamForTarget`: the event on its destination for the
/// next Go Live (a signed-in destination of the event's account).
pub fn select_for_target(
    config: &mut Value,
    target_id: &str,
    event: &Event,
    now: &str,
) -> Result<(), &'static str> {
    let provider = event.provider();
    let fits = config["streaming"]["targets"]
        .as_array()
        .and_then(|targets| targets.iter().find(|t| t["id"] == target_id))
        .is_some_and(|t| {
            t["platform"] == provider
                && t["authMode"] == "oauth"
                && t["accountId"].as_str() == event.account_id.as_deref()
        });
    if !fits {
        return Err(if provider == "x" {
            copy::CHOOSE_X_DESTINATION
        } else {
            copy::CHOOSE_YOUTUBE_DESTINATION
        });
    }
    let Some(targets) = config["streaming"]["targets"].as_array_mut() else {
        return Ok(());
    };
    for target in targets.iter_mut() {
        if target["id"] != target_id {
            continue;
        }
        let Some(object) = target.as_object_mut() else {
            continue;
        };
        object.insert("enabled".into(), Value::Bool(true));
        object.insert("scheduledEventId".into(), json!(event.id));
        object.insert("scheduledEventTitle".into(), json!(event.requested.title));
        object.insert("scheduledStartUtc".into(), json!(event.start_utc));
        object.insert("scheduledPrivacy".into(), json!(event.requested.privacy));
        for key in [
            "scheduledAttemptId",
            "platformBroadcastId",
            "platformStreamId",
            "streamKeySecretRef",
        ] {
            object.remove(key);
        }
        object.insert("streamKey".into(), json!(""));
        object.insert("streamKeyPresent".into(), Value::Bool(false));
        object.insert("updatedAt".into(), json!(now));
    }
    let enabled: Vec<Value> = targets
        .iter()
        .filter(|t| t["enabled"] == true)
        .map(|t| t["id"].clone())
        .collect();
    config["streamEnabled"] = Value::Bool(true);
    config["streaming"]["enabled"] = Value::Bool(true);
    config["streaming"]["mode"] = json!(if enabled.len() > 1 { "multi" } else { "single" });
    config["streaming"]["enabledTargetIds"] = Value::Array(enabled);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(provider: &str, lifecycle: &str) -> Event {
        Event {
            id: format!("{provider}-{lifecycle}"),
            provider: Some(provider.into()),
            schema_version: 1,
            lifecycle: lifecycle.into(),
            account_label: "Orc".into(),
            start_utc: "2035-01-01T11:00:00Z".into(),
            requested: Requested {
                title: "Launch".into(),
                privacy: "unlisted".into(),
                local_start: "2035-01-01T12:00".into(),
                time_zone: "Europe/Madrid".into(),
                planned_end_local: Some("2035-01-01T14:00".into()),
                ..Requested::default()
            },
            ..Event::default()
        }
    }

    #[test]
    fn upcoming_splits_by_platform_and_names_each_state() {
        let events = vec![
            event("youtube", "scheduled"),
            event("x", "draft"),
            event("youtube", "completed"),
        ];
        let upcoming = sections(&events, None, false);
        assert_eq!(upcoming.len(), 2);
        assert_eq!(upcoming[0].events.len(), 1);
        assert_eq!(upcoming[1].events[0].lifecycle, "draft");
        assert_eq!(sections(&events, None, true)[0].events.len(), 1);
        assert_eq!(
            lifecycle_chip(&events[0]),
            Chip::Status("Scheduled".into(), "good")
        );
        assert_eq!(lifecycle_chip(&events[1]), Chip::Tag("Draft".into()));
        assert_eq!(
            lifecycle_chip(&event("x", "missing")),
            Chip::Status("Deleted on X".into(), "warn")
        );
        assert_eq!(privacy_label(&events[0]), Some("Unlisted"));
        assert_eq!(privacy_label(&events[1]), None);
        assert!(can_edit(&events[0]));
        assert_eq!(when_label(&events[0]), "Mon, Jan 1, 2035, 12:00 PM GMT+1");
        assert_eq!(
            when_label(&events[1]),
            "Mon, Jan 1, 2035, 12:00\u{2009}–\u{2009}2:00 PM GMT+1"
        );
    }

    fn x_ending(start_utc: &str, local_start: &str, end: &str, choice: Option<&str>) -> Event {
        let mut x = event("x", "scheduled");
        x.start_utc = start_utc.into();
        x.requested.local_start = local_start.into();
        x.requested.planned_end_local = Some(end.into());
        x.requested.offset_choice = choice.map(str::to_string);
        x
    }

    // The strings are Node 24's `Intl` (en-US, Europe/Madrid) for the same events.
    #[test]
    fn an_x_planned_end_reads_as_icu_writes_the_range() {
        let start = "2035-01-01T11:00:00Z";
        let local = "2035-01-01T12:00";
        assert_eq!(
            when_label(&x_ending(start, local, "2035-01-01T13:30", None)),
            "Mon, Jan 1, 2035, 12:00\u{2009}–\u{2009}1:30 PM GMT+1"
        );
        assert_eq!(
            when_label(&x_ending(start, local, "2035-01-02T01:00", None)),
            "Mon, Jan 1, 2035, 12:00 PM GMT+1\u{2009}–\u{2009}Tue, Jan 2, 2035, 1:00 AM GMT+1"
        );
        assert_eq!(
            when_label(&x_ending(start, local, "2035-01-01T11:00", None)),
            "Mon, Jan 1, 2035, 12:00 PM GMT+1"
        );
        let mut youtube = x_ending(start, local, "2035-01-01T13:30", None);
        youtube.provider = Some("youtube".into());
        assert_eq!(when_label(&youtube), "Mon, Jan 1, 2035, 12:00 PM GMT+1");
    }

    // #1479: the end is a wall time resolved on its own, so a DST change between
    // start and end doesn't shift it.
    #[test]
    fn a_planned_end_across_a_clock_change_shows_the_real_end() {
        let cases = [
            (
                "2027-03-28T00:30:00Z",
                "2027-03-28T01:30",
                "2027-03-28T03:30",
                "Sun, Mar 28, 2027, 1:30\u{2009}–\u{2009}3:30 AM GMT+2",
            ),
            (
                "2027-10-30T23:30:00Z",
                "2027-10-31T01:30",
                "2027-10-31T03:30",
                "Sun, Oct 31, 2027, 1:30\u{2009}–\u{2009}3:30 AM GMT+1",
            ),
            (
                "2027-03-27T00:30:00Z",
                "2027-03-27T01:30",
                "2027-03-27T03:30",
                "Sat, Mar 27, 2027, 1:30\u{2009}–\u{2009}3:30 AM GMT+1",
            ),
        ];
        for (start, local, end, label) in cases {
            assert_eq!(when_label(&x_ending(start, local, end, None)), label);
        }
        let repeated = |choice| {
            when_label(&x_ending(
                "2027-10-30T23:30:00Z",
                "2027-10-31T01:30",
                "2027-10-31T02:30",
                choice,
            ))
        };
        assert_eq!(
            repeated(Some("earlier")),
            "Sun, Oct 31, 2027, 1:30\u{2009}–\u{2009}2:30 AM GMT+2"
        );
        assert_eq!(
            repeated(Some("later")),
            "Sun, Oct 31, 2027, 1:30\u{2009}–\u{2009}2:30 AM GMT+1"
        );
        assert!(!repeated(None).contains('–'));
    }

    #[test]
    fn local_times_resolve_as_the_backend_does() {
        let at = |s: &str| s.parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            resolve_local_time("2035-01-01T12:00", "Europe/Madrid", None),
            Some(at("2035-01-01T11:00:00Z"))
        );
        assert_eq!(
            resolve_local_time("2035-03-25T02:30", "Europe/Madrid", Some("earlier")),
            None
        );
        assert_eq!(
            resolve_local_time("2035-10-28T02:30", "Europe/Madrid", Some("earlier")),
            Some(at("2035-10-28T00:30:00Z"))
        );
        assert_eq!(
            resolve_local_time("2035-10-28T02:30", "Europe/Madrid", Some("later")),
            Some(at("2035-10-28T01:30:00Z"))
        );
        assert_eq!(
            resolve_local_time("2035-10-28T02:30", "Europe/Madrid", None),
            None
        );
    }

    #[test]
    fn a_scheduled_start_names_its_zone_as_en_us_does() {
        let now = "2035-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            format_scheduled_start("2035-07-01T16:00:00Z", "Europe/Madrid", now),
            "Sun, Jul 1, 6:00 PM GMT+2"
        );
        let last_year = "2034-12-31T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            format_scheduled_start("2035-07-01T16:00:00Z", "America/New_York", last_year),
            "Sun, Jul 1, 2035, 12:00 PM EDT"
        );
    }

    #[test]
    fn times_read_as_people_name_them() {
        assert_eq!(format_gmt_offset(120), "GMT+2");
        assert_eq!(format_gmt_offset(-330), "GMT-5:30");
        let summer = "2035-07-01T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(time_zone_label("Europe/Madrid", summer), "Madrid (GMT+2)");
        assert_eq!(
            time_zone_label("America/New_York", summer),
            "New York (GMT-4)"
        );
        // Madrid's clocks go back at 03:00 on the last Sunday of October.
        assert_eq!(
            local_time_offsets("2035-10-28T02:30", "Europe/Madrid"),
            [120, 60]
        );
        assert_eq!(
            local_time_offsets("2035-03-25T02:30", "Europe/Madrid"),
            Vec::<i32>::new()
        );
        assert_eq!(default_planned_end("2035-01-01T23:30"), "2035-01-02T01:30");
        // New York's clocks go back at 02:00 on 2035-11-04 and forward on
        // 2035-03-11: two real hours, from the earlier 01:30 and from the 02:30
        // that doesn't exist (read as 03:30), as JavaScript's Date does.
        let ny = chrono_tz::America::New_York;
        assert_eq!(
            default_planned_end_in("2035-11-04T01:30", &ny),
            "2035-11-04T02:30"
        );
        assert_eq!(
            default_planned_end_in("2035-03-11T02:30", &ny),
            "2035-03-11T05:30"
        );
        assert_eq!(
            default_planned_end_in("2035-03-11T00:30", &ny),
            "2035-03-11T03:30"
        );
        let at = |s: &str| s.parse::<DateTime<Utc>>().unwrap();
        // 01:30 EST on the spring night: an hour on is 03:30, not the 02:30
        // that doesn't exist.
        let fresh = fresh_metadata_in("x", at("2035-03-11T06:30:00Z"), "America/New_York", &ny);
        assert_eq!(fresh.local_start, "2035-03-11T03:30");
        assert_eq!(fresh.planned_end_local.as_deref(), Some("2035-03-11T05:30"));
        assert_eq!(
            planned_end_error("x", "2035-01-01T12:00", Some("2035-01-01T11:00")),
            Some("The planned end must be after the start.")
        );
        let form = ScheduleForm {
            provider: "youtube",
            account_id: "c",
            title: "",
            description: "",
            audience: "",
            planned_end_error: None,
            time_error: None,
            resolving: false,
        };
        assert_eq!(
            schedule_blocked_reason(&form).as_deref(),
            Some("Add a title.")
        );
        let form = ScheduleForm {
            title: "Launch",
            ..form
        };
        assert_eq!(
            schedule_blocked_reason(&form).as_deref(),
            Some("Choose whether it's made for kids.")
        );
    }

    #[test]
    fn using_an_event_puts_it_on_its_signed_in_destination() {
        let mut config = json!({
            "streamEnabled": false,
            "streaming": {
                "enabled": false,
                "targets": [
                    { "id": "youtube", "platform": "youtube", "authMode": "oauth", "accountId": "ch", "enabled": false, "streamKeyPresent": true, "streamKeySecretRef": "k" },
                    { "id": "twitch", "platform": "twitch", "authMode": "manual-rtmp", "enabled": true },
                ],
                "enabledTargetIds": ["twitch"],
            },
        });
        let mut picked = event("youtube", "scheduled");
        picked.account_id = Some("ch".into());
        assert!(select_for_target(&mut config, "twitch", &picked, "now").is_err());
        select_for_target(&mut config, "youtube", &picked, "now").unwrap();
        let youtube = &config["streaming"]["targets"][0];
        assert_eq!(youtube["scheduledEventId"], json!("youtube-scheduled"));
        assert_eq!(youtube["enabled"], json!(true));
        assert!(youtube.get("streamKeySecretRef").is_none());
        assert_eq!(
            config["streaming"]["enabledTargetIds"],
            json!(["youtube", "twitch"])
        );
        assert_eq!(config["streaming"]["mode"], json!("multi"));
    }
}
