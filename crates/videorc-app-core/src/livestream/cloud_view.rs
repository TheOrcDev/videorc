//! S1.6c: what Videorc Cloud says on Destinations → Setup and in the Studio's
//! toasts (`lib/cloud-view.ts`, `lib/cloud-toasts.ts`, `lib/cloud-toast-id.ts`
//! and the strings of `components/streaming/cloud-section.tsx`). Plain words
//! ("Be right back", "cloud hours"), never "relay" or "runner"; nothing is
//! said when the cloud was never expected (the backend decides that).

use std::collections::BTreeSet;

use chrono::{DateTime, NaiveDate, Utc};
use videorc_protocol::AiCapabilitiesCloud;

use super::cloud_status::{CloudStatus, CloudTestResult, CloudTestStatus, CloudTestUpload};
use super::on_air::format_cloud_countdown;
use super::targets::format_bitrate;

/// The one id every Videorc Cloud toast shares, so a newer one replaces the
/// older.
pub const CLOUD_TOAST_ID: &str = "videorc-cloud";

/// The Premium sentence: Max includes Premium.
pub const CLOUD_PREMIUM_REASON: &str = "Videorc Cloud is part of Videorc Premium.";
/// A paid plan whose cloud isn't on yet: the rollout switch or the cohort.
pub const CLOUD_NOT_YET_REASON: &str =
    "Videorc Cloud isn't on for your account yet. Go Live streams directly from this computer.";
/// The switch off: where the next Go Live goes.
pub const CLOUD_DIRECT_LINE: &str = "Go Live streams directly from this computer.";
/// A show this computer isn't feeding is still live on our servers.
pub const CLOUD_SHOW_HELD_LINE: &str = "A show is live through Videorc Cloud. Go Live feeds it.";
/// The held show is live from another device, so Go Live is refused for it.
pub const CLOUD_SHOW_ELSEWHERE_LINE: &str =
    "Your show is live on another device. Use Continue here in the Studio.";

// --- The section's own words (`cloud-section.tsx`) ---

pub const SECTION_TITLE: &str = "Videorc Cloud";
pub const SECTION_DESCRIPTION: &str = "Your stream stays on air if this computer drops.";
pub const STREAM_THROUGH_LABEL: &str = "Stream through Videorc Cloud";
pub const TEST_LABEL: &str = "Test Videorc Cloud";
pub const TEST_BUTTON: &str = "Test";
pub const TESTING_BUTTON: &str = "Testing…";
pub const HOLD_IMAGE_LABEL: &str = "If this computer drops, show";
pub const HOLD_IMAGE_DESCRIPTION: &str = "Viewers see it until you're back.";
/// The hold image's first choice; its value on the wire is no screen id.
pub const BRB_CARD_LABEL: &str = "Be right back card";
pub const BRB_CARD_VALUE: &str = "default";
pub const HOLD_MAX_LABEL: &str = "End the stream after";
pub const HOLD_MAX_DESCRIPTION: &str =
    "Come back before then and the stream picks up where it left off.";

/// A show is live through the cloud with no local session feeding it.
pub fn cloud_show_held(status: Option<&CloudStatus>) -> bool {
    status
        .and_then(|status| status.show.as_ref())
        .is_some_and(|show| show.resumable)
}

fn cloud_show_held_line(status: &CloudStatus) -> &'static str {
    if status.live_elsewhere() {
        CLOUD_SHOW_ELSEWHERE_LINE
    } else {
        CLOUD_SHOW_HELD_LINE
    }
}

fn hours_or_minutes(seconds: u64) -> String {
    if seconds >= 3600 {
        let hours = seconds / 3600;
        format!("{hours} {}", if hours == 1 { "hour" } else { "hours" })
    } else {
        format!("{} min", seconds / 60)
    }
}

fn parse_instant(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .map(|at| at.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(at, "%Y-%m-%d")
                .ok()
                .and_then(|day| day.and_hms_opt(0, 0, 0))
                .map(|at| at.and_utc())
        })
}

/// `formatCloudResetDate`: "Nov 1". Cloud hours reset on the 1st, UTC.
pub fn format_cloud_reset_date(reset_at: Option<&str>) -> Option<String> {
    parse_instant(reset_at?).map(|at| at.format("%b %-d").to_string())
}

/// `cloudHoursLine`: "37 of 100 cloud hours left · resets Nov 1". Under an
/// hour left counts minutes; past the allowance it says so plainly, with no
/// charge.
pub fn cloud_hours_line(
    allowance: Option<&AiCapabilitiesCloud>,
    past_seconds: Option<u64>,
) -> Option<String> {
    let allowance = allowance.filter(|allowance| allowance.seconds_per_month > 0)?;
    let total = hours_or_minutes(allowance.seconds_per_month);
    let suffix = format_cloud_reset_date(allowance.reset_at.as_deref())
        .map(|reset| format!(" · resets {reset}"))
        .unwrap_or_default();
    if let Some(past) = past_seconds.filter(|past| *past > 0) {
        let of = if allowance.seconds_per_month >= 3600 {
            (allowance.seconds_per_month / 3600).to_string()
        } else {
            total
        };
        return Some(format!(
            "Cloud hours: 0 of {of} left · past by {}{suffix}",
            format_cloud_countdown(past as f64)
        ));
    }
    if allowance.overage_seconds > 0 {
        return Some(format!(
            "{} over this month's {total}, no charge{suffix}",
            hours_or_minutes(allowance.overage_seconds)
        ));
    }
    let left = allowance.seconds_remaining();
    if left >= 3600 {
        return Some(format!(
            "{} of {} cloud hours left{suffix}",
            left / 3600,
            allowance.seconds_per_month / 3600
        ));
    }
    Some(format!(
        "{} of {total} left{suffix}",
        hours_or_minutes(left)
    ))
}

/// `formatHoldLimit`: "5 min", "30 min", "1 hour".
pub fn format_hold_limit(seconds: u32) -> String {
    if seconds.is_multiple_of(3600) {
        let hours = seconds / 3600;
        format!("{hours} {}", if hours == 1 { "hour" } else { "hours" })
    } else {
        format!("{} min", (f64::from(seconds) / 60.0).round())
    }
}

/// `CloudSectionState`: what the Destinations page's Videorc Cloud section
/// shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionState {
    Upsell,
    Unavailable { reason: String },
    Available { hours: Option<String> },
}

/// `cloudSectionState`: `None` hides the section (no status yet, an older
/// backend, or no cloud expected).
pub fn section_state(status: Option<&CloudStatus>) -> Option<SectionState> {
    let status = status?;
    let allowance_on = status.allowance.as_ref().is_some_and(|a| a.enabled);
    if !allowance_on && status.show.is_none() && status.room.is_none() {
        return None;
    }
    if status.entitled {
        return Some(SectionState::Available {
            hours: cloud_hours_line(
                status.allowance.as_ref(),
                status.allowance_past.map(|past| past.seconds),
            ),
        });
    }
    if status.plan.is_some() {
        return Some(SectionState::Unavailable {
            reason: if cloud_show_held(Some(status)) {
                format!(
                    "Videorc Cloud isn't on for your account right now. {}",
                    cloud_show_held_line(status)
                )
            } else {
                CLOUD_NOT_YET_REASON.into()
            },
        });
    }
    Some(SectionState::Upsell)
}

/// `CloudUploadPlan`: what going through the cloud uploads against
/// streaming directly. The driver works it out from the capture config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadPlan {
    /// One feed per orientation in use: horizontal first.
    pub feeds_kbps: Vec<u32>,
    pub direct_kbps: u32,
    pub destinations: usize,
}

/// `cloudUploadLine`: "Uploads once. 6 Mbps for 3 destinations; direct
/// would be 18 Mbps." Numbers only, never a selling line.
pub fn cloud_upload_line(plan: Option<&UploadPlan>) -> Option<String> {
    let plan = plan.filter(|plan| !plan.feeds_kbps.is_empty())?;
    let cloud_kbps: u32 = plan.feeds_kbps.iter().sum();
    let lead = if plan.feeds_kbps.len() == 1 {
        "Uploads once."
    } else {
        "Uploads twice, once per orientation."
    };
    if plan.destinations <= plan.feeds_kbps.len() || plan.direct_kbps <= cloud_kbps {
        return Some(format!("{lead} {}.", format_bitrate(cloud_kbps)));
    }
    Some(format!(
        "{lead} {} for {} destinations; direct would be {}.",
        format_bitrate(cloud_kbps),
        plan.destinations,
        format_bitrate(plan.direct_kbps)
    ))
}

/// `cloudSwitchLines`: on, the hours and the upload; off, where Go Live
/// goes.
pub fn cloud_switch_lines(
    status: &CloudStatus,
    section: &SectionState,
    upload: Option<&UploadPlan>,
) -> Vec<String> {
    let SectionState::Available { hours } = section else {
        return Vec::new();
    };
    if !status.settings.enabled {
        let line = if cloud_show_held(Some(status)) {
            cloud_show_held_line(status)
        } else {
            CLOUD_DIRECT_LINE
        };
        return vec![line.into()];
    }
    hours
        .clone()
        .into_iter()
        .chain(cloud_upload_line(upload))
        .collect()
}

// --- Test cloud ---

/// The Test row's description while no test ran.
pub const CLOUD_TEST_DESCRIPTION: &str = "Sends 10 seconds of test video. Nothing goes public.";
pub const CLOUD_TEST_SESSION_REASON: &str = "Locked while you're recording or live.";
pub const CLOUD_TEST_SHOW_LIVE_REASON: &str = "A show is live through Videorc Cloud. End it first.";

/// "2:05 PM": the local time a limit frees up.
fn format_reset_time(reset_at: Option<&str>) -> Option<String> {
    parse_instant(reset_at?).map(|at| {
        at.with_timezone(&chrono::Local)
            .format("%-I:%M %p")
            .to_string()
    })
}

/// "2.3 s", rounded half up as `toFixed(1)` does.
fn format_short_seconds(ms: u64) -> String {
    let tenths = (ms + 50) / 100;
    format!("{}.{} s", tenths / 10, tenths % 10)
}

/// "6.2 of 6 Mbps".
fn upload_figure(upload: &CloudTestUpload) -> String {
    let measured = format_bitrate(upload.measured_kbps.unwrap_or(0));
    let measured = measured.strip_suffix(" Mbps").unwrap_or(&measured);
    format!("{measured} of {}", format_bitrate(upload.target_kbps))
}

/// "Upload held 6.2 of 6 Mbps."; a dual-orientation test names both.
fn uploads_line(uploads: &[CloudTestUpload], verb: &str) -> String {
    let measured: Vec<&CloudTestUpload> = uploads
        .iter()
        .filter(|upload| upload.measured_kbps.is_some())
        .collect();
    match measured.as_slice() {
        [] => String::new(),
        [one] => format!("Upload {verb} {}.", upload_figure(one)),
        [first, rest @ ..] => format!(
            "Upload {verb} {} for the {} stream and {}.",
            upload_figure(first),
            first.orientation,
            rest.iter()
                .map(|upload| format!("{} for the {}", upload_figure(upload), upload.orientation))
                .collect::<Vec<_>>()
                .join(" and ")
        ),
    }
}

/// `cloudTestRunning`: the button reads "Testing…" and stays disabled.
pub fn cloud_test_running(test: Option<&CloudTestStatus>) -> bool {
    test.is_some_and(|test| test.phase != "done")
}

/// `cloudTestResultLine`: what works, or what to do.
pub fn cloud_test_result_line(result: &CloudTestResult) -> String {
    if result.ok {
        let live = result
            .time_to_live_ms
            .map(|ms| format!(" Live in {}.", format_short_seconds(ms)))
            .unwrap_or_default();
        let mut upload = uploads_line(&result.uploads, "held");
        if upload.is_empty() && !result.uploads.is_empty() {
            upload = "Videorc couldn't measure the upload.".into();
        }
        let upload = if upload.is_empty() {
            upload
        } else {
            format!(" {upload}")
        };
        return format!("Videorc Cloud works from here.{live}{upload}");
    }
    match result.reason.as_deref() {
        Some("too-slow") => {
            let upload = uploads_line(&result.uploads, "reached");
            let lead = match upload.split_at_checked(1) {
                Some((first, rest)) if !upload.is_empty() => {
                    format!("Your {}{rest} ", first.to_lowercase())
                }
                _ => "Your upload fell short. ".into(),
            };
            format!("{lead}Choose a lower stream quality or use a wired connection.")
        }
        Some("cant-reach") => {
            "Videorc Cloud couldn't be reached from here. Check your connection and try again."
                .into()
        }
        Some("off") => "Videorc Cloud is off right now. Try again later.".into(),
        Some("full") => "Videorc Cloud is full right now. Try again in a few minutes.".into(),
        Some("not-entitled") => CLOUD_PREMIUM_REASON.into(),
        Some("no-hours") => match format_cloud_reset_date(result.reset_at.as_deref()) {
            Some(day) => format!("You've used this month's cloud hours. They come back {day}."),
            None => "You've used this month's cloud hours.".into(),
        },
        Some("limit") => match format_reset_time(result.reset_at.as_deref()) {
            Some(reset) => format!("You've run this hour's tests. Try again after {reset}."),
            None => "You've run this hour's tests. Try again in a while.".into(),
        },
        Some("show-live") => CLOUD_TEST_SHOW_LIVE_REASON.into(),
        Some("certificate") => "Videorc Cloud's certificate couldn't be checked on this network. Try another network, or turn off apps that inspect secure connections.".into(),
        Some("no-feed") => "Videorc Cloud didn't receive the test video. This network or a firewall may block streaming. Try another network.".into(),
        _ => "Couldn't test Videorc Cloud. Try again. If it keeps happening, export a support bundle from Health.".into(),
    }
}

/// A finished test that failed in a way the streamer acts on. A refusal is
/// a plain line, never an error.
fn cloud_test_failed(result: &CloudTestResult) -> bool {
    !result.ok
        && !matches!(
            result.reason.as_deref(),
            Some("off" | "full" | "not-entitled" | "no-hours" | "limit" | "show-live")
        )
}

/// `cloudTestLine`: the step under way, the result, or what it does.
pub fn cloud_test_line(test: Option<&CloudTestStatus>) -> String {
    let Some(test) = test else {
        return CLOUD_TEST_DESCRIPTION.into();
    };
    match test.phase.as_str() {
        "creating" | "connecting" => "Connecting to Videorc Cloud…".into(),
        "pushing" => "Sending 10 seconds of test video…".into(),
        "ending" => "Finishing the test…".into(),
        _ => test
            .result
            .as_ref()
            .map_or_else(|| CLOUD_TEST_DESCRIPTION.into(), cloud_test_result_line),
    }
}

/// The Test row's two lines: a failure is the row's own error, never a
/// toast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestRowLines {
    pub description: Option<String>,
    pub error: Option<String>,
}

/// `cloudTestRowLines`.
pub fn cloud_test_row_lines(test: Option<&CloudTestStatus>) -> TestRowLines {
    let result = test
        .filter(|test| test.phase == "done")
        .and_then(|test| test.result.as_ref());
    if let Some(result) = result.filter(|result| cloud_test_failed(result)) {
        return TestRowLines {
            description: None,
            error: Some(cloud_test_result_line(result)),
        };
    }
    TestRowLines {
        description: Some(cloud_test_line(test)),
        error: None,
    }
}

/// `cloudTestBlockedReason`: why Test is disabled in an open section.
pub fn cloud_test_blocked_reason(
    status: Option<&CloudStatus>,
    session_active: bool,
) -> Option<&'static str> {
    if session_active {
        return Some(CLOUD_TEST_SESSION_REASON);
    }
    status
        .and_then(|status| status.show.as_ref())
        .map(|_| CLOUD_TEST_SHOW_LIVE_REASON)
}

/// The hold image's choices: the Be right back card, then each screen
/// (`(value, label)`; the trigger shows the label, never the value).
pub fn hold_image_choices(screens: &[(String, String)]) -> Vec<(String, String)> {
    std::iter::once((BRB_CARD_VALUE.to_string(), BRB_CARD_LABEL.to_string()))
        .chain(screens.iter().cloned())
        .collect()
}

/// The section as the page draws it (`CloudSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionView {
    pub state: SectionState,
    /// The switch, the Test button and the hold choices are disabled.
    pub disabled: bool,
    /// The switch reads on.
    pub enabled: bool,
    pub switch_lines: Vec<String>,
    pub test_running: bool,
    pub test_blocked: Option<&'static str>,
    pub test_lines: TestRowLines,
    /// The hold choices show: a locked section shows what the cloud does, an
    /// open one folds them away while the switch is off.
    pub show_hold: bool,
    /// The chosen hold image's value (`default` for the card).
    pub hold_image: String,
    pub hold_max_choices: Vec<(u32, String)>,
    pub hold_max_seconds: u32,
}

pub fn section_view(
    status: Option<&CloudStatus>,
    session_active: bool,
    upload: Option<&UploadPlan>,
) -> Option<SectionView> {
    let state = section_state(status)?;
    let status = status?;
    let available = matches!(state, SectionState::Available { .. });
    let settings = &status.settings;
    Some(SectionView {
        disabled: !available || session_active,
        enabled: available && settings.enabled,
        switch_lines: cloud_switch_lines(status, &state, upload),
        test_running: cloud_test_running(status.test.as_ref()),
        test_blocked: if available {
            cloud_test_blocked_reason(Some(status), session_active)
        } else {
            None
        },
        test_lines: cloud_test_row_lines(status.test.as_ref()),
        show_hold: !available || settings.enabled,
        hold_image: settings
            .hold_image_screen_id
            .clone()
            .unwrap_or_else(|| BRB_CARD_VALUE.into()),
        hold_max_choices: settings
            .hold_max_choices
            .iter()
            .map(|seconds| (*seconds, format_hold_limit(*seconds)))
            .collect(),
        hold_max_seconds: settings.hold_max_seconds,
        state,
    })
}

/// The settings patch a hold image choice sends (`null` for the card).
pub fn hold_image_patch(value: &str) -> serde_json::Value {
    let screen = (value != BRB_CARD_VALUE).then_some(value);
    serde_json::json!({ "holdImageScreenId": screen })
}

// --- Toasts (`cloud-toasts.ts`) ---

/// `cloudFallbackMessage`: one toast line for a Go Live that streamed
/// directly; `None` for a reason this app doesn't know.
pub fn cloud_fallback_message(
    reason: &str,
    allowance: Option<&AiCapabilitiesCloud>,
) -> Option<String> {
    let direct = "You're streaming directly from this computer";
    Some(match reason {
        "cloud-full" => format!("Videorc Cloud is full right now. {direct}."),
        "cloud-hours-used-up" => {
            match format_cloud_reset_date(allowance.and_then(|a| a.reset_at.as_deref())) {
                Some(reset) => {
                    format!("You've used this month's cloud hours. {direct} until {reset}.")
                }
                None => format!("You've used this month's cloud hours. {direct}."),
            }
        }
        "cloud-node-unreachable" => format!("Videorc Cloud couldn't be reached. {direct}."),
        "cloud-show-limit" => {
            format!("You've started this hour's Videorc Cloud shows. {direct} for now.")
        }
        "cloud-disabled" => format!("Videorc Cloud is off right now. {direct}."),
        "not-entitled" => format!("{CLOUD_PREMIUM_REASON} {direct}."),
        "cloud-quality" => {
            format!("Videorc Cloud can't carry this stream's quality yet. {direct}.")
        }
        "cloud-unchecked" => format!("Videorc couldn't check your last cloud show. {direct}."),
        "cloud-guest-hours-used-up" => {
            "This month's guest limit is reached. Guests already on stay.".into()
        }
        "cloud-rooms-unavailable" => {
            "Rooms aren't available right now. Try again in a moment.".into()
        }
        _ => return None,
    })
}

/// `cloudFallbackToast`: a NEW fallback, once per Go Live.
pub fn cloud_fallback_toast(previous: Option<&CloudStatus>, next: &CloudStatus) -> Option<String> {
    let fallback = next.fallback.as_ref()?;
    if previous
        .and_then(|previous| previous.fallback.as_ref())
        .is_some_and(|before| before.session_id == fallback.session_id)
    {
        return None;
    }
    cloud_fallback_message(&fallback.reason, next.allowance.as_ref())
}

/// `cloudLostToast`: once, when the cloud loses a show this computer fed.
pub fn cloud_lost_toast(
    previous: Option<&CloudStatus>,
    next: &CloudStatus,
) -> Option<&'static str> {
    if !next.direct_fallback_available
        || previous.is_some_and(|previous| previous.direct_fallback_available)
    {
        return None;
    }
    Some(
        "Videorc Cloud lost your show. Stop, then go live again to stream directly from this computer.",
    )
}

/// `cloudRestartToast`: once per runner restart, and once more if the
/// platforms then could not be reconnected.
pub fn cloud_restart_toast(
    previous: Option<&CloudStatus>,
    next: &CloudStatus,
) -> Option<&'static str> {
    const UNRECOVERED: &str = "Videorc Cloud restarted your show, but your platforms couldn't be reconnected. Stop, then go live again.";
    let restart = next.restart.as_ref()?;
    if let Some(before) = previous
        .and_then(|previous| previous.restart.as_ref())
        .filter(|before| before.at == restart.at)
    {
        return (before.destinations_resent && !restart.destinations_resent).then_some(UNRECOVERED);
    }
    Some(if restart.destinations_resent {
        "Videorc Cloud restarted your show. Your platforms reconnect in a few seconds."
    } else {
        UNRECOVERED
    })
}

/// A show on a node ends after 12 hours on air, with a warning at 11.
pub const CLOUD_SHOW_MAX_SECONDS: u64 = 12 * 60 * 60;
pub const CLOUD_SHOW_WARN_SECONDS: u64 = 11 * 60 * 60;
const MANAGED_NODE_ID: &str = "livekit";
const HOUR_MS: i64 = 60 * 60 * 1000;

/// `cloudShowCapToast`: the once-per-show warning an hour before the show
/// ends. A node's clock is `liveSeconds`; a managed show counts down to its
/// `expiresAt`. `warned` is Electron's module-level set of managed shows
/// already warned; the Studio owns it for the app's lifetime.
pub fn cloud_show_cap_toast(
    previous: Option<&CloudStatus>,
    next: &CloudStatus,
    now_ms: i64,
    warned: &mut BTreeSet<String>,
) -> Option<String> {
    let show = next.show.as_ref().filter(|show| !show.id.is_empty())?;
    let ends_at = (show.node_id == MANAGED_NODE_ID)
        .then_some(show.expires_at.as_deref())
        .flatten()
        .and_then(parse_instant);
    let live = next.live_seconds.unwrap_or(0);
    let left = if let Some(ends_at) = ends_at {
        let left_ms = ends_at.timestamp_millis() - now_ms;
        if left_ms > HOUR_MS || warned.contains(&show.id) {
            return None;
        }
        warned.insert(show.id.clone());
        left_ms as f64 / 1000.0
    } else {
        if live < CLOUD_SHOW_WARN_SECONDS {
            return None;
        }
        if previous.is_some_and(|previous| {
            previous
                .show
                .as_ref()
                .is_some_and(|before| before.id == show.id)
                && previous.live_seconds.unwrap_or(0) >= CLOUD_SHOW_WARN_SECONDS
        }) {
            return None;
        }
        CLOUD_SHOW_MAX_SECONDS.saturating_sub(live) as f64
    };
    Some(format!(
        "Your livestream ends in {}. A Videorc Cloud show runs about 12 hours at most.",
        format_cloud_countdown(left.max(0.0))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::livestream::cloud_status::{
        CloudFallback, CloudOnAirDevice, CloudRestart, CloudSettings, CloudShow,
    };

    fn allowance(per_month: u64, used: u64, overage: u64) -> AiCapabilitiesCloud {
        AiCapabilitiesCloud {
            enabled: true,
            seconds_per_month: per_month,
            seconds_used: used,
            overage_seconds: overage,
            reset_at: Some("2035-11-01T00:00:00Z".into()),
            ..AiCapabilitiesCloud::default()
        }
    }

    fn entitled() -> CloudStatus {
        CloudStatus {
            phase: "off".into(),
            entitled: true,
            plan: Some("premium".into()),
            settings: CloudSettings {
                enabled: true,
                hold_max_seconds: 1800,
                hold_max_choices: vec![300, 1800, 3600],
                hold_image_screen_id: None,
            },
            allowance: Some(allowance(100 * 3600, 63 * 3600, 0)),
            ..CloudStatus::default()
        }
    }

    fn test_result(ok: bool, reason: Option<&str>) -> CloudTestResult {
        CloudTestResult {
            ok,
            reason: reason.map(str::to_string),
            ..CloudTestResult::default()
        }
    }

    fn upload(orientation: &str, target: u32, measured: Option<u32>) -> CloudTestUpload {
        CloudTestUpload {
            orientation: orientation.into(),
            target_kbps: target,
            measured_kbps: measured,
        }
    }

    #[test]
    fn the_hours_line_counts_hours_minutes_overage_and_past() {
        let line = |a: &AiCapabilitiesCloud, past| cloud_hours_line(Some(a), past).unwrap();
        assert_eq!(
            line(&allowance(100 * 3600, 63 * 3600, 0), None),
            "37 of 100 cloud hours left · resets Nov 1"
        );
        assert_eq!(
            line(&allowance(100 * 3600, 100 * 3600 - 1500, 0), None),
            "25 min of 100 hours left · resets Nov 1"
        );
        assert_eq!(
            line(&allowance(3600, 3600, 5400), None),
            "1 hour over this month's 1 hour, no charge · resets Nov 1"
        );
        assert_eq!(
            line(&allowance(100 * 3600, 100 * 3600, 0), Some(1500)),
            "Cloud hours: 0 of 100 left · past by 25 min · resets Nov 1"
        );
        assert_eq!(
            line(&allowance(1800, 1800, 0), Some(30)),
            "Cloud hours: 0 of 30 min left · past by 30 s · resets Nov 1"
        );
        assert_eq!(cloud_hours_line(Some(&allowance(0, 0, 0)), None), None);
        assert_eq!(
            format_cloud_reset_date(Some("2035-12-01")).as_deref(),
            Some("Dec 1")
        );
        assert_eq!(format_cloud_reset_date(Some("soon")), None);
        assert_eq!(format_hold_limit(300), "5 min");
        assert_eq!(format_hold_limit(3600), "1 hour");
        assert_eq!(format_hold_limit(7200), "2 hours");
    }

    #[test]
    fn the_section_shows_upsell_not_yet_held_or_available() {
        assert_eq!(section_state(None), None);
        let mut status = entitled();
        assert_eq!(
            section_state(Some(&status)),
            Some(SectionState::Available {
                hours: Some("37 of 100 cloud hours left · resets Nov 1".into())
            })
        );
        status.entitled = false;
        assert_eq!(
            section_state(Some(&status)),
            Some(SectionState::Unavailable {
                reason: CLOUD_NOT_YET_REASON.into()
            })
        );
        status.show = Some(CloudShow {
            id: "s".into(),
            resumable: true,
            ..CloudShow::default()
        });
        assert_eq!(
            section_state(Some(&status)),
            Some(SectionState::Unavailable {
                reason: "Videorc Cloud isn't on for your account right now. A show is live through Videorc Cloud. Go Live feeds it.".into()
            })
        );
        status.plan = None;
        assert_eq!(section_state(Some(&status)), Some(SectionState::Upsell));
        status.show = None;
        status.allowance = None;
        assert_eq!(section_state(Some(&status)), None);
    }

    #[test]
    fn the_switch_says_hours_and_upload_or_where_go_live_goes() {
        let mut status = entitled();
        let section = section_state(Some(&status)).unwrap();
        let plan = UploadPlan {
            feeds_kbps: vec![6000],
            direct_kbps: 18000,
            destinations: 3,
        };
        assert_eq!(
            cloud_switch_lines(&status, &section, Some(&plan)),
            [
                "37 of 100 cloud hours left · resets Nov 1",
                "Uploads once. 6 Mbps for 3 destinations; direct would be 18 Mbps."
            ]
        );
        let two = UploadPlan {
            feeds_kbps: vec![6000, 4500],
            direct_kbps: 10500,
            destinations: 2,
        };
        assert_eq!(
            cloud_upload_line(Some(&two)).as_deref(),
            Some("Uploads twice, once per orientation. 10.5 Mbps.")
        );
        status.settings.enabled = false;
        assert_eq!(
            cloud_switch_lines(&status, &section, Some(&plan)),
            [CLOUD_DIRECT_LINE]
        );
        status.show = Some(CloudShow {
            resumable: true,
            ..CloudShow::default()
        });
        status.on_air = Some(CloudOnAirDevice {
            this_device: false,
            waiting: false,
            ..CloudOnAirDevice::default()
        });
        assert_eq!(
            cloud_switch_lines(&status, &section, None),
            [CLOUD_SHOW_ELSEWHERE_LINE]
        );
        assert!(cloud_switch_lines(&status, &SectionState::Upsell, None).is_empty());
    }

    #[test]
    fn test_cloud_says_the_step_the_result_or_the_error() {
        assert_eq!(cloud_test_line(None), CLOUD_TEST_DESCRIPTION);
        let running = CloudTestStatus {
            phase: "pushing".into(),
            ..CloudTestStatus::default()
        };
        assert!(cloud_test_running(Some(&running)));
        assert_eq!(
            cloud_test_line(Some(&running)),
            "Sending 10 seconds of test video…"
        );
        let mut ok = test_result(true, None);
        ok.time_to_live_ms = Some(2250);
        ok.uploads = vec![upload("horizontal", 6000, Some(6200))];
        assert_eq!(
            cloud_test_result_line(&ok),
            "Videorc Cloud works from here. Live in 2.3 s. Upload held 6.2 of 6 Mbps."
        );
        ok.uploads = vec![
            upload("horizontal", 6000, Some(6200)),
            upload("vertical", 3000, Some(3100)),
        ];
        ok.time_to_live_ms = None;
        assert_eq!(
            cloud_test_result_line(&ok),
            "Videorc Cloud works from here. Upload held 6.2 of 6 Mbps for the horizontal stream and 3.1 of 3 Mbps for the vertical."
        );
        ok.uploads = vec![upload("horizontal", 6000, None)];
        assert_eq!(
            cloud_test_result_line(&ok),
            "Videorc Cloud works from here. Videorc couldn't measure the upload."
        );
        let mut slow = test_result(false, Some("too-slow"));
        slow.uploads = vec![upload("horizontal", 6000, Some(4100))];
        assert_eq!(
            cloud_test_result_line(&slow),
            "Your upload reached 4.1 of 6 Mbps. Choose a lower stream quality or use a wired connection."
        );
        slow.uploads.clear();
        assert_eq!(
            cloud_test_result_line(&slow),
            "Your upload fell short. Choose a lower stream quality or use a wired connection."
        );
        let mut no_hours = test_result(false, Some("no-hours"));
        no_hours.reset_at = Some("2035-11-01T00:00:00Z".into());
        assert_eq!(
            cloud_test_result_line(&no_hours),
            "You've used this month's cloud hours. They come back Nov 1."
        );
        assert_eq!(
            cloud_test_result_line(&test_result(false, Some("limit"))),
            "You've run this hour's tests. Try again in a while."
        );

        let done = |result| CloudTestStatus {
            phase: "done".into(),
            result: Some(result),
            ..CloudTestStatus::default()
        };
        let failed = cloud_test_row_lines(Some(&done(test_result(false, Some("no-feed")))));
        assert_eq!(failed.description, None);
        assert!(
            failed
                .error
                .unwrap()
                .starts_with("Videorc Cloud didn't receive")
        );
        let refused = cloud_test_row_lines(Some(&done(test_result(false, Some("full")))));
        assert_eq!(
            refused.description.as_deref(),
            Some("Videorc Cloud is full right now. Try again in a few minutes.")
        );
        assert_eq!(refused.error, None);
        let unknown = cloud_test_row_lines(Some(&done(test_result(false, None))));
        assert!(
            unknown
                .error
                .unwrap()
                .starts_with("Couldn't test Videorc Cloud.")
        );

        assert_eq!(
            cloud_test_blocked_reason(None, true),
            Some(CLOUD_TEST_SESSION_REASON)
        );
        let mut status = entitled();
        assert_eq!(cloud_test_blocked_reason(Some(&status), false), None);
        status.show = Some(CloudShow::default());
        assert_eq!(
            cloud_test_blocked_reason(Some(&status), false),
            Some(CLOUD_TEST_SHOW_LIVE_REASON)
        );
    }

    #[test]
    fn the_section_view_locks_and_folds_as_the_page_does() {
        let mut status = entitled();
        let view = section_view(Some(&status), false, None).unwrap();
        assert!(!view.disabled && view.enabled && view.show_hold);
        assert_eq!(view.hold_image, BRB_CARD_VALUE);
        assert_eq!(
            view.hold_max_choices,
            [
                (300, "5 min".to_string()),
                (1800, "30 min".to_string()),
                (3600, "1 hour".to_string())
            ]
        );
        assert!(section_view(Some(&status), true, None).unwrap().disabled);
        status.settings.enabled = false;
        assert!(!section_view(Some(&status), false, None).unwrap().show_hold);
        status.entitled = false;
        let locked = section_view(Some(&status), false, None).unwrap();
        assert!(locked.disabled && !locked.enabled && locked.show_hold);
        assert_eq!(locked.test_blocked, None);
        assert_eq!(
            hold_image_patch("default"),
            serde_json::json!({"holdImageScreenId": null})
        );
        assert_eq!(
            hold_image_patch("screen-2"),
            serde_json::json!({"holdImageScreenId": "screen-2"})
        );
        assert_eq!(
            hold_image_choices(&[("screen-2".into(), "Slides".into())])[0].1,
            BRB_CARD_LABEL
        );
    }

    #[test]
    fn toasts_fire_once_per_change() {
        let mut next = entitled();
        next.fallback = Some(CloudFallback {
            reason: "cloud-hours-used-up".into(),
            session_id: "a".into(),
            ..CloudFallback::default()
        });
        assert_eq!(
            cloud_fallback_toast(None, &next).as_deref(),
            Some(
                "You've used this month's cloud hours. You're streaming directly from this computer until Nov 1."
            )
        );
        assert_eq!(cloud_fallback_toast(Some(&next), &next), None);
        assert_eq!(cloud_fallback_message("cloud-new-reason", None), None);

        next.direct_fallback_available = true;
        assert!(cloud_lost_toast(None, &next).is_some());
        assert_eq!(cloud_lost_toast(Some(&next), &next), None);

        next.restart = Some(CloudRestart {
            at: "t1".into(),
            destinations_resent: true,
        });
        assert_eq!(
            cloud_restart_toast(None, &next),
            Some("Videorc Cloud restarted your show. Your platforms reconnect in a few seconds.")
        );
        assert_eq!(cloud_restart_toast(Some(&next), &next), None);
        let mut failed = next.clone();
        failed.restart = Some(CloudRestart {
            at: "t1".into(),
            destinations_resent: false,
        });
        assert!(
            cloud_restart_toast(Some(&next), &failed)
                .unwrap()
                .contains("couldn't be reconnected")
        );
    }

    #[test]
    fn the_cap_warns_an_hour_before_a_show_ends_once() {
        let mut warned = BTreeSet::new();
        let mut node = entitled();
        node.show = Some(CloudShow {
            id: "n".into(),
            node_id: "node-1".into(),
            ..CloudShow::default()
        });
        node.live_seconds = Some(CLOUD_SHOW_WARN_SECONDS - 1);
        assert_eq!(cloud_show_cap_toast(None, &node, 0, &mut warned), None);
        let mut later = node.clone();
        later.live_seconds = Some(CLOUD_SHOW_WARN_SECONDS + 60);
        assert_eq!(
            cloud_show_cap_toast(Some(&node), &later, 0, &mut warned).as_deref(),
            Some(
                "Your livestream ends in 59 min. A Videorc Cloud show runs about 12 hours at most."
            )
        );
        assert_eq!(
            cloud_show_cap_toast(Some(&later), &later, 0, &mut warned),
            None
        );

        let mut managed = entitled();
        managed.show = Some(CloudShow {
            id: "m".into(),
            node_id: "livekit".into(),
            expires_at: Some("2035-01-01T12:00:00Z".into()),
            ..CloudShow::default()
        });
        let at = |s: &str| s.parse::<DateTime<Utc>>().unwrap().timestamp_millis();
        assert_eq!(
            cloud_show_cap_toast(None, &managed, at("2035-01-01T10:30:00Z"), &mut warned),
            None
        );
        assert_eq!(
            cloud_show_cap_toast(None, &managed, at("2035-01-01T11:15:00Z"), &mut warned)
                .as_deref(),
            Some(
                "Your livestream ends in 45 min. A Videorc Cloud show runs about 12 hours at most."
            )
        );
        assert_eq!(
            cloud_show_cap_toast(None, &managed, at("2035-01-01T11:30:00Z"), &mut warned),
            None
        );
    }
}
