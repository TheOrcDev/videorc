//! The key families the renderer moved to the UI settings store (plan 220
//! S1.4b), each with the reader and writer its TypeScript file has (S3.0d):
//! first run, onboarding and What's New (`lib/first-run.ts`,
//! `lib/whats-new.ts`), the theme (`App.tsx` `ThemeStoreSync`), the output
//! choice (`use-studio.tsx`), the consents and Clean cut
//! (`lib/clean-cut-auto.ts`, `lib/clean-cut-notify.ts`), following and
//! privacy (`lib/follow-settings.ts`, `lib/privacy-settings.ts`), Buddy
//! (`lib/buddy-pet-review-marks.ts`, `lib/buddy-library-view.ts`,
//! `lib/buddy-worn-pack.ts`, `lib/cohost-view.ts`) and the Stream
//! Manager's stats bar (`lib/stream-manager-stats-layout.ts`).
//!
//! A reader takes what `getItem` returns (the stored string, see
//! [`UiSettingsCache::get_item`]) and answers what the TypeScript reader
//! answers for it; a writer returns the [`SettingWrite`] its TypeScript
//! writer makes, in the same string shape (a plain word where the family
//! stores one, JSON text where it stores JSON). The scenes, the background
//! library and the takeover's mute ownership arrive with their pages.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::js_value::{date_parses, get, is_object_like, json_parse, truthy};
use super::settings::{SettingWrite, UiSettingsCache, keys};

/// `ONBOARDING_DISMISSED_VALUE`.
pub const ONBOARDING_DISMISSED_VALUE: &str = "permissions-v1";

// --- first run ---

/// `FIRST_RUN_STEPS`, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirstRunStep {
    Permissions,
    Goal,
    Look,
    Sound,
    Destinations,
}

impl FirstRunStep {
    fn parse(value: Option<&Value>) -> Option<Self> {
        serde_json::from_value(value?.clone()).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirstRunGoal {
    Record,
    Stream,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirstRunStatus {
    InProgress,
    Done,
    Skipped,
    ExistingInstall,
}

/// `FirstRunRecord` (always written as version 2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunRecord {
    pub version: u8,
    pub status: FirstRunStatus,
    pub step: FirstRunStep,
    /// Stored as `null` when there is none: the record's own shape (a UI
    /// settings value, not a wire contract).
    pub goal: Option<FirstRunGoal>,
    pub updated_at: String,
}

/// `parseFirstRunRecord`: a version 1 or 2 record with a known status and a
/// date `Date.parse` reads; a version 1 record (or a bad step or goal) starts
/// at Permissions with no goal.
pub fn parse_first_run_record(text: Option<&str>) -> Option<FirstRunRecord> {
    let record = json_parse(text?)?;
    if !matches!(record, Value::Object(_)) {
        return None;
    }
    let version = record.get("version").and_then(Value::as_f64);
    let status: FirstRunStatus = serde_json::from_value(record.get("status")?.clone()).ok()?;
    let updated_at = record.get("updatedAt")?.as_str()?;
    if !matches!(version, Some(v) if v == 1.0 || v == 2.0) || !date_parses(updated_at) {
        return None;
    }
    let two = version == Some(2.0);
    Some(FirstRunRecord {
        version: 2,
        status,
        step: if two {
            FirstRunStep::parse(record.get("step")).unwrap_or(FirstRunStep::Permissions)
        } else {
            FirstRunStep::Permissions
        },
        goal: if two {
            serde_json::from_value(record.get("goal").cloned().unwrap_or(Value::Null))
                .ok()
                .flatten()
        } else {
            None
        },
        updated_at: updated_at.to_string(),
    })
}

/// `FirstRunSnapshot`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirstRunSnapshot {
    Fresh,
    Resume,
    Finished,
    ExistingInstall,
}

/// `firstRunSnapshot`: a record decides; without one, any legacy onboarding
/// value or What's New marker means an existing install.
pub fn first_run_snapshot(
    record: Option<&FirstRunRecord>,
    legacy_onboarding: Option<&str>,
    whats_new_last_seen: Option<&str>,
) -> FirstRunSnapshot {
    match record {
        Some(record) if record.status == FirstRunStatus::InProgress => FirstRunSnapshot::Resume,
        Some(_) => FirstRunSnapshot::Finished,
        None if legacy_onboarding.is_some() || whats_new_last_seen.is_some() => {
            FirstRunSnapshot::ExistingInstall
        }
        None => FirstRunSnapshot::Fresh,
    }
}

/// What `createFirstRunStartup` reads before the first render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunStartup {
    pub snapshot: FirstRunSnapshot,
    pub step: FirstRunStep,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<FirstRunGoal>,
}

/// `createFirstRunStartup(store)`: the snapshot and the saved progress.
pub fn first_run_startup(cache: &UiSettingsCache) -> FirstRunStartup {
    let record = parse_first_run_record(cache.get_item(keys::FIRST_RUN).as_deref());
    FirstRunStartup {
        snapshot: first_run_snapshot(
            record.as_ref(),
            cache.get_item(keys::ONBOARDING).as_deref(),
            cache.get_item(keys::WHATS_NEW_LAST_SEEN).as_deref(),
        ),
        step: record
            .as_ref()
            .map_or(FirstRunStep::Permissions, |record| record.step),
        goal: record.and_then(|record| record.goal),
    }
}

/// `writeFirstRunRecord(status, store, updatedAt, progress)`.
pub fn write_first_run_record(
    status: FirstRunStatus,
    updated_at: &str,
    step: FirstRunStep,
    goal: Option<FirstRunGoal>,
) -> SettingWrite {
    let record = FirstRunRecord {
        version: 2,
        status,
        step,
        goal,
        updated_at: updated_at.to_string(),
    };
    SettingWrite::json(
        keys::FIRST_RUN,
        &serde_json::to_value(record).unwrap_or(Value::Null),
    )
}

/// `completeFirstRun`: the record, then the retired onboarding flag (a
/// downgrade keeps it dismissed).
pub fn complete_first_run(
    status: FirstRunStatus,
    updated_at: &str,
    step: FirstRunStep,
    goal: Option<FirstRunGoal>,
) -> Vec<SettingWrite> {
    vec![
        write_first_run_record(status, updated_at, step, goal),
        SettingWrite::text(keys::ONBOARDING, ONBOARDING_DISMISSED_VALUE),
    ]
}

/// `markWhatsNewSeen(version)`.
pub fn mark_whats_new_seen(version: &str) -> SettingWrite {
    SettingWrite::text(keys::WHATS_NEW_LAST_SEEN, version)
}

// --- the theme and the Studio's flags ---

/// `ThemeStoreSync`: the stored theme when there is one (next-themes'
/// value, a plain word: `dark`, `light`, `system`); `None` keeps the default
/// (dark) unstored.
pub fn theme(cache: &UiSettingsCache) -> Option<String> {
    cache
        .get_item(keys::THEME)
        .filter(|theme| !theme.is_empty())
}

/// `storage.setItem(STORAGE_KEYS.theme, theme)`.
pub fn write_theme(theme: &str) -> SettingWrite {
    SettingWrite::text(keys::THEME, theme)
}

/// `outputChosenByUser()`, once the store is hydrated (before that the
/// renderer says chosen, so a check never applies an output).
pub fn output_chosen_by_user(cache: &UiSettingsCache) -> bool {
    !cache.hydrated() || cache.get_item(keys::OUTPUT_CHOSEN_BY_USER).is_some()
}

/// `markOutputChosenByUser()`.
pub fn mark_output_chosen_by_user() -> SettingWrite {
    SettingWrite::text(keys::OUTPUT_CHOSEN_BY_USER, "1")
}

/// The AI consent (`=== '1'`).
pub fn ai_consent(cache: &UiSettingsCache) -> bool {
    cache.get_item(keys::AI_CONSENT).as_deref() == Some("1")
}

/// `setAiConsent(consent)`: `'1'` or `'0'`.
pub fn write_ai_consent(consent: bool) -> SettingWrite {
    SettingWrite::text(keys::AI_CONSENT, if consent { "1" } else { "0" })
}

/// Buddy may post on its own once asked (`=== '1'`).
pub fn buddy_auto_chat_consent(cache: &UiSettingsCache) -> bool {
    cache.get_item(keys::BUDDY_AUTO_CHAT_CONSENT).as_deref() == Some("1")
}

pub fn write_buddy_auto_chat_consent() -> SettingWrite {
    SettingWrite::text(keys::BUDDY_AUTO_CHAT_CONSENT, "1")
}

// --- Clean cut ---

/// `CLEAN_CUT_ATTEMPTED_MAX`, and the announced list's own bound.
pub const CLEAN_CUT_LEDGER_MAX: usize = 50;

/// `cleanCutAutoFromStorage`.
pub fn clean_cut_auto(cache: &UiSettingsCache) -> bool {
    cache.get_item(keys::CLEAN_CUT_AUTO).as_deref() == Some("1")
}

/// `cleanCutAutoToStorage`.
pub fn write_clean_cut_auto(enabled: bool) -> SettingWrite {
    SettingWrite::text(keys::CLEAN_CUT_AUTO, if enabled { "1" } else { "0" })
}

/// `parseAttemptedSessionIds`: the non-empty strings of a stored array.
pub fn clean_cut_attempted(cache: &UiSettingsCache) -> Vec<String> {
    string_list(cache.get_item(keys::CLEAN_CUT_ATTEMPTED).as_deref(), true)
}

/// The announced job revisions (`readKeys` in `clean-cut-notify.ts`): every
/// string of a stored array.
pub fn clean_cut_announced(cache: &UiSettingsCache) -> Vec<String> {
    string_list(cache.get_item(keys::CLEAN_CUT_ANNOUNCED).as_deref(), false)
}

fn string_list(text: Option<&str>, non_empty: bool) -> Vec<String> {
    let Some(Value::Array(items)) = text.filter(|text| !text.is_empty()).and_then(json_parse)
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .filter(|item| !non_empty || !item.is_empty())
        .map(str::to_string)
        .collect()
}

/// `id` appended (newest last) without a repeat, the oldest dropped past
/// the bound (`withAttemptedSessionId`, and the announced list's write).
fn with_newest(list: &[String], id: &str) -> Vec<String> {
    let mut next: Vec<String> = list.iter().filter(|entry| *entry != id).cloned().collect();
    next.push(id.to_string());
    let excess = next.len().saturating_sub(CLEAN_CUT_LEDGER_MAX);
    next.split_off(excess)
}

/// The auto-run's claim: `JSON.stringify(withAttemptedSessionId(ids, sessionId))`.
pub fn write_clean_cut_attempted(attempted: &[String], session_id: &str) -> SettingWrite {
    SettingWrite::json(
        keys::CLEAN_CUT_ATTEMPTED,
        &json!(with_newest(attempted, session_id)),
    )
}

/// `announceCleanCutReady`'s write: the revision key appended to what was
/// stored.
pub fn write_clean_cut_announced(stored: &[String], key: &str) -> SettingWrite {
    SettingWrite::json(keys::CLEAN_CUT_ANNOUNCED, &json!(with_newest(stored, key)))
}

// --- following and privacy ---

/// `FollowSettings` (plan 210 D10): the stream follows the app in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowSettings {
    pub follow_front_app: bool,
}

impl Default for FollowSettings {
    /// On, and nothing stored until the streamer changes it.
    fn default() -> Self {
        Self {
            follow_front_app: true,
        }
    }
}

/// `loadFollowSettings`.
pub fn follow_settings(cache: &UiSettingsCache) -> FollowSettings {
    let Some(parsed) = cache
        .get_item(keys::FOLLOW_SETTINGS)
        .filter(|text| !text.is_empty())
        .and_then(|text| json_parse(&text))
    else {
        return FollowSettings::default();
    };
    if !truthy(Some(&parsed)) || !is_object_like(Some(&parsed)) {
        return FollowSettings::default();
    }
    FollowSettings {
        follow_front_app: get(Some(&parsed), "followFrontApp")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

/// `saveFollowSettings`: the default stores nothing.
pub fn save_follow_settings(settings: FollowSettings) -> SettingWrite {
    if settings == FollowSettings::default() {
        SettingWrite::delete(keys::FOLLOW_SETTINGS)
    } else {
        SettingWrite::json(
            keys::FOLLOW_SETTINGS,
            &serde_json::to_value(settings).unwrap_or(Value::Null),
        )
    }
}

/// An app the streamer added to the password-manager list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedPasswordManager {
    pub bundle_id: String,
    pub name: String,
}

/// `PrivacySettings` (plan 210 D11): hide the screen while a password
/// manager is in front, with the built-in list adjusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacySettings {
    pub hide_for_password_managers: bool,
    pub added_password_managers: Vec<AddedPasswordManager>,
    pub removed_password_manager_bundle_ids: Vec<String>,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            hide_for_password_managers: true,
            added_password_managers: Vec::new(),
            removed_password_manager_bundle_ids: Vec::new(),
        }
    }
}

/// `BUILT_IN_PASSWORD_MANAGERS` (`lib/follow-front-app.ts`): each product
/// once, with every bundle id it ships under.
pub const BUILT_IN_PASSWORD_MANAGERS: &[(&str, &[&str])] = &[
    (
        "1Password",
        &[
            "com.1password.1password",
            "com.agilebits.onepassword7",
            "com.agilebits.onepassword-osx",
            "com.agilebits.onepassword4",
        ],
    ),
    ("Bitwarden", &["com.bitwarden.desktop"]),
    (
        "Dashlane",
        &[
            "com.dashlane.dashlanephonefinal",
            "com.dashlane.Dashlane",
            "com.dashlane.DashlaneAgent",
        ],
    ),
    (
        "Keeper",
        &[
            "com.keepersecurity.passwordmanager",
            "com.callpod.keeper",
            "com.callpod.keepermac.lite",
        ],
    ),
    (
        "LastPass",
        &[
            "com.lastpass.lastpassmacdesktop",
            "com.lastpass.LastPass",
            "com.lastpass.lastpassforsafari",
        ],
    ),
    ("Passwords", &["com.apple.Passwords"]),
    ("Keychain Access", &["com.apple.keychainaccess"]),
    (
        "Proton Pass",
        &[
            "me.proton.pass.electron",
            "me.proton.pass",
            "me.proton.pass.catalyst",
        ],
    ),
    (
        "KeePassXC",
        &["org.keepassxc.keepassxc", "org.keepassx.keepassxc"],
    ),
    (
        "Enpass",
        &["in.sinew.Enpass-Desktop", "in.sinew.Enpass-Desktop.App"],
    ),
];

const MAX_ADDED_PASSWORD_MANAGERS: usize = 100;
const MAX_BUNDLE_ID: usize = 255;
const MAX_PASSWORD_MANAGER_NAME: usize = 120;

fn built_in_password_manager(bundle_id: &str) -> Option<&'static [&'static str]> {
    let wanted = bundle_id.to_lowercase();
    BUILT_IN_PASSWORD_MANAGERS
        .iter()
        .find(|(_, ids)| ids.iter().any(|id| id.to_lowercase() == wanted))
        .map(|(_, ids)| *ids)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `addPasswordManager`: a built-in app taken off comes back whole; an app
/// already on the list or past the bound changes nothing.
pub fn add_password_manager(
    settings: &PrivacySettings,
    bundle_id: &str,
    name: &str,
) -> PrivacySettings {
    let bundle_id = super::js_value::trim(bundle_id);
    let trimmed_name = super::js_value::trim(name);
    let name = if trimmed_name.is_empty() {
        bundle_id
    } else {
        trimmed_name
    };
    if bundle_id.is_empty() || utf16_len(bundle_id) > MAX_BUNDLE_ID {
        return settings.clone();
    }
    if let Some(variants) = built_in_password_manager(bundle_id) {
        let variants: BTreeSet<String> = variants.iter().map(|id| id.to_lowercase()).collect();
        let mut next = settings.clone();
        next.removed_password_manager_bundle_ids
            .retain(|id| !variants.contains(&id.to_lowercase()));
        return next;
    }
    let key = bundle_id.to_lowercase();
    if settings
        .added_password_managers
        .iter()
        .any(|entry| entry.bundle_id.to_lowercase() == key)
        || settings.added_password_managers.len() >= MAX_ADDED_PASSWORD_MANAGERS
    {
        return settings.clone();
    }
    let mut next = settings.clone();
    // `name.slice(0, MAX_NAME)` counts UTF-16 code units.
    let mut units = 0;
    let name: String = name
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_PASSWORD_MANAGER_NAME
        })
        .collect();
    next.added_password_managers.push(AddedPasswordManager {
        bundle_id: bundle_id.to_string(),
        name,
    });
    next
}

/// `parsePrivacySettings`: field by field, anything unreadable the default;
/// removals only of built-in ids; additions through [`add_password_manager`].
pub fn parse_privacy_settings(value: &Value) -> PrivacySettings {
    if !truthy(Some(value)) || !is_object_like(Some(value)) {
        return PrivacySettings::default();
    }
    let field = |name: &str| get(Some(value), name);
    let mut seen = BTreeSet::new();
    let removed = match field("removedPasswordManagerBundleIds") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|item| {
                let id = super::js_value::trim(item);
                let key = id.to_lowercase();
                if id.is_empty() || utf16_len(id) > MAX_BUNDLE_ID || seen.contains(&key) {
                    return None;
                }
                seen.insert(key);
                Some(id.to_string())
            })
            .filter(|id| built_in_password_manager(id).is_some())
            .collect(),
        _ => Vec::new(),
    };
    let mut settings = PrivacySettings {
        hide_for_password_managers: field("hideForPasswordManagers")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        added_password_managers: Vec::new(),
        removed_password_manager_bundle_ids: removed,
    };
    if let Some(Value::Array(added)) = field("addedPasswordManagers") {
        for app in added {
            if !truthy(Some(app)) || !is_object_like(Some(app)) {
                continue;
            }
            let Some(bundle_id) = get(Some(app), "bundleId").and_then(Value::as_str) else {
                continue;
            };
            if built_in_password_manager(bundle_id).is_some() {
                continue;
            }
            let name = get(Some(app), "name")
                .and_then(Value::as_str)
                .unwrap_or(bundle_id);
            settings = add_password_manager(&settings, bundle_id, name);
        }
    }
    settings
}

/// `loadPrivacySettings`.
pub fn privacy_settings(cache: &UiSettingsCache) -> PrivacySettings {
    cache
        .get_item(keys::PRIVACY_SETTINGS)
        .filter(|text| !text.is_empty())
        .and_then(|text| json_parse(&text))
        .map_or_else(PrivacySettings::default, |parsed| {
            parse_privacy_settings(&parsed)
        })
}

/// `savePrivacySettings`: the defaults store nothing.
pub fn save_privacy_settings(settings: &PrivacySettings) -> SettingWrite {
    if settings.hide_for_password_managers
        && settings.added_password_managers.is_empty()
        && settings.removed_password_manager_bundle_ids.is_empty()
    {
        SettingWrite::delete(keys::PRIVACY_SETTINGS)
    } else {
        SettingWrite::json(
            keys::PRIVACY_SETTINGS,
            &serde_json::to_value(settings).unwrap_or(Value::Null),
        )
    }
}

// --- Buddy ---

/// The Alive creator's "Looks right" marks by build: row → version.
pub type BuddyPetReviewMarks = BTreeMap<String, BTreeMap<String, u64>>;

/// `readBuddyPetReviewMarks`: only marks shaped as stored (a positive
/// integer version per row) come back.
pub fn buddy_pet_review_marks(cache: &UiSettingsCache) -> BuddyPetReviewMarks {
    let Some(Value::Object(builds)) = cache
        .get_item(keys::BUDDY_PET_REVIEW_MARKS)
        .filter(|text| !text.is_empty())
        .and_then(|text| json_parse(&text))
    else {
        return BuddyPetReviewMarks::new();
    };
    builds
        .iter()
        .filter_map(|(build, marks)| {
            let Value::Object(marks) = marks else {
                return None;
            };
            let clean = marks
                .iter()
                .filter_map(|(row, version)| {
                    let version = version.as_f64()?;
                    (version.fract() == 0.0 && version > 0.0 && version.is_finite())
                        .then(|| (row.clone(), version as u64))
                })
                .collect();
            Some((build.clone(), clean))
        })
        .collect()
}

fn marks_write(marks: &BuddyPetReviewMarks) -> SettingWrite {
    if marks.is_empty() {
        SettingWrite::delete(keys::BUDDY_PET_REVIEW_MARKS)
    } else {
        SettingWrite::json(keys::BUDDY_PET_REVIEW_MARKS, &json!(marks))
    }
}

/// `writeBuddyPetReviewMarks(buildId, marks)`: one creation at a time, the
/// marks of an earlier build go with it.
pub fn write_buddy_pet_review_marks(build_id: &str, marks: &BTreeMap<String, u64>) -> SettingWrite {
    marks_write(&BuddyPetReviewMarks::from([(
        build_id.to_string(),
        marks.clone(),
    )]))
}

/// `forgetBuddyPetReviewMarks(buildId)`.
pub fn forget_buddy_pet_review_marks(
    current: &BuddyPetReviewMarks,
    build_id: &str,
) -> SettingWrite {
    let mut next = current.clone();
    next.remove(build_id);
    marks_write(&next)
}

/// `readBuddyInvitationDismissed`: `'1'` or `'true'`.
pub fn buddy_invitation_dismissed(cache: &UiSettingsCache) -> bool {
    matches!(
        cache.get_item(keys::BUDDY_INVITATION_DISMISSED).as_deref(),
        Some("1" | "true")
    )
}

pub fn write_buddy_invitation_dismissed() -> SettingWrite {
    SettingWrite::text(keys::BUDDY_INVITATION_DISMISSED, "1")
}

/// `readBuddyWornPack(personaId)`: the pack id, unless blank.
pub fn buddy_worn_pack(cache: &UiSettingsCache, persona_id: &str) -> Option<String> {
    cache
        .get_item(&format!("{}{persona_id}", keys::BUDDY_WORN_PACK_PREFIX))
        .filter(|pack| !super::js_value::trim(pack).is_empty())
}

/// `writeBuddyWornPack(personaId, packId)`.
pub fn write_buddy_worn_pack(persona_id: &str, pack_id: &str) -> SettingWrite {
    SettingWrite::text(
        &format!("{}{persona_id}", keys::BUDDY_WORN_PACK_PREFIX),
        pack_id,
    )
}

/// The co-host's flag sensitivity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CohostSensitivity {
    Relaxed,
    #[default]
    Balanced,
    Strict,
}

impl CohostSensitivity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Relaxed => "relaxed",
            Self::Balanced => "balanced",
            Self::Strict => "strict",
        }
    }
}

/// `cohostSensitivityFromStorage`: a known step, else Balanced.
pub fn cohost_sensitivity(cache: &UiSettingsCache) -> CohostSensitivity {
    match cache.get_item(keys::COHOST_SENSITIVITY).as_deref() {
        Some("relaxed") => CohostSensitivity::Relaxed,
        Some("strict") => CohostSensitivity::Strict,
        _ => CohostSensitivity::Balanced,
    }
}

/// `setCohostSensitivity(next)`.
pub fn write_cohost_sensitivity(sensitivity: CohostSensitivity) -> SettingWrite {
    SettingWrite::text(keys::COHOST_SENSITIVITY, sensitivity.as_str())
}

/// `cohostNudgeDismissedFromStorage`: `'1'` or `'true'`.
pub fn cohost_nudge_dismissed(cache: &UiSettingsCache) -> bool {
    matches!(
        cache.get_item(keys::COHOST_NUDGE_DISMISSED).as_deref(),
        Some("1" | "true")
    )
}

pub fn write_cohost_nudge_dismissed() -> SettingWrite {
    SettingWrite::text(keys::COHOST_NUDGE_DISMISSED, "1")
}

/// `readCohostListenPromptDismissed`: `'1'` or `'true'`.
pub fn cohost_listen_prompt_dismissed(cache: &UiSettingsCache) -> bool {
    matches!(
        cache
            .get_item(keys::COHOST_LISTEN_PROMPT_DISMISSED)
            .as_deref(),
        Some("1" | "true")
    )
}

/// `persistCohostListenPromptDismissed`.
pub fn write_cohost_listen_prompt_dismissed() -> SettingWrite {
    SettingWrite::text(keys::COHOST_LISTEN_PROMPT_DISMISSED, "1")
}

// --- the Stream Manager's stats bar ---

/// `DEFAULT_STAT_ORDER` (`lib/stream-manager-stats.ts`).
pub const DEFAULT_STAT_ORDER: [&str; 6] = [
    "session",
    "viewers",
    "followers",
    "supporters",
    "tips",
    "chat",
];
/// `LOCKED_STATS`: always shown, always in the main slots.
pub const LOCKED_STATS: [&str; 2] = ["session", "viewers"];
/// `MAIN_SLOTS`.
pub const MAIN_SLOTS: usize = 3;

/// `StatsLayout`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsLayout {
    pub order: Vec<String>,
    pub hidden: Vec<String>,
}

impl Default for StatsLayout {
    fn default() -> Self {
        Self {
            order: DEFAULT_STAT_ORDER.iter().map(|id| id.to_string()).collect(),
            hidden: Vec::new(),
        }
    }
}

fn dedupe_stats(items: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in items.iter().filter_map(Value::as_str) {
        if DEFAULT_STAT_ORDER.contains(&id) && !out.iter().any(|seen| seen == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// `normalizeStatsLayout`: unknown and repeated ids dropped, missing ones
/// appended in default order, and a layout that moved the clock or the
/// viewer count out of the main slots back to the default order.
pub fn normalize_stats_layout(raw: &Value) -> StatsLayout {
    if !truthy(Some(raw)) || !is_object_like(Some(raw)) {
        return StatsLayout::default();
    }
    let mut order = match get(Some(raw), "order") {
        Some(Value::Array(items)) => dedupe_stats(items),
        _ => Vec::new(),
    };
    for id in DEFAULT_STAT_ORDER {
        if !order.iter().any(|seen| seen == id) {
            order.push(id.to_string());
        }
    }
    let hidden = match get(Some(raw), "hidden") {
        Some(Value::Array(items)) => dedupe_stats(items)
            .into_iter()
            .filter(|id| !LOCKED_STATS.contains(&id.as_str()))
            .collect(),
        _ => Vec::new(),
    };
    let locked_in_main = LOCKED_STATS.iter().all(|locked| {
        order
            .iter()
            .position(|id| id == locked)
            .is_some_and(|index| index < MAIN_SLOTS)
    });
    if !locked_in_main {
        return StatsLayout {
            order: StatsLayout::default().order,
            hidden,
        };
    }
    StatsLayout { order, hidden }
}

/// `loadStatsLayout`.
pub fn stats_layout(cache: &UiSettingsCache) -> StatsLayout {
    cache
        .get_item(keys::STREAM_MANAGER_STATS_BAR)
        .filter(|text| !text.is_empty())
        .and_then(|text| json_parse(&text))
        .map_or_else(StatsLayout::default, |parsed| {
            normalize_stats_layout(&parsed)
        })
}

/// `saveStatsLayout`: `{v: 1, ...layout}`.
pub fn save_stats_layout(layout: &StatsLayout) -> SettingWrite {
    SettingWrite::json(
        keys::STREAM_MANAGER_STATS_BAR,
        &json!({"v": 1, "order": layout.order, "hidden": layout.hidden}),
    )
}

/// `moveStat`: move `id` to `to_index`. A move that would push the clock or
/// the viewer count out of the main slots is refused.
pub fn move_stat(layout: &StatsLayout, id: &str, to_index: usize) -> StatsLayout {
    let Some(from) = layout.order.iter().position(|candidate| candidate == id) else {
        return layout.clone();
    };
    let mut order: Vec<String> = layout
        .order
        .iter()
        .filter(|candidate| candidate.as_str() != id)
        .cloned()
        .collect();
    let index = to_index.min(order.len());
    order.insert(index, id.to_string());
    if order.iter().zip(layout.order.iter()).all(|(a, b)| a == b)
        && order.len() == layout.order.len()
    {
        return layout.clone();
    }
    let locked_in_main = LOCKED_STATS.iter().all(|locked| {
        order
            .iter()
            .position(|candidate| candidate == locked)
            .is_some_and(|index| index < MAIN_SLOTS)
    });
    if locked_in_main {
        StatsLayout {
            order,
            hidden: layout.hidden.clone(),
        }
    } else {
        layout.clone()
    }
}

/// `setStatHidden`.
pub fn set_stat_hidden(layout: &StatsLayout, id: &str, hidden: bool) -> StatsLayout {
    if LOCKED_STATS.contains(&id) {
        return layout.clone();
    }
    let without: Vec<String> = layout
        .hidden
        .iter()
        .filter(|candidate| candidate.as_str() != id)
        .cloned()
        .collect();
    StatsLayout {
        order: layout.order.clone(),
        hidden: if hidden {
            let mut next = without;
            next.push(id.to_string());
            next
        } else {
            without
        },
    }
}

/// Visible stats ids in layout order (`arrangeStats` without the models).
pub fn arranged_stat_ids(layout: &StatsLayout) -> Vec<String> {
    let hidden: std::collections::HashSet<&str> =
        layout.hidden.iter().map(String::as_str).collect();
    layout
        .order
        .iter()
        .filter(|id| !hidden.contains(id.as_str()))
        .cloned()
        .collect()
}

// --- every family at once ---

/// Every family's reading of the store, for the snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFamilies {
    pub first_run: FirstRunStartup,
    /// The retired onboarding flag, as stored (any value marks an existing
    /// install).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onboarding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whats_new_last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    pub output_chosen_by_user: bool,
    pub ai_consent: bool,
    pub buddy_auto_chat_consent: bool,
    pub clean_cut_auto: bool,
    pub clean_cut_attempted: Vec<String>,
    pub clean_cut_announced: Vec<String>,
    pub follow: FollowSettings,
    pub privacy: PrivacySettings,
    pub buddy_pet_review_marks: BuddyPetReviewMarks,
    pub buddy_invitation_dismissed: bool,
    /// Every persona's remembered pack (`videorc.buddyWornPack:<persona>`).
    pub buddy_worn_packs: BTreeMap<String, String>,
    pub cohost_sensitivity: CohostSensitivity,
    pub cohost_nudge_dismissed: bool,
    pub cohost_listen_prompt_dismissed: bool,
    pub stats_bar: StatsLayout,
}

impl UiFamilies {
    pub fn read(cache: &UiSettingsCache) -> Self {
        let buddy_worn_packs = cache
            .entries()
            .keys()
            .filter_map(|key| key.strip_prefix(keys::BUDDY_WORN_PACK_PREFIX))
            .filter_map(|persona| {
                buddy_worn_pack(cache, persona).map(|pack| (persona.to_string(), pack))
            })
            .collect();
        Self {
            first_run: first_run_startup(cache),
            onboarding: cache.get_item(keys::ONBOARDING),
            whats_new_last_seen: cache.get_item(keys::WHATS_NEW_LAST_SEEN),
            theme: theme(cache),
            output_chosen_by_user: output_chosen_by_user(cache),
            ai_consent: ai_consent(cache),
            buddy_auto_chat_consent: buddy_auto_chat_consent(cache),
            clean_cut_auto: clean_cut_auto(cache),
            clean_cut_attempted: clean_cut_attempted(cache),
            clean_cut_announced: clean_cut_announced(cache),
            follow: follow_settings(cache),
            privacy: privacy_settings(cache),
            buddy_pet_review_marks: buddy_pet_review_marks(cache),
            buddy_invitation_dismissed: buddy_invitation_dismissed(cache),
            buddy_worn_packs,
            cohost_sensitivity: cohost_sensitivity(cache),
            cohost_nudge_dismissed: cohost_nudge_dismissed(cache),
            cohost_listen_prompt_dismissed: cohost_listen_prompt_dismissed(cache),
            stats_bar: stats_layout(cache),
        }
    }
}

impl Default for UiFamilies {
    fn default() -> Self {
        Self::read(&UiSettingsCache::new())
    }
}
