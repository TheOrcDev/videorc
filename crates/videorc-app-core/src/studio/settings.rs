//! The persisted UI settings, read and written through `ui.settings.*`
//! (plan 220 S1.4a): what `localStorage` held while Electron owned the UI.
//!
//! [`UiSettingsCache`] is the pure half of `lib/ui-settings-store.ts`: one
//! snapshot hydrates it, every landed batch (`ui.settings.changed`) applies to
//! it unless it is this window's own echo (`writer`), and reads come from the
//! cache. A key with a write the engine has not confirmed keeps its local
//! value: a snapshot or another window's change for it is older (S3.0d,
//! [`SettingsJournal`]).
//!
//! **Value shape.** The one-time migration copies every `videorc.*`
//! `localStorage` entry verbatim: the value is the string `localStorage`
//! held. Most families keep JSON *text* in it (`videorc.settings` is a string
//! holding `{"keep…"}`); a few keep a plain word (`videorc.theme` is `dark`,
//! `videorc.aiConsent` is `1`). Each family reads and writes its own shape
//! ([`super::families`]); the generic [`UiSettingsCache::read`] parses a
//! string value as JSON text and also accepts a bare value (a writer that
//! skips the text layer).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use videorc_protocol::ui_settings::{UiSettingsChange, UiSettingsSetParams, UiSettingsSnapshot};

use super::camera_background::normalize_camera_background;
use super::capture_config::normalize_camera_look;
pub use super::capture_config::{CaptureConfig, CaptureConfigView};
use super::js_value::{finite_number, get, json_parse, spread_into, stored_text, truthy};

/// Every key the UI settings store holds for the renderer
/// (`UI_SETTINGS_MOVED_KEYS` in `lib/ui-settings-key-families.ts`), with
/// `STORAGE_KEYS`' names where `lib/capture.ts` has one.
pub mod keys {
    pub const SETTINGS: &str = "videorc.settings";
    pub const CAPTURE_CONFIG: &str = "videorc.captureConfig";
    pub const ONBOARDING: &str = "videorc.onboardingComplete";
    pub const FIRST_RUN: &str = "videorc.firstRun";
    pub const THEME: &str = "videorc.theme";
    pub const BACKGROUND_ASSETS: &str = "videorc.backgroundAssets";
    pub const OUTPUT_CHOSEN_BY_USER: &str = "videorc.outputChosenByUser";
    /// Plan 231 (#1543): the scenes library, written whole (`SCENES_KEY`).
    pub const SCENES: &str = "videorc.scenes.v2";
    /// Read once for plan 231's migration into [`SCENES`], never written.
    pub const SCENE_PRESETS: &str = "videorc.scene-presets.v1";
    pub const WORKING_SCENE: &str = "videorc.working-scene.v1";
    pub const SCENE_WINDOW_APPS: &str = "videorc.scene-window-apps.v1";
    pub const AI_CONSENT: &str = "videorc.aiConsent";
    pub const BUDDY_AUTO_CHAT_CONSENT: &str = "videorc.buddyAutoChatConsent";
    pub const CLEAN_CUT_AUTO: &str = "videorc.cleanCutAuto";
    pub const CLEAN_CUT_ATTEMPTED: &str = "videorc.cleanCutAttempted";
    pub const CLEAN_CUT_ANNOUNCED: &str = "videorc.cleanCutAnnounced";
    pub const FOLLOW_SETTINGS: &str = "videorc.followSettings.v1";
    pub const PRIVACY_SETTINGS: &str = "videorc.privacySettings.v1";
    pub const WHATS_NEW_LAST_SEEN: &str = "videorc.whatsNewLastSeenVersion";
    pub const BUDDY_PET_REVIEW_MARKS: &str = "videorc.buddyPetReviewMarks";
    pub const BUDDY_INVITATION_DISMISSED: &str = "videorc.buddyInvitationDismissed";
    /// A prefix: one key per Buddy persona (`videorc.buddyWornPack:<id>`).
    pub const BUDDY_WORN_PACK_PREFIX: &str = "videorc.buddyWornPack:";
    pub const COHOST_SENSITIVITY: &str = "videorc.cohostSensitivity";
    pub const COHOST_NUDGE_DISMISSED: &str = "videorc.cohostNudgeDismissed";
    /// Keeps its old name (plan 170 D22) so a dismissal survives updates.
    pub const COHOST_LISTEN_PROMPT_DISMISSED: &str = "videorc.orcleListenPromptDismissed";
    pub const STREAM_MANAGER_STATS_BAR: &str = "videorc.streamManager.statsBar";
    pub const SCREEN_TAKEOVER_MUTE_OWNERSHIP: &str = "videorc.screenTakeoverMuteOwnership.v1";
    /// S3.6b (P3-D1): the chosen recordings folder as a plain path the
    /// backend's store holds, which both apps read (Electron's bridge
    /// release writes its choice here, S5.4c and S5.4d). Not a moved
    /// `localStorage` key.
    pub const RECORDINGS_FOLDER: &str = "videorc.recordingsFolder";

    /// `UI_SETTINGS_MOVED_KEYS` as videorc-rust's S1.4a listed it (the
    /// persona key as its prefix), with today's scenes library. L2's S1.4
    /// owns the list the backend migrates; this is the Studio's reading of
    /// Electron's `localStorage` inventory.
    pub const MOVED: [&str; 27] = [
        SETTINGS,
        CAPTURE_CONFIG,
        ONBOARDING,
        FIRST_RUN,
        THEME,
        BACKGROUND_ASSETS,
        OUTPUT_CHOSEN_BY_USER,
        SCENES,
        SCENE_PRESETS,
        WORKING_SCENE,
        SCENE_WINDOW_APPS,
        AI_CONSENT,
        BUDDY_AUTO_CHAT_CONSENT,
        CLEAN_CUT_AUTO,
        CLEAN_CUT_ATTEMPTED,
        CLEAN_CUT_ANNOUNCED,
        FOLLOW_SETTINGS,
        PRIVACY_SETTINGS,
        WHATS_NEW_LAST_SEEN,
        BUDDY_PET_REVIEW_MARKS,
        BUDDY_INVITATION_DISMISSED,
        BUDDY_WORN_PACK_PREFIX,
        COHOST_SENSITIVITY,
        COHOST_NUDGE_DISMISSED,
        COHOST_LISTEN_PROMPT_DISMISSED,
        STREAM_MANAGER_STATS_BAR,
        SCREEN_TAKEOVER_MUTE_OWNERSHIP,
    ];
}

/// The cached store.
#[derive(Debug, Clone, Default)]
pub struct UiSettingsCache {
    entries: BTreeMap<String, Value>,
    revision: u64,
    hydrated: bool,
    local_storage_migrated: bool,
    /// Moves with every change to the entries, so a view built from them is
    /// built again only when they changed.
    generation: u64,
}

/// Why a read gave nothing useful.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// The value is a string that is not JSON text.
    NotJsonText(String),
    /// The JSON does not fit the type.
    Shape(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::NotJsonText(error) => write!(f, "the stored text is not JSON: {error}"),
            ReadError::Shape(error) => write!(f, "the stored value has the wrong shape: {error}"),
        }
    }
}

impl UiSettingsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The whole store, from `ui.settings.get`.
    pub fn hydrate(&mut self, snapshot: UiSettingsSnapshot) {
        self.hydrate_keeping(snapshot, &BTreeSet::new());
    }

    /// `hydrateOnce`: the snapshot, except the keys this window still has a
    /// pending write for (their local value is newer).
    pub fn hydrate_keeping(&mut self, snapshot: UiSettingsSnapshot, pending: &BTreeSet<String>) {
        let mut entries = snapshot.entries;
        for key in pending {
            match self.entries.get(key) {
                Some(local) => {
                    entries.insert(key.clone(), local.clone());
                }
                None => {
                    entries.remove(key);
                }
            }
        }
        self.entries = entries;
        self.generation += 1;
        self.revision = snapshot.revision;
        self.local_storage_migrated = snapshot.local_storage_migrated;
        self.hydrated = true;
    }

    /// A landed batch, from `ui.settings.changed` or from the answer to this
    /// window's own `ui.settings.set`. Returns false when it was skipped:
    /// this window's echo of a batch it already applied, or a batch older
    /// than the cache.
    pub fn apply_change(&mut self, change: &UiSettingsChange, own_writer: Option<&str>) -> bool {
        self.apply_change_keeping(change, own_writer, &BTreeSet::new())
    }

    /// `onRemoteChange`: as [`Self::apply_change`], skipping the keys this
    /// window still has a pending write for.
    pub fn apply_change_keeping(
        &mut self,
        change: &UiSettingsChange,
        own_writer: Option<&str>,
        pending: &BTreeSet<String>,
    ) -> bool {
        if change.writer.is_some() && change.writer.as_deref() == own_writer {
            // Already in the cache from the write-through; the revision still
            // moves with the store.
            self.revision = self.revision.max(change.revision);
            return false;
        }
        if change.revision < self.revision {
            return false;
        }
        for (key, value) in &change.put {
            if !pending.contains(key) {
                self.entries.insert(key.clone(), value.clone());
            }
        }
        for key in &change.delete {
            if !pending.contains(key) {
                self.entries.remove(key);
            }
        }
        self.generation += 1;
        self.revision = change.revision;
        true
    }

    /// This window's write landed in the cache at once (write-through); the
    /// answer to `ui.settings.set` then moves the revision.
    pub fn put_local(&mut self, key: &str, value: Value) {
        self.entries.insert(key.to_string(), value);
        self.generation += 1;
    }

    pub fn delete_local(&mut self, key: &str) {
        self.entries.remove(key);
        self.generation += 1;
    }

    /// Moves with every change to the entries.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The store's revision moved (the answer to this window's batch).
    pub fn note_revision(&mut self, revision: u64) {
        self.revision = self.revision.max(revision);
    }

    pub fn hydrated(&self) -> bool {
        self.hydrated
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn local_storage_migrated(&self) -> bool {
        self.local_storage_migrated
    }

    pub fn entries(&self) -> &BTreeMap<String, Value> {
        &self.entries
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.get(key)
    }

    /// What a key family's `getItem` returns: the stored string, or the JSON
    /// of a value a newer UI stored bare (`uiSettingsValueAsString`).
    pub fn get_item(&self, key: &str) -> Option<String> {
        stored_text(self.entries.get(key))
    }

    /// The value under `key` as `T`: JSON text in a string, or the value
    /// itself. `None` when the key is absent.
    pub fn read<T: DeserializeOwned>(&self, key: &str) -> Option<Result<T, ReadError>> {
        let value = self.entries.get(key)?;
        Some(decode(value))
    }

    /// `read`, with the type's default for an absent key and for a value
    /// that does not fit (never a silent default while hydrating: the
    /// caller checks [`Self::hydrated`]).
    pub fn read_or_default<T: DeserializeOwned + Default>(&self, key: &str) -> T {
        match self.read(key) {
            Some(Ok(value)) => value,
            _ => T::default(),
        }
    }

    /// A string entry, read without the JSON-text layer: JSON text holding a
    /// string parses to that string; a plain string is itself.
    pub fn read_string(&self, key: &str) -> Option<String> {
        match self.entries.get(key)? {
            Value::String(text) => match serde_json::from_str::<Value>(text) {
                Ok(Value::String(inner)) => Some(inner),
                _ => Some(text.clone()),
            },
            other => other.as_str().map(str::to_string),
        }
    }

    /// The batch that writes `value` under `key` in the text convention.
    pub fn put_params(key: &str, value: &impl Serialize, writer: &str) -> UiSettingsSetParams {
        UiSettingsSetParams {
            put: BTreeMap::from([(key.to_string(), encode(value))]),
            writer: Some(writer.to_string()),
            ..UiSettingsSetParams::default()
        }
    }

    pub fn delete_params(key: &str, writer: &str) -> UiSettingsSetParams {
        UiSettingsSetParams {
            delete: vec![key.to_string()],
            writer: Some(writer.to_string()),
            ..UiSettingsSetParams::default()
        }
    }
}

/// A stored value as `T` (see the module docs).
pub fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, ReadError> {
    match value {
        Value::String(text) => {
            let parsed: Value = serde_json::from_str(text)
                .map_err(|error| ReadError::NotJsonText(error.to_string()))?;
            serde_json::from_value(parsed).map_err(|error| ReadError::Shape(error.to_string()))
        }
        other => serde_json::from_value(other.clone())
            .map_err(|error| ReadError::Shape(error.to_string())),
    }
}

/// `value` as the store holds it: JSON text in a string.
pub fn encode(value: &impl Serialize) -> Value {
    Value::String(serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
}

/// One write a family makes: the stored string under its key, or the key
/// removed.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingWrite {
    Put { key: String, value: Value },
    Delete { key: String },
}

impl SettingWrite {
    /// `setItem(key, text)`.
    pub fn text(key: &str, text: impl Into<String>) -> Self {
        Self::Put {
            key: key.to_string(),
            value: Value::String(text.into()),
        }
    }

    /// `setItem(key, JSON.stringify(value))`.
    pub fn json(key: &str, value: &Value) -> Self {
        Self::text(
            key,
            serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
        )
    }

    /// `removeItem(key)`.
    pub fn delete(key: &str) -> Self {
        Self::Delete {
            key: key.to_string(),
        }
    }

    pub fn key(&self) -> &str {
        match self {
            Self::Put { key, .. } | Self::Delete { key } => key,
        }
    }
}

// --- the Studio's own settings ---

/// `SettingsState` in `lib/capture.ts`, as the renderer holds it: the stored
/// JSON spread over `defaultSettings` (`loadJson(STORAGE_KEYS.settings,
/// defaultSettings)`), every field kept as stored, and written back whole
/// (`JSON.stringify(settings)`) after each change. The accessors read each
/// field the way the renderer's consumers do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StudioSettings {
    doc: Map<String, Value>,
}

impl Default for StudioSettings {
    /// `defaultSettings` (its `outputDirectoryHandle: undefined` is no key).
    fn default() -> Self {
        let doc = json!({
            "outputDirectory": "",
            "keepOriginalRecording": false,
            "keepMicrophoneWarm": true,
            "animateSceneChanges": false,
            "audioMixer": {"monitorWhenIdle": false},
        });
        Self {
            doc: doc.as_object().cloned().unwrap_or_default(),
        }
    }
}

impl StudioSettings {
    /// `loadJson(STORAGE_KEYS.settings, defaultSettings)`, for the value the
    /// store holds (`None` when absent): no value, an empty one or text that
    /// is not JSON is the defaults; otherwise the parsed JSON spread over
    /// them.
    pub fn load(stored: Option<&Value>) -> Self {
        let mut settings = Self::default();
        if let Some(text) = stored_text(stored).filter(|text| !text.is_empty())
            && let Some(parsed) = json_parse(&text)
        {
            spread_into(&mut settings.doc, &parsed);
        }
        settings
    }

    /// The whole object, as stored after a write.
    pub fn doc(&self) -> &Map<String, Value> {
        &self.doc
    }

    pub fn doc_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.doc
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.doc.get(key)
    }

    /// `setSettings(current => ({...current, [key]: value}))`.
    pub fn set(&mut self, key: &str, value: Value) {
        self.doc.insert(key.to_string(), value);
    }

    /// `{...current, [key]: undefined}`.
    pub fn remove(&mut self, key: &str) {
        self.doc.remove(key);
    }

    /// What the store holds after a write: `JSON.stringify(settings)`.
    pub fn stored(&self) -> Value {
        encode(&self.doc)
    }

    fn field(&self, key: &str) -> Option<&Value> {
        self.doc.get(key)
    }

    /// A picker label only; never a filesystem path.
    pub fn output_directory(&self) -> &str {
        self.field("outputDirectory")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    /// The handle the picker issued; the start exchanges it for a
    /// capability.
    pub fn output_directory_handle(&self) -> Option<&str> {
        self.field("outputDirectoryHandle")
            .and_then(Value::as_str)
            .filter(|handle| !handle.is_empty())
    }

    /// Keep the capture MKV next to the exported MP4 (the switch is
    /// `checked={settings.keepOriginalRecording}`).
    pub fn keep_original_recording(&self) -> bool {
        truthy(self.field("keepOriginalRecording"))
    }

    /// Keep the microphone open while Studio is visible (instant-record P5):
    /// `keepMicrophoneWarm !== false`.
    pub fn keep_microphone_warm(&self) -> bool {
        self.field("keepMicrophoneWarm") != Some(&Value::Bool(false))
    }

    /// Open the Stream Manager when a livestream goes live (plan 055 D6):
    /// `=== true`.
    pub fn open_stream_manager_on_live(&self) -> bool {
        self.field("openStreamManagerOnLive") == Some(&Value::Bool(true))
    }

    /// Scene motion (`=== true`).
    pub fn animate_scene_changes(&self) -> bool {
        self.field("animateSceneChanges") == Some(&Value::Bool(true))
    }

    /// Retro LCD (plan 197): `=== true`.
    pub fn retro_lcd_studio(&self) -> bool {
        self.field("retroLcdStudio") == Some(&Value::Bool(true))
    }

    /// Chat in Studio (plan 204): `=== true`.
    pub fn studio_chat(&self) -> bool {
        self.field("studioChat") == Some(&Value::Bool(true))
    }

    /// The audio mixer's idle monitor (`audioMixer.monitorWhenIdle`): off
    /// unless explicitly on.
    pub fn monitor_when_idle(&self) -> bool {
        get(self.field("audioMixer"), "monitorWhenIdle") == Some(&Value::Bool(true))
    }

    /// `settings.globalShortcuts ?? {}`.
    pub fn global_shortcuts(&self) -> Value {
        match self.field("globalShortcuts") {
            None | Some(Value::Null) => json!({}),
            Some(shortcuts) => shortcuts.clone(),
        }
    }

    /// The camera's look (`cameraLookLayout`: `normalizeCameraLook(looks?.[cameraId])`),
    /// `None` when neutral or unset.
    pub fn camera_look(&self, camera_id: Option<&str>) -> Option<Value> {
        let looks = self.field("cameraLooks");
        normalize_camera_look(camera_id.and_then(|id| get(looks, id)))
    }

    /// Plan 258 S1: the camera's background (`cameraBackgrounds?.[cameraId]`,
    /// normalized), `None` when none is stored (Off).
    pub fn camera_background(&self, camera_id: Option<&str>) -> Option<Value> {
        let backgrounds = self.field("cameraBackgrounds");
        normalize_camera_background(camera_id.and_then(|id| get(backgrounds, id)))
    }

    /// Plan 258 D4: `cameraBackgroundMigrated(cameraBackgroundMigration)`,
    /// true once the scenes' keys moved to the cameras; from then on the
    /// key comes from the camera's choice (S1.6b applies it).
    pub fn camera_background_migrated(&self) -> bool {
        finite_number(self.field("cameraBackgroundMigration"))
            .is_some_and(|version| version >= CAMERA_BACKGROUND_MIGRATION_VERSION)
    }
}

/// `CAMERA_BACKGROUND_MIGRATION_VERSION`: the D4 migration's version, stored
/// once it settles.
pub const CAMERA_BACKGROUND_MIGRATION_VERSION: f64 = 1.0;

// --- the write journal ---

/// `RETRY_BACKOFF_MS` (`lib/ui-settings-store.ts`): the waits between sends
/// that did not land.
pub const RETRY_BACKOFF_MS: [u64; 6] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/// `UI_SETTINGS_HYDRATE_TIMEOUT_MS`: how long a window waits for its first
/// snapshot before it renders without it.
pub const HYDRATE_TIMEOUT: Duration = Duration::from_millis(15_000);

/// The `step`th retry's wait (the last one repeats).
pub fn retry_delay(step: usize) -> Duration {
    Duration::from_millis(RETRY_BACKOFF_MS[step.min(RETRY_BACKOFF_MS.len() - 1)])
}

/// The store's limits (`ui_settings.rs`, `UI_SETTINGS_*` in `shared/backend.ts`).
/// A value is at most 8 MiB serialized, so a previous release's whole scene
/// library fits (#1833 raised it from 1 MiB). The limits stay in the backend,
/// not `videorc-protocol`, so they are mirrored here.
pub const KEY_MAX_CHARS: usize = 256;
pub const VALUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// `migrationRefusal`: why the store would refuse this key or value, or
/// `None`. A write past the limits fails at once, as full web storage did,
/// so it never waits in the journal for a send that cannot land.
pub fn write_refusal(key: &str, value: Option<&Value>) -> Option<String> {
    let chars = key.encode_utf16().count();
    if chars > KEY_MAX_CHARS {
        return Some(format!(
            "the key is {chars} characters; the limit is {KEY_MAX_CHARS}"
        ));
    }
    if key
        .chars()
        .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}'))
    {
        return Some("the key contains a control character".into());
    }
    if super::js_value::trim(key) != key {
        return Some("the key starts or ends with whitespace".into());
    }
    if let Some(value) = value {
        let bytes = serde_json::to_string(value).map_or(0, |text| text.len());
        if bytes > VALUE_MAX_BYTES {
            return Some(format!(
                "the value is {bytes} bytes; the limit is {VALUE_MAX_BYTES}"
            ));
        }
    }
    None
}

/// The writes the engine has not confirmed (`pendingPut`, `pendingDelete`),
/// kept in the Rust app's own journal file in its data directory so a write
/// made while the engine is away survives the app closing: the next start
/// sends it once the snapshot is in. The file's shape is the renderer's
/// journal (`{"put": {...}, "delete": [...]}`).
#[derive(Debug, Default)]
pub struct SettingsJournal {
    path: Option<PathBuf>,
    put: BTreeMap<String, Value>,
    delete: BTreeSet<String>,
}

impl SettingsJournal {
    /// The journal at `path` (none: in memory only), with what a previous run
    /// left there (`parseJournal`: a put of `null` and a non-string delete
    /// are dropped; an unreadable file is an empty journal).
    pub fn open(path: Option<PathBuf>) -> Self {
        let mut journal = Self {
            path,
            ..Self::default()
        };
        let Some(path) = journal.path.as_deref() else {
            return journal;
        };
        let Some(parsed) = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| json_parse(&text))
        else {
            return journal;
        };
        if let Some(Value::Object(put)) = parsed.get("put") {
            for (key, value) in put {
                if !value.is_null() {
                    journal.put.insert(key.clone(), value.clone());
                }
            }
        }
        if let Some(Value::Array(deletes)) = parsed.get("delete") {
            for key in deletes.iter().filter_map(Value::as_str) {
                if !journal.put.contains_key(key) {
                    journal.delete.insert(key.to_string());
                }
            }
        }
        journal
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn is_empty(&self) -> bool {
        self.put.is_empty() && self.delete.is_empty()
    }

    /// The keys with a write waiting.
    pub fn keys(&self) -> BTreeSet<String> {
        self.put.keys().chain(self.delete.iter()).cloned().collect()
    }

    pub fn puts(&self) -> &BTreeMap<String, Value> {
        &self.put
    }

    pub fn deletes(&self) -> &BTreeSet<String> {
        &self.delete
    }

    /// `set(key, value)`: the newest value for the key waits.
    pub fn put(&mut self, key: &str, value: Value) {
        self.delete.remove(key);
        self.put.insert(key.to_string(), value);
    }

    /// `remove(key)`.
    pub fn delete(&mut self, key: &str) {
        self.put.remove(key);
        self.delete.insert(key.to_string());
    }

    /// The batch to send now.
    pub fn batch(&self, writer: &str) -> UiSettingsSetParams {
        UiSettingsSetParams {
            put: self.put.clone(),
            delete: self.delete.iter().cloned().collect(),
            writer: Some(writer.to_string()),
            ..UiSettingsSetParams::default()
        }
    }

    /// The batch landed: what it sent is no longer pending, unless a newer
    /// write for the key came in meanwhile.
    pub fn landed(&mut self, sent: &UiSettingsSetParams) {
        for (key, value) in &sent.put {
            if self.put.get(key) == Some(value) {
                self.put.remove(key);
            }
        }
        for key in &sent.delete {
            if !self.put.contains_key(key) {
                self.delete.remove(key);
            }
        }
    }

    /// `writeJournal`: the pending writes to the file, or the file removed
    /// when nothing is pending. Written whole to a temporary file and moved
    /// into place.
    pub fn save(&self) -> std::io::Result<()> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        if self.is_empty() {
            return match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            };
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string(&json!({
            "put": self.put,
            "delete": self.delete,
        }))
        .map_err(std::io::Error::other)?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(revision: u64, writer: Option<&str>, put: &[(&str, Value)]) -> UiSettingsChange {
        UiSettingsChange {
            revision,
            put: put
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect(),
            delete: Vec::new(),
            writer: writer.map(str::to_string),
        }
    }

    #[test]
    fn camera_backgrounds_read_as_electron_reads_them() {
        // `quietWhileLive` ("Quiet while recording or live") is retired: an
        // older settings file that still has it loads as before, and nothing
        // reads it.
        let settings = StudioSettings::load(Some(&json!(
            r#"{"cameraBackgrounds":{"cam":{"mode":"blur","blurPct":30}},"cameraBackgroundMigration":1,"quietWhileLive":false}"#
        )));
        assert_eq!(
            settings.camera_background(Some("cam")),
            Some(json!({"mode": "blur", "blurPct": 30, "edges": "balanced"}))
        );
        assert_eq!(settings.camera_background(Some("other")), None);
        assert_eq!(settings.camera_background(None), None);
        assert!(settings.camera_background_migrated());
        let defaults = StudioSettings::default();
        assert!(!defaults.camera_background_migrated());
    }

    #[test]
    fn a_snapshot_hydrates_and_foreign_changes_apply_but_own_echoes_do_not() {
        let mut cache = UiSettingsCache::new();
        assert!(!cache.hydrated());
        cache.hydrate(UiSettingsSnapshot {
            entries: BTreeMap::from([(keys::THEME.to_string(), json!("dark"))]),
            revision: 4,
            local_storage_migrated: true,
        });
        assert!(cache.hydrated());
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("dark"));

        // This window wrote: write-through, then its echo is skipped.
        cache.put_local(keys::THEME, json!("light"));
        assert!(!cache.apply_change(
            &change(5, Some("me"), &[(keys::THEME, json!("light"))]),
            Some("me")
        ));
        assert_eq!(cache.revision(), 5);
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("light"));

        // Another window wrote: applied.
        assert!(cache.apply_change(
            &change(6, Some("other"), &[(keys::THEME, json!("system"))]),
            Some("me")
        ));
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("system"));
        // An older batch is ignored.
        assert!(!cache.apply_change(
            &change(3, None, &[(keys::THEME, json!("dark"))]),
            Some("me")
        ));
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("system"));
        // A key with a pending write keeps its local value.
        let pending = BTreeSet::from([keys::THEME.to_string()]);
        cache.put_local(keys::THEME, json!("light"));
        assert!(cache.apply_change_keeping(
            &change(7, Some("other"), &[(keys::THEME, json!("dark"))]),
            Some("me"),
            &pending
        ));
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("light"));
        cache.hydrate_keeping(
            UiSettingsSnapshot {
                entries: BTreeMap::from([(keys::THEME.to_string(), json!("dark"))]),
                revision: 8,
                local_storage_migrated: true,
            },
            &pending,
        );
        assert_eq!(cache.get_item(keys::THEME).as_deref(), Some("light"));
        // A delete lands.
        let mut delete = change(9, None, &[]);
        delete.delete = vec![keys::THEME.to_string()];
        assert!(cache.apply_change(&delete, Some("me")));
        assert_eq!(cache.get_item(keys::THEME), None);
    }

    #[test]
    fn settings_load_as_the_renderer_spreads_them_and_keep_unknown_fields() {
        let text = r#"{"outputDirectory":"Movies","keepOriginalRecording":true,"globalShortcuts":{"record":"F9"}}"#;
        let settings = StudioSettings::load(Some(&Value::String(text.to_string())));
        assert_eq!(settings.output_directory(), "Movies");
        assert!(settings.keep_original_recording());
        assert!(settings.keep_microphone_warm(), "the default is on");
        assert!(!settings.open_stream_manager_on_live());
        assert_eq!(settings.global_shortcuts()["record"], "F9");
        assert_eq!(
            settings.get("audioMixer"),
            Some(&json!({"monitorWhenIdle": false}))
        );
        // The write-back keeps what it did not model.
        let stored: Value = decode(&settings.stored()).unwrap();
        assert_eq!(stored["globalShortcuts"]["record"], "F9");
        assert_eq!(stored["keepMicrophoneWarm"], json!(true));
        assert!(stored.get("outputDirectoryHandle").is_none());

        let bare = StudioSettings::load(Some(&json!({"openStreamManagerOnLive": true})));
        assert!(bare.open_stream_manager_on_live());
        assert_eq!(
            StudioSettings::load(Some(&json!("not json"))),
            StudioSettings::default()
        );
        assert_eq!(
            StudioSettings::load(Some(&json!(""))),
            StudioSettings::default()
        );
        assert_eq!(StudioSettings::load(None), StudioSettings::default());
        // A wrong type is kept as stored and read as the consumer reads it.
        let odd = StudioSettings::load(Some(&json!(
            r#"{"keepMicrophoneWarm":"no","studioChat":1}"#
        )));
        assert!(odd.keep_microphone_warm(), "only `false` turns it off");
        assert!(!odd.studio_chat(), "only `true` turns it on");
        assert_eq!(odd.get("keepMicrophoneWarm"), Some(&json!("no")));
        let looks = StudioSettings::load(Some(&json!(
            r#"{"cameraLooks":{"cam-1":{"brightness":0.1,"contrast":1,"saturation":1}}}"#
        )));
        assert_eq!(
            looks.camera_look(Some("cam-1")).unwrap()["brightness"],
            json!(0.1)
        );
        assert_eq!(looks.camera_look(Some("cam-2")), None);
    }

    #[test]
    fn the_journal_survives_a_restart_and_forgets_what_landed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ui-settings-journal.json");
        let mut journal = SettingsJournal::open(Some(path.clone()));
        assert!(journal.is_empty());
        journal.put(keys::THEME, json!("light"));
        journal.delete(keys::AI_CONSENT);
        journal.save().unwrap();

        let reopened = SettingsJournal::open(Some(path.clone()));
        assert_eq!(reopened.puts()[keys::THEME], json!("light"));
        assert!(reopened.deletes().contains(keys::AI_CONSENT));

        let mut journal = reopened;
        let sent = journal.batch("me");
        // A newer write for the theme arrived while the batch was out.
        journal.put(keys::THEME, json!("dark"));
        journal.landed(&sent);
        assert_eq!(journal.puts()[keys::THEME], json!("dark"));
        assert!(journal.deletes().is_empty());
        let sent = journal.batch("me");
        journal.landed(&sent);
        assert!(journal.is_empty());
        journal.save().unwrap();
        assert!(!path.exists(), "an empty journal leaves no file");

        std::fs::write(&path, r#"{"put":{"a":null,"b":"1"},"delete":["c",2]}"#).unwrap();
        let parsed = SettingsJournal::open(Some(path.clone()));
        assert_eq!(
            parsed.keys(),
            BTreeSet::from(["b".to_string(), "c".to_string()])
        );
        std::fs::write(&path, "not json").unwrap();
        assert!(SettingsJournal::open(Some(path)).is_empty());
    }

    #[test]
    fn writes_past_the_limits_are_refused_at_once() {
        assert_eq!(write_refusal(keys::THEME, Some(&json!("dark"))), None);
        assert!(
            write_refusal(&"k".repeat(257), None)
                .unwrap()
                .contains("257 characters")
        );
        assert!(write_refusal("videorc.\u{0007}", None).is_some());
        assert!(write_refusal(" videorc.x", None).is_some());
        let library = Value::String("x".repeat(2 * 1024 * 1024));
        assert_eq!(
            write_refusal(keys::THEME, Some(&library)),
            None,
            "a value past the old 1 MiB limit is kept"
        );
        let huge = Value::String("x".repeat(VALUE_MAX_BYTES));
        assert!(
            write_refusal(keys::THEME, Some(&huge))
                .unwrap()
                .contains("bytes")
        );
        assert_eq!(retry_delay(0), Duration::from_secs(1));
        assert_eq!(retry_delay(5), Duration::from_secs(30));
        assert_eq!(retry_delay(99), Duration::from_secs(30));
    }
}
