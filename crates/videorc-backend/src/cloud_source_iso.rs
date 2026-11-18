//! Plan 249 S22: cloud ISO import model.
//!
//! A cloud ISO manifest (web `lib/cloud/iso/manifest.ts`) lists one file per
//! stable source role and publication generation of a cloud talk room, tied
//! to one mixed program take. This module validates that manifest exactly as
//! the web and the desktop TS mirror do (shared fixture
//! `protocol-fixtures/cloud-source-iso.json`), and plans which files may be
//! imported into Library beside the take's mixed recording.
//!
//! It is deliberately separate from the native separate-source writer in
//! `source_iso.rs`: nothing here records, and a mixed take alone never
//! produces an ISO plan. Cloud ISO is not production-qualified; no RPC or UI
//! enables it yet. Pure: no crate state, network or filesystem.
//!
//! The download journal below is the import state machine a future
//! downloader persists (as JSON) per take: one record per ISO entry,
//! idempotent, size-checked, bounded retries, retention-aware. Until managed
//! ISO is qualified there is no authorized manifest source, so nothing in
//! the app constructs it outside tests.
#![allow(dead_code)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ISO_MANIFEST_VERSION: i64 = 1;
pub const ISO_MANIFEST_KIND: &str = "videorc.cloud-iso";
pub const MAX_ENTRIES: usize = 48;
pub const MAX_REFUSED: usize = 64;
pub const MAX_GUESTS: usize = 16;
pub const MAX_LIVE_INTERVALS: usize = 32;
pub const MAX_GENERATIONS_PER_SLOT: i64 = 6;
/// A single ISO file larger than this is refused before download.
pub const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

pub const ROLES: [&str; 8] = [
    "host-camera",
    "host-microphone",
    "host-aux",
    "host-screen",
    "guest-camera",
    "guest-microphone",
    "guest-screen",
    "guest-screen-audio",
];
const STATES: [&str; 6] = [
    "starting",
    "recording",
    "complete",
    "partial",
    "failed",
    "expired",
];
const FAILURES: [&str; 7] = [
    "start-failed",
    "provider-failed",
    "provider-aborted",
    "limit-reached",
    "missing-output",
    "stop-failed",
    "start-unknown",
];
const DECLARED_LAYOUTS: [&str; 2] = ["opaque", "rgb-left-alpha-right:g8"];

/// Video layout of one ISO file. v1 never trusts a declared layout: a host
/// camera stays `unknown` (basis `unavailable`) until a verified descriptor
/// exists, because S13a can publish packed `rgb-left-alpha-right` frames on
/// it. Other video roles are opaque by role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoFrameLayout {
    pub basis: String,
    pub layout: String,
    pub declared: Option<String>,
}
const END_REASONS: [&str; 6] = [
    "unpublished",
    "stopped",
    "take-ended",
    "budget-exhausted",
    "time-limit",
    "consent-withdrawn",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoEntry {
    pub id: String,
    pub role: String,
    pub subject: String,
    pub generation: i64,
    pub track_sid: String,
    pub kind: String,
    pub mime_type: String,
    pub state: String,
    pub egress_id: Option<String>,
    pub object_prefix: String,
    pub object_key: Option<String>,
    pub requested_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub offset_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    pub overlap: bool,
    pub frame_layout: Option<IsoFrameLayout>,
    pub end_reason: Option<String>,
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoClock {
    pub origin: String,
    pub origin_at_ms: i64,
    pub basis: String,
    pub uncertainty: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoManifest {
    pub show_id: String,
    pub take_id: String,
    pub orientation: String,
    pub live_interval_ids: Vec<String>,
    pub clock: IsoClock,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub stopped_at_ms: Option<i64>,
    pub entries: Vec<IsoEntry>,
}

/// One file Library may import: its local name, title and common-clock offset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoImportItem {
    pub take_id: String,
    pub entry_id: String,
    pub role: String,
    pub subject: String,
    pub generation: i64,
    pub object_key: String,
    pub offset_ms: i64,
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    /// `partial` files keep what was recorded and say so; never "complete".
    pub partial: bool,
    pub overlap: bool,
    /// `opaque`, `unknown` (never shown as a normal picture) or None for audio.
    pub frame_layout: Option<String>,
    pub file_name: String,
    pub title: String,
}

fn fail(field: &str) -> anyhow::Error {
    anyhow::anyhow!("Invalid cloud ISO manifest: {field}")
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value.as_object().ok_or_else(|| fail(field))
}

fn exact_keys(map: &serde_json::Map<String, Value>, keys: &[&str], field: &str) -> Result<()> {
    if map.len() != keys.len() || keys.iter().any(|k| !map.contains_key(*k)) {
        return Err(fail(&format!("{field}.keys")));
    }
    Ok(())
}

fn int(value: &Value, field: &str, min: i64) -> Result<i64> {
    // JSON safe integers only, as JS `Number.isSafeInteger`.
    const SAFE: i64 = 9_007_199_254_740_991;
    match value.as_i64() {
        Some(v) if value.is_i64() || value.is_u64() => {
            if v < min || !(-SAFE..=SAFE).contains(&v) {
                Err(fail(field))
            } else {
                Ok(v)
            }
        }
        _ => Err(fail(field)),
    }
}

fn int_or_null(value: &Value, field: &str, min: i64) -> Result<Option<i64>> {
    if value.is_null() {
        Ok(None)
    } else {
        int(value, field, min).map(Some)
    }
}

fn text<'a>(value: &'a Value, field: &str, ok: impl Fn(&str) -> bool) -> Result<&'a str> {
    match value.as_str() {
        Some(v) if ok(v) => Ok(v),
        _ => Err(fail(field)),
    }
}

fn one_of<'a>(value: &'a Value, field: &str, list: &[&str]) -> Result<&'a str> {
    text(value, field, |v| list.contains(&v))
}

fn word(v: &str, prefix: &str, max: usize, extra: &[char]) -> bool {
    let Some(rest) = v.strip_prefix(prefix) else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= max
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

pub fn is_guest_identity(v: &str) -> bool {
    word(v, "g_", 128, &['_', '-'])
}
fn is_track_sid(v: &str) -> bool {
    word(v, "TR_", 64, &[])
}
fn is_egress_id(v: &str) -> bool {
    word(v, "EG_", 64, &[])
}
pub fn is_take_id(v: &str) -> bool {
    v.len() == 15 && word(v, "tk_", 12, &[])
}
fn is_show_id(v: &str) -> bool {
    let n = v.len().saturating_sub(3);
    (8..=64).contains(&n) && word(v, "sh_", 64, &['_', '-'])
}
fn is_mime(v: &str) -> bool {
    let Some((kind, codec)) = v.split_once('/') else {
        return false;
    };
    (kind == "audio" || kind == "video")
        && !codec.is_empty()
        && codec.len() <= 32
        && codec
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

pub fn role_kind(role: &str) -> &'static str {
    if role.ends_with("camera") || role.ends_with("screen") {
        "video"
    } else {
        "audio"
    }
}

pub fn role_title(role: &str) -> &'static str {
    match role {
        "host-camera" => "Host camera",
        "host-microphone" => "Host microphone",
        "host-aux" => "Host sounds",
        "host-screen" => "Host screen",
        "guest-camera" => "Guest camera",
        "guest-microphone" => "Guest microphone",
        "guest-screen" => "Guest screen",
        _ => "Guest screen audio",
    }
}

fn is_terminal(state: &str) -> bool {
    state != "starting" && state != "recording"
}

const ENTRY_KEYS: [&str; 21] = [
    "id",
    "role",
    "subject",
    "generation",
    "trackSid",
    "kind",
    "mimeType",
    "state",
    "egressId",
    "objectPrefix",
    "objectKey",
    "requestedAtMs",
    "startedAtMs",
    "endedAtMs",
    "offsetMs",
    "durationMs",
    "bytes",
    "overlap",
    "frameLayout",
    "endReason",
    "failure",
];

fn parse_entry(value: &Value, index: usize, take_id: &str, origin: i64) -> Result<IsoEntry> {
    let f = format!("entries[{index}]");
    let e = object(value, &f)?;
    exact_keys(e, &ENTRY_KEYS, &f)?;
    let role = one_of(&e["role"], &format!("{f}.role"), &ROLES)?;
    let host = role.starts_with("host-");
    let subject = text(&e["subject"], &format!("{f}.subject"), |v| {
        if host {
            v == "host"
        } else {
            is_guest_identity(v)
        }
    })?;
    let generation = int(&e["generation"], &format!("{f}.generation"), 1)?;
    if generation > MAX_GENERATIONS_PER_SLOT {
        return Err(fail(&format!("{f}.generation")));
    }
    let id = format!("{subject}/{role}/g{generation}");
    if e["id"].as_str() != Some(id.as_str()) {
        return Err(fail(&format!("{f}.id")));
    }
    if e["kind"].as_str() != Some(role_kind(role)) {
        return Err(fail(&format!("{f}.kind")));
    }
    let mime = text(&e["mimeType"], &format!("{f}.mimeType"), is_mime)?;
    if !mime.starts_with(&format!("{}/", role_kind(role))) {
        return Err(fail(&format!("{f}.mimeType")));
    }
    let prefix = format!("iso/{role}/{subject}-g{generation}");
    if e["objectPrefix"].as_str() != Some(prefix.as_str()) {
        return Err(fail(&format!("{f}.objectPrefix")));
    }
    let state = one_of(&e["state"], &format!("{f}.state"), &STATES)?;
    let egress_id = if e["egressId"].is_null() {
        None
    } else {
        Some(text(&e["egressId"], &format!("{f}.egressId"), is_egress_id)?.to_string())
    };
    let object_key = if e["objectKey"].is_null() {
        None
    } else {
        let key = text(&e["objectKey"], &format!("{f}.objectKey"), |v| {
            !v.is_empty()
                && v.len() <= 512
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
        })?;
        if key.contains("..")
            || key.starts_with('/')
            || !key.contains(&format!("/{take_id}/{prefix}"))
        {
            return Err(fail(&format!("{f}.objectKey")));
        }
        Some(key.to_string())
    };
    let requested_at_ms = int(&e["requestedAtMs"], &format!("{f}.requestedAtMs"), 0)?;
    let started_at_ms = int_or_null(&e["startedAtMs"], &format!("{f}.startedAtMs"), 0)?;
    let ended_at_ms = int_or_null(&e["endedAtMs"], &format!("{f}.endedAtMs"), 0)?;
    if let (Some(s), Some(end)) = (started_at_ms, ended_at_ms)
        && end < s
    {
        return Err(fail(&format!("{f}.endedAtMs")));
    }
    let offset_ms = int_or_null(&e["offsetMs"], &format!("{f}.offsetMs"), i64::MIN)?;
    match (offset_ms, started_at_ms) {
        (Some(o), Some(s)) if o == s - origin => {}
        (None, None) => {}
        _ => return Err(fail(&format!("{f}.offsetMs"))),
    }
    let duration_ms = int_or_null(&e["durationMs"], &format!("{f}.durationMs"), 0)?;
    let bytes = int_or_null(&e["bytes"], &format!("{f}.bytes"), 0)?;
    let overlap = e["overlap"]
        .as_bool()
        .ok_or_else(|| fail(&format!("{f}.overlap")))?;
    let frame_layout = if role_kind(role) == "video" {
        let field = format!("{f}.frameLayout");
        let l = object(&e["frameLayout"], &field)?;
        exact_keys(l, &["basis", "layout", "declared"], &field)?;
        let declared = if l["declared"].is_null() {
            None
        } else {
            Some(one_of(&l["declared"], &field, &DECLARED_LAYOUTS)?.to_string())
        };
        let (basis, layout) = if role == "host-camera" {
            ("unavailable", "unknown")
        } else {
            if declared.is_some() {
                return Err(fail(&field));
            }
            ("role-opaque", "opaque")
        };
        if l["basis"] != basis || l["layout"] != layout {
            return Err(fail(&field));
        }
        Some(IsoFrameLayout {
            basis: basis.into(),
            layout: layout.into(),
            declared,
        })
    } else {
        if !e["frameLayout"].is_null() {
            return Err(fail(&format!("{f}.frameLayout")));
        }
        None
    };
    let end_reason = if e["endReason"].is_null() {
        None
    } else {
        Some(one_of(&e["endReason"], &format!("{f}.endReason"), &END_REASONS)?.to_string())
    };
    let failure = if e["failure"].is_null() {
        None
    } else {
        Some(one_of(&e["failure"], &format!("{f}.failure"), &FAILURES)?.to_string())
    };
    if state == "complete" && (object_key.is_none() || started_at_ms.is_none()) {
        return Err(fail(&format!("{f}.state")));
    }
    if state == "failed" && failure.is_none() {
        return Err(fail(&format!("{f}.failure")));
    }
    if !is_terminal(state) && (failure.is_some() || ended_at_ms.is_some()) {
        return Err(fail(&format!("{f}.state")));
    }
    Ok(IsoEntry {
        id,
        role: role.to_string(),
        subject: subject.to_string(),
        generation,
        track_sid: text(&e["trackSid"], &format!("{f}.trackSid"), is_track_sid)?.to_string(),
        kind: role_kind(role).to_string(),
        mime_type: mime.to_string(),
        state: state.to_string(),
        egress_id,
        object_prefix: prefix,
        object_key,
        requested_at_ms,
        started_at_ms,
        ended_at_ms,
        offset_ms,
        duration_ms,
        bytes,
        overlap,
        frame_layout,
        end_reason,
        failure,
    })
}

const MANIFEST_KEYS: [&str; 17] = [
    "v",
    "kind",
    "showId",
    "takeId",
    "orientation",
    "liveIntervalIds",
    "clock",
    "consent",
    "reservation",
    "meter",
    "createdAtMs",
    "expiresAtMs",
    "stoppedAtMs",
    "stopReason",
    "entries",
    "refused",
    "productionQualified",
];

/// Strict: unknown keys, unbounded lists, incoherent states, keys outside
/// the take and any production-qualification claim fail closed.
pub fn parse_iso_manifest(value: &Value) -> Result<IsoManifest> {
    let m = object(value, "manifest")?;
    exact_keys(m, &MANIFEST_KEYS, "manifest")?;
    if m["v"].as_i64() != Some(ISO_MANIFEST_VERSION) || !m["v"].is_i64() {
        return Err(fail("v"));
    }
    if m["kind"].as_str() != Some(ISO_MANIFEST_KIND) {
        return Err(fail("kind"));
    }
    if m["productionQualified"] != Value::Bool(false) {
        return Err(fail("productionQualified"));
    }
    let show_id = text(&m["showId"], "showId", is_show_id)?.to_string();
    let take_id = text(&m["takeId"], "takeId", is_take_id)?.to_string();
    let orientation = one_of(&m["orientation"], "orientation", &["h", "v"])?.to_string();
    let intervals = m["liveIntervalIds"]
        .as_array()
        .filter(|a| a.len() <= MAX_LIVE_INTERVALS)
        .ok_or_else(|| fail("liveIntervalIds"))?;
    let live_interval_ids = intervals
        .iter()
        .map(|id| {
            text(id, "liveIntervalIds[]", |v| {
                !v.is_empty()
                    && v.len() <= 64
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
            .map(str::to_string)
        })
        .collect::<Result<Vec<_>>>()?;
    let clock = object(&m["clock"], "clock")?;
    exact_keys(
        clock,
        &["origin", "originAtMs", "basis", "uncertainty"],
        "clock",
    )?;
    if clock["origin"] != "program-take-start"
        || clock["basis"] != "provider-egress-start"
        || clock["uncertainty"] != "unmeasured"
    {
        return Err(fail("clock"));
    }
    let origin = int(&clock["originAtMs"], "clock.originAtMs", 1)?;
    let consent = object(&m["consent"], "consent")?;
    exact_keys(consent, &["hostAtMs", "guests"], "consent")?;
    int(&consent["hostAtMs"], "consent.hostAtMs", 1)?;
    let guests = object(&consent["guests"], "consent.guests")?;
    if guests.len() > MAX_GUESTS {
        return Err(fail("consent.guests"));
    }
    for (id, at) in guests {
        if !is_guest_identity(id) {
            return Err(fail("consent.guests.key"));
        }
        int(at, "consent.guests[]", 1)?;
    }
    let r = object(&m["reservation"], "reservation")?;
    exact_keys(
        r,
        &[
            "maxActiveEntries",
            "maxMinutes",
            "ceilingMicros",
            "estimateMicros",
            "deadlineAtMs",
        ],
        "reservation",
    )?;
    int(&r["maxActiveEntries"], "reservation.maxActiveEntries", 1)?;
    int(&r["maxMinutes"], "reservation.maxMinutes", 1)?;
    let ceiling = int(&r["ceilingMicros"], "reservation.ceilingMicros", 0)?;
    if int(&r["estimateMicros"], "reservation.estimateMicros", 0)? > ceiling {
        return Err(fail("reservation.estimateMicros"));
    }
    int(&r["deadlineAtMs"], "reservation.deadlineAtMs", 1)?;
    let meter = object(&m["meter"], "meter")?;
    exact_keys(meter, &["egressMs", "costMicros"], "meter")?;
    int(&meter["egressMs"], "meter.egressMs", 0)?;
    int(&meter["costMicros"], "meter.costMicros", 0)?;
    let raw_entries = m["entries"]
        .as_array()
        .filter(|a| a.len() <= MAX_ENTRIES)
        .ok_or_else(|| fail("entries"))?;
    let entries = raw_entries
        .iter()
        .enumerate()
        .map(|(i, e)| parse_entry(e, i, &take_id, origin))
        .collect::<Result<Vec<_>>>()?;
    let mut ids = std::collections::HashSet::new();
    let mut sids = std::collections::HashSet::new();
    for entry in &entries {
        if !ids.insert(entry.id.as_str()) {
            return Err(fail("entries.id"));
        }
        if !sids.insert(entry.track_sid.as_str()) {
            return Err(fail("entries.trackSid"));
        }
        if !entry.role.starts_with("host-") && !guests.contains_key(&entry.subject) {
            return Err(fail("entries.consent"));
        }
    }
    let refused = m["refused"]
        .as_array()
        .filter(|a| a.len() <= MAX_REFUSED)
        .ok_or_else(|| fail("refused"))?;
    for (i, item) in refused.iter().enumerate() {
        let f = format!("refused[{i}]");
        let r = object(item, &f)?;
        exact_keys(r, &["trackSid", "reason"], &f)?;
        text(&r["trackSid"], &f, is_track_sid)?;
        text(&r["reason"], &f, |v| {
            !v.is_empty() && v.len() <= 40 && v.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        })?;
    }
    let stopped_at_ms = int_or_null(&m["stoppedAtMs"], "stoppedAtMs", 0)?;
    if !m["stopReason"].is_null() {
        one_of(&m["stopReason"], "stopReason", &END_REASONS)?;
    }
    Ok(IsoManifest {
        show_id,
        take_id,
        orientation,
        live_interval_ids,
        clock: IsoClock {
            origin: "program-take-start".into(),
            origin_at_ms: origin,
            basis: "provider-egress-start".into(),
            uncertainty: "unmeasured".into(),
        },
        created_at_ms: int(&m["createdAtMs"], "createdAtMs", 1)?,
        expires_at_ms: int(&m["expiresAtMs"], "expiresAtMs", 1)?,
        stopped_at_ms,
        entries,
    })
}

fn extension(key: &str) -> &str {
    key.rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| matches!(*ext, "webm" | "ogg" | "mp4" | "mkv" | "m4a"))
        .unwrap_or("bin")
}

/// Which ISO files Library may import now. Past retention nothing is
/// offered; failed or still-recording entries are skipped; a mixed take
/// alone (an empty manifest) yields nothing. Partial files are importable
/// and stay labelled partial.
pub fn plan_iso_import(manifest: &IsoManifest, now_ms: i64) -> Vec<IsoImportItem> {
    if now_ms >= manifest.expires_at_ms {
        return Vec::new();
    }
    manifest
        .entries
        .iter()
        .filter(|e| e.state == "complete" || e.state == "partial")
        .filter_map(|e| {
            let key = e.object_key.as_ref()?;
            let offset = e.offset_ms?;
            if e.bytes.is_some_and(|b| b as u64 > MAX_IMPORT_BYTES) {
                return None;
            }
            let partial = e.state == "partial";
            Some(IsoImportItem {
                take_id: manifest.take_id.clone(),
                entry_id: e.id.clone(),
                role: e.role.clone(),
                subject: e.subject.clone(),
                generation: e.generation,
                object_key: key.clone(),
                offset_ms: offset,
                duration_ms: e.duration_ms,
                bytes: e.bytes,
                partial,
                overlap: e.overlap,
                frame_layout: e.frame_layout.as_ref().map(|l| l.layout.clone()),
                file_name: format!(
                    "{}-iso-{}-{}-g{}.{}",
                    manifest.take_id,
                    e.role,
                    e.subject,
                    e.generation,
                    extension(key)
                ),
                title: format!(
                    "{}{}{}{}",
                    role_title(&e.role),
                    if e.generation > 1 {
                        format!(" (part {})", e.generation)
                    } else {
                        String::new()
                    },
                    if e.frame_layout
                        .as_ref()
                        .is_some_and(|l| l.layout == "unknown")
                    {
                        " (layout unknown)"
                    } else {
                        ""
                    },
                    if partial { " (partial)" } else { "" }
                ),
            })
        })
        .collect()
}

pub const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IsoDownloadState {
    Pending,
    Downloading,
    Complete,
    Failed,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoDownloadRecord {
    pub entry_id: String,
    pub object_key: String,
    pub expected_bytes: Option<i64>,
    pub state: IsoDownloadState,
    pub attempts: u32,
    pub local_file_name: String,
    pub bytes: Option<u64>,
    pub error: Option<String>,
}

/// Per-take import journal. Records are keyed by manifest entry id, so a
/// retried import never registers one file twice, and one entry failing
/// never touches another (failure isolation).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsoDownloadJournal {
    pub take_id: String,
    pub records: Vec<IsoDownloadRecord>,
}

impl IsoDownloadJournal {
    pub fn new(take_id: &str) -> Self {
        Self {
            take_id: take_id.to_string(),
            records: Vec::new(),
        }
    }

    /// Merge a fresh plan. New entries become pending; known entries keep
    /// their state; past retention every unfinished record expires, while
    /// completed local copies stay (Library owns them from then on).
    pub fn sync(&mut self, manifest: &IsoManifest, now_ms: i64) -> Result<()> {
        if manifest.take_id != self.take_id {
            anyhow::bail!("The ISO manifest belongs to another take.");
        }
        if now_ms >= manifest.expires_at_ms {
            for record in &mut self.records {
                if record.state != IsoDownloadState::Complete {
                    record.state = IsoDownloadState::Expired;
                }
            }
            return Ok(());
        }
        for item in plan_iso_import(manifest, now_ms) {
            match self
                .records
                .iter_mut()
                .find(|r| r.entry_id == item.entry_id)
            {
                Some(record) => {
                    // A partial file that later completed must be refetched.
                    if record.object_key != item.object_key
                        && record.state != IsoDownloadState::Downloading
                    {
                        record.object_key = item.object_key;
                        record.expected_bytes = item.bytes;
                        record.state = IsoDownloadState::Pending;
                        record.attempts = 0;
                        record.error = None;
                    }
                }
                None => self.records.push(IsoDownloadRecord {
                    entry_id: item.entry_id,
                    object_key: item.object_key,
                    expected_bytes: item.bytes,
                    state: IsoDownloadState::Pending,
                    attempts: 0,
                    local_file_name: item.file_name,
                    bytes: None,
                    error: None,
                }),
            }
        }
        Ok(())
    }

    /// The next record to fetch, marked downloading. One at a time.
    pub fn begin_next(&mut self) -> Option<IsoDownloadRecord> {
        if self
            .records
            .iter()
            .any(|r| r.state == IsoDownloadState::Downloading)
        {
            return None;
        }
        let record = self.records.iter_mut().find(|r| {
            r.state == IsoDownloadState::Pending
                || (r.state == IsoDownloadState::Failed && r.attempts < MAX_DOWNLOAD_ATTEMPTS)
        })?;
        record.state = IsoDownloadState::Downloading;
        record.attempts += 1;
        record.error = None;
        Some(record.clone())
    }

    /// A finished transfer. Complete only when the size is what the
    /// provider reported; a short file is a failure, never a completed take.
    pub fn finish(&mut self, entry_id: &str, outcome: Result<u64, String>) -> Result<()> {
        let record = self
            .records
            .iter_mut()
            .find(|r| r.entry_id == entry_id && r.state == IsoDownloadState::Downloading)
            .ok_or_else(|| anyhow::anyhow!("No ISO download is running for {entry_id}."))?;
        match outcome {
            Ok(bytes)
                if bytes > 0
                    && bytes <= MAX_IMPORT_BYTES
                    && record.expected_bytes.is_none_or(|e| e as u64 == bytes) =>
            {
                record.state = IsoDownloadState::Complete;
                record.bytes = Some(bytes);
            }
            Ok(bytes) => {
                record.state = IsoDownloadState::Failed;
                record.error = Some(format!("Downloaded {bytes} bytes; the size did not match."));
            }
            Err(error) => {
                record.state = IsoDownloadState::Failed;
                record.error = Some(error);
            }
        }
        Ok(())
    }

    /// After a crash, an interrupted transfer is retried, not trusted.
    pub fn recover_interrupted(&mut self) {
        for record in &mut self.records {
            if record.state == IsoDownloadState::Downloading {
                record.state = IsoDownloadState::Failed;
                record.error = Some("The download was interrupted.".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../protocol-fixtures/cloud-source-iso.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    #[test]
    fn shared_fixture_valid_parses_and_every_invalid_case_fails_closed() {
        let doc = fixture();
        let manifest = parse_iso_manifest(&doc["valid"]).expect("valid manifest");
        assert_eq!(manifest.entries.len(), 6);
        assert_eq!(manifest.take_id, "tk_AbCdEf123456");
        let cases = doc["invalid"].as_array().expect("invalid list");
        assert!(cases.len() >= 15);
        for case in cases {
            let mut candidate = doc["valid"].clone();
            let pointer = case["pointer"].as_str().expect("pointer");
            let (parent, leaf) = pointer.rsplit_once('/').expect("pointer parent");
            let target = if parent.is_empty() {
                &mut candidate
            } else {
                candidate.pointer_mut(parent).expect("pointer target")
            };
            match target {
                Value::Object(map) => {
                    map.insert(leaf.to_string(), case["value"].clone());
                }
                Value::Array(items) => {
                    items[leaf.parse::<usize>().expect("index")] = case["value"].clone();
                }
                _ => panic!("pointer target"),
            }
            assert!(
                parse_iso_manifest(&candidate).is_err(),
                "{} must be refused",
                case["case"]
            );
        }
    }

    #[test]
    fn import_plan_keeps_roles_separate_and_aux_out_of_the_mic() {
        let manifest = parse_iso_manifest(&fixture()["valid"]).unwrap();
        let plan = plan_iso_import(&manifest, manifest.created_at_ms + 1);
        let ids: Vec<_> = plan.iter().map(|i| i.entry_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "host/host-camera/g1",
                "host/host-microphone/g1",
                "host/host-microphone/g2",
                "host/host-aux/g1",
                "g_ann/guest-camera/g1",
            ],
            "the failed guest microphone is not offered"
        );
        let aux = plan.iter().find(|i| i.role == "host-aux").unwrap();
        assert_eq!(aux.file_name, "tk_AbCdEf123456-iso-host-aux-host-g1.ogg");
        assert!(
            plan.iter()
                .filter(|i| i.role == "host-microphone")
                .all(|i| !i.object_key.contains("host-aux"))
        );
        let partial = plan.iter().find(|i| i.role == "guest-camera").unwrap();
        assert!(partial.partial);
        assert!(partial.title.ends_with("(partial)"));
        assert_eq!(plan[2].title, "Host microphone (part 2)");
        // v1 never trusts a host camera layout, even when declared opaque.
        assert_eq!(plan[0].frame_layout.as_deref(), Some("unknown"));
        assert_eq!(plan[0].title, "Host camera (layout unknown)");
        assert_eq!(plan[4].frame_layout.as_deref(), Some("opaque"));
        assert_eq!(plan[1].frame_layout, None);
        // Offsets share the program take's clock origin.
        assert_eq!(plan[0].offset_ms, 400);
        assert_eq!(plan[2].offset_ms, 20_900);
    }

    #[test]
    fn retention_expiry_and_empty_manifest_offer_nothing() {
        let mut doc = fixture()["valid"].clone();
        let manifest = parse_iso_manifest(&doc).unwrap();
        assert!(plan_iso_import(&manifest, manifest.expires_at_ms).is_empty());
        doc["entries"] = Value::Array(Vec::new());
        let empty = parse_iso_manifest(&doc).unwrap();
        assert!(
            plan_iso_import(&empty, empty.created_at_ms + 1).is_empty(),
            "a mixed take alone is never ISO"
        );
    }

    #[test]
    fn download_journal_is_idempotent_isolated_and_size_checked() {
        let manifest = parse_iso_manifest(&fixture()["valid"]).unwrap();
        let now = manifest.created_at_ms + 1;
        let mut journal = IsoDownloadJournal::new(&manifest.take_id);
        journal.sync(&manifest, now).unwrap();
        journal.sync(&manifest, now).unwrap();
        assert_eq!(journal.records.len(), 5, "a resync never duplicates");
        let first = journal.begin_next().unwrap();
        assert!(journal.begin_next().is_none(), "one transfer at a time");
        journal.finish(&first.entry_id, Ok(1)).unwrap();
        assert_eq!(journal.records[0].state, IsoDownloadState::Failed);
        let second = journal.begin_next().unwrap();
        assert_eq!(second.entry_id, first.entry_id, "failed entries retry");
        journal.finish(&second.entry_id, Ok(900_000)).unwrap();
        assert_eq!(journal.records[0].state, IsoDownloadState::Complete);
        let next = journal.begin_next().unwrap();
        journal
            .finish(&next.entry_id, Err("network".into()))
            .unwrap();
        assert_eq!(journal.records[0].state, IsoDownloadState::Complete);
        let third = journal.begin_next().unwrap();
        journal.recover_interrupted();
        assert_eq!(
            journal
                .records
                .iter()
                .find(|r| r.entry_id == third.entry_id)
                .unwrap()
                .state,
            IsoDownloadState::Failed
        );
        journal.sync(&manifest, manifest.expires_at_ms).unwrap();
        assert_eq!(journal.records[0].state, IsoDownloadState::Complete);
        assert!(
            journal.records[1..]
                .iter()
                .all(|r| r.state == IsoDownloadState::Expired)
        );
        assert!(journal.begin_next().is_none());
        let mut other = IsoDownloadJournal::new("tk_Zzzzzzzzzzzz");
        assert!(other.sync(&manifest, now).is_err());
    }
}
