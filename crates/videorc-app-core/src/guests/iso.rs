//! "Separate files", the opt-in cloud ISO (plan 249 S22;
//! `lib/cloud-iso-view.ts`): each person and each source of a talk show as
//! its own file in the cloud, beside the mixed recording. The words and
//! states for the Guests page's control and the Library's take rows. The
//! manifest is read through the one strict parser the backend uses
//! (`videorc_protocol::cloud_source_iso`), so every refusal matches.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::Value;
use videorc_protocol::cloud_source_iso::{
    IsoDownloadRecord, IsoDownloadState, IsoEntry, IsoManifest, ROLES, parse_iso_manifest,
    plan_iso_import,
};

use super::view::{Tone, plural};
use super::wire::RoomGuest;

// --- Wire (`cloud.iso.status`, `cloud.iso.imports`, the `cloud.iso.import` event) --

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoProvider {
    pub adapter: String,
    pub sdk_support: String,
    /// Published figures (`microsPerTrackEgressMinute`, …), never a bill.
    pub facts: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoAvailability {
    pub enabled: bool,
    pub production_qualified: bool,
    pub provider: Option<IsoProvider>,
    pub unmet: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoGuestConsent {
    pub identity: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoRefusal {
    pub reason: String,
    pub at_ms: i64,
    pub take_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoTakeWire {
    /// The manifest as the backend relays it: parsed again before use.
    pub manifest: Value,
    pub program_recording_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoStatus {
    /// The host's consent and limits; None while separate files are off.
    pub request: Option<Value>,
    pub guest_consent: Vec<IsoGuestConsent>,
    pub last_refusal: Option<IsoRefusal>,
    pub takes: Vec<IsoTakeWire>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct IsoAnswer {
    pub availability: IsoAvailability,
    pub iso: Option<IsoStatus>,
}

/// `cloud.iso.imports`: one per take this computer imported from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IsoImportJournal {
    pub show_id: String,
    pub take_id: String,
    pub program_recording_id: String,
    pub records: Vec<IsoDownloadRecord>,
}

/// The `cloud.iso.import` event: one file of an import job.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoImportEvent {
    pub job_id: String,
    #[serde(default)]
    pub show_id: String,
    pub take_id: String,
    /// None for a job-level failure that names no file.
    #[serde(default)]
    pub entry_id: Option<String>,
    pub state: IsoDownloadState,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub local_session_id: Option<String>,
}

// --- Availability, limits and cost -------------------------------------------

/// The published per-minute price of one separate file (raw track export).
pub const ISO_MICROS_PER_FILE_MINUTE: f64 = 1_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IsoLimits {
    pub max_active_entries: u32,
    pub max_minutes: u32,
}

/// What Turn on asks for: the web's cap on files at once, and two hours.
pub const ISO_DEFAULT_LIMITS: IsoLimits = IsoLimits {
    max_active_entries: 12,
    max_minutes: 120,
};

pub const ISO_NOT_AVAILABLE: &str = "Separate cloud files aren't available yet.";
pub const ISO_NOT_ON_PLAN: &str = "Separate cloud files aren't part of your plan.";
pub const ISO_OPEN_ROOM_FIRST: &str = "Open the room first.";
pub const ISO_CHECKING: &str = "Checking separate files…";
pub const ISO_FOLDER_UNAVAILABLE: &str = "The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.";
pub const ISO_LAYOUT_UNKNOWN_NOTE: &str = "Layout unknown: this camera file may hold a hidden transparency layer, so Videorc never shows it as a picture. Check it in an editor before you use it.";
pub const ISO_OVERLAP_NOTE: &str =
    "Overlaps: another part of the same source was recording at the same time.";
/// `lib/lock-reason.ts`'s `OFFLINE_LOCK_REASON`.
pub const OFFLINE_LOCK_REASON: &str =
    "Videorc is reconnecting. These controls come back in a moment.";

/// The price the web published, when it sent one; else the known one.
pub fn iso_micros_per_file_minute(availability: Option<&IsoAvailability>) -> f64 {
    availability
        .and_then(|availability| availability.provider.as_ref())
        .and_then(|provider| provider.facts.get("microsPerTrackEgressMinute"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(ISO_MICROS_PER_FILE_MINUTE)
}

/// The worst case: every file recording for the whole limit.
pub fn iso_estimate_micros(limits: IsoLimits, micros_per_minute: f64) -> f64 {
    f64::from(limits.max_active_entries) * f64::from(limits.max_minutes) * micros_per_minute
}

/// "$1.44"; a per-minute price keeps its third decimal: "$0.001". Rounds
/// half up on the exact decimal value.
pub fn format_usd_micros(micros: f64) -> String {
    let micros = micros.round() as i64;
    if (1..10_000).contains(&micros) {
        let mills = (micros + 500) / 1_000;
        format!("${}.{:03}", mills / 1_000, mills % 1_000)
    } else {
        let cents = (micros + 5_000).div_euclid(10_000);
        format!("${}.{:02}", cents.div_euclid(100), cents.rem_euclid(100))
    }
}

fn minutes_label(minutes: u32) -> String {
    if minutes.is_multiple_of(60) {
        plural(minutes / 60, "hour", None)
    } else {
        plural(minutes, "minute", None)
    }
}

pub fn iso_limits_line(limits: IsoLimits) -> String {
    format!(
        "Up to {} at once, for up to {}.",
        plural(limits.max_active_entries, "file", None),
        minutes_label(limits.max_minutes)
    )
}

pub fn iso_cost_line(limits: IsoLimits, micros_per_minute: f64) -> String {
    format!(
        "Estimated cost: up to {} ({} × {} at {} a minute, the published price). An estimate, not a bill.",
        format_usd_micros(iso_estimate_micros(limits, micros_per_minute)),
        plural(limits.max_active_entries, "file", None),
        plural(limits.max_minutes, "minute", None),
        format_usd_micros(micros_per_minute)
    )
}

/// The one request Turn on sends: consent from the checked confirmation only.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoEnableParams {
    pub show_id: String,
    pub consent: bool,
    pub max_active_entries: u32,
    pub max_minutes: u32,
    /// Whole micros: the backend's `cloud.iso.enable` takes a `u64` and
    /// refuses `1440000.0`. The estimate stays `f64` for display.
    pub cost_ceiling_micros: u64,
}

/// The ceiling the backend takes, in whole micros. Rounded up, so it never
/// sits below the estimate; none when the estimate is not a finite,
/// non-negative amount that fits a `u64`.
pub fn iso_ceiling_micros(estimate: f64) -> Option<u64> {
    let ceiling = estimate.ceil();
    (ceiling.is_finite() && ceiling >= 0.0 && ceiling < u64::MAX as f64).then_some(ceiling as u64)
}

/// None only for a price that is not a real amount (never the published one).
pub fn iso_enable_params(
    show_id: &str,
    limits: IsoLimits,
    micros_per_minute: f64,
) -> Option<IsoEnableParams> {
    Some(IsoEnableParams {
        show_id: show_id.to_string(),
        consent: true,
        max_active_entries: limits.max_active_entries,
        max_minutes: limits.max_minutes,
        cost_ceiling_micros: iso_ceiling_micros(iso_estimate_micros(limits, micros_per_minute))?,
    })
}

/// Limits on an enable request, or the defaults while separate files are off.
pub fn iso_request_limits(request: Option<&Value>) -> IsoLimits {
    let Some(request) = request else {
        return ISO_DEFAULT_LIMITS;
    };
    IsoLimits {
        max_active_entries: request
            .get("maxActiveEntries")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0 && n <= u32::MAX as u64)
            .map(|n| n as u32)
            .unwrap_or(ISO_DEFAULT_LIMITS.max_active_entries),
        max_minutes: request
            .get("maxMinutes")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0 && n <= u32::MAX as u64)
            .map(|n| n as u32)
            .unwrap_or(ISO_DEFAULT_LIMITS.max_minutes),
    }
}

/// A refusal's words, by the backend's error code.
pub fn iso_error_text(code: Option<&str>) -> Option<&'static str> {
    Some(match code? {
        "cloud-iso-not-qualified" => ISO_NOT_AVAILABLE,
        "cloud-iso-plan" => ISO_NOT_ON_PLAN,
        "cloud-iso-refused" => "Videorc Cloud can't record separate files for this show right now.",
        "cloud-iso-controller" => "Another device controls this show now. Continue here first.",
        "cloud-iso-failed" => "Videorc Cloud didn't answer about separate files. Try again.",
        "cloud-iso-import-failed" => "The separate files couldn't be downloaded. Try again.",
        "resource-capability-rejected" => ISO_FOLDER_UNAVAILABLE,
        _ => return None,
    })
}

/// What Turn on's gate reads.
#[derive(Debug, Clone, Copy)]
pub struct IsoRoomGate<'a> {
    pub offline: bool,
    pub room_open: bool,
    /// The last `cloud.iso.status` answer; None until one arrives.
    pub answer: Option<&'a IsoAnswer>,
    /// The error code of the last status check that failed.
    pub error_code: Option<&'a str>,
}

/// Why Turn on is disabled, or None when it can be asked for.
pub fn iso_enable_blocked_reason(gate: IsoRoomGate<'_>) -> Option<&'static str> {
    if gate.offline {
        return Some(OFFLINE_LOCK_REASON);
    }
    if !gate.room_open {
        return Some(ISO_OPEN_ROOM_FIRST);
    }
    match gate.error_code {
        Some("cloud-iso-plan") => return Some(ISO_NOT_ON_PLAN),
        Some("cloud-iso-not-qualified") => return Some(ISO_NOT_AVAILABLE),
        _ => {}
    }
    let Some(answer) = gate.answer else {
        return Some(if gate.error_code.is_some() {
            ISO_NOT_AVAILABLE
        } else {
            ISO_CHECKING
        });
    };
    if !answer.availability.production_qualified || !answer.availability.enabled {
        return Some(ISO_NOT_AVAILABLE);
    }
    None
}

// --- Takes ---------------------------------------------------------------------

/// A take read through the strict parser, with the two manifest facts the
/// notes need and the parser does not keep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoTake {
    pub manifest: IsoManifest,
    pub stop_reason: Option<String>,
    pub refused: usize,
}

/// A take, or an unreadable one, which stays listed as unreadable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoParsedTake {
    pub take: Option<IsoTake>,
    pub program_recording_id: String,
}

pub fn iso_parse_take(manifest: &Value) -> Option<IsoTake> {
    let parsed = parse_iso_manifest(manifest).ok()?;
    Some(IsoTake {
        manifest: parsed,
        stop_reason: manifest["stopReason"].as_str().map(str::to_string),
        refused: manifest["refused"].as_array().map_or(0, Vec::len),
    })
}

/// Every take, read through the strict parser.
pub fn iso_parsed_takes(status: Option<&IsoStatus>) -> Vec<IsoParsedTake> {
    status
        .map(|status| {
            status
                .takes
                .iter()
                .map(|take| IsoParsedTake {
                    take: iso_parse_take(&take.manifest),
                    program_recording_id: take.program_recording_id.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The take the room records now, or the last one: the newest manifest.
pub fn iso_current_take(takes: &[IsoParsedTake]) -> Option<&IsoTake> {
    let mut current: Option<&IsoTake> = None;
    for take in takes.iter().filter_map(|parsed| parsed.take.as_ref()) {
        if current.is_none_or(|known| take.manifest.created_at_ms > known.manifest.created_at_ms) {
            current = Some(take);
        }
    }
    current
}

// --- Rows ----------------------------------------------------------------------

fn role_title(role: &str) -> &'static str {
    match role {
        "host-camera" => "Host camera",
        "host-microphone" => "Host microphone",
        "host-aux" => "Host sounds",
        "host-screen" => "Host screen",
        "guest-camera" => "Guest camera",
        "guest-microphone" => "Guest microphone",
        "guest-screen" => "Guest screen",
        "guest-screen-audio" => "Guest screen audio",
        _ => "File",
    }
}

fn role_word(role: &str) -> &'static str {
    match role {
        "host-camera" | "guest-camera" => "camera",
        "host-microphone" | "guest-microphone" => "microphone",
        "host-aux" => "show sounds",
        "host-screen" | "guest-screen" => "screen",
        "guest-screen-audio" => "screen audio",
        _ => "file",
    }
}

pub fn iso_failure_text(failure: Option<&str>) -> Option<&'static str> {
    Some(match failure? {
        "start-failed" => "Couldn't start",
        "provider-failed" => "Stopped by a cloud error",
        "provider-aborted" => "Stopped by the cloud",
        "limit-reached" => "Reached the cloud's time limit",
        "missing-output" => "No file was saved",
        "stop-failed" => "Couldn't stop cleanly",
        "start-unknown" => "Didn't start",
        _ => return None,
    })
}

fn stop_text(reason: &str) -> Option<&'static str> {
    match reason {
        "budget-exhausted" => Some("Separate files stopped: the cost limit was reached."),
        "time-limit" => Some("Separate files stopped: the time limit was reached."),
        _ => None,
    }
}

fn part_suffix(generation: i64) -> String {
    if generation > 1 {
        format!(" (part {generation})")
    } else {
        String::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoStatusWord {
    pub label: String,
    pub tone: Tone,
}

fn word(label: &str, tone: Tone) -> IsoStatusWord {
    IsoStatusWord {
        label: label.to_string(),
        tone,
    }
}

/// A file's state in the cloud, as one status word and an optional reason.
pub fn iso_entry_status(entry: &IsoEntry) -> (IsoStatusWord, Option<&'static str>) {
    let detail = iso_failure_text(entry.failure.as_deref());
    match entry.state.as_str() {
        "starting" => (word("Starting", Tone::Neutral), None),
        "recording" => (word("Recording", Tone::Live), None),
        "complete" => (word("Saved", Tone::Good), None),
        "partial" => (word("Partial", Tone::Warn), detail),
        "failed" => (word("Failed", Tone::Error), detail),
        _ => (word("Expired", Tone::Neutral), None),
    }
}

fn role_order(role: &str) -> usize {
    ROLES
        .iter()
        .position(|known| *known == role)
        .unwrap_or(ROLES.len())
}

fn sorted_entries(manifest: &IsoManifest) -> Vec<&IsoEntry> {
    let mut subjects: Vec<&str> = Vec::new();
    for entry in &manifest.entries {
        if !subjects.contains(&entry.subject.as_str()) {
            subjects.push(&entry.subject);
        }
    }
    let subject_order = |subject: &str| -> i64 {
        if subject == "host" {
            -1
        } else {
            subjects
                .iter()
                .position(|known| *known == subject)
                .map_or(0, |index| index as i64)
        }
    };
    let mut entries: Vec<&IsoEntry> = manifest.entries.iter().collect();
    entries.sort_by(|a, b| {
        subject_order(&a.subject)
            .cmp(&subject_order(&b.subject))
            .then(role_order(&a.role).cmp(&role_order(&b.role)))
            .then(a.generation.cmp(&b.generation))
    });
    entries
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoRoomRow {
    pub id: String,
    pub title: String,
    pub status: IsoStatusWord,
    pub detail: Option<&'static str>,
}

/// The room's live list: who and what records, by name, the host first.
pub fn iso_room_rows(manifest: &IsoManifest, guests: &[RoomGuest]) -> Vec<IsoRoomRow> {
    sorted_entries(manifest)
        .into_iter()
        .map(|entry| {
            let owner = if entry.subject == "host" {
                "Your".to_string()
            } else {
                guests
                    .iter()
                    .find(|guest| guest.guest_id == entry.subject && !guest.name.is_empty())
                    .map_or_else(
                        || "A guest's".to_string(),
                        |guest| format!("{}'s", guest.name),
                    )
            };
            let (status, detail) = iso_entry_status(entry);
            IsoRoomRow {
                id: entry.id.clone(),
                title: format!(
                    "{owner} {}{}",
                    role_word(&entry.role),
                    part_suffix(entry.generation)
                ),
                status,
                detail,
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoGuestConsentRow {
    pub guest_id: String,
    pub name: String,
    pub agreed: bool,
    pub status: IsoStatusWord,
}

/// Each guest in the room and whether they agreed to their own files.
pub fn iso_guest_consent_rows(
    guests: &[RoomGuest],
    consent: &[IsoGuestConsent],
) -> Vec<IsoGuestConsentRow> {
    let agreed: BTreeSet<&str> = consent
        .iter()
        .map(|entry| entry.identity.as_str())
        .collect();
    guests
        .iter()
        .map(|guest| {
            let yes = agreed.contains(guest.guest_id.as_str());
            IsoGuestConsentRow {
                guest_id: guest.guest_id.clone(),
                name: guest.name.clone(),
                agreed: yes,
                status: if yes {
                    word("Agreed", Tone::Good)
                } else {
                    word("Hasn't agreed", Tone::Neutral)
                },
            }
        })
        .collect()
}

/// Lines for a take that stopped early or left sources out: never hidden.
pub fn iso_take_notes(take: &IsoTake) -> Vec<String> {
    let mut notes = Vec::new();
    if let Some(stopped) = take.stop_reason.as_deref().and_then(stop_text) {
        notes.push(stopped.to_string());
    }
    if take.refused > 0 {
        let count = take.refused as u32;
        notes.push(format!(
            "{} {} recorded separately: a guest who hasn't agreed, or audio Videorc can't tell apart.",
            plural(count, "source", None),
            if count == 1 { "wasn't" } else { "weren't" }
        ));
    }
    notes
}

fn refusal_text(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "not-qualified" => "Separate cloud files aren't available yet.",
        "no-program-take" => "Separate files start once the show is recording.",
        "host-consent-missing" => "Turn separate files on again to confirm.",
        "cost-ceiling-too-low" => "The cost limit is too low for these limits.",
        "cost-ceiling-over-cap" => "The cost limit is higher than your plan allows.",
        "limits-exceeded" => "These limits are higher than your plan allows.",
        "concurrency-unavailable" => {
            "Videorc Cloud is busy right now. Separate files will try again."
        }
        "show-expired" => "This show has ended.",
        "take-expired" => "This recording has already expired.",
        "take-limit" => "This show has reached its number of separate recordings.",
        _ => return None,
    })
}

/// Why the current recording has no separate files, from the last refusal.
pub fn iso_refusal_text(status: Option<&IsoStatus>) -> Option<String> {
    let refusal = status?.last_refusal.as_ref()?;
    Some(refusal_text(&refusal.reason).map_or_else(
        || {
            format!(
                "Separate files couldn't start for this recording ({}).",
                refusal.reason
            )
        },
        str::to_string,
    ))
}

// --- Library -------------------------------------------------------------------

/// The Library recording a complete file is registered as.
pub fn iso_local_session_id(take_id: &str, subject: &str, role: &str, generation: i64) -> String {
    format!("cloud-iso-{take_id}-{subject}-{role}-g{generation}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoLibraryRow {
    pub entry_id: String,
    pub title: String,
    /// "Guest 2" when a take has more than one guest.
    pub context: Option<String>,
    pub role: String,
    /// Planned by `plan_iso_import`: complete or partial, inside retention.
    pub importable: bool,
    pub partial: bool,
    pub overlap: bool,
    /// A host camera file in v1: possibly packed alpha, never a picture.
    pub layout_unknown: bool,
    pub bytes: Option<i64>,
    pub duration_ms: Option<i64>,
    /// Why a file can't be imported, when it can't.
    pub unavailable: Option<String>,
    pub local_session_id: String,
}

/// `<subject>/<role>/g<generation>` back into its parts.
fn entry_parts(entry_id: &str) -> Option<(String, String, i64)> {
    let mut parts = entry_id.split('/');
    let subject = parts.next().filter(|subject| !subject.is_empty())?;
    let role = parts.next()?;
    let generation = parts.next()?.strip_prefix('g')?;
    if parts.next().is_some()
        || !ROLES.contains(&role)
        || generation.is_empty()
        || !generation.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((
        subject.to_string(),
        role.to_string(),
        generation.parse().ok()?,
    ))
}

fn guest_ordinals<'a>(subjects: impl Iterator<Item = &'a str>) -> BTreeMap<String, String> {
    let mut guests: Vec<&str> = Vec::new();
    for subject in subjects {
        if subject != "host" && !guests.contains(&subject) {
            guests.push(subject);
        }
    }
    if guests.len() <= 1 {
        return BTreeMap::new();
    }
    guests
        .into_iter()
        .enumerate()
        .map(|(index, subject)| (subject.to_string(), format!("Guest {}", index + 1)))
        .collect()
}

/// Every file of a take, importable or not, in the room's order.
pub fn iso_library_rows(manifest: &IsoManifest, now_ms: i64) -> Vec<IsoLibraryRow> {
    let planned: BTreeSet<String> = plan_iso_import(manifest, now_ms)
        .into_iter()
        .map(|item| item.entry_id)
        .collect();
    let entries = sorted_entries(manifest);
    let ordinals = guest_ordinals(entries.iter().map(|entry| entry.subject.as_str()));
    let expired = now_ms >= manifest.expires_at_ms;
    entries
        .into_iter()
        .map(|entry| {
            let importable = planned.contains(&entry.id);
            let unavailable = if importable {
                None
            } else if matches!(entry.state.as_str(), "starting" | "recording") {
                Some("Still recording".to_string())
            } else if entry.state == "expired" || expired {
                Some("Expired in the cloud".to_string())
            } else if entry.state == "failed" {
                Some(format!(
                    "Not recorded: {}",
                    iso_failure_text(entry.failure.as_deref()).unwrap_or("Failed")
                ))
            } else {
                Some("Can't be imported".to_string())
            };
            IsoLibraryRow {
                entry_id: entry.id.clone(),
                title: format!(
                    "{}{}",
                    role_title(&entry.role),
                    part_suffix(entry.generation)
                ),
                context: ordinals.get(&entry.subject).cloned(),
                role: entry.role.clone(),
                importable,
                partial: entry.state == "partial",
                overlap: entry.overlap,
                layout_unknown: entry
                    .frame_layout
                    .as_ref()
                    .is_some_and(|layout| layout.layout == "unknown"),
                bytes: entry.bytes,
                duration_ms: entry.duration_ms,
                unavailable,
                local_session_id: iso_local_session_id(
                    &manifest.take_id,
                    &entry.subject,
                    &entry.role,
                    entry.generation,
                ),
            }
        })
        .collect()
}

/// A take whose manifest the cloud no longer serves but this computer
/// imported from: its rows from the import journal alone.
pub fn iso_journal_rows(journal: &IsoImportJournal) -> Vec<IsoLibraryRow> {
    let parts: Vec<(&IsoDownloadRecord, (String, String, i64))> = journal
        .records
        .iter()
        .filter_map(|record| entry_parts(&record.entry_id).map(|parts| (record, parts)))
        .collect();
    let ordinals = guest_ordinals(parts.iter().map(|(_, (subject, _, _))| subject.as_str()));
    parts
        .into_iter()
        .map(|(record, (subject, role, generation))| IsoLibraryRow {
            entry_id: record.entry_id.clone(),
            title: format!("{}{}", role_title(&role), part_suffix(generation)),
            context: ordinals.get(&subject).cloned(),
            importable: false,
            partial: false,
            overlap: false,
            // v1 never trusts a host camera layout.
            layout_unknown: role == "host-camera",
            bytes: record.expected_bytes,
            duration_ms: None,
            unavailable: (record.state != IsoDownloadState::Complete)
                .then(|| "Expired in the cloud".to_string()),
            local_session_id: iso_local_session_id(&journal.take_id, &subject, &role, generation),
            role,
        })
        .collect()
}

// --- Imports -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoFileImport {
    pub state: IsoDownloadState,
    pub bytes: Option<u64>,
    pub expected_bytes: Option<i64>,
    /// Raw text: the console's, never a row's.
    pub error: Option<String>,
    pub local_session_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IsoTakeImport {
    /// The running job, when this window started it or saw its events.
    pub job_id: Option<String>,
    /// Asked for, no answer yet.
    pub starting: bool,
    /// The job failed as a whole (no file named), or could not start.
    pub failed: bool,
    pub files: BTreeMap<String, IsoFileImport>,
}

/// Keyed by take id.
pub type IsoImports = BTreeMap<String, IsoTakeImport>;

pub fn iso_take_import(imports: &IsoImports, take_id: &str) -> IsoTakeImport {
    imports.get(take_id).cloned().unwrap_or_default()
}

fn is_file_running(file: &IsoFileImport) -> bool {
    matches!(
        file.state,
        IsoDownloadState::Pending | IsoDownloadState::Downloading
    )
}

/// The journal is the truth for each file; a job id this window knows is kept.
pub fn iso_imports_from_journal(
    previous: &IsoImports,
    journals: &[IsoImportJournal],
) -> IsoImports {
    let mut next = previous.clone();
    for journal in journals {
        let before = iso_take_import(previous, &journal.take_id);
        let mut files = before.files.clone();
        for record in &journal.records {
            let local_session_id = files
                .get(&record.entry_id)
                .and_then(|file| file.local_session_id.clone());
            files.insert(
                record.entry_id.clone(),
                IsoFileImport {
                    state: record.state,
                    bytes: record.bytes,
                    expected_bytes: record.expected_bytes,
                    error: record.error.clone(),
                    local_session_id,
                },
            );
        }
        let running = files.values().any(is_file_running);
        next.insert(
            journal.take_id.clone(),
            IsoTakeImport {
                job_id: if running { before.job_id.clone() } else { None },
                starting: false,
                failed: before.failed && !running,
                files,
            },
        );
    }
    next
}

pub fn reduce_iso_import_event(imports: &IsoImports, event: &IsoImportEvent) -> IsoImports {
    let before = iso_take_import(imports, &event.take_id);
    let mut next = imports.clone();
    let Some(entry_id) = &event.entry_id else {
        let failed = event.state == IsoDownloadState::Failed;
        next.insert(
            event.take_id.clone(),
            IsoTakeImport {
                job_id: if failed {
                    None
                } else {
                    Some(event.job_id.clone())
                },
                starting: false,
                failed,
                ..before
            },
        );
        return next;
    };
    let mut files = before.files.clone();
    let file = files.get(entry_id).cloned();
    files.insert(
        entry_id.clone(),
        IsoFileImport {
            state: event.state,
            bytes: event
                .bytes
                .or_else(|| file.as_ref().and_then(|file| file.bytes)),
            expected_bytes: file.as_ref().and_then(|file| file.expected_bytes),
            error: event.error.clone(),
            local_session_id: event
                .local_session_id
                .clone()
                .or_else(|| file.as_ref().and_then(|file| file.local_session_id.clone())),
        },
    );
    let running = files.values().any(is_file_running);
    next.insert(
        event.take_id.clone(),
        IsoTakeImport {
            job_id: running.then(|| event.job_id.clone()),
            starting: false,
            failed: false,
            files,
        },
    );
    next
}

pub fn iso_import_starting(imports: &IsoImports, take_id: &str) -> IsoImports {
    let mut next = imports.clone();
    let before = iso_take_import(imports, take_id);
    next.insert(
        take_id.to_string(),
        IsoTakeImport {
            starting: true,
            failed: false,
            ..before
        },
    );
    next
}

pub fn iso_import_answered(
    imports: &IsoImports,
    take_id: &str,
    job_id: Option<&str>,
) -> IsoImports {
    let mut next = imports.clone();
    let before = iso_take_import(imports, take_id);
    next.insert(
        take_id.to_string(),
        IsoTakeImport {
            job_id: job_id.map(str::to_string).or(before.job_id.clone()),
            starting: false,
            failed: job_id.is_none(),
            ..before
        },
    );
    next
}

/// A file's progress, 0–100, while its size is known.
pub fn iso_file_percent(file: &IsoFileImport, expected: Option<i64>) -> Option<u8> {
    if file.state == IsoDownloadState::Complete {
        return Some(100);
    }
    let total = file
        .expected_bytes
        .or(expected)
        .filter(|total| *total > 0)?;
    let bytes = file.bytes?;
    let percent = (bytes as f64 / total as f64 * 100.0).floor();
    Some(percent.clamp(0.0, 99.0) as u8)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoFileWord {
    pub label: String,
    pub tone: Tone,
    pub percent: Option<u8>,
}

/// One file's local state for its row, or None before it was asked for.
pub fn iso_file_word(file: Option<&IsoFileImport>, expected: Option<i64>) -> Option<IsoFileWord> {
    let file = file?;
    let (label, tone, percent) = match file.state {
        IsoDownloadState::Pending => ("Waiting".to_string(), Tone::Neutral, None),
        IsoDownloadState::Downloading => {
            let percent = iso_file_percent(file, expected);
            let label = percent.map_or_else(
                || "Downloading".to_string(),
                |percent| format!("Downloading {percent}%"),
            );
            (label, Tone::Neutral, percent)
        }
        IsoDownloadState::Complete => ("Imported".to_string(), Tone::Good, Some(100)),
        IsoDownloadState::Failed => ("Couldn't import".to_string(), Tone::Error, None),
        IsoDownloadState::Expired => ("Expired in the cloud".to_string(), Tone::Neutral, None),
    };
    Some(IsoFileWord {
        label,
        tone,
        percent,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoTakeImportSummary {
    pub running: bool,
    pub importable: usize,
    pub imported: usize,
    pub failed: usize,
    /// The take's Import button: None once every file is here.
    pub action: Option<&'static str>,
}

pub fn iso_take_import_summary(
    rows: &[IsoLibraryRow],
    take: &IsoTakeImport,
) -> IsoTakeImportSummary {
    let importable: Vec<&IsoLibraryRow> = rows.iter().filter(|row| row.importable).collect();
    let mut imported = 0;
    let mut failed = 0;
    let mut running = take.starting;
    for row in &importable {
        match take.files.get(&row.entry_id) {
            Some(file) if file.state == IsoDownloadState::Complete => imported += 1,
            Some(file) if file.state == IsoDownloadState::Failed => failed += 1,
            Some(file) if is_file_running(file) => running = true,
            // A job this window started whose first event for the file hasn't come.
            None if take.job_id.is_some() => running = true,
            _ => {}
        }
    }
    let action = if running {
        Some(if take.starting {
            "Starting…"
        } else {
            "Importing…"
        })
    } else if !importable.is_empty() && imported < importable.len() {
        Some(if failed > 0 || take.failed || imported > 0 {
            "Import again"
        } else {
            "Import separate files"
        })
    } else {
        None
    };
    IsoTakeImportSummary {
        running,
        importable: importable.len(),
        imported,
        failed,
        action,
    }
}

#[cfg(test)]
#[path = "iso_tests.rs"]
mod tests;
