use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::diagnostics::permission_pane_for_log;
use crate::live_chat::{
    CommentsSendOperation, CommentsSendOperationPhase, LiveChatEventType, LiveChatMessage,
    LiveChatMessageFragment,
};
use crate::process_job::output_owned_std;
use crate::protocol::{
    AiArtifact, AiArtifactKind, AiArtifactStatus, DiagnosticStats, HealthEvent, HealthLevel,
    LayoutSettings, NoiseCleanupJob, NoiseCleanupJobStatus, OutputSettings, SessionLogEntry,
    SessionStorageTotals, SessionSummary, SourceSelection, StreamScreen, StreamScreenStatus,
};
use crate::repair::{GateStatus, RepairJob, RepairJobStatus};
use crate::streaming::{
    PlatformAccount, PlatformAccountStatus, StreamMetadataDraft, StreamPlatform,
    UpsertPlatformAccount, default_stream_metadata_draft, stream_platform_from_id,
    stream_platform_id,
};

const MAX_NOISE_CLEANUP_JOB_LIST: usize = 1_000;

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SessionCloneFacts {
    pub title: String,
    pub output_path: Option<String>,
    pub mp4_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub mode: String,
    pub output_path: Option<String>,
    pub container: Option<String>,
    pub stream_preset: Option<String>,
    pub sources: SourceSelection,
    pub layout: LayoutSettings,
    pub output: OutputSettings,
}

#[derive(Debug, Clone)]
pub(crate) struct NoiseCleanupSource {
    pub id: String,
    pub title: String,
    pub status: String,
    pub mode: String,
    pub media_path: Option<String>,
    pub container: Option<String>,
    pub sources: SourceSelection,
    pub derived_from_session_id: Option<String>,
    pub processing_kind: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersistedNoiseCleanupJob {
    pub job: NoiseCleanupJob,
    pub source_identity: SessionFileBoundIdentity,
    pub source_full_sha256: String,
}

#[derive(Debug, Clone)]
pub struct PlatformAccountCredentials {
    pub account: PlatformAccount,
    pub token_secret_ref: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub stream_key_secret_ref: Option<String>,
    pub write_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAccountWriteExpectation {
    pub exists: bool,
    pub token_secret_ref: Option<String>,
    pub refresh_token_secret_ref: Option<String>,
    pub stream_key_secret_ref: Option<String>,
    pub generation: u64,
}

impl PlatformAccountWriteExpectation {
    pub fn absent(generation: u64) -> Self {
        Self {
            exists: false,
            token_secret_ref: None,
            refresh_token_secret_ref: None,
            stream_key_secret_ref: None,
            generation,
        }
    }

    pub fn from_credentials(credentials: &PlatformAccountCredentials) -> Self {
        Self {
            exists: true,
            token_secret_ref: credentials.token_secret_ref.clone(),
            refresh_token_secret_ref: credentials.refresh_token_secret_ref.clone(),
            stream_key_secret_ref: credentials.stream_key_secret_ref.clone(),
            generation: credentials.write_generation,
        }
    }

    pub fn for_account(account: &UpsertPlatformAccount, generation: u64) -> Self {
        Self {
            exists: true,
            token_secret_ref: account.token_secret_ref.clone(),
            refresh_token_secret_ref: account.refresh_token_secret_ref.clone(),
            stream_key_secret_ref: account.stream_key_secret_ref.clone(),
            generation,
        }
    }

    pub fn secret_refs(&self) -> impl Iterator<Item = &str> {
        self.token_secret_ref
            .iter()
            .chain(self.refresh_token_secret_ref.iter())
            .chain(self.stream_key_secret_ref.iter())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformAccountCasOutcome {
    Applied(PlatformAccount),
    AlreadyApplied(PlatformAccount),
    Stale(PlatformAccountWriteExpectation),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFinalization {
    pub session_id: String,
    pub status: String,
    pub ended_at: Option<String>,
    pub mp4_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub diagnostics_json: String,
    /// Authoritative MKV produced by the capture process. Recovery retains it
    /// until an identity-matched MP4 is committed to SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_identity: Option<SessionFileIdentity>,
    /// Stable object identity captured from the same open MKV handle as
    /// `output_identity`. Source cleanup requires both identities so a copied
    /// same-content replacement is never mistaken for the original capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_object_identity: Option<SessionFileObjectIdentity>,
    /// Same-directory private export path. It is journaled before FFmpeg starts
    /// so a crash never leaves an unexplained publication window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_path: Option<String>,
    /// Identity captured and synced before the no-replace publication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_identity: Option<SessionFileIdentity>,
    /// Stable filesystem-object identity captured before FFmpeg writes any
    /// bytes. Unlike the content identity above, this survives truncation and
    /// lets recovery discard an interrupted partial export without trusting a
    /// path alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_object_identity: Option<SessionFileObjectIdentity>,
    /// Same-directory private name used for move-first verification of an
    /// interrupted MP4 staging file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_cleanup_path: Option<String>,
    /// Private same-filesystem directory that owns the FFmpeg output name.
    /// The directory exists before FFmpeg starts, while `mp4_staging_path`
    /// deliberately does not, so FFmpeg can retain `-n` no-overwrite safety.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_directory_path: Option<String>,
    /// Stable identity of the private staging directory. Recovery verifies
    /// this object before removing an interrupted or empty export workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_directory_object_identity: Option<SessionFileObjectIdentity>,
    /// Same-directory quarantine name for move-first verification of the
    /// private staging directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp4_staging_directory_cleanup_path: Option<String>,
    #[serde(default)]
    pub remove_output_after_commit: bool,
    /// Private same-directory name used for move-first, verify-second MKV
    /// cleanup. Persisting it makes a crash or mismatch retryable without ever
    /// deleting by the original user-visible path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_cleanup_path: Option<String>,
}

impl SessionFinalization {
    pub fn new(
        session_id: impl Into<String>,
        status: impl Into<String>,
        ended_at: Option<String>,
        mp4_path: Option<String>,
        duration_ms: Option<i64>,
        diagnostics: &DiagnosticStats,
    ) -> Result<Self> {
        Ok(Self {
            session_id: session_id.into(),
            status: status.into(),
            ended_at,
            mp4_path,
            duration_ms,
            diagnostics_json: serde_json::to_string(diagnostics)?,
            output_path: None,
            output_identity: None,
            output_object_identity: None,
            mp4_staging_path: None,
            mp4_identity: None,
            mp4_staging_object_identity: None,
            mp4_staging_cleanup_path: None,
            mp4_staging_directory_path: None,
            mp4_staging_directory_object_identity: None,
            mp4_staging_directory_cleanup_path: None,
            remove_output_after_commit: false,
            output_cleanup_path: None,
        })
    }

    pub fn with_media_ownership(
        mut self,
        output_path: Option<String>,
        output_identity: Option<SessionFileIdentity>,
        mp4_staging_path: Option<String>,
        mp4_identity: Option<SessionFileIdentity>,
        remove_output_after_commit: bool,
    ) -> Self {
        self.output_path = output_path;
        self.output_identity = output_identity;
        self.mp4_staging_path = mp4_staging_path;
        self.mp4_identity = mp4_identity;
        self.remove_output_after_commit = remove_output_after_commit;
        if remove_output_after_commit
            && self.output_cleanup_path.is_none()
            && let Some(output_path) = self.output_path.as_deref()
        {
            self.output_cleanup_path = Some(
                Path::new(output_path)
                    .with_file_name(format!(".videorc-finalize-cleanup-{}", Uuid::new_v4()))
                    .display()
                    .to_string(),
            );
        }
        self
    }

    pub fn with_output_file_object_identity(
        mut self,
        object_identity: SessionFileObjectIdentity,
    ) -> Self {
        self.output_object_identity = Some(object_identity);
        self
    }

    #[cfg(test)]
    pub fn with_mp4_staging_object_ownership(
        mut self,
        object_identity: SessionFileObjectIdentity,
        cleanup_path: String,
    ) -> Self {
        self.mp4_staging_object_identity = Some(object_identity);
        self.mp4_staging_cleanup_path = Some(cleanup_path);
        self
    }

    pub fn with_mp4_staging_file_object_identity(
        mut self,
        object_identity: SessionFileObjectIdentity,
    ) -> Self {
        self.mp4_staging_object_identity = Some(object_identity);
        self
    }

    pub fn with_mp4_staging_directory_ownership(
        mut self,
        directory_path: String,
        object_identity: SessionFileObjectIdentity,
        cleanup_path: String,
    ) -> Self {
        self.mp4_staging_directory_path = Some(directory_path);
        self.mp4_staging_directory_object_identity = Some(object_identity);
        self.mp4_staging_directory_cleanup_path = Some(cleanup_path);
        self
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionFinalizationRecoverySummary {
    pub recovered: usize,
    pub pending: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileOperation {
    pub id: String,
    pub kind: String,
    pub session_id: String,
    pub staging_path: String,
    pub final_path: String,
    pub created_at: String,
    staging_cleanup_path: Option<String>,
    staging_object_identity: Option<SessionFileObjectIdentity>,
    published_identity: Option<SessionFileIdentity>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionFileReconciliationSummary {
    pub published: usize,
    pub discarded: usize,
    pub pending: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatMessagesPage {
    pub messages: Vec<LiveChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("Live chat message {message_id} references missing session {session_id}.")]
pub(crate) struct MissingLiveChatSession {
    message_id: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDeletion {
    pub operation_id: String,
    pub session_id: String,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SessionDeletionPathRecord {
    #[serde(alias = "path")]
    original_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quarantine_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<SessionFileIdentity>,
    /// Stable identity of the exact filesystem object hidden for deletion.
    /// Legacy tombstones omit this field and therefore fail closed for every
    /// path that still exists instead of relying on sampled bytes alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    object_identity: Option<SessionFileObjectIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileIdentity {
    len: u64,
    modified_unix_nanos: Option<i64>,
    sample_sha256: String,
}

impl SessionFileIdentity {
    /// Compare the durable byte evidence that survives a same-object rename.
    /// Timestamps remain part of strict identity equality for legacy records
    /// that do not carry an exact filesystem object identity.
    pub(crate) fn same_sampled_bytes(&self, other: &Self) -> bool {
        self.len == other.len && self.sample_sha256 == other.sample_sha256
    }
}

/// Identity of one filesystem object, independent of its length, timestamps,
/// or contents. It is recorded while the creating handle is still open and is
/// stable across writes and same-filesystem renames.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileObjectIdentity {
    volume_id: u64,
    file_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionFileBoundIdentity {
    pub content_identity: SessionFileIdentity,
    pub object_identity: SessionFileObjectIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionMediaPathState {
    Present,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DeletionPathState {
    Missing,
    Ready(String),
    Blocked(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionCompletion {
    pub session_id: String,
    pub deleted: bool,
    pub pending_paths: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionDeletionReconciliationSummary {
    pub completed: usize,
    pub pending: usize,
    pub errors: Vec<String>,
}

fn parse_session_deletion_path_records(value: &str) -> Result<Vec<SessionDeletionPathRecord>> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(value)?;
    entries
        .into_iter()
        .map(|entry| match entry {
            serde_json::Value::String(path) => Ok(SessionDeletionPathRecord {
                original_path: path,
                quarantine_path: None,
                // Legacy tombstones did not capture identity. Existing files
                // are therefore blocked rather than guessed safe to Trash.
                identity: None,
                object_identity: None,
            }),
            entry => serde_json::from_value(entry).map_err(Into::into),
        })
        .collect()
}

fn pending_session_deletion_from_records(
    operation_id: String,
    session_id: String,
    records: Vec<SessionDeletionPathRecord>,
) -> Result<PendingSessionDeletion> {
    let mut paths = Vec::new();
    let mut blocked_paths = Vec::new();
    for record in records {
        match deletion_path_state(&record)? {
            DeletionPathState::Missing => {}
            DeletionPathState::Ready(path) => paths.push(path),
            DeletionPathState::Blocked(path) => blocked_paths.push(path),
        }
    }
    Ok(PendingSessionDeletion {
        operation_id,
        session_id,
        paths,
        blocked_paths,
    })
}

pub(crate) fn capture_session_file_content_identity_from_file(
    file: &mut File,
    path: &Path,
) -> Result<SessionFileIdentity> {
    const SAMPLE_BYTES: u64 = 64 * 1024;
    let metadata = file
        .metadata()
        .with_context(|| format!("Could not inspect session file {}", path.display()))?;
    if !metadata.is_file() {
        bail!(
            "Session media path {} is not a regular file.",
            path.display()
        );
    }
    let len = metadata.len();
    let modified_unix_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX));
    let mut hasher = Sha256::new();
    hasher.update(len.to_le_bytes());
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("Could not seek session file {}", path.display()))?;
    let mut first = vec![0_u8; usize::try_from(len.min(SAMPLE_BYTES)).unwrap_or(0)];
    file.read_exact(&mut first)
        .with_context(|| format!("Could not sample session file {}", path.display()))?;
    hasher.update(&first);
    if len > SAMPLE_BYTES {
        file.seek(SeekFrom::Start(len.saturating_sub(SAMPLE_BYTES)))
            .with_context(|| format!("Could not seek session file {}", path.display()))?;
        let mut last = vec![0_u8; SAMPLE_BYTES as usize];
        file.read_exact(&mut last)
            .with_context(|| format!("Could not sample session file {}", path.display()))?;
        hasher.update(&last);
    }
    Ok(SessionFileIdentity {
        len,
        modified_unix_nanos,
        sample_sha256: format!("{:x}", hasher.finalize()),
    })
}

pub(crate) fn capture_session_file_identity(path: &Path) -> Result<Option<SessionFileIdentity>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not inspect session file {}", path.display()));
        }
    };
    capture_session_file_content_identity_from_file(&mut file, path).map(Some)
}

pub(crate) fn capture_session_file_object_identity_from_file(
    file: &File,
    path: &Path,
) -> Result<SessionFileObjectIdentity> {
    let metadata = file
        .metadata()
        .with_context(|| format!("Could not inspect session file {}", path.display()))?;
    if !metadata.is_file() {
        bail!(
            "Session media path {} is not a regular file.",
            path.display()
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(SessionFileObjectIdentity {
            volume_id: metadata.dev(),
            file_id: metadata.ino(),
        })
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;

        windows_session_object_identity_from_handle(HANDLE(file.as_raw_handle()), path)
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = metadata;
        bail!(
            "Stable session file object identities are unsupported on this platform for {}",
            path.display()
        )
    }
}

#[cfg(target_os = "windows")]
fn windows_session_object_identity_from_handle(
    handle: windows::Win32::Foundation::HANDLE,
    path: &Path,
) -> Result<SessionFileObjectIdentity> {
    use std::mem::MaybeUninit;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) }.with_context(|| {
        format!(
            "Windows could not read the stable filesystem identity for {}",
            path.display()
        )
    })?;
    let information = unsafe { information.assume_init() };
    let file_id =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok(SessionFileObjectIdentity {
        volume_id: u64::from(information.dwVolumeSerialNumber),
        file_id,
    })
}

pub(crate) fn capture_session_file_object_identity(
    path: &Path,
) -> Result<Option<SessionFileObjectIdentity>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not inspect session file {}", path.display()));
        }
    };
    capture_session_file_object_identity_from_file(&file, path).map(Some)
}

pub(crate) fn capture_session_file_bound_identity(
    path: &Path,
) -> Result<Option<SessionFileBoundIdentity>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not inspect session file {}", path.display()));
        }
    };
    let object_identity = capture_session_file_object_identity_from_file(&file, path)?;
    let content_identity = capture_session_file_content_identity_from_file(&mut file, path)?;
    Ok(Some(SessionFileBoundIdentity {
        content_identity,
        object_identity,
    }))
}

pub(crate) fn session_file_bound_identity_matches(
    actual: &SessionFileBoundIdentity,
    expected_content_identity: &SessionFileIdentity,
    expected_object_identity: Option<&SessionFileObjectIdentity>,
) -> bool {
    match expected_object_identity {
        Some(expected_object_identity) => {
            &actual.object_identity == expected_object_identity
                && actual
                    .content_identity
                    .same_sampled_bytes(expected_content_identity)
        }
        None => &actual.content_identity == expected_content_identity,
    }
}

/// Cheap list/bootstrap staleness check: exact filesystem object plus length
/// and modification time, without sampling media bytes. Full/sample hashing is
/// reserved for the capture-aware background worker.
pub(crate) fn session_file_quick_identity_matches(
    path: &Path,
    expected: &SessionFileBoundIdentity,
) -> Result<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    let modified_unix_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX));
    let object_identity = capture_session_file_object_identity_from_file(&file, path)?;
    Ok(object_identity == expected.object_identity
        && metadata.len() == expected.content_identity.len
        && modified_unix_nanos == expected.content_identity.modified_unix_nanos)
}

/// Classify a managed media path without treating every I/O error as deletion.
/// In particular, permission failures and unavailable volumes must not cause
/// Library metadata to be retired.
pub(crate) fn session_media_path_state(path: &Path) -> SessionMediaPathState {
    match File::open(path) {
        Ok(file) => match file.metadata() {
            Ok(metadata) if metadata.is_file() => SessionMediaPathState::Present,
            Ok(_) => SessionMediaPathState::Missing,
            Err(_) => SessionMediaPathState::Unavailable,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            SessionMediaPathState::Missing
        }
        Err(_) => SessionMediaPathState::Unavailable,
    }
}

pub(crate) fn capture_session_directory_object_identity(
    path: &Path,
) -> Result<Option<SessionFileObjectIdentity>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let directory = match File::open(path) {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Could not open session directory {}", path.display())
                });
            }
        };
        let metadata = directory
            .metadata()
            .with_context(|| format!("Could not inspect session directory {}", path.display()))?;
        if !metadata.is_dir() {
            bail!(
                "Session staging directory {} is not a directory.",
                path.display()
            );
        }
        Ok(Some(SessionFileObjectIdentity {
            volume_id: metadata.dev(),
            file_id: metadata.ino(),
        }))
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        use windows::core::PCWSTR;

        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Could not inspect session directory {}", path.display())
                });
            }
        };
        if !metadata.is_dir() {
            bail!(
                "Session staging directory {} is not a directory.",
                path.display()
            );
        }
        let path_wide = crate::atomic_file::windows_verbatim_path(path)?;
        let raw_handle = unsafe {
            CreateFileW(
                PCWSTR(path_wide.as_ptr()),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        }
        .with_context(|| format!("Could not open session directory {}", path.display()))?;
        let owned_handle = unsafe {
            OwnedHandle::from_raw_handle(raw_handle.0 as std::os::windows::io::RawHandle)
        };
        windows_session_object_identity_from_handle(HANDLE(owned_handle.as_raw_handle()), path)
            .map(Some)
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        bail!(
            "Stable session directory identities are unsupported on this platform for {}",
            path.display()
        )
    }
}

fn move_session_file_to_cleanup(source: &Path, cleanup: &Path) -> Result<bool> {
    if source == cleanup {
        bail!(
            "Session staging and cleanup paths must differ: {}",
            source.display()
        );
    }
    let source_exists = source
        .try_exists()
        .with_context(|| format!("Could not inspect session staging {}", source.display()))?;
    let cleanup_exists = cleanup
        .try_exists()
        .with_context(|| format!("Could not inspect session cleanup {}", cleanup.display()))?;
    if source_exists && cleanup_exists {
        bail!(
            "Both session staging {} and private cleanup {} exist; refusing ambiguous cleanup.",
            source.display(),
            cleanup.display()
        );
    }
    if cleanup_exists {
        return Ok(true);
    }
    if !source_exists {
        return Ok(false);
    }
    crate::session_ops::rename_session_file_no_replace(source, cleanup).with_context(|| {
        format!(
            "Could not quarantine session staging {} at {}",
            source.display(),
            cleanup.display()
        )
    })?;
    crate::session_ops::sync_session_file_parent(cleanup)?;
    Ok(true)
}

fn restore_session_file_from_cleanup(source: &Path, cleanup: &Path) -> Result<()> {
    crate::session_ops::rename_session_file_no_replace(cleanup, source).with_context(|| {
        format!(
            "Session cleanup found a replacement at {}; it was retained at {} because the original path could not be restored without replacement",
            cleanup.display(),
            source.display()
        )
    })?;
    crate::session_ops::sync_session_file_parent(source)?;
    Ok(())
}

/// Move first, then verify the stable object and/or completed bytes before
/// deleting. The private cleanup name is persisted before the source can be
/// created, making a crash between rename and unlink retryable.
fn cleanup_identity_bound_session_file(
    source: &Path,
    cleanup: &Path,
    expected_object_identity: Option<&SessionFileObjectIdentity>,
    expected_content_identity: Option<&SessionFileIdentity>,
) -> Result<bool> {
    if expected_object_identity.is_none() && expected_content_identity.is_none() {
        bail!(
            "Session file {} has no durable identity; refusing path-only cleanup.",
            source.display()
        );
    }
    if !move_session_file_to_cleanup(source, cleanup)? {
        return Ok(false);
    }

    let identity_matches = match (expected_object_identity, expected_content_identity) {
        (Some(expected_object), Some(expected_content)) => {
            capture_session_file_bound_identity(cleanup)?.is_some_and(|actual| {
                session_file_bound_identity_matches(
                    &actual,
                    expected_content,
                    Some(expected_object),
                )
            })
        }
        (Some(expected), None) => {
            capture_session_file_object_identity(cleanup)?.as_ref() == Some(expected)
        }
        (None, Some(expected)) => {
            capture_session_file_identity(cleanup)?.as_ref() == Some(expected)
        }
        (None, None) => unreachable!("identity authority was checked before cleanup"),
    };
    if !identity_matches {
        restore_session_file_from_cleanup(source, cleanup)?;
        bail!(
            "Session staging {} changed before cleanup; the replacement was retained.",
            source.display()
        );
    }

    std::fs::remove_file(cleanup).with_context(|| {
        format!(
            "Could not remove verified session file {}",
            cleanup.display()
        )
    })?;
    crate::session_ops::sync_session_file_parent(cleanup)?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdentityBoundDirectoryCleanup {
    Missing,
    Removed,
    RetainedReplacement,
}

/// Move the private directory out of its active name, verify the stable object
/// identity, then remove the entire workspace. An identity mismatch is not an
/// error: the unrelated replacement is restored and deliberately retained.
fn cleanup_identity_bound_session_directory(
    source: &Path,
    cleanup: &Path,
    expected_object_identity: &SessionFileObjectIdentity,
) -> Result<IdentityBoundDirectoryCleanup> {
    if !move_session_file_to_cleanup(source, cleanup)? {
        return Ok(IdentityBoundDirectoryCleanup::Missing);
    }

    if capture_session_directory_object_identity(cleanup)?.as_ref()
        != Some(expected_object_identity)
    {
        restore_session_file_from_cleanup(source, cleanup)?;
        return Ok(IdentityBoundDirectoryCleanup::RetainedReplacement);
    }

    std::fs::remove_dir_all(cleanup).with_context(|| {
        format!(
            "Could not remove verified session staging directory {}",
            cleanup.display()
        )
    })?;
    crate::session_ops::sync_session_file_parent(cleanup)?;
    Ok(IdentityBoundDirectoryCleanup::Removed)
}

#[cfg(test)]
pub(crate) fn cleanup_session_mp4_staging_directory(
    source: &Path,
    cleanup: &Path,
    expected_object_identity: &SessionFileObjectIdentity,
) -> Result<()> {
    let _ = cleanup_identity_bound_session_directory(source, cleanup, expected_object_identity)?;
    Ok(())
}

struct SessionMp4ValidationWorkspace {
    directory_path: PathBuf,
    staging_path: PathBuf,
    cleanup_path: PathBuf,
    directory_identity: SessionFileObjectIdentity,
}

fn prepare_session_mp4_validation_workspace(
    published_path: &Path,
) -> Result<SessionMp4ValidationWorkspace> {
    let parent = published_path.parent().with_context(|| {
        format!(
            "Published MP4 {} does not have a parent directory",
            published_path.display()
        )
    })?;
    let id = Uuid::new_v4();
    let directory_path = parent.join(format!(".videorc-recovery-validation-{id}.partial"));
    let cleanup_path = parent.join(format!(".videorc-recovery-validation-{id}.cleanup"));
    let staging_path = directory_path.join("export.mp4");
    #[cfg(unix)]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory_path).with_context(|| {
        format!(
            "Could not create private MP4 recovery workspace {}",
            directory_path.display()
        )
    })?;
    let prepared = (|| -> Result<SessionMp4ValidationWorkspace> {
        crate::session_ops::sync_session_file_parent(&directory_path)?;
        crate::session_ops::sync_session_file_parent(&staging_path)?;
        let directory_identity = capture_session_directory_object_identity(&directory_path)?
            .with_context(|| {
                format!(
                    "MP4 recovery workspace {} disappeared after creation",
                    directory_path.display()
                )
            })?;
        if staging_path.try_exists()? {
            bail!(
                "Private MP4 recovery staging {} unexpectedly exists",
                staging_path.display()
            );
        }
        Ok(SessionMp4ValidationWorkspace {
            directory_path: directory_path.clone(),
            staging_path,
            cleanup_path,
            directory_identity,
        })
    })();
    if prepared.is_err() {
        // Nothing owned has been written yet. `remove_dir` deliberately leaves
        // any unexpected child rather than deleting unrelated bytes.
        let _ = std::fs::remove_dir(&directory_path);
        let _ = crate::session_ops::sync_session_file_parent(&directory_path);
    }
    prepared
}

/// An identity-less operation can exist only in the tiny interval between
/// create-new and binding the open handle. It may be moved out of the managed
/// staging name, but is never adopted or deleted by path alone.
fn quarantine_unbound_session_file(source: &Path, cleanup: &Path) -> Result<bool> {
    move_session_file_to_cleanup(source, cleanup)
}

fn session_file_operation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SessionFileOperation> {
    fn identity_from_column<T: for<'de> Deserialize<'de>>(
        row: &rusqlite::Row<'_>,
        index: usize,
    ) -> rusqlite::Result<Option<T>> {
        row.get::<_, Option<String>>(index)?
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
    }

    Ok(SessionFileOperation {
        id: row.get(0)?,
        kind: row.get(1)?,
        session_id: row.get(2)?,
        staging_path: row.get(3)?,
        final_path: row.get(4)?,
        created_at: row.get(5)?,
        staging_cleanup_path: row.get(6)?,
        staging_object_identity: identity_from_column(row, 7)?,
        published_identity: identity_from_column(row, 8)?,
    })
}

fn deletion_path_state(record: &SessionDeletionPathRecord) -> Result<DeletionPathState> {
    let original_path = Path::new(&record.original_path);
    let Some(quarantine_path) = record.quarantine_path.as_deref().map(Path::new) else {
        // Legacy tombstones cannot close the backend-check/Electron-use gap.
        // Missing is complete; any existing path remains blocked for an
        // explicit migration rather than being sent to Trash unsafely.
        return Ok(match capture_session_file_identity(original_path)? {
            None => DeletionPathState::Missing,
            Some(_) => DeletionPathState::Blocked(record.original_path.clone()),
        });
    };
    let (Some(expected), Some(expected_object_identity)) =
        (record.identity.as_ref(), record.object_identity.as_ref())
    else {
        // Structured tombstones written before stable object identities were
        // introduced have the same authority as legacy string tombstones: an
        // existing path is retained for explicit resolution, never trashed by
        // sampled content alone.
        return Ok(
            match capture_session_file_bound_identity(quarantine_path)? {
                Some(_) => DeletionPathState::Blocked(quarantine_path.display().to_string()),
                None => match capture_session_file_bound_identity(original_path)? {
                    Some(_) => DeletionPathState::Blocked(record.original_path.clone()),
                    None => DeletionPathState::Missing,
                },
            },
        );
    };

    match capture_session_file_bound_identity(quarantine_path)? {
        Some(actual)
            if session_file_bound_identity_matches(
                &actual,
                expected,
                Some(expected_object_identity),
            ) =>
        {
            return Ok(DeletionPathState::Ready(
                quarantine_path.display().to_string(),
            ));
        }
        Some(_) => {
            return match crate::session_ops::rename_session_file_no_replace(
                quarantine_path,
                original_path,
            ) {
                Ok(()) => {
                    crate::session_ops::sync_session_file_parent(original_path)?;
                    Ok(DeletionPathState::Missing)
                }
                Err(_) => Ok(DeletionPathState::Blocked(
                    quarantine_path.display().to_string(),
                )),
            };
        }
        None => {}
    }

    // Move first, verify second. Checking the original path and then renaming
    // it lets a replacement race into the checked name and be sent to Trash.
    match crate::session_ops::rename_session_file_no_replace(original_path, quarantine_path) {
        Ok(()) => {
            crate::session_ops::sync_session_file_parent(quarantine_path)?;
            match capture_session_file_bound_identity(quarantine_path)? {
                Some(actual)
                    if session_file_bound_identity_matches(
                        &actual,
                        expected,
                        Some(expected_object_identity),
                    ) =>
                {
                    Ok(DeletionPathState::Ready(
                        quarantine_path.display().to_string(),
                    ))
                }
                Some(_) => {
                    match crate::session_ops::rename_session_file_no_replace(
                        quarantine_path,
                        original_path,
                    ) {
                        Ok(()) => {
                            crate::session_ops::sync_session_file_parent(original_path)?;
                            Ok(DeletionPathState::Missing)
                        }
                        Err(_) => Ok(DeletionPathState::Blocked(
                            quarantine_path.display().to_string(),
                        )),
                    }
                }
                None => Ok(DeletionPathState::Missing),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DeletionPathState::Missing)
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                || matches!(error.raw_os_error(), Some(17 | 80 | 183)) =>
        {
            match capture_session_file_bound_identity(quarantine_path)? {
                Some(actual)
                    if session_file_bound_identity_matches(
                        &actual,
                        expected,
                        Some(expected_object_identity),
                    ) =>
                {
                    Ok(DeletionPathState::Ready(
                        quarantine_path.display().to_string(),
                    ))
                }
                Some(_) => Ok(DeletionPathState::Blocked(
                    quarantine_path.display().to_string(),
                )),
                None => Err(error).with_context(|| {
                    format!(
                        "Could not quarantine session file {}",
                        original_path.display()
                    )
                }),
            }
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "Could not quarantine session file {}",
                original_path.display()
            )
        }),
    }
}

fn session_deletion_quarantine_path(
    original_path: &Path,
    operation_id: &str,
    index: usize,
) -> PathBuf {
    original_path.with_file_name(format!(".videorc-trash-{operation_id}-{index}"))
}

fn distinct_nonempty_paths<const N: usize>(paths: [Option<String>; N]) -> Vec<String> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .flatten()
        .filter(|path| !path.trim().is_empty())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)
            .with_context(|| format!("Could not open {} for sync", directory.display()))?
            .sync_all()
            .with_context(|| format!("Could not sync {}", directory.display()))?;
    }
    // On Windows, publication uses filesystem APIs whose namespace updates are
    // durable with the file handle flush; std cannot open directories for
    // FlushFileBuffers portably.
    Ok(())
}

impl Database {
    pub fn open_default() -> Result<Self> {
        let path = default_database_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Could not create {}", parent.display()))?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("Could not open SQLite database {}", path.display()))?;
        let database = Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
        };
        database.migrate()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn open_in_memory_for_tests() -> Self {
        let database = Self {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            path: PathBuf::from(":memory:"),
        };
        database.migrate().unwrap();
        database
    }

    #[cfg(test)]
    pub fn open_file_for_tests(path: &Path) -> Self {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let database = Self {
            conn: Arc::new(Mutex::new(Connection::open(path).unwrap())),
            path: path.to_path_buf(),
        };
        database.migrate().unwrap();
        database
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn create_session(&self, session: &NewSession) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO sessions (
                id, title, started_at, status, mode, output_path, container, stream_preset,
                sources_json, layout_json, output_json
            ) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                session.id,
                session.title,
                session.started_at,
                session.mode,
                session.output_path,
                session.container,
                session.stream_preset,
                serde_json::to_string(&session.sources)?,
                serde_json::to_string(&session.layout)?,
                serde_json::to_string(&session.output)?,
            ],
        )?;
        Ok(())
    }

    /// Insert an imported session directly in its truthful terminal state.
    /// Imports already have a complete media file; exposing a transient
    /// `running` row would make a crash between create/finalize indistinguishable
    /// from an interrupted capture.
    pub fn create_completed_session(
        &self,
        session: &NewSession,
        ended_at: &str,
        mp4_path: Option<&str>,
        duration_ms: Option<i64>,
        file_size_bytes: Option<i64>,
    ) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO sessions (
                id, title, started_at, ended_at, status, mode, output_path, mp4_path,
                container, stream_preset, duration_ms, sources_json, layout_json,
                output_json, file_size_bytes
             ) VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                session.id,
                session.title,
                session.started_at,
                ended_at,
                session.mode,
                session.output_path,
                mp4_path,
                session.container,
                session.stream_preset,
                duration_ms,
                serde_json::to_string(&session.sources)?,
                serde_json::to_string(&session.layout)?,
                serde_json::to_string(&session.output)?,
                file_size_bytes,
            ],
        )?;
        Ok(())
    }

    /// Fake chat is an explicit test/smoke transport. Give it a real session
    /// row so inbound comments and outbound operations exercise the same
    /// SQLite foreign-key/persistence path as production sessions.
    pub fn ensure_fake_live_chat_session(&self, session_id: &str) -> Result<()> {
        if self
            .lock()?
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1",
                params![session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Ok(());
        }
        self.create_session(&NewSession {
            id: session_id.to_string(),
            title: "Comments smoke session".to_string(),
            started_at: Utc::now().to_rfc3339(),
            mode: "stream".to_string(),
            output_path: None,
            container: None,
            stream_preset: Some("stream-safe-1080p30".to_string()),
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: crate::protocol::default_layout_settings(),
            output: OutputSettings {
                record_enabled: false,
                stream_enabled: true,
                output_directory: None,
                ffmpeg_path: None,
                video: crate::protocol::VideoSettings {
                    preset: crate::protocol::VideoPreset::StreamSafe1080p30,
                    width: 1920,
                    height: 1080,
                    fps: 30,
                    bitrate_kbps: 6_000,
                },
                rtmp: crate::protocol::RtmpSettings {
                    preset: crate::protocol::RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        })
    }

    pub fn finish_session(
        &self,
        session_id: &str,
        status: &str,
        ended_at: Option<String>,
        mp4_path: Option<String>,
        duration_ms: Option<i64>,
    ) -> Result<()> {
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE sessions
             SET status = ?2,
                 ended_at = COALESCE(?3, ended_at),
                 mp4_path = COALESCE(?4, mp4_path),
                 duration_ms = COALESCE(?5, duration_ms)
             WHERE id = ?1",
            params![session_id, status, ended_at, mp4_path, duration_ms],
        )?;
        if updated != 1 {
            bail!(
                "Session {session_id} could not be finalized because its database row is missing."
            );
        }
        Ok(())
    }

    /// Commit terminal session metadata and diagnostics as one truthful unit.
    /// A media artifact is not reported as fully finalized unless exactly one
    /// session row received every terminal field.
    pub fn finalize_session_with_diagnostics(
        &self,
        finalization: &SessionFinalization,
    ) -> Result<()> {
        self.finalize_session_with_diagnostics_recovery(finalization, None)
    }

    fn finalize_session_with_diagnostics_recovery(
        &self,
        finalization: &SessionFinalization,
        clear_mp4_path_if_matches: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let updated = transaction.execute(
            "UPDATE sessions
             SET status = ?2,
                 ended_at = COALESCE(?3, ended_at),
                 mp4_path = CASE
                     WHEN ?7 IS NOT NULL AND mp4_path = ?7 THEN NULL
                     ELSE COALESCE(?4, mp4_path)
                 END,
                 duration_ms = COALESCE(?5, duration_ms),
                 diagnostics_json = ?6
             WHERE id = ?1",
            params![
                finalization.session_id,
                finalization.status,
                finalization.ended_at,
                finalization.mp4_path,
                finalization.duration_ms,
                finalization.diagnostics_json,
                clear_mp4_path_if_matches,
            ],
        )?;
        if updated != 1 {
            bail!(
                "Session {} could not be finalized because its database row is missing.",
                finalization.session_id
            );
        }
        transaction.commit()?;
        Ok(())
    }

    /// Persist enough terminal metadata outside SQLite to retry after an I/O,
    /// lock, or corruption failure. The file is removed only after a later
    /// transactional database commit succeeds.
    pub fn persist_session_finalization_recovery(
        &self,
        finalization: &SessionFinalization,
    ) -> Result<PathBuf> {
        let directory = self.session_finalization_recovery_directory();
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("Could not create {}", directory.display()))?;
        let safe_session_id: String = finalization
            .session_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        let recovery_id = Uuid::new_v4();
        let path = directory.join(format!("{safe_session_id}-{recovery_id}.json"));
        let temporary_path = directory.join(format!(".{safe_session_id}-{recovery_id}.tmp"));
        let bytes = serde_json::to_vec_pretty(finalization)?;
        let mut temporary = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .with_context(|| format!("Could not create {}", temporary_path.display()))?;
        temporary
            .write_all(&bytes)
            .with_context(|| format!("Could not write {}", temporary_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))?;
        }
        temporary
            .sync_all()
            .with_context(|| format!("Could not sync {}", temporary_path.display()))?;
        drop(temporary);
        crate::session_ops::rename_session_file_no_replace(&temporary_path, &path).with_context(
            || {
                format!(
                    "Could not atomically publish session recovery {}",
                    path.display()
                )
            },
        )?;
        sync_directory(&directory)?;
        Ok(path)
    }

    /// Atomically advance one write-ahead record (for example from
    /// pre-FFmpeg ownership to exact completed bytes) without a gap where
    /// neither intent is durable.
    pub fn replace_session_finalization_recovery(
        &self,
        path: &Path,
        finalization: &SessionFinalization,
    ) -> Result<()> {
        let directory = self.session_finalization_recovery_directory();
        if path.parent() != Some(directory.as_path()) {
            bail!(
                "Session recovery path {} is outside {}",
                path.display(),
                directory.display()
            );
        }
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .context("Session recovery path has no UTF-8 file name")?;
        let temporary_path = directory.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(finalization)?;
        let mut temporary = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .with_context(|| format!("Could not create {}", temporary_path.display()))?;
        temporary
            .write_all(&bytes)
            .with_context(|| format!("Could not write {}", temporary_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))?;
        }
        temporary
            .sync_all()
            .with_context(|| format!("Could not sync {}", temporary_path.display()))?;
        drop(temporary);
        if let Err(error) = crate::atomic_file::replace_file(&temporary_path, path) {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(error).with_context(|| {
                format!("Could not atomically update recovery {}", path.display())
            });
        }
        sync_directory(&directory)?;
        Ok(())
    }

    pub fn clear_session_finalization_recovery(&self, path: &Path) -> Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| format!("Could not remove {}", path.display()));
            }
        }
        if let Some(directory) = path.parent() {
            sync_directory(directory)?;
        }
        Ok(())
    }

    pub fn cleanup_session_finalization_mp4_staging(
        &self,
        finalization: &SessionFinalization,
    ) -> Result<()> {
        if let Some(directory_path) = finalization
            .mp4_staging_directory_path
            .as_deref()
            .map(Path::new)
        {
            let cleanup_path = finalization
                .mp4_staging_directory_cleanup_path
                .as_deref()
                .map(Path::new)
                .context("MP4 staging directory is missing its durable cleanup path")?;
            if let Some(staging_path) = finalization.mp4_staging_path.as_deref().map(Path::new)
                && staging_path.parent() != Some(directory_path)
            {
                bail!(
                    "MP4 staging file {} is outside its owned directory {}",
                    staging_path.display(),
                    directory_path.display()
                );
            }
            let Some(expected_directory_identity) =
                finalization.mp4_staging_directory_object_identity.as_ref()
            else {
                // Planned records are durable before the directory exists or
                // has an identity. FFmpeg cannot start in this phase, so only
                // an empty directory is safe to remove by path. Any child is
                // unrelated/ambiguous and is deliberately retained.
                match std::fs::remove_dir(directory_path) {
                    Ok(()) => crate::session_ops::sync_session_file_parent(directory_path)?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error)
                        if error.kind() == std::io::ErrorKind::DirectoryNotEmpty
                            || matches!(error.raw_os_error(), Some(39 | 145)) => {}
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!(
                                "Could not remove empty planned MP4 workspace {}",
                                directory_path.display()
                            )
                        });
                    }
                }
                return Ok(());
            };
            let _ = cleanup_identity_bound_session_directory(
                directory_path,
                cleanup_path,
                expected_directory_identity,
            )?;
            return Ok(());
        }

        let Some(staging_path) = finalization.mp4_staging_path.as_deref().map(Path::new) else {
            return Ok(());
        };
        let Some(expected_object_identity) = finalization.mp4_staging_object_identity.as_ref()
        else {
            // Legacy recovery intents cannot safely remove staging by path.
            return Ok(());
        };
        let cleanup_path = finalization
            .mp4_staging_cleanup_path
            .as_deref()
            .map(Path::new)
            .context("MP4 staging ownership is missing its durable cleanup path")?;
        cleanup_identity_bound_session_file(
            staging_path,
            cleanup_path,
            Some(expected_object_identity),
            finalization.mp4_identity.as_ref(),
        )?;
        Ok(())
    }

    /// Resolve only identity-bound media from a write-ahead finalization
    /// record. A path match alone is never enough: the user may have replaced
    /// either the private staging file or the published MP4 after a crash.
    fn resolve_session_finalization_media(
        &self,
        recovery_path: &Path,
        finalization: &SessionFinalization,
    ) -> Result<(SessionFinalization, Option<String>)> {
        let managed_intent = finalization.output_path.is_some()
            || finalization.mp4_staging_path.is_some()
            || finalization.mp4_identity.is_some();
        if !managed_intent {
            // Backward compatibility for recovery records written before media
            // identities were introduced. They retain the old DB-only replay
            // behavior and never perform source cleanup.
            return Ok((finalization.clone(), None));
        }

        let mut resolved = finalization.clone();
        let Some(expected_identity) = finalization.mp4_identity.as_ref() else {
            self.cleanup_session_finalization_mp4_staging(finalization)?;
            resolved.mp4_path = None;
            resolved.remove_output_after_commit = false;
            return Ok((resolved, None));
        };
        let Some(mp4_path) = finalization.mp4_path.as_deref() else {
            resolved.remove_output_after_commit = false;
            return Ok((resolved, None));
        };
        let mp4_path = PathBuf::from(mp4_path);
        let Some(initial_staging_path) =
            finalization.mp4_staging_path.as_deref().map(PathBuf::from)
        else {
            resolved.mp4_path = None;
            resolved.remove_output_after_commit = false;
            return Ok((resolved, finalization.mp4_path.clone()));
        };
        let mut staging_path = initial_staging_path;
        if let (Some(directory_path), Some(expected_directory_identity)) = (
            finalization
                .mp4_staging_directory_path
                .as_deref()
                .map(Path::new),
            finalization.mp4_staging_directory_object_identity.as_ref(),
        ) && capture_session_directory_object_identity(directory_path)?.as_ref()
            != Some(expected_directory_identity)
        {
            if !mp4_path
                .try_exists()
                .with_context(|| format!("Could not inspect MP4 {}", mp4_path.display()))?
            {
                // No candidate remains to validate. Preserve any unrelated
                // replacement workspace and fall back to the MKV.
                resolved.mp4_path = None;
                resolved.remove_output_after_commit = false;
                return Ok((resolved, finalization.mp4_path.clone()));
            }
            if let Some(cleanup_path) = finalization
                .mp4_staging_directory_cleanup_path
                .as_deref()
                .map(Path::new)
            {
                // A prior crash may have moved the owned empty workspace to
                // its cleanup name. Retire it before rebinding the journal;
                // mismatched replacements are restored and retained.
                let _ = cleanup_identity_bound_session_directory(
                    directory_path,
                    cleanup_path,
                    expected_directory_identity,
                )?;
            }
            let workspace = prepare_session_mp4_validation_workspace(&mp4_path)?;
            resolved.mp4_staging_path = Some(workspace.staging_path.display().to_string());
            resolved.mp4_staging_directory_path =
                Some(workspace.directory_path.display().to_string());
            resolved.mp4_staging_directory_object_identity =
                Some(workspace.directory_identity.clone());
            resolved.mp4_staging_directory_cleanup_path =
                Some(workspace.cleanup_path.display().to_string());
            if let Err(error) = self.replace_session_finalization_recovery(recovery_path, &resolved)
            {
                let _ = cleanup_identity_bound_session_directory(
                    &workspace.directory_path,
                    &workspace.cleanup_path,
                    &workspace.directory_identity,
                );
                return Err(error).context(
                    "Could not persist replacement MP4 validation workspace before publication",
                );
            }
            staging_path = workspace.staging_path;
        }
        let mut staged_from_published_path = false;
        if mp4_path
            .try_exists()
            .with_context(|| format!("Could not inspect MP4 {}", mp4_path.display()))?
        {
            if staging_path.try_exists().with_context(|| {
                format!("Could not inspect MP4 staging {}", staging_path.display())
            })? {
                // The publication intent is written before the no-replace
                // rename. If its candidate already existed, a crash in that
                // window leaves both paths. The candidate is unrelated by
                // construction; discard only the identity-owned workspace,
                // retain the MKV, and allow the recovery record to retire.
                self.cleanup_session_finalization_mp4_staging(finalization)?;
                resolved.mp4_path = None;
                resolved.remove_output_after_commit = false;
                resolved.mp4_staging_path = None;
                resolved.mp4_staging_object_identity = None;
                resolved.mp4_staging_cleanup_path = None;
                resolved.mp4_staging_directory_path = None;
                resolved.mp4_staging_directory_object_identity = None;
                resolved.mp4_staging_directory_cleanup_path = None;
                return Ok((resolved, None));
            }
            // Re-enter the private staging name before validation. This closes
            // the existing-final check/use gap just like first-time publish.
            crate::session_ops::rename_session_file_no_replace(&mp4_path, &staging_path)
                .with_context(|| {
                    format!(
                        "Could not move published MP4 {} back to private validation staging",
                        mp4_path.display()
                    )
                })?;
            crate::session_ops::sync_session_file_parent(&staging_path)?;
            staged_from_published_path = true;
        }
        // Move first, verify second. A pre-move identity check can race with a
        // staging replacement and publish the replacement as session media.
        match crate::session_ops::rename_session_file_no_replace(&staging_path, &mp4_path) {
            Ok(()) => {
                crate::session_ops::sync_session_file_parent(&mp4_path)?;
                let object_identity_matches = match finalization
                    .mp4_staging_object_identity
                    .as_ref()
                {
                    Some(expected) => {
                        capture_session_file_object_identity(&mp4_path)?.as_ref() == Some(expected)
                    }
                    None => true,
                };
                match capture_session_file_identity(&mp4_path)? {
                    Some(actual) if &actual == expected_identity && object_identity_matches => {
                        Ok((resolved, None))
                    }
                    Some(_) => {
                        if !staged_from_published_path
                            && crate::session_ops::rename_session_file_no_replace(
                                &mp4_path,
                                &staging_path,
                            )
                            .is_ok()
                        {
                            let _ = crate::session_ops::sync_session_file_parent(&staging_path);
                        }
                        resolved.mp4_path = None;
                        resolved.remove_output_after_commit = false;
                        Ok((resolved, finalization.mp4_path.clone()))
                    }
                    None => {
                        resolved.mp4_path = None;
                        resolved.remove_output_after_commit = false;
                        Ok((resolved, finalization.mp4_path.clone()))
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                resolved.mp4_path = None;
                resolved.remove_output_after_commit = false;
                Ok((resolved, finalization.mp4_path.clone()))
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    || matches!(error.raw_os_error(), Some(17 | 80 | 183)) =>
            {
                Err(error).with_context(|| {
                    format!(
                        "MP4 {} was replaced while private staging was being published; retained staging for recovery",
                        mp4_path.display()
                    )
                })
            }
            Err(error) => Err(error)
                .with_context(|| format!("Could not publish recovered MP4 {}", mp4_path.display())),
        }
    }

    /// Remove the original MKV only after SQLite owns the identity-matched MP4.
    /// Cleanup moves to a private persisted name first; a mismatched move is
    /// restored no-replace or retained for recovery, never deleted.
    pub fn cleanup_session_finalization_source(
        &self,
        finalization: &SessionFinalization,
    ) -> Result<()> {
        if !finalization.remove_output_after_commit || finalization.mp4_path.is_none() {
            return Ok(());
        }
        let Some(output_path) = finalization.output_path.as_deref().map(Path::new) else {
            return Ok(());
        };
        let cleanup_path = finalization
            .output_cleanup_path
            .as_deref()
            .map(Path::new)
            .context("Finalized MKV cleanup path was not persisted before cleanup")?;
        let (Some(expected_identity), Some(expected_object_identity)) = (
            finalization.output_identity.as_ref(),
            finalization.output_object_identity.as_ref(),
        ) else {
            // Legacy records never bound the MKV to a stable filesystem
            // object. Never delete from sampled bytes alone. If a prior
            // version already moved the MKV to its persisted cleanup name,
            // restore it no-replace so the retained recovery stays visible.
            let output_exists = output_path.try_exists().with_context(|| {
                format!("Could not inspect finalized MKV {}", output_path.display())
            })?;
            let cleanup_exists = cleanup_path.try_exists().with_context(|| {
                format!("Could not inspect cleanup path {}", cleanup_path.display())
            })?;
            if output_exists && cleanup_exists {
                bail!(
                    "Legacy finalized MKV exists at both {} and {}; refusing ambiguous recovery.",
                    output_path.display(),
                    cleanup_path.display()
                );
            }
            if cleanup_exists {
                restore_session_file_from_cleanup(output_path, cleanup_path)?;
            }
            return Ok(());
        };

        // Move first, verify second. Checking and then removing `output_path`
        // can delete a replacement raced into that name. The cleanup path is
        // private, same-directory, unguessable, and persisted in new intents.
        if !cleanup_path
            .try_exists()
            .with_context(|| format!("Could not inspect cleanup path {}", cleanup_path.display()))?
        {
            match crate::session_ops::rename_session_file_no_replace(output_path, cleanup_path) {
                Ok(()) => crate::session_ops::sync_session_file_parent(cleanup_path)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        || matches!(error.raw_os_error(), Some(17 | 80 | 183)) => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "Could not quarantine finalized MKV {}",
                            output_path.display()
                        )
                    });
                }
            }
        }

        match capture_session_file_bound_identity(cleanup_path)? {
            Some(actual)
                if session_file_bound_identity_matches(
                    &actual,
                    expected_identity,
                    Some(expected_object_identity),
                ) =>
            {
                std::fs::remove_file(cleanup_path).with_context(|| {
                    format!(
                        "Could not remove verified finalized MKV {}",
                        cleanup_path.display()
                    )
                })?;
                if let Some(parent) = cleanup_path.parent() {
                    sync_directory(parent)?;
                }
            }
            Some(_) => {
                crate::session_ops::rename_session_file_no_replace(cleanup_path, output_path)
                    .with_context(|| {
                        format!(
                            "Finalized MKV cleanup found a replacement at {}; it was retained at {} because the original path could not be restored without replacement",
                            cleanup_path.display(),
                            output_path.display()
                        )
                    })?;
                crate::session_ops::sync_session_file_parent(output_path)?;
            }
            None => {}
        }
        Ok(())
    }

    fn persist_missing_session_finalization_cleanup_path(
        &self,
        recovery_path: &Path,
        finalization: &SessionFinalization,
    ) -> Result<SessionFinalization> {
        if !finalization.remove_output_after_commit
            || finalization.mp4_path.is_none()
            || finalization.output_identity.is_none()
            || finalization.output_cleanup_path.is_some()
        {
            return Ok(finalization.clone());
        }
        let Some(output_path) = finalization.output_path.as_deref().map(Path::new) else {
            return Ok(finalization.clone());
        };
        let mut updated = finalization.clone();
        updated.output_cleanup_path = Some(
            output_path
                .with_file_name(format!(".videorc-finalize-cleanup-{}", Uuid::new_v4()))
                .display()
                .to_string(),
        );
        // This replacement is the write-ahead edge for legacy records. A
        // crash after the later rename can always rediscover the same private
        // MKV path instead of generating a new, orphaning name.
        self.replace_session_finalization_recovery(recovery_path, &updated)?;
        Ok(updated)
    }

    pub fn reconcile_session_finalization_recoveries(
        &self,
    ) -> Result<SessionFinalizationRecoverySummary> {
        let directory = self.session_finalization_recovery_directory();
        if !directory
            .try_exists()
            .with_context(|| format!("Could not inspect {}", directory.display()))?
        {
            return Ok(SessionFinalizationRecoverySummary::default());
        }

        let mut summary = SessionFinalizationRecoverySummary::default();
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let result = (|| -> Result<()> {
                let bytes = std::fs::read(&path)
                    .with_context(|| format!("Could not read {}", path.display()))?;
                let finalization: SessionFinalization = serde_json::from_slice(&bytes)
                    .with_context(|| format!("Could not parse {}", path.display()))?;
                let (resolved, clear_mp4_path_if_matches) =
                    self.resolve_session_finalization_media(&path, &finalization)?;
                let resolved =
                    self.persist_missing_session_finalization_cleanup_path(&path, &resolved)?;
                self.finalize_session_with_diagnostics_recovery(
                    &resolved,
                    clear_mp4_path_if_matches.as_deref(),
                )?;
                self.cleanup_session_finalization_source(&resolved)?;
                self.cleanup_session_finalization_mp4_staging(&resolved)?;
                self.clear_session_finalization_recovery(&path)?;
                Ok(())
            })();
            match result {
                Ok(()) => summary.recovered = summary.recovered.saturating_add(1),
                Err(error) => {
                    summary.pending = summary.pending.saturating_add(1);
                    summary
                        .errors
                        .push(format!("{}: {error:#}", path.display()));
                }
            }
        }
        Ok(summary)
    }

    fn session_finalization_recovery_directory(&self) -> PathBuf {
        if self.path == Path::new(":memory:") {
            return std::env::temp_dir().join(format!(
                "videorc-session-finalization-recovery-{}",
                std::process::id()
            ));
        }
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("session-finalization-recovery")
    }

    /// A freshly-started backend cannot have running sessions: any 'running'
    /// rows are orphans from a crash or a start that never reached a live
    /// pipeline (F-014/F-017). Flip them to failed so the Library stops
    /// claiming a recording is in flight.
    pub fn reconcile_orphaned_sessions(&self) -> Result<usize> {
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE sessions
             SET status = 'failed',
                 ended_at = COALESCE(ended_at, ?1)
             WHERE status = 'running'",
            params![Utc::now().to_rfc3339()],
        )?;
        Ok(updated)
    }

    pub fn session_recording_path(&self, session_id: &str) -> Result<Option<String>> {
        let conn = self.lock()?;
        let path = conn
            .query_row(
                "SELECT output_path FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(path)
    }

    /// Snapshot the terminal fields that a manual remux must preserve while it
    /// advances only the session's MP4 path. Keeping the existing diagnostics
    /// in the recovery record prevents a later crash replay from substituting
    /// the current studio's diagnostics for an older recording.
    pub fn session_finalization_snapshot(&self, session_id: &str) -> Result<SessionFinalization> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT status, ended_at, mp4_path, duration_ms, COALESCE(diagnostics_json, '{}')
             FROM sessions
             WHERE id = ?1",
            params![session_id],
            |row| {
                Ok(SessionFinalization {
                    session_id: session_id.to_string(),
                    status: row.get(0)?,
                    ended_at: row.get(1)?,
                    mp4_path: row.get(2)?,
                    duration_ms: row.get(3)?,
                    diagnostics_json: row.get(4)?,
                    output_path: None,
                    output_identity: None,
                    output_object_identity: None,
                    mp4_staging_path: None,
                    mp4_identity: None,
                    mp4_staging_object_identity: None,
                    mp4_staging_cleanup_path: None,
                    mp4_staging_directory_path: None,
                    mp4_staging_directory_object_identity: None,
                    mp4_staging_directory_cleanup_path: None,
                    remove_output_after_commit: false,
                    output_cleanup_path: None,
                })
            },
        )
        .optional()?
        .with_context(|| format!("Session {session_id} does not exist"))
    }

    #[cfg(test)]
    pub fn save_session_diagnostics(
        &self,
        session_id: &str,
        diagnostics: &DiagnosticStats,
    ) -> Result<()> {
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE sessions
             SET diagnostics_json = ?2
             WHERE id = ?1",
            params![session_id, serde_json::to_string(diagnostics)?],
        )?;
        if updated != 1 {
            bail!(
                "Session {session_id} diagnostics could not be saved because its row is missing."
            );
        }
        Ok(())
    }

    /// Every recorded media path for a session, in preference order (mp4 export
    /// first, then the original container). Callers that hand a path to FFmpeg
    /// must pick the first one that still EXISTS on disk — the DB records where
    /// files were written, not whether the user has since moved or deleted them.
    pub fn session_media_candidates(&self, session_id: &str) -> Result<Vec<String>> {
        let conn = self.lock()?;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT mp4_path, output_path FROM sessions WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((mp4_path, output_path)) = row else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();
        for path in [mp4_path, output_path].into_iter().flatten() {
            if !path.trim().is_empty() && !candidates.contains(&path) {
                candidates.push(path);
            }
        }
        Ok(candidates)
    }

    pub(crate) fn noise_cleanup_source(
        &self,
        session_id: &str,
    ) -> Result<Option<NoiseCleanupSource>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT id, title, status, mode, mp4_path, output_path, container,
                    sources_json, derived_from_session_id, processing_kind
             FROM sessions WHERE id = ?1 AND library_hidden = 0",
                params![session_id],
                |row| {
                    let sources_json: String = row.get(7)?;
                    let sources = serde_json::from_str(&sources_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            7,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        sources,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(
            |(
                id,
                title,
                status,
                mode,
                mp4_path,
                output_path,
                container,
                sources,
                derived_from_session_id,
                processing_kind,
            )| {
                let media_path = [mp4_path, output_path]
                    .into_iter()
                    .flatten()
                    .find(|path| Path::new(path).is_file());
                NoiseCleanupSource {
                    id,
                    title,
                    status,
                    mode,
                    media_path,
                    container,
                    sources,
                    derived_from_session_id,
                    processing_kind,
                }
            },
        ))
    }

    /// Return active work or create a queued job immediately using only the fast
    /// bound identity. The worker computes the full-file fingerprint off Tokio,
    /// then resolves completed-result idempotency before FFmpeg starts.
    pub(crate) fn create_or_get_noise_cleanup_job(
        &self,
        source_session_id: &str,
        source_identity: &SessionFileBoundIdentity,
        preset: &str,
    ) -> Result<PersistedNoiseCleanupJob> {
        let source_identity_json = serde_json::to_string(&source_identity.content_identity)?;
        let source_object_identity_json = serde_json::to_string(&source_identity.object_identity)?;
        let now = Utc::now().to_rfc3339();
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        if let Some(existing) = query_one_noise_cleanup_job(
            &transaction,
            "WHERE source_session_id = ?1 AND status IN ('queued', 'processing', 'validating') ORDER BY created_at ASC LIMIT 1",
            params![source_session_id],
        )? {
            transaction.commit()?;
            return Ok(existing);
        }
        if let Some(completed) = query_one_noise_cleanup_job(
            &transaction,
            "WHERE source_session_id = ?1 AND source_identity_json = ?2
                    AND source_object_identity_json = ?3 AND preset = ?4
                    AND status = 'completed'
             ORDER BY updated_at DESC, id DESC LIMIT 1",
            params![
                source_session_id,
                source_identity_json,
                source_object_identity_json,
                preset
            ],
        )? {
            let output_state = completed
                .job
                .output_path
                .as_deref()
                .map(|path| session_media_path_state(Path::new(path)))
                .unwrap_or(SessionMediaPathState::Missing);
            let session_exists =
                completed
                    .job
                    .output_session_id
                    .as_deref()
                    .is_some_and(|session_id| {
                        transaction
                            .query_row(
                                "SELECT 1 FROM sessions WHERE id = ?1",
                                params![session_id],
                                |_| Ok(()),
                            )
                            .optional()
                            .ok()
                            .flatten()
                            .is_some()
                    });
            if session_exists
                && matches!(
                    output_state,
                    SessionMediaPathState::Present | SessionMediaPathState::Unavailable
                )
            {
                transaction.commit()?;
                return Ok(completed);
            }
            transaction.execute(
                "UPDATE noise_cleanup_jobs
                 SET status = 'failed', progress_percent = 0, error_code = 'file-missing',
                     error_message = 'The cleaned recording is missing or unregistered.',
                     updated_at = ?2
                 WHERE id = ?1",
                params![completed.job.id, now],
            )?;
        }
        let id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO noise_cleanup_jobs
                (id, source_session_id, source_identity_json, source_object_identity_json,
                 source_full_sha256, status, progress_percent, preset,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', 'queued', 0, ?5, ?6, ?6)",
            params![
                id,
                source_session_id,
                source_identity_json,
                source_object_identity_json,
                preset,
                now
            ],
        )?;
        let job = query_one_noise_cleanup_job(&transaction, "WHERE id = ?1", params![id])?
            .context("New Noise Cleanup job disappeared")?;
        transaction.commit()?;
        Ok(job)
    }

    /// Bind the slow full-file fingerprint, returning an existing validated
    /// result for the exact content + filesystem object + preset when present.
    pub(crate) fn bind_noise_cleanup_source_fingerprint(
        &self,
        job_id: &str,
        source_full_sha256: &str,
    ) -> Result<Option<NoiseCleanupJob>> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let updated = transaction.execute(
            "UPDATE noise_cleanup_jobs SET source_full_sha256 = ?2, updated_at = ?3
             WHERE id = ?1 AND status = 'queued'",
            params![job_id, source_full_sha256, Utc::now().to_rfc3339()],
        )?;
        if updated != 1 {
            bail!("Noise Cleanup job {job_id} was no longer queued for fingerprinting.");
        }
        let current = query_one_noise_cleanup_job(&transaction, "WHERE id = ?1", params![job_id])?
            .context("Fingerprint-bound Noise Cleanup job disappeared")?;
        let completed = query_one_noise_cleanup_job(
            &transaction,
            "WHERE id <> ?1 AND source_session_id = ?2 AND source_identity_json = ?3
                    AND source_object_identity_json = ?4 AND source_full_sha256 = ?5
                    AND preset = ?6 AND status = 'completed'
             ORDER BY updated_at DESC LIMIT 1",
            params![
                job_id,
                current.job.source_session_id,
                serde_json::to_string(&current.source_identity.content_identity)?,
                serde_json::to_string(&current.source_identity.object_identity)?,
                source_full_sha256,
                current.job.preset,
            ],
        )?
        .map(|job| job.job);
        transaction.commit()?;
        Ok(completed)
    }

    pub(crate) fn noise_cleanup_job(
        &self,
        job_id: &str,
    ) -> Result<Option<PersistedNoiseCleanupJob>> {
        let conn = self.lock()?;
        query_one_noise_cleanup_job(&conn, "WHERE id = ?1", params![job_id])
    }

    pub(crate) fn list_noise_cleanup_jobs(&self) -> Result<Vec<NoiseCleanupJob>> {
        let conn = self.lock()?;
        let mut jobs = query_noise_cleanup_jobs(
            &conn,
            "WHERE status IN ('queued', 'processing', 'validating')
             ORDER BY updated_at DESC, id DESC LIMIT ?1",
            params![MAX_NOISE_CLEANUP_JOB_LIST as i64],
        )?;
        let remaining = MAX_NOISE_CLEANUP_JOB_LIST.saturating_sub(jobs.len());
        if remaining > 0 {
            jobs.extend(query_noise_cleanup_jobs(
                &conn,
                "WHERE id IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY source_session_id
                            ORDER BY updated_at DESC, id DESC
                        ) AS source_rank
                        FROM noise_cleanup_jobs
                        WHERE status NOT IN ('queued', 'processing', 'validating')
                    ) WHERE source_rank = 1
                 ) ORDER BY updated_at DESC, id DESC LIMIT ?1",
                params![remaining as i64],
            )?);
        }
        let mut source_paths_cache: HashMap<String, Vec<String>> = HashMap::new();
        for persisted in &jobs {
            if persisted.job.status != NoiseCleanupJobStatus::Completed
                || source_paths_cache.contains_key(&persisted.job.source_session_id)
            {
                continue;
            }
            let source_paths: Option<(Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT mp4_path, output_path FROM sessions WHERE id = ?1",
                    params![persisted.job.source_session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            source_paths_cache.insert(
                persisted.job.source_session_id.clone(),
                source_paths
                    .into_iter()
                    .flat_map(|(mp4, output)| [mp4, output])
                    .flatten()
                    .collect(),
            );
        }
        drop(conn);

        let now = Utc::now().to_rfc3339();
        for persisted in &mut jobs {
            if persisted.job.status != NoiseCleanupJobStatus::Completed {
                continue;
            }
            let output_state = persisted
                .job
                .output_path
                .as_deref()
                .map(|path| session_media_path_state(Path::new(path)))
                .unwrap_or(SessionMediaPathState::Missing);
            if output_state == SessionMediaPathState::Unavailable {
                continue;
            }
            let output_missing = output_state == SessionMediaPathState::Missing;
            // Metadata/object checks deliberately happen outside the DB mutex
            // and never sample large media bodies during bootstrap.
            let mut source_matches = false;
            let mut source_unavailable = false;
            if let Some(paths) = source_paths_cache.get(&persisted.job.source_session_id) {
                for path in paths {
                    match session_file_quick_identity_matches(
                        Path::new(path),
                        &persisted.source_identity,
                    ) {
                        Ok(true) => source_matches = true,
                        Ok(false) => {}
                        Err(_) => source_unavailable = true,
                    }
                }
            }
            if !output_missing && !source_matches && source_unavailable {
                continue;
            }
            let source_changed = !source_matches;
            if output_missing || source_changed {
                let code = if output_missing {
                    "file-missing"
                } else {
                    "source-changed"
                };
                let message = if output_missing {
                    "The cleaned recording is missing on disk."
                } else {
                    "The source recording changed after this cleanup completed."
                };
                let mut conn = self.lock()?;
                let transaction = conn.transaction()?;
                transaction.execute(
                    "UPDATE noise_cleanup_jobs
                     SET status = 'failed', progress_percent = 0,
                         error_code = ?2, error_message = ?3,
                         updated_at = ?4
                     WHERE id = ?1 AND status = 'completed'",
                    params![persisted.job.id, code, message, now],
                )?;
                transaction.commit()?;
                persisted.job.status = NoiseCleanupJobStatus::Failed;
                persisted.job.progress_percent = 0;
                persisted.job.error_code = Some(code.to_string());
                persisted.job.error_message = Some(message.to_string());
                persisted.job.updated_at = now.clone();
            }
        }
        Ok(jobs.into_iter().map(|job| job.job).collect())
    }

    pub(crate) fn active_noise_cleanup_job_for_source(
        &self,
        source_session_id: &str,
    ) -> Result<Option<NoiseCleanupJob>> {
        let conn = self.lock()?;
        Ok(query_one_noise_cleanup_job(
            &conn,
            "WHERE source_session_id = ?1 AND status IN ('queued', 'processing', 'validating') ORDER BY created_at ASC LIMIT 1",
            params![source_session_id],
        )?
        .map(|job| job.job))
    }

    pub(crate) fn session_id_for_media_path(&self, path: &str) -> Result<Option<String>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id FROM sessions WHERE output_path = ?1 OR mp4_path = ?1 LIMIT 1",
            params![path],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub(crate) fn session_media_path_registered(&self, path: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn
            .query_row(
                "SELECT 1 FROM sessions
                 WHERE output_path = ?1 OR mp4_path = ?1
                 LIMIT 1",
                params![path],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub(crate) fn save_noise_cleanup_job(&self, job: &NoiseCleanupJob) -> Result<()> {
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE noise_cleanup_jobs
             SET status = ?2, progress_percent = ?3, output_session_id = ?4,
                 output_path = ?5, error_code = ?6, error_message = ?7, updated_at = ?8
             WHERE id = ?1",
            params![
                job.id,
                job.status.as_str(),
                i64::from(job.progress_percent.min(100)),
                job.output_session_id,
                job.output_path,
                job.error_code,
                job.error_message,
                job.updated_at,
            ],
        )?;
        if updated != 1 {
            bail!("Noise Cleanup job {} was not found.", job.id);
        }
        Ok(())
    }

    pub(crate) fn reconcile_interrupted_noise_cleanup_jobs(&self) -> Result<Vec<NoiseCleanupJob>> {
        let now = Utc::now().to_rfc3339();
        self.lock()?.execute(
            "UPDATE noise_cleanup_jobs
             SET status = 'queued', progress_percent = 0, output_session_id = NULL,
                 output_path = NULL, error_code = NULL, error_message = NULL, updated_at = ?1
             WHERE status IN ('processing', 'validating')",
            params![now],
        )?;
        let conn = self.lock()?;
        query_noise_cleanup_jobs(
            &conn,
            "WHERE status = 'queued' ORDER BY created_at ASC, id ASC",
            [],
        )
        .map(|jobs| jobs.into_iter().map(|job| job.job).collect())
    }

    /// Commit the managed derivative row and its completed job state in one
    /// SQLite transaction. The file-operation journal is intentionally removed
    /// after this commit: a crash before commit rolls the exact owned file back;
    /// a crash after commit retains the row/file pair and startup only retires
    /// the still-present journal.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn complete_noise_cleanup_derivative(
        &self,
        job_id: &str,
        source_session_id: &str,
        output_session_id: &str,
        title: &str,
        source_title: &str,
        output_path: &str,
        container: &str,
        duration_ms: Option<i64>,
        file_size_bytes: i64,
    ) -> Result<bool> {
        let now = Utc::now().to_rfc3339();
        let is_mp4 = container == "mp4";
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let inserted = transaction.execute(
            "INSERT INTO sessions
                (id, title, started_at, ended_at, status, mode, output_path, mp4_path,
                 stream_preset, container, duration_ms, sources_json, layout_json, output_json,
                 diagnostics_json, file_size_bytes, derived_from_session_id, source_title,
                 processing_kind)
             SELECT ?3, ?4, ?6, ?6, 'completed', mode,
                    CASE WHEN ?9 = 0 THEN ?7 ELSE NULL END,
                    CASE WHEN ?9 = 1 THEN ?7 ELSE NULL END,
                    stream_preset, ?8, COALESCE(?10, duration_ms), sources_json, layout_json,
                    output_json, NULL, ?11, ?2, ?5, 'noise-cleanup'
             FROM sessions WHERE id = ?2",
            params![
                job_id,
                source_session_id,
                output_session_id,
                title,
                source_title,
                now,
                output_path,
                container,
                is_mp4 as i64,
                duration_ms,
                file_size_bytes,
            ],
        )?;
        if inserted != 1 {
            return Ok(false);
        }
        let completed = transaction.execute(
            "UPDATE noise_cleanup_jobs
             SET status = 'completed', progress_percent = 100, output_session_id = ?2,
                 output_path = ?3, error_code = NULL, error_message = NULL, updated_at = ?4
             WHERE id = ?1 AND source_session_id = ?5
               AND source_full_sha256 <> 'pending'
               AND status IN ('queued', 'processing', 'validating')",
            params![
                job_id,
                output_session_id,
                output_path,
                now,
                source_session_id
            ],
        )?;
        if completed != 1 {
            bail!("Noise Cleanup job {job_id} was no longer active at derivative commit.");
        }
        transaction.commit()?;
        Ok(true)
    }

    #[cfg(test)]
    pub fn save_live_chat_message(&self, message: &LiveChatMessage) -> Result<()> {
        self.save_live_chat_messages(std::slice::from_ref(message))
    }

    /// Persist one provider burst in a single SQLite transaction. The caller's
    /// bounded worker supplies backpressure and never holds the async runtime
    /// while this synchronous transaction is executing.
    pub fn save_live_chat_messages(&self, messages: &[LiveChatMessage]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let mut existing_sessions = HashSet::new();
        for message in messages {
            if !existing_sessions.contains(&message.session_id) {
                let exists = transaction
                    .query_row(
                        "SELECT 1 FROM sessions WHERE id = ?1",
                        params![message.session_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !exists {
                    return Err(MissingLiveChatSession {
                        message_id: message.id.clone(),
                        session_id: message.session_id.clone(),
                    }
                    .into());
                }
                existing_sessions.insert(message.session_id.clone());
            }
            transaction.execute(
                "INSERT INTO live_chat_messages (
                    id, session_id, provider_message_id, platform, target_id, author_id,
                    author_name, author_avatar_url, author_badges_json, author_roles_json,
                    published_at, received_at, message_text, fragments_json, event_type,
                    amount_text, is_deleted, raw_provider_type
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                 ON CONFLICT(id) DO UPDATE SET
                    target_id = excluded.target_id,
                    author_id = excluded.author_id,
                    author_name = excluded.author_name,
                    author_avatar_url = excluded.author_avatar_url,
                    author_badges_json = excluded.author_badges_json,
                    author_roles_json = excluded.author_roles_json,
                    published_at = excluded.published_at,
                    received_at = excluded.received_at,
                    message_text = excluded.message_text,
                    fragments_json = excluded.fragments_json,
                    event_type = excluded.event_type,
                    amount_text = excluded.amount_text,
                    is_deleted = excluded.is_deleted,
                    raw_provider_type = excluded.raw_provider_type",
                params![
                    message.id,
                    message.session_id,
                    message.provider_message_id,
                    stream_platform_id(message.platform),
                    message.target_id,
                    message.author_id,
                    message.author_name,
                    message.author_avatar_url,
                    serde_json::to_string(&message.author_badges)?,
                    serde_json::to_string(&message.author_roles)?,
                    message.published_at,
                    message.received_at,
                    message.message_text,
                    serde_json::to_string(&message.fragments)?,
                    serde_json::to_string(&message.event_type)?,
                    message.amount_text,
                    message.is_deleted,
                    message.raw_provider_type,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    #[cfg(test)]
    pub fn list_live_chat_messages(&self, session_id: &str) -> Result<Vec<LiveChatMessage>> {
        let conn = self.lock()?;
        self.live_chat_messages_for_session_locked(&conn, session_id)
    }

    pub fn list_live_chat_messages_page(
        &self,
        session_id: &str,
        cursor: Option<&str>,
        requested_limit: usize,
    ) -> Result<LiveChatMessagesPage> {
        let limit = requested_limit.clamp(1, 200);
        let query_limit = i64::try_from(limit.saturating_add(1)).unwrap_or(201);
        let conn = self.lock()?;
        let mut messages = if let Some(cursor) = cursor {
            let (received_at, id) = parse_live_chat_cursor(cursor)?;
            let mut statement = conn.prepare(
                "SELECT id, session_id, provider_message_id, platform, target_id, author_id,
                        author_name, author_avatar_url, author_badges_json, author_roles_json,
                        published_at, received_at, message_text, fragments_json, event_type,
                        amount_text, is_deleted, raw_provider_type
                 FROM live_chat_messages
                 WHERE session_id = ?1
                   AND (received_at < ?2 OR (received_at = ?2 AND id < ?3))
                 ORDER BY received_at DESC, id DESC
                 LIMIT ?4",
            )?;
            statement
                .query_map(
                    params![session_id, received_at, id, query_limit],
                    live_chat_message_from_row,
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            let mut statement = conn.prepare(
                "SELECT id, session_id, provider_message_id, platform, target_id, author_id,
                        author_name, author_avatar_url, author_badges_json, author_roles_json,
                        published_at, received_at, message_text, fragments_json, event_type,
                        amount_text, is_deleted, raw_provider_type
                 FROM live_chat_messages
                 WHERE session_id = ?1
                 ORDER BY received_at DESC, id DESC
                 LIMIT ?2",
            )?;
            statement
                .query_map(params![session_id, query_limit], live_chat_message_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let has_older = messages.len() > limit;
        messages.truncate(limit);
        let next_cursor = has_older
            .then(|| messages.last().map(live_chat_cursor))
            .flatten();
        messages.reverse();
        Ok(LiveChatMessagesPage {
            messages,
            next_cursor,
        })
    }

    /// Internal consumers that need a wider session sample still page through
    /// SQLite and declare an explicit ceiling; no caller can materialize an
    /// unbounded table by accident.
    pub fn list_live_chat_messages_recent(
        &self,
        session_id: &str,
        requested_limit: usize,
    ) -> Result<Vec<LiveChatMessage>> {
        let limit = requested_limit.clamp(1, 5_000);
        let mut messages = Vec::with_capacity(limit.min(500));
        let mut cursor = None;
        while messages.len() < limit {
            let page = self.list_live_chat_messages_page(
                session_id,
                cursor.as_deref(),
                (limit - messages.len()).min(200),
            )?;
            messages.splice(0..0, page.messages);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok(messages)
    }

    pub fn save_chat_send_operation(&self, operation: &CommentsSendOperation) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO live_chat_send_operations (
                id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                phase_json = excluded.phase_json,
                destinations_json = excluded.destinations_json,
                updated_at = excluded.updated_at",
            params![
                operation.id,
                operation.session_id,
                operation.text,
                serde_json::to_string(&operation.phase)?,
                serde_json::to_string(&operation.destinations)?,
                operation.created_at,
                operation.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_chat_send_operation(&self, id: &str) -> Result<Option<CommentsSendOperation>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             FROM live_chat_send_operations WHERE id = ?1",
            params![id],
            chat_send_operation_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_chat_send_operations(
        &self,
        session_id: &str,
    ) -> Result<Vec<CommentsSendOperation>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
             FROM live_chat_send_operations
             WHERE session_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![session_id], chat_send_operation_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn reconcile_orphaned_chat_send_operations(&self) -> Result<usize> {
        let sending = serde_json::to_string(&CommentsSendOperationPhase::Sending)?;
        let operations = {
            let conn = self.lock()?;
            let mut statement = conn.prepare(
                "SELECT id, session_id, message_text, phase_json, destinations_json, created_at, updated_at
                 FROM live_chat_send_operations WHERE phase_json = ?1",
            )?;
            let rows = statement.query_map(params![sending], chat_send_operation_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let count = operations.len();
        let now = Utc::now().to_rfc3339();
        for mut operation in operations {
            operation.mark_interrupted_unknown(now.clone());
            self.save_chat_send_operation(&operation)?;
        }
        Ok(count)
    }

    pub fn save_ai_artifact(
        &self,
        session_id: &str,
        kind: AiArtifactKind,
        status: AiArtifactStatus,
        content: serde_json::Value,
        file_path: Option<String>,
    ) -> Result<AiArtifact> {
        let artifact = AiArtifact {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            kind,
            status,
            content,
            file_path,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO ai_artifacts (
                id, session_id, kind, status, content_json, file_path, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                artifact.id,
                artifact.session_id,
                serde_json::to_string(&artifact.kind)?,
                serde_json::to_string(&artifact.status)?,
                serde_json::to_string(&artifact.content)?,
                artifact.file_path,
                artifact.created_at,
            ],
        )?;
        Ok(artifact)
    }

    pub fn list_ai_artifacts(&self, session_id: &str) -> Result<Vec<AiArtifact>> {
        let conn = self.lock()?;
        self.ai_artifacts_for_session_locked(&conn, session_id)
    }

    pub fn list_health_events(&self, session_id: &str) -> Result<Vec<HealthEvent>> {
        let conn = self.lock()?;
        self.health_events_for_session_locked(&conn, session_id)
    }

    pub fn add_health_event(
        &self,
        session_id: Option<&str>,
        level: HealthLevel,
        code: &str,
        message: &str,
    ) -> Result<HealthEvent> {
        let permission_pane = permission_pane_for_log(code, message);
        let event = HealthEvent {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.map(str::to_string),
            level,
            code: code.to_string(),
            message: message.to_string(),
            permission_pane,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO health_events (id, session_id, level, code, message, permission_pane, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.id,
                event.session_id,
                serde_json::to_string(&event.level)?,
                event.code,
                event.message,
                event
                    .permission_pane
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                event.created_at,
            ],
        )?;
        Ok(event)
    }

    pub fn add_session_log(
        &self,
        session_id: &str,
        level: HealthLevel,
        code: &str,
        message: &str,
        source_id: Option<&str>,
    ) -> Result<SessionLogEntry> {
        let permission_pane = permission_pane_for_log(code, message);
        let entry = SessionLogEntry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            level,
            code: code.to_string(),
            message: message.to_string(),
            source_id: source_id.map(str::to_string),
            permission_pane,
            created_at: Utc::now().to_rfc3339(),
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO session_logs (
                id, session_id, level, code, message, source_id, permission_pane, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                entry.session_id,
                serde_json::to_string(&entry.level)?,
                entry.code,
                entry.message,
                entry.source_id,
                entry
                    .permission_pane
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                entry.created_at,
            ],
        )?;
        Ok(entry)
    }

    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, status, mode, output_path, mp4_path,
                    stream_preset, container, duration_ms, sources_json, layout_json,
                    diagnostics_json, file_size_bytes, derived_from_session_id, source_title,
                    processing_kind
             FROM sessions
             WHERE library_hidden = 0
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let id: String = row.get(0)?;
            let sources_json: String = row.get(11)?;
            let layout_json: String = row.get(12)?;
            let diagnostics_json: Option<String> = row.get(13)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                sources_json,
                layout_json,
                diagnostics_json,
                row.get::<_, Option<i64>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
            ))
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            let (
                id,
                title,
                started_at,
                ended_at,
                status,
                mode,
                output_path,
                mp4_path,
                stream_preset,
                container,
                duration_ms,
                sources_json,
                layout_json,
                diagnostics_json,
                stored_file_size,
                derived_from_session_id,
                source_title,
                processing_kind,
            ) = row?;

            // Size truth (Library rewrite L1): stat the VISIBLE file live while
            // it exists (repairs and MP4 exports change it), fall back to the
            // last-known size when it has gone missing, and write changes back
            // so missing-file rows keep a truthful number. A stat is microseconds;
            // 200 rows cost less than a frame.
            let visible_path = mp4_path.as_deref().or(output_path.as_deref());
            let live_size = visible_path
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|metadata| metadata.len() as i64);
            let file_size_bytes = live_size.or(stored_file_size);
            if live_size.is_some() && live_size != stored_file_size {
                let _ = conn.execute(
                    "UPDATE sessions SET file_size_bytes = ?2 WHERE id = ?1",
                    params![id, live_size],
                );
            }
            let layout: LayoutSettings = serde_json::from_str(&layout_json)?;
            let scene_label = session_scene_label(&layout, stream_preset.as_deref(), &mode);

            sessions.push(SessionSummary {
                file_size_bytes,
                scene_label,
                health_events: self.health_events_for_session_locked(&conn, &id)?,
                session_logs: self.session_logs_for_session_locked(&conn, &id)?,
                ai_artifacts: self.ai_artifacts_for_session_locked(&conn, &id)?,
                comment_count: self.live_chat_message_count_for_session_locked(&conn, &id)?,
                derived_from_session_id,
                source_title,
                processing_kind,
                quality_status: self.latest_quality_status_for_session_locked(
                    &conn,
                    output_path.as_deref(),
                    mp4_path.as_deref(),
                )?,
                id,
                title,
                started_at,
                ended_at,
                status,
                mode,
                output_path,
                mp4_path,
                stream_preset,
                container,
                duration_ms,
                final_diagnostics: diagnostics_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                sources: serde_json::from_str(&sources_json)?,
                layout,
            });
        }

        Ok(sessions)
    }

    /// Rename a session (Library L3). Title is validated at the RPC edge.
    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<bool> {
        let conn = self.lock()?;
        let changed = conn.execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1",
            params![session_id, title],
        )?;
        Ok(changed > 0)
    }

    /// Persist an import/duplicate file operation before bytes are copied.
    /// The durable journal lets startup discard an unowned final file or
    /// publish a completed row without guessing which side of the operation won.
    pub fn begin_session_file_operation(
        &self,
        kind: &str,
        session_id: &str,
        staging_path: &Path,
        final_path: &Path,
    ) -> Result<SessionFileOperation> {
        if !matches!(kind, "import" | "duplicate" | "noise-cleanup") {
            bail!("Unsupported session file operation kind: {kind}");
        }
        if staging_path == final_path {
            bail!("Session file staging and final paths must differ.");
        }
        let operation = SessionFileOperation {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            staging_path: staging_path.display().to_string(),
            final_path: final_path.display().to_string(),
            created_at: Utc::now().to_rfc3339(),
            staging_cleanup_path: Some(
                staging_path
                    .with_file_name(format!(".videorc-session-op-cleanup-{}", Uuid::new_v4()))
                    .display()
                    .to_string(),
            ),
            staging_object_identity: None,
            published_identity: None,
        };
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO session_file_operations
                (id, kind, session_id, staging_path, final_path, created_at,
                 staging_cleanup_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                operation.id,
                operation.kind,
                operation.session_id,
                operation.staging_path,
                operation.final_path,
                operation.created_at,
                operation.staging_cleanup_path,
            ],
        )?;
        Ok(operation)
    }

    pub fn finish_session_file_operation(&self, operation_id: &str) -> Result<()> {
        let conn = self.lock()?;
        let deleted = conn.execute(
            "DELETE FROM session_file_operations WHERE id = ?1",
            params![operation_id],
        )?;
        if deleted != 1 {
            bail!("Session file operation {operation_id} was not found.");
        }
        Ok(())
    }

    /// Bind the journal to the exact staging bytes before the no-replace
    /// rename. If the destination is later replaced, startup can neither adopt
    /// nor delete the replacement by path alone.
    #[cfg(test)]
    pub fn bind_session_file_operation_identity(
        &self,
        operation_id: &str,
        staging_path: &Path,
    ) -> Result<SessionFileIdentity> {
        let identity = capture_session_file_identity(staging_path)?.with_context(|| {
            format!(
                "Session staging file {} disappeared before publication",
                staging_path.display()
            )
        })?;
        self.bind_session_file_operation_content_identity(operation_id, &identity)?;
        Ok(identity)
    }

    /// Persist bytes sampled from the already-open create-new staging handle.
    /// Live import/duplicate uses this form so replacing the path between the
    /// copy and content binding cannot redefine which bytes the journal owns.
    pub fn bind_session_file_operation_content_identity(
        &self,
        operation_id: &str,
        identity: &SessionFileIdentity,
    ) -> Result<()> {
        let identity_json = serde_json::to_string(&identity)?;
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE session_file_operations
             SET published_identity_json = ?2
             WHERE id = ?1",
            params![operation_id, identity_json],
        )?;
        if updated != 1 {
            bail!("Session file operation {operation_id} was not found.");
        }
        Ok(())
    }

    pub fn bind_session_file_operation_object_identity(
        &self,
        operation_id: &str,
        identity: &SessionFileObjectIdentity,
    ) -> Result<()> {
        let identity_json = serde_json::to_string(identity)?;
        let conn = self.lock()?;
        let updated = conn.execute(
            "UPDATE session_file_operations
             SET staging_object_identity_json = ?2
             WHERE id = ?1",
            params![operation_id, identity_json],
        )?;
        if updated != 1 {
            bail!("Session file operation {operation_id} was not found.");
        }
        Ok(())
    }

    pub fn cancel_session_file_operation(&self, operation: &SessionFileOperation) -> Result<()> {
        let Some(current) = self.session_file_operation(&operation.id)? else {
            return Ok(());
        };
        if self.reconcile_session_file_operation(&current)? {
            bail!(
                "Session file operation {} already owns a completed row and cannot be cancelled.",
                operation.id
            );
        }
        Ok(())
    }

    pub fn pending_session_file_operations(&self) -> Result<Vec<SessionFileOperation>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, kind, session_id, staging_path, final_path, created_at,
                    staging_cleanup_path, staging_object_identity_json,
                    published_identity_json
             FROM session_file_operations
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map([], session_file_operation_from_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn session_file_operation(&self, operation_id: &str) -> Result<Option<SessionFileOperation>> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, kind, session_id, staging_path, final_path, created_at,
                    staging_cleanup_path, staging_object_identity_json,
                    published_identity_json
             FROM session_file_operations
             WHERE id = ?1",
            params![operation_id],
            session_file_operation_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn reconcile_session_file_operations(&self) -> Result<SessionFileReconciliationSummary> {
        let mut summary = SessionFileReconciliationSummary::default();
        for operation in self.pending_session_file_operations()? {
            match self.reconcile_session_file_operation(&operation) {
                Ok(true) => summary.published = summary.published.saturating_add(1),
                Ok(false) => summary.discarded = summary.discarded.saturating_add(1),
                Err(error) => {
                    summary.pending = summary.pending.saturating_add(1);
                    summary
                        .errors
                        .push(format!("Operation {}: {error:#}", operation.id));
                }
            }
        }
        Ok(summary)
    }

    /// Returns true when a complete row/file pair was retained, false when an
    /// incomplete pair was rolled back. Journal deletion is always last.
    fn reconcile_session_file_operation(&self, operation: &SessionFileOperation) -> Result<bool> {
        let staging_path = Path::new(&operation.staging_path);
        let final_path = Path::new(&operation.final_path);
        let generated_cleanup_path;
        let cleanup_path = if let Some(path) = operation.staging_cleanup_path.as_deref() {
            Path::new(path)
        } else {
            // Legacy rows did not persist this column. The operation id is
            // already durable, so this remains deterministic across retries.
            generated_cleanup_path = staging_path
                .with_file_name(format!(".videorc-session-op-cleanup-{}", operation.id));
            &generated_cleanup_path
        };
        let row_exists = self
            .lock()?
            .query_row(
                "SELECT 1 FROM sessions WHERE id = ?1",
                params![operation.session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let staging_exists = staging_path.try_exists().with_context(|| {
            format!(
                "Could not inspect session staging file {}",
                staging_path.display()
            )
        })?;
        let final_exists = final_path
            .try_exists()
            .with_context(|| format!("Could not inspect session file {}", final_path.display()))?;
        let cleanup_exists = cleanup_path.try_exists().with_context(|| {
            format!(
                "Could not inspect session cleanup {}",
                cleanup_path.display()
            )
        })?;

        if !staging_exists && !final_exists && !cleanup_exists {
            let mut conn = self.lock()?;
            let transaction = conn.transaction()?;
            transaction.execute(
                "DELETE FROM sessions WHERE id = ?1",
                params![operation.session_id],
            )?;
            transaction.execute(
                "DELETE FROM session_file_operations WHERE id = ?1",
                params![operation.id],
            )?;
            transaction.commit()?;
            return Ok(false);
        }

        let Some(expected_identity) = operation.published_identity.as_ref() else {
            // A crash can land between create-new and binding the open file
            // handle. Retire that journal deterministically: an object-bound
            // staging file is verified and removed; a truly unbound path is
            // only moved to private quarantine and never deleted or adopted.
            if operation.staging_object_identity.is_some() {
                cleanup_identity_bound_session_file(
                    staging_path,
                    cleanup_path,
                    operation.staging_object_identity.as_ref(),
                    None,
                )?;
            } else {
                quarantine_unbound_session_file(staging_path, cleanup_path)?;
            }
            let mut conn = self.lock()?;
            let transaction = conn.transaction()?;
            transaction.execute(
                "DELETE FROM sessions WHERE id = ?1",
                params![operation.session_id],
            )?;
            transaction.execute(
                "DELETE FROM session_file_operations WHERE id = ?1",
                params![operation.id],
            )?;
            transaction.commit()?;
            return Ok(false);
        };

        if row_exists && !final_exists && staging_exists {
            crate::session_ops::rename_session_file_no_replace(staging_path, final_path)
                .with_context(|| {
                    format!(
                        "Could not publish recovered session file {}",
                        final_path.display()
                    )
                })?;
            crate::session_ops::sync_session_file_parent(final_path)?;
            let published_ownership = capture_session_file_bound_identity(final_path)?
                .with_context(|| {
                    format!(
                        "Published session file {} disappeared",
                        final_path.display()
                    )
                })?;
            if !session_file_bound_identity_matches(
                &published_ownership,
                expected_identity,
                operation.staging_object_identity.as_ref(),
            ) {
                if crate::session_ops::rename_session_file_no_replace(final_path, staging_path)
                    .is_ok()
                {
                    let _ = crate::session_ops::sync_session_file_parent(staging_path);
                }
                bail!(
                    "Session staging file {} changed before publication for operation {}; it was not adopted.",
                    staging_path.display(),
                    operation.id
                );
            }
        }

        let staging_exists = staging_path.try_exists().with_context(|| {
            format!(
                "Could not inspect session staging file {}",
                staging_path.display()
            )
        })?;
        let final_exists = final_path
            .try_exists()
            .with_context(|| format!("Could not inspect session file {}", final_path.display()))?;
        let cleanup_exists = cleanup_path.try_exists().with_context(|| {
            format!(
                "Could not inspect session cleanup {}",
                cleanup_path.display()
            )
        })?;
        if row_exists && final_exists {
            let final_ownership = capture_session_file_bound_identity(final_path)?
                .with_context(|| format!("Session file {} disappeared", final_path.display()))?;
            if !session_file_bound_identity_matches(
                &final_ownership,
                expected_identity,
                operation.staging_object_identity.as_ref(),
            ) {
                if staging_exists || cleanup_exists {
                    cleanup_identity_bound_session_file(
                        staging_path,
                        cleanup_path,
                        operation.staging_object_identity.as_ref(),
                        Some(expected_identity),
                    )?;
                }
                let mut conn = self.lock()?;
                let transaction = conn.transaction()?;
                transaction.execute(
                    "DELETE FROM sessions WHERE id = ?1",
                    params![operation.session_id],
                )?;
                transaction.execute(
                    "DELETE FROM session_file_operations WHERE id = ?1",
                    params![operation.id],
                )?;
                transaction.commit()?;
                return Ok(false);
            }
            if staging_exists || cleanup_exists {
                cleanup_identity_bound_session_file(
                    staging_path,
                    cleanup_path,
                    operation.staging_object_identity.as_ref(),
                    Some(expected_identity),
                )?;
            }
            self.finish_session_file_operation(&operation.id)?;
            return Ok(true);
        }

        if staging_exists || cleanup_exists {
            cleanup_identity_bound_session_file(
                staging_path,
                cleanup_path,
                operation.staging_object_identity.as_ref(),
                Some(expected_identity),
            )?;
        }
        if final_exists {
            let final_identity = capture_session_file_identity(final_path)?
                .with_context(|| format!("Session file {} disappeared", final_path.display()))?;
            if &final_identity == expected_identity {
                cleanup_identity_bound_session_file(
                    final_path,
                    cleanup_path,
                    operation.staging_object_identity.as_ref(),
                    Some(expected_identity),
                )?;
            }
        }
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM sessions WHERE id = ?1",
            params![operation.session_id],
        )?;
        transaction.execute(
            "DELETE FROM session_file_operations WHERE id = ?1",
            params![operation.id],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    /// Durably hide sessions before Electron moves their media to the system
    /// Trash. A crash at any later point leaves a retryable tombstone instead
    /// of either a visible broken row or an unmanaged deleted row.
    pub fn prepare_session_deletions(
        &self,
        session_ids: &[String],
    ) -> Result<Vec<PendingSessionDeletion>> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let now = Utc::now().to_rfc3339();
        let mut operation_ids = Vec::new();

        for session_id in session_ids {
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT id FROM session_delete_operations WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                operation_ids.push(existing);
                continue;
            }

            let media: Option<(String, Option<String>, Option<String>)> = transaction
                .query_row(
                    "SELECT status, mp4_path, output_path
                     FROM sessions
                     WHERE id = ?1 AND library_hidden = 0",
                    params![session_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((status, mp4_path, output_path)) = media else {
                continue;
            };
            if status == "running" {
                bail!("Session {session_id} is still active and cannot be deleted.");
            }
            let paths = distinct_nonempty_paths([mp4_path, output_path]);
            let operation_id = Uuid::new_v4().to_string();
            let path_records = paths
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let ownership = capture_session_file_bound_identity(Path::new(path))?;
                    Ok(SessionDeletionPathRecord {
                        original_path: path.clone(),
                        quarantine_path: Some(
                            session_deletion_quarantine_path(Path::new(path), &operation_id, index)
                                .display()
                                .to_string(),
                        ),
                        identity: ownership
                            .as_ref()
                            .map(|ownership| ownership.content_identity.clone()),
                        object_identity: ownership.map(|ownership| ownership.object_identity),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            transaction.execute(
                "INSERT INTO session_delete_operations
                    (id, session_id, paths_json, last_error, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
                params![
                    operation_id,
                    session_id,
                    serde_json::to_string(&path_records)?,
                    now,
                ],
            )?;
            let hidden = transaction.execute(
                "UPDATE sessions SET library_hidden = 1 WHERE id = ?1 AND library_hidden = 0",
                params![session_id],
            )?;
            if hidden != 1 {
                bail!("Session {session_id} could not be hidden for deletion.");
            }
            operation_ids.push(operation_id);
        }

        transaction.commit()?;
        drop(conn);
        let requested = operation_ids.into_iter().collect::<HashSet<_>>();
        Ok(self
            .pending_session_deletions()?
            .into_iter()
            .filter(|operation| requested.contains(&operation.operation_id))
            .collect())
    }

    pub fn pending_session_deletions(&self) -> Result<Vec<PendingSessionDeletion>> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, session_id, paths_json
             FROM session_delete_operations
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(operation_id, session_id, paths_json)| {
                pending_session_deletion_from_records(
                    operation_id,
                    session_id,
                    parse_session_deletion_path_records(&paths_json)?,
                )
            })
            .collect()
    }

    /// Resolve one Trash attempt. Successful paths are forgotten. If no paths
    /// remain, deleting the session and its tombstone is one SQLite transaction;
    /// otherwise the hidden row remains durable for the next retry.
    pub fn complete_session_deletion(
        &self,
        operation_id: &str,
        failed_paths: &[String],
    ) -> Result<SessionDeletionCompletion> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let (session_id, paths_json): (String, String) = transaction
            .query_row(
                "SELECT session_id, paths_json
                 FROM session_delete_operations
                 WHERE id = ?1",
                params![operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .with_context(|| format!("Delete operation {operation_id} was not found."))?;
        let expected_records = parse_session_deletion_path_records(&paths_json)?;
        let expected = expected_records
            .iter()
            .flat_map(|record| {
                std::iter::once(record.original_path.as_str())
                    .chain(record.quarantine_path.as_deref())
            })
            .collect::<HashSet<_>>();
        let explicitly_failed = failed_paths
            .iter()
            .filter(|path| !path.trim().is_empty())
            .cloned()
            .collect::<HashSet<_>>();
        if explicitly_failed
            .iter()
            .any(|path| !expected.contains(path.as_str()))
        {
            bail!("Delete completion contained a path outside its durable tombstone.");
        }
        let mut pending_records = Vec::new();
        let mut pending_paths = Vec::new();
        for record in expected_records {
            // The filesystem is authoritative after Electron's attempt. Even
            // when Trash reported an error, a now-missing path is complete;
            // any present or uninspectable path remains retryable.
            match deletion_path_state(&record)? {
                DeletionPathState::Missing => {}
                DeletionPathState::Ready(path) | DeletionPathState::Blocked(path) => {
                    pending_paths.push(path);
                    pending_records.push(record);
                }
            }
        }
        pending_paths.sort();

        let deleted = if pending_paths.is_empty() {
            let deleted = transaction.execute(
                "DELETE FROM sessions WHERE id = ?1 AND library_hidden = 1",
                params![session_id],
            )?;
            if deleted != 1 {
                bail!("Hidden session {session_id} could not be completed for deletion.");
            }
            true
        } else {
            transaction.execute(
                "UPDATE session_delete_operations
                 SET paths_json = ?2, last_error = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![
                    operation_id,
                    serde_json::to_string(&pending_records)?,
                    format!(
                        "{} path(s) could not be moved to Trash.",
                        pending_paths.len()
                    ),
                    Utc::now().to_rfc3339(),
                ],
            )?;
            false
        };
        transaction.commit()?;
        Ok(SessionDeletionCompletion {
            session_id,
            deleted,
            pending_paths,
        })
    }

    /// Finish delete operations whose files were already moved before a crash,
    /// and retain existing paths as hidden retry work for Electron's Trash API.
    pub fn reconcile_session_deletions(&self) -> Result<SessionDeletionReconciliationSummary> {
        let mut summary = SessionDeletionReconciliationSummary::default();
        for operation in self.pending_session_deletions()? {
            let mut remaining = operation.paths.clone();
            remaining.extend(operation.blocked_paths.clone());
            if !remaining.is_empty() {
                summary.pending = summary.pending.saturating_add(1);
                continue;
            }
            match self.complete_session_deletion(&operation.operation_id, &remaining) {
                Ok(completion) if completion.deleted => {
                    summary.completed = summary.completed.saturating_add(1);
                }
                Ok(_) => summary.pending = summary.pending.saturating_add(1),
                Err(error) => {
                    summary.pending = summary.pending.saturating_add(1);
                    summary.errors.push(format!(
                        "Delete operation {}: {error:#}",
                        operation.operation_id
                    ));
                }
            }
        }
        Ok(summary)
    }

    /// Clone a session row for Duplicate (Library L3): same config lineage,
    /// new id/title/paths/timestamps; quality history and artifacts stay with
    /// the original.
    #[allow(clippy::too_many_arguments)]
    pub fn clone_session_row(
        &self,
        source_id: &str,
        new_id: &str,
        new_title: &str,
        new_output_path: Option<&str>,
        new_mp4_path: Option<&str>,
        started_at: &str,
        file_size_bytes: Option<i64>,
    ) -> Result<bool> {
        let conn = self.lock()?;
        let inserted = conn.execute(
            "INSERT INTO sessions (id, title, started_at, ended_at, status, mode, output_path,
                                   mp4_path, stream_preset, container, duration_ms, sources_json,
                                   layout_json, output_json, diagnostics_json, file_size_bytes,
                                   derived_from_session_id, source_title, processing_kind)
             SELECT ?2, ?3, ?6, ?6, 'completed', mode, ?4, ?5, stream_preset, container,
                    duration_ms, sources_json, layout_json, output_json, NULL, ?7,
                    derived_from_session_id, source_title, processing_kind
             FROM sessions WHERE id = ?1",
            params![
                source_id,
                new_id,
                new_title,
                new_output_path,
                new_mp4_path,
                started_at,
                file_size_bytes
            ],
        )?;
        Ok(inserted > 0)
    }

    /// Full facts Duplicate needs from the source row (Library L3).
    pub fn session_clone_facts(&self, session_id: &str) -> Result<Option<SessionCloneFacts>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT title, output_path, mp4_path FROM sessions WHERE id = ?1")?;
        let mut rows = stmt.query(params![session_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(SessionCloneFacts {
            title: row.get(0)?,
            output_path: row.get(1)?,
            mp4_path: row.get(2)?,
        }))
    }

    /// The visible file + duration for one session (poster backfill, L2).
    pub fn session_file_facts(&self, session_id: &str) -> Result<Option<(String, Option<i64>)>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(mp4_path, output_path), duration_ms FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![session_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let path: Option<String> = row.get(0)?;
        let duration_ms: Option<i64> = row.get(1)?;
        Ok(path.map(|path| (path, duration_ms)))
    }

    /// Library footer facts (L1): total sessions + the sum of last-known file
    /// sizes. Free disk space comes from the Electron-side directory facts —
    /// the renderer combines the two.
    pub fn session_storage_totals(&self) -> Result<SessionStorageTotals> {
        let conn = self.lock()?;
        let (count, total_bytes) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size_bytes), 0)
             FROM sessions
             WHERE library_hidden = 0",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok(SessionStorageTotals { count, total_bytes })
    }

    pub fn load_setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let conn = self.lock()?;
        let value_json: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        value_json
            .map(|value_json| serde_json::from_str(&value_json).map_err(Into::into))
            .transpose()
    }

    pub fn save_setting<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn import_screen_image(&self, image_path: &str, ffmpeg_path: &str) -> Result<StreamScreen> {
        self.import_screen_image_with_optimizer(image_path, |source, destination| {
            optimize_screen_image(source, destination, ffmpeg_path)
        })
    }

    pub fn list_platform_accounts(&self) -> Result<Vec<PlatformAccount>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status,
                    COALESCE((SELECT generation FROM platform_account_write_generations
                              WHERE platform = platform_accounts.platform), 0)
             FROM platform_accounts
             ORDER BY platform ASC",
        )?;
        let rows = stmt.query_map([], |row| self.platform_account_from_row(row))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_platform_account_credentials(&self) -> Result<Vec<PlatformAccountCredentials>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status,
                    COALESCE((SELECT generation FROM platform_account_write_generations
                              WHERE platform = platform_accounts.platform), 0)
             FROM platform_accounts
             ORDER BY platform ASC",
        )?;
        let rows = stmt.query_map([], |row| self.platform_account_credentials_from_row(row))?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn platform_account_write_expectation(
        &self,
        platform: StreamPlatform,
    ) -> Result<PlatformAccountWriteExpectation> {
        let conn = self.lock()?;
        self.platform_account_write_expectation_locked(&conn, platform)
    }

    #[allow(dead_code)]
    pub fn upsert_platform_account(
        &self,
        account: UpsertPlatformAccount,
    ) -> Result<PlatformAccount> {
        self.validate_platform_account_input(&account)?;
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let current =
            self.platform_account_write_expectation_locked(&transaction, account.platform)?;
        let generation = current.generation.saturating_add(1);
        let stored = self.upsert_platform_account_locked(&transaction, account, generation)?;
        transaction.commit()?;
        Ok(stored)
    }

    pub fn compare_and_upsert_platform_account<F>(
        &self,
        account: UpsertPlatformAccount,
        expected: Option<&PlatformAccountWriteExpectation>,
        write_generation: u64,
        allow_skipped_predecessor: bool,
        accept_already_applied: bool,
        before_apply: F,
    ) -> Result<PlatformAccountCasOutcome>
    where
        F: FnOnce() -> Result<()>,
    {
        self.validate_platform_account_input(&account)?;
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let current =
            self.platform_account_write_expectation_locked(&transaction, account.platform)?;
        let desired = PlatformAccountWriteExpectation::for_account(&account, write_generation);
        if accept_already_applied && current == desired {
            let stored =
                self.platform_account_by_platform_locked(&transaction, account.platform)?;
            transaction.commit()?;
            return Ok(PlatformAccountCasOutcome::AlreadyApplied(stored));
        }
        let expected_matches = expected.is_some_and(|expected| current == *expected);
        let predecessor_was_skipped = allow_skipped_predecessor
            && expected.is_some_and(|expected| current.generation < expected.generation);
        if (!expected_matches && !predecessor_was_skipped) || write_generation <= current.generation
        {
            transaction.commit()?;
            return Ok(PlatformAccountCasOutcome::Stale(current));
        }

        before_apply()?;
        let stored =
            self.upsert_platform_account_locked(&transaction, account, write_generation)?;
        transaction.commit()?;
        Ok(PlatformAccountCasOutcome::Applied(stored))
    }

    fn upsert_platform_account_locked(
        &self,
        conn: &Connection,
        account: UpsertPlatformAccount,
        generation: u64,
    ) -> Result<PlatformAccount> {
        let now = Utc::now().to_rfc3339();
        let account_platform = account.platform;
        let platform = stream_platform_id(account_platform);
        let existing_id = conn
            .query_row(
                "SELECT id FROM platform_accounts WHERE platform = ?1",
                params![platform],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let connected_at = conn
            .query_row(
                "SELECT connected_at FROM platform_accounts WHERE platform = ?1",
                params![platform],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| now.clone());

        conn.execute(
            "INSERT INTO platform_accounts (
                id, platform, account_id, account_label, account_handle, avatar_url, scopes_json,
                token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref, expires_at,
                connected_at, updated_at, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(platform) DO UPDATE SET
                account_id = excluded.account_id,
                account_label = excluded.account_label,
                account_handle = excluded.account_handle,
                avatar_url = excluded.avatar_url,
                scopes_json = excluded.scopes_json,
                token_secret_ref = excluded.token_secret_ref,
                refresh_token_secret_ref = CASE
                    WHEN excluded.refresh_token_secret_ref IS NOT NULL THEN excluded.refresh_token_secret_ref
                    WHEN platform_accounts.account_id = excluded.account_id THEN platform_accounts.refresh_token_secret_ref
                    ELSE NULL
                END,
                stream_key_secret_ref = excluded.stream_key_secret_ref,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at,
                status = excluded.status",
            params![
                id,
                platform,
                account.account_id.trim(),
                account.account_label.trim(),
                account.account_handle,
                account.avatar_url,
                serde_json::to_string(&normalized_scopes(account.scopes))?,
                account.token_secret_ref,
                account.refresh_token_secret_ref,
                account.stream_key_secret_ref,
                account.expires_at,
                connected_at,
                now,
                serde_json::to_string(&account.status)?,
            ],
        )?;
        self.set_platform_account_generation_locked(conn, account_platform, generation)?;
        self.platform_account_by_platform_locked(conn, account_platform)
    }

    #[cfg(test)]
    #[cfg_attr(test, allow(dead_code))]
    pub fn disconnect_platform_account(
        &self,
        platform: StreamPlatform,
    ) -> Result<Option<PlatformAccount>> {
        self.disconnect_platform_account_after_generation(platform, 0)
    }

    pub fn disconnect_platform_account_after_generation(
        &self,
        platform: StreamPlatform,
        pending_generation: u64,
    ) -> Result<Option<PlatformAccount>> {
        self.disconnect_platform_account_with_generation_and_secret_deleter(
            platform,
            pending_generation,
            crate::secrets::delete_secret,
        )
    }

    #[cfg(test)]
    fn disconnect_platform_account_with_secret_deleter<F>(
        &self,
        platform: StreamPlatform,
        delete_secret: F,
    ) -> Result<Option<PlatformAccount>>
    where
        F: FnMut(&str) -> Result<()>,
    {
        self.disconnect_platform_account_with_generation_and_secret_deleter(
            platform,
            0,
            delete_secret,
        )
    }

    fn disconnect_platform_account_with_generation_and_secret_deleter<F>(
        &self,
        platform: StreamPlatform,
        pending_generation: u64,
        mut delete_secret: F,
    ) -> Result<Option<PlatformAccount>>
    where
        F: FnMut(&str) -> Result<()>,
    {
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        let platform_id = stream_platform_id(platform);
        let refs = transaction
            .query_row(
                "SELECT token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref
                 FROM platform_accounts
                 WHERE platform = ?1",
                params![platform_id],
                |row| {
                    Ok([
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ])
                },
            )
            .optional()?;
        let Some(refs) = refs else {
            let current = self.platform_account_write_expectation_locked(&transaction, platform)?;
            self.set_platform_account_generation_locked(
                &transaction,
                platform,
                current.generation.max(pending_generation).saturating_add(1),
            )?;
            transaction.commit()?;
            return Ok(None);
        };
        let account = self.platform_account_by_platform_locked(&transaction, platform)?;
        let current = self.platform_account_write_expectation_locked(&transaction, platform)?;
        transaction.execute(
            "DELETE FROM platform_accounts WHERE platform = ?1",
            params![platform_id],
        )?;
        self.set_platform_account_generation_locked(
            &transaction,
            platform,
            current.generation.max(pending_generation).saturating_add(1),
        )?;
        transaction.commit()?;
        drop(conn);
        for secret_ref in refs.into_iter().flatten() {
            delete_secret(&secret_ref)?;
        }
        Ok(Some(account))
    }

    pub fn stream_metadata_draft(&self) -> Result<StreamMetadataDraft> {
        let conn = self.lock()?;
        let value_json = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'streamMetadataDraft'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value_json {
            Some(value) => Ok(serde_json::from_str::<StreamMetadataDraft>(&value)
                .unwrap_or_else(|_| default_stream_metadata_draft(Utc::now().to_rfc3339()))),
            None => Ok(default_stream_metadata_draft(Utc::now().to_rfc3339())),
        }
    }

    pub fn save_stream_metadata_draft(
        &self,
        mut draft: StreamMetadataDraft,
    ) -> Result<StreamMetadataDraft> {
        let now = Utc::now().to_rfc3339();
        draft.updated_at = now.clone();
        for target in &mut draft.target_overrides {
            target.updated_at = now.clone();
        }
        self.save_setting("streamMetadataDraft", &draft)?;
        Ok(draft)
    }

    fn import_screen_image_with_optimizer<F>(
        &self,
        image_path: &str,
        optimize: F,
    ) -> Result<StreamScreen>
    where
        F: FnOnce(&Path, &Path) -> Result<()>,
    {
        let source_path = Path::new(image_path);
        validate_screen_image_source(source_path)?;
        let conn = self.lock()?;
        let now = Utc::now().to_rfc3339();
        let next_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM stream_screens",
            [],
            |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let screen_dir = self.screen_assets_dir();
        std::fs::create_dir_all(&screen_dir)
            .with_context(|| format!("Could not create {}", screen_dir.display()))?;
        validate_managed_screen_root(&screen_dir)?;
        let optimized_path = screen_dir.join(format!("{id}.png"));
        optimize(source_path, &optimized_path)?;
        let optimized_path =
            resolve_managed_screen_image_path(&screen_dir, &id, &optimized_path)
                .context("Optimized Screen image did not remain a managed regular file")?;
        let screen = StreamScreen {
            id,
            name: screen_name_from_path(image_path),
            image_path: optimized_path.display().to_string(),
            thumbnail_path: None,
            sort_order: next_order,
            status: StreamScreenStatus::Ready,
            created_at: now.clone(),
            updated_at: now,
        };

        conn.execute(
            "INSERT INTO stream_screens (
                id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                screen.id,
                screen.name,
                screen.image_path,
                screen.thumbnail_path,
                screen.sort_order,
                serde_json::to_string(&screen.status)?,
                screen.created_at,
                screen.updated_at,
            ],
        )?;
        Ok(screen)
    }

    pub fn list_stream_screens(&self) -> Result<Vec<StreamScreen>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             FROM stream_screens
             ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], stream_screen_from_row)?;
        let screens = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(screens
            .into_iter()
            .map(|screen| self.validate_stream_screen(screen))
            .collect())
    }

    pub fn rename_stream_screen(&self, screen_id: &str, name: &str) -> Result<StreamScreen> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Screen name cannot be empty.");
        }

        let conn = self.lock()?;
        let updated_at = Utc::now().to_rfc3339();
        let changed = conn.execute(
            "UPDATE stream_screens SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![screen_id, trimmed, updated_at],
        )?;
        if changed == 0 {
            anyhow::bail!("Screen not found.");
        }

        self.stream_screen_by_id_locked(&conn, screen_id)
    }

    pub fn delete_stream_screen(&self, screen_id: &str) -> Result<()> {
        let conn = self.lock()?;
        let screen = self
            .stream_screen_by_id_raw_locked(&conn, screen_id)
            .optional()?;
        let Some(screen) = screen else {
            anyhow::bail!("Screen not found.");
        };

        // Invalid persisted paths are retired from SQLite without ever being
        // followed or deleted. In particular, a forged row cannot turn
        // screens.delete into an arbitrary file deletion primitive.
        if let Ok(path) = resolve_managed_screen_image_path(
            &self.screen_assets_dir(),
            &screen.id,
            Path::new(&screen.image_path),
        ) {
            std::fs::remove_file(&path)
                .with_context(|| format!("Could not delete {}", path.display()))?;
        }
        conn.execute(
            "DELETE FROM stream_screens WHERE id = ?1",
            params![screen_id],
        )?;
        if self.active_screen_id_locked(&conn)?.as_deref() == Some(screen_id) {
            self.save_setting_locked(&conn, "activeScreenId", &Option::<String>::None)?;
        }
        Ok(())
    }

    pub fn reorder_stream_screens(&self, screen_ids: &[String]) -> Result<Vec<StreamScreen>> {
        let conn = self.lock()?;
        let existing_ids = {
            let mut stmt = conn.prepare("SELECT id FROM stream_screens")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let existing = existing_ids.iter().collect::<HashSet<_>>();
        let requested = screen_ids.iter().collect::<HashSet<_>>();
        if existing.len() != requested.len()
            || existing_ids.len() != screen_ids.len()
            || existing != requested
        {
            anyhow::bail!("Screen reorder must include every Screen exactly once.");
        }

        let updated_at = Utc::now().to_rfc3339();
        for (index, screen_id) in screen_ids.iter().enumerate() {
            conn.execute(
                "UPDATE stream_screens SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
                params![screen_id, index as i64, updated_at],
            )?;
        }

        drop(conn);
        self.list_stream_screens()
    }

    pub fn active_stream_screen(&self) -> Result<Option<StreamScreen>> {
        let conn = self.lock()?;
        let Some(screen_id) = self.active_screen_id_locked(&conn)? else {
            return Ok(None);
        };
        let screen = self.stream_screen_by_id_locked(&conn, &screen_id)?;
        if screen.status == StreamScreenStatus::Ready {
            return Ok(Some(screen));
        }
        self.save_setting_locked(&conn, "activeScreenId", &Option::<String>::None)?;
        Ok(None)
    }

    pub fn stream_screen_by_id(&self, screen_id: &str) -> Result<StreamScreen> {
        let conn = self.lock()?;
        self.stream_screen_by_id_locked(&conn, screen_id)
    }

    pub fn activate_stream_screen(&self, screen_id: &str) -> Result<StreamScreen> {
        let conn = self.lock()?;
        let screen = self.stream_screen_by_id_locked(&conn, screen_id)?;
        if screen.status != StreamScreenStatus::Ready {
            anyhow::bail!("Screen image is missing and cannot be activated.");
        }
        self.save_setting_locked(&conn, "activeScreenId", &Some(screen_id.to_string()))?;
        Ok(screen)
    }

    /// Re-resolve an active takeover from its authoritative persisted row at
    /// the compositor boundary. Caller-supplied/stale paths are ignored, and
    /// a path that was swapped after activation becomes a pathless Missing
    /// screen before the image decoder can touch it.
    pub(crate) fn revalidate_stream_screen_for_compositor(
        &self,
        requested: StreamScreen,
    ) -> StreamScreen {
        match self.stream_screen_by_id(&requested.id) {
            Ok(screen) => screen,
            Err(_) => {
                // Compositor unit tests use synthetic in-memory screens that
                // deliberately have no database row. Production must fail
                // closed for the same input.
                #[cfg(test)]
                {
                    requested
                }
                #[cfg(not(test))]
                {
                    missing_stream_screen(requested)
                }
            }
        }
    }

    pub fn clear_active_stream_screen(&self) -> Result<()> {
        let conn = self.lock()?;
        self.save_setting_locked(&conn, "activeScreenId", &Option::<String>::None)
    }

    fn stream_screen_by_id_locked(
        &self,
        conn: &Connection,
        screen_id: &str,
    ) -> Result<StreamScreen> {
        let screen = self.stream_screen_by_id_raw_locked(conn, screen_id)?;
        Ok(self.validate_stream_screen(screen))
    }

    fn stream_screen_by_id_raw_locked(
        &self,
        conn: &Connection,
        screen_id: &str,
    ) -> rusqlite::Result<StreamScreen> {
        conn.query_row(
            "SELECT id, name, image_path, thumbnail_path, sort_order, status, created_at, updated_at
             FROM stream_screens
             WHERE id = ?1",
            params![screen_id],
            stream_screen_from_row,
        )
    }

    fn validate_stream_screen(&self, mut screen: StreamScreen) -> StreamScreen {
        match resolve_managed_screen_image_path(
            &self.screen_assets_dir(),
            &screen.id,
            Path::new(&screen.image_path),
        ) {
            Ok(path) => {
                screen.image_path = path.display().to_string();
                // Takeover thumbnails are not currently generated. Never echo
                // an old/tampered auxiliary path merely because the primary
                // image was valid.
                screen.thumbnail_path = None;
                screen
            }
            Err(_) => missing_stream_screen(screen),
        }
    }

    fn active_screen_id_locked(&self, conn: &Connection) -> Result<Option<String>> {
        let value_json = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'activeScreenId'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value_json {
            Some(value) => Ok(serde_json::from_str::<Option<String>>(&value)?),
            None => Ok(None),
        }
    }

    fn save_setting_locked<T: serde::Serialize>(
        &self,
        conn: &Connection,
        key: &str,
        value: &T,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    fn validate_platform_account_input(&self, account: &UpsertPlatformAccount) -> Result<()> {
        if matches!(account.platform, StreamPlatform::Custom) {
            anyhow::bail!("Custom RTMP does not support OAuth accounts.");
        }
        if account.account_id.trim().is_empty() {
            anyhow::bail!("Platform account id cannot be empty.");
        }
        if account.account_label.trim().is_empty() {
            anyhow::bail!("Platform account label cannot be empty.");
        }
        Ok(())
    }

    fn platform_account_by_platform_locked(
        &self,
        conn: &Connection,
        platform: StreamPlatform,
    ) -> Result<PlatformAccount> {
        conn.query_row(
            "SELECT id, platform, account_id, account_label, account_handle, avatar_url,
                    scopes_json, token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref,
                    expires_at, connected_at, updated_at, status
             FROM platform_accounts
             WHERE platform = ?1",
            params![stream_platform_id(platform)],
            |row| self.platform_account_from_row(row),
        )
        .map_err(Into::into)
    }

    fn platform_account_from_row(
        &self,
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<PlatformAccount> {
        let platform_id: String = row.get(1)?;
        let scopes_json: String = row.get(6)?;
        let status_json: String = row.get(13)?;
        Ok(PlatformAccount {
            id: row.get(0)?,
            platform: stream_platform_from_id(&platform_id).unwrap_or(StreamPlatform::Custom),
            account_id: row.get(2)?,
            account_label: row.get(3)?,
            account_handle: row.get(4)?,
            avatar_url: row.get(5)?,
            scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
            access_token_present: row.get::<_, Option<String>>(7)?.is_some(),
            refresh_token_present: row.get::<_, Option<String>>(8)?.is_some(),
            stream_key_present: row.get::<_, Option<String>>(9)?.is_some(),
            expires_at: row.get(10)?,
            connected_at: row.get(11)?,
            updated_at: row.get(12)?,
            status: serde_json::from_str(&status_json)
                .unwrap_or(PlatformAccountStatus::NeedsReconnect),
        })
    }

    fn platform_account_credentials_from_row(
        &self,
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<PlatformAccountCredentials> {
        let account = self.platform_account_from_row(row)?;
        Ok(PlatformAccountCredentials {
            account,
            token_secret_ref: row.get(7)?,
            refresh_token_secret_ref: row.get(8)?,
            stream_key_secret_ref: row.get(9)?,
            write_generation: row.get::<_, i64>(14)?.max(0) as u64,
        })
    }

    fn platform_account_write_expectation_locked(
        &self,
        conn: &Connection,
        platform: StreamPlatform,
    ) -> Result<PlatformAccountWriteExpectation> {
        let platform_id = stream_platform_id(platform);
        let generation = conn
            .query_row(
                "SELECT generation FROM platform_account_write_generations WHERE platform = ?1",
                params![platform_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            .max(0) as u64;
        let refs = conn
            .query_row(
                "SELECT token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref
                 FROM platform_accounts WHERE platform = ?1",
                params![platform_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        Ok(match refs {
            Some((token_secret_ref, refresh_token_secret_ref, stream_key_secret_ref)) => {
                PlatformAccountWriteExpectation {
                    exists: true,
                    token_secret_ref,
                    refresh_token_secret_ref,
                    stream_key_secret_ref,
                    generation,
                }
            }
            None => PlatformAccountWriteExpectation::absent(generation),
        })
    }

    fn set_platform_account_generation_locked(
        &self,
        conn: &Connection,
        platform: StreamPlatform,
        generation: u64,
    ) -> Result<()> {
        let generation = i64::try_from(generation)
            .context("Platform account write generation exceeded SQLite bounds")?;
        conn.execute(
            "INSERT INTO platform_account_write_generations (platform, generation)
             VALUES (?1, ?2)
             ON CONFLICT(platform) DO UPDATE SET generation = excluded.generation",
            params![stream_platform_id(platform), generation],
        )?;
        Ok(())
    }

    fn screen_assets_dir(&self) -> PathBuf {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            return parent.join("Screens");
        }

        std::env::temp_dir().join("videorc-screens")
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.lock()?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL,
                mode TEXT NOT NULL,
                output_path TEXT,
                mp4_path TEXT,
                stream_preset TEXT,
                container TEXT,
                duration_ms INTEGER,
                sources_json TEXT NOT NULL,
                layout_json TEXT NOT NULL,
                output_json TEXT NOT NULL,
                diagnostics_json TEXT,
                derived_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
                source_title TEXT,
                processing_kind TEXT
            );

            CREATE TABLE IF NOT EXISTS health_events (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                permission_pane TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_logs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                source_id TEXT,
                permission_pane TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS ai_artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                content_json TEXT NOT NULL,
                file_path TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS live_chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                provider_message_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                target_id TEXT,
                author_id TEXT,
                author_name TEXT NOT NULL,
                author_avatar_url TEXT,
                author_badges_json TEXT NOT NULL,
                author_roles_json TEXT NOT NULL,
                published_at TEXT NOT NULL,
                received_at TEXT NOT NULL,
                message_text TEXT NOT NULL,
                fragments_json TEXT NOT NULL,
                event_type TEXT NOT NULL,
                amount_text TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                raw_provider_type TEXT,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_live_chat_messages_session_received
                ON live_chat_messages(session_id, received_at, id);

            CREATE TABLE IF NOT EXISTS live_chat_send_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_text TEXT NOT NULL,
                phase_json TEXT NOT NULL,
                destinations_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_live_chat_send_operations_session_created
                ON live_chat_send_operations(session_id, created_at, id);

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stream_screens (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                image_path TEXT NOT NULL,
                thumbnail_path TEXT,
                sort_order INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS platform_accounts (
                id TEXT PRIMARY KEY,
                platform TEXT NOT NULL UNIQUE,
                account_id TEXT NOT NULL,
                account_label TEXT NOT NULL,
                account_handle TEXT,
                avatar_url TEXT,
                scopes_json TEXT NOT NULL,
                token_secret_ref TEXT,
                refresh_token_secret_ref TEXT,
                stream_key_secret_ref TEXT,
                expires_at TEXT,
                connected_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS platform_account_write_generations (
                platform TEXT PRIMARY KEY,
                generation INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS repair_jobs (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                status TEXT NOT NULL,
                intended_fps REAL,
                expect_audio INTEGER NOT NULL,
                outcome_json TEXT,
                reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_file_operations (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                session_id TEXT NOT NULL UNIQUE,
                staging_path TEXT NOT NULL,
                final_path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                staging_cleanup_path TEXT,
                staging_object_identity_json TEXT,
                published_identity_json TEXT
            );

            CREATE TABLE IF NOT EXISTS noise_cleanup_jobs (
                id TEXT PRIMARY KEY,
                source_session_id TEXT NOT NULL,
                source_identity_json TEXT NOT NULL,
                source_object_identity_json TEXT NOT NULL,
                source_full_sha256 TEXT NOT NULL,
                status TEXT NOT NULL,
                progress_percent INTEGER NOT NULL DEFAULT 0,
                preset TEXT NOT NULL,
                output_session_id TEXT,
                output_path TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY(output_session_id) REFERENCES sessions(id) ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_noise_cleanup_one_active_per_source
                ON noise_cleanup_jobs(source_session_id)
                WHERE status IN ('queued', 'processing', 'validating');
            CREATE TRIGGER IF NOT EXISTS trg_noise_cleanup_derivative_deleted
            BEFORE DELETE ON sessions
            FOR EACH ROW
            BEGIN
                UPDATE noise_cleanup_jobs
                SET status = 'failed', progress_percent = 0, output_session_id = NULL,
                    output_path = NULL, error_code = 'file-missing',
                    error_message = 'The cleaned recording was deleted.',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE output_session_id = OLD.id AND status = 'completed';
            END;

            CREATE TABLE IF NOT EXISTS session_delete_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                paths_json TEXT NOT NULL,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            ",
        )?;
        ensure_column(&conn, "sessions", "container", "container TEXT")?;
        ensure_column(&conn, "sessions", "duration_ms", "duration_ms INTEGER")?;
        ensure_column(
            &conn,
            "sessions",
            "file_size_bytes",
            "file_size_bytes INTEGER",
        )?;
        ensure_column(
            &conn,
            "sessions",
            "diagnostics_json",
            "diagnostics_json TEXT",
        )?;
        ensure_column(
            &conn,
            "session_file_operations",
            "published_identity_json",
            "published_identity_json TEXT",
        )?;
        ensure_column(
            &conn,
            "session_file_operations",
            "staging_cleanup_path",
            "staging_cleanup_path TEXT",
        )?;
        ensure_column(
            &conn,
            "session_file_operations",
            "staging_object_identity_json",
            "staging_object_identity_json TEXT",
        )?;
        ensure_column(
            &conn,
            "sessions",
            "library_hidden",
            "library_hidden INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &conn,
            "sessions",
            "derived_from_session_id",
            "derived_from_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL",
        )?;
        ensure_column(&conn, "sessions", "source_title", "source_title TEXT")?;
        ensure_column(&conn, "sessions", "processing_kind", "processing_kind TEXT")?;
        ensure_column(
            &conn,
            "noise_cleanup_jobs",
            "source_object_identity_json",
            "source_object_identity_json TEXT",
        )?;
        ensure_column(
            &conn,
            "noise_cleanup_jobs",
            "source_full_sha256",
            "source_full_sha256 TEXT",
        )?;
        conn.execute(
            "UPDATE noise_cleanup_jobs
             SET status = 'failed', progress_percent = 0,
                 source_object_identity_json = COALESCE(
                    source_object_identity_json, '{\"volumeId\":0,\"fileId\":0}'
                 ),
                 source_full_sha256 = COALESCE(source_full_sha256, 'legacy-unverified'),
                 output_session_id = NULL, output_path = NULL,
                 error_code = 'source-changed',
                 error_message = 'Noise Cleanup must be retried after the safety upgrade.',
                 updated_at = ?1
             WHERE source_object_identity_json IS NULL OR source_full_sha256 IS NULL",
            params![Utc::now().to_rfc3339()],
        )?;
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_noise_cleanup_completed_identity_preset;
             CREATE INDEX idx_noise_cleanup_completed_identity_preset
                ON noise_cleanup_jobs(source_session_id, source_identity_json,
                                      source_object_identity_json, source_full_sha256, preset)
                WHERE status = 'completed';",
        )?;
        ensure_column(
            &conn,
            "health_events",
            "permission_pane",
            "permission_pane TEXT",
        )?;
        Ok(())
    }

    /// Inserts or replaces a persisted repair job so it survives an app restart.
    pub fn upsert_repair_job(&self, job: &RepairJob) -> Result<()> {
        let conn = self.lock()?;
        let outcome_json = match &job.outcome {
            Some(value) => Some(serde_json::to_string(value)?),
            None => None,
        };
        conn.execute(
            "INSERT OR REPLACE INTO repair_jobs
                (id, file_path, status, intended_fps, expect_audio, outcome_json, reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                job.id,
                job.file_path,
                job.status.as_str(),
                job.intended_fps,
                job.expect_audio as i64,
                outcome_json,
                job.reason,
                job.created_at,
                job.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Repair jobs that were not finished (pending or running) — the set to resume on the
    /// next launch. Listing all jobs and deleting them are added with the history UI.
    pub fn incomplete_repair_jobs(&self) -> Result<Vec<RepairJob>> {
        let conn = self.lock()?;
        query_repair_jobs(&conn, "WHERE status IN ('pending', 'running')")
    }

    fn ai_artifacts_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<AiArtifact>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, status, content_json, file_path, created_at
             FROM ai_artifacts
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let kind_json: String = row.get(2)?;
            let status_json: String = row.get(3)?;
            let content_json: String = row.get(4)?;
            Ok(AiArtifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                kind: serde_json::from_str(&kind_json).unwrap_or(AiArtifactKind::Transcript),
                status: serde_json::from_str(&status_json).unwrap_or(AiArtifactStatus::Failed),
                content: serde_json::from_str(&content_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
                file_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn live_chat_message_count_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<u64> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM live_chat_messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    #[cfg(test)]
    fn live_chat_messages_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<LiveChatMessage>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, provider_message_id, platform, target_id, author_id,
                    author_name, author_avatar_url, author_badges_json, author_roles_json,
                    published_at, received_at, message_text, fragments_json, event_type,
                    amount_text, is_deleted, raw_provider_type
             FROM live_chat_messages
             WHERE session_id = ?1
             ORDER BY received_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![session_id], live_chat_message_from_row)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn latest_quality_status_for_session_locked(
        &self,
        conn: &Connection,
        output_path: Option<&str>,
        mp4_path: Option<&str>,
    ) -> Result<Option<GateStatus>> {
        let mut latest: Option<(String, GateStatus)> = None;
        let mut seen_paths = HashSet::new();

        for path in [mp4_path, output_path].into_iter().flatten() {
            if !seen_paths.insert(path) {
                continue;
            }
            let Some((updated_at, status)) = latest_quality_status_for_path_locked(conn, path)?
            else {
                continue;
            };
            let replace = latest
                .as_ref()
                .map(|(current_updated_at, _)| updated_at.as_str() > current_updated_at.as_str())
                .unwrap_or(true);
            if replace {
                latest = Some((updated_at, status));
            }
        }

        Ok(latest.map(|(_, status)| status))
    }

    fn health_events_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<HealthEvent>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, level, code, message, permission_pane, created_at
             FROM health_events
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let level_json: String = row.get(2)?;
            let permission_json: Option<String> = row.get(5)?;
            Ok(HealthEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                level: serde_json::from_str(&level_json).unwrap_or(HealthLevel::Warn),
                code: row.get(3)?,
                message: row.get(4)?,
                permission_pane: permission_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                created_at: row.get(6)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn session_logs_for_session_locked(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Vec<SessionLogEntry>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, level, code, message, source_id, permission_pane, created_at
             FROM session_logs
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let level_json: String = row.get(2)?;
            let permission_json: Option<String> = row.get(6)?;
            Ok(SessionLogEntry {
                id: row.get(0)?,
                session_id: row.get(1)?,
                level: serde_json::from_str(&level_json).unwrap_or(HealthLevel::Warn),
                code: row.get(3)?,
                message: row.get(4)?,
                source_id: row.get(5)?,
                permission_pane: permission_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                created_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("SQLite connection lock was poisoned"))
    }
}

fn stream_screen_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StreamScreen> {
    let status_json: String = row.get(5)?;
    Ok(StreamScreen {
        id: row.get(0)?,
        name: row.get(1)?,
        image_path: row.get(2)?,
        thumbnail_path: row.get(3)?,
        sort_order: row.get(4)?,
        status: serde_json::from_str(&status_json).unwrap_or(StreamScreenStatus::Missing),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn missing_stream_screen(mut screen: StreamScreen) -> StreamScreen {
    screen.status = StreamScreenStatus::Missing;
    screen.image_path.clear();
    screen.thumbnail_path = None;
    screen
}

fn validate_managed_screen_root(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| "Managed Screens directory is unavailable.")?;
    if !metadata.is_dir() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Managed Screens directory is not a direct regular directory.");
    }
    std::fs::canonicalize(root).context("Managed Screens directory could not be resolved.")
}

fn resolve_managed_screen_image_path(root: &Path, screen_id: &str, path: &Path) -> Result<PathBuf> {
    Uuid::parse_str(screen_id).context("Screen id is invalid.")?;
    let root = validate_managed_screen_root(root)?;
    let expected_name = format!("{screen_id}.png");
    if path.file_name() != Some(OsStr::new(&expected_name)) {
        bail!("Screen image does not match its managed object id.");
    }
    let parent = path
        .parent()
        .context("Screen image has no managed parent directory.")?;
    let canonical_parent = std::fs::canonicalize(parent)
        .context("Screen image parent directory could not be resolved.")?;
    if canonical_parent != root {
        bail!("Screen image is outside the managed Screens directory.");
    }
    let metadata = std::fs::symlink_metadata(path)
        .context("Screen image is missing or could not be inspected.")?;
    if !metadata.is_file() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Screen image is not a direct regular file.");
    }
    let canonical = std::fs::canonicalize(path).context("Screen image could not be resolved.")?;
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name() != Some(OsStr::new(&expected_name))
    {
        bail!("Screen image escaped the managed Screens directory.");
    }
    let opened = File::open(&canonical).context("Screen image could not be opened.")?;
    if !opened
        .metadata()
        .context("Screen image metadata could not be read.")?
        .is_file()
    {
        bail!("Screen image is not a regular file.");
    }
    Ok(canonical)
}

fn metadata_is_symlink_or_reparse(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn live_chat_cursor(message: &LiveChatMessage) -> String {
    format!("{}\n{}", message.received_at, message.id)
}

fn parse_live_chat_cursor(cursor: &str) -> Result<(&str, &str)> {
    let (received_at, id) = cursor
        .split_once('\n')
        .ok_or_else(|| anyhow::anyhow!("Comments cursor is invalid."))?;
    if received_at.is_empty()
        || id.is_empty()
        || received_at.len() > 128
        || id.len() > 512
        || id.contains('\n')
    {
        bail!("Comments cursor is invalid.");
    }
    Ok((received_at, id))
}

fn live_chat_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiveChatMessage> {
    let platform_id: String = row.get(3)?;
    let author_badges_json: String = row.get(8)?;
    let author_roles_json: String = row.get(9)?;
    let fragments_json: String = row.get(13)?;
    let event_type_json: String = row.get(14)?;
    Ok(LiveChatMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        provider_message_id: row.get(2)?,
        platform: stream_platform_from_id(&platform_id).unwrap_or(StreamPlatform::Custom),
        target_id: row.get(4)?,
        author_id: row.get(5)?,
        author_name: row.get(6)?,
        author_avatar_url: row.get(7)?,
        author_badges: serde_json::from_str(&author_badges_json).unwrap_or_default(),
        author_roles: serde_json::from_str(&author_roles_json).unwrap_or_default(),
        published_at: row.get(10)?,
        received_at: row.get(11)?,
        message_text: row.get(12)?,
        fragments: serde_json::from_str::<Vec<LiveChatMessageFragment>>(&fragments_json)
            .unwrap_or_default(),
        event_type: serde_json::from_str::<LiveChatEventType>(&event_type_json)
            .unwrap_or(LiveChatEventType::Message),
        amount_text: row.get(15)?,
        is_deleted: row.get(16)?,
        raw_provider_type: row.get(17)?,
    })
}

fn chat_send_operation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CommentsSendOperation> {
    let phase_json: String = row.get(3)?;
    let destinations_json: String = row.get(4)?;
    let phase = serde_json::from_str(&phase_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let destinations = serde_json::from_str(&destinations_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CommentsSendOperation {
        id: row.get(0)?,
        session_id: row.get(1)?,
        text: row.get(2)?,
        phase,
        destinations,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn noise_cleanup_job_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PersistedNoiseCleanupJob> {
    let status_text: String = row.get(5)?;
    let status = status_text.parse().map_err(|error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    let progress: i64 = row.get(6)?;
    let source_identity_json: String = row.get(2)?;
    let source_content_identity = serde_json::from_str(&source_identity_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let source_object_identity_json: String = row.get(3)?;
    let source_object_identity =
        serde_json::from_str(&source_object_identity_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(PersistedNoiseCleanupJob {
        job: NoiseCleanupJob {
            id: row.get(0)?,
            source_session_id: row.get(1)?,
            status,
            progress_percent: u8::try_from(progress.clamp(0, 100)).unwrap_or(0),
            preset: row.get(7)?,
            output_session_id: row.get(8)?,
            output_path: row.get(9)?,
            error_code: row.get(10)?,
            error_message: row.get(11)?,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        },
        source_identity: SessionFileBoundIdentity {
            content_identity: source_content_identity,
            object_identity: source_object_identity,
        },
        source_full_sha256: row.get(4)?,
    })
}

fn query_noise_cleanup_jobs<P: rusqlite::Params>(
    conn: &Connection,
    filter: &str,
    params: P,
) -> Result<Vec<PersistedNoiseCleanupJob>> {
    let sql = format!(
        "SELECT id, source_session_id, source_identity_json, source_object_identity_json,
                source_full_sha256, status, progress_percent, preset,
                output_session_id, output_path, error_code, error_message, created_at, updated_at
         FROM noise_cleanup_jobs {filter}"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params, noise_cleanup_job_from_row)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn query_one_noise_cleanup_job<P: rusqlite::Params>(
    conn: &Connection,
    filter: &str,
    params: P,
) -> Result<Option<PersistedNoiseCleanupJob>> {
    let mut jobs = query_noise_cleanup_jobs(conn, filter, params)?;
    Ok(jobs.pop())
}

fn query_repair_jobs(conn: &Connection, filter: &str) -> Result<Vec<RepairJob>> {
    let sql = format!(
        "SELECT id, file_path, status, intended_fps, expect_audio, outcome_json, reason, created_at, updated_at
         FROM repair_jobs {filter} ORDER BY created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        let status: String = row.get(2)?;
        let expect_audio: i64 = row.get(4)?;
        let outcome_json: Option<String> = row.get(5)?;
        Ok(RepairJob {
            id: row.get(0)?,
            file_path: row.get(1)?,
            status: RepairJobStatus::from_db(&status),
            intended_fps: row.get(3)?,
            expect_audio: expect_audio != 0,
            outcome: outcome_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok()),
            reason: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn latest_quality_status_for_path_locked(
    conn: &Connection,
    file_path: &str,
) -> Result<Option<(String, GateStatus)>> {
    let mut stmt = conn.prepare(
        "SELECT outcome_json, reason, updated_at, status
         FROM repair_jobs
         WHERE file_path = ?1
           AND status IN ('completed', 'running')
           AND outcome_json IS NOT NULL
         ORDER BY updated_at DESC, created_at DESC",
    )?;
    let rows = stmt.query_map(params![file_path], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    for row in rows {
        let (outcome_json, reason, updated_at, job_status) = row?;
        if let Ok(status) = serde_json::from_str::<GateStatus>(&outcome_json) {
            if reason.as_deref().is_some_and(|value| !value.is_empty())
                && matches!(
                    status,
                    GateStatus::Ready { .. } | GateStatus::Repaired { .. }
                )
            {
                continue;
            }
            if job_status == "running"
                && matches!(
                    status,
                    GateStatus::Ready { .. } | GateStatus::Repaired { .. }
                )
            {
                continue;
            }
            return Ok(Some((updated_at, status)));
        }
    }

    Ok(None)
}

/// Human label for a session's composition (Library rewrite L1): the layout
/// preset name, or the stream preset for stream-only sessions. Pure + tested.
pub fn session_scene_label(
    layout: &LayoutSettings,
    stream_preset: Option<&str>,
    mode: &str,
) -> Option<String> {
    if mode == "streaming"
        && let Some(preset) = stream_preset
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Some(preset.to_string());
    }
    Some(
        match layout.layout_preset {
            crate::protocol::LayoutPreset::ScreenCamera => "Screen + Camera",
            crate::protocol::LayoutPreset::ScreenOnly => "Screen only",
            crate::protocol::LayoutPreset::CameraOnly => "Camera only",
            crate::protocol::LayoutPreset::SideBySide => "Side by side",
            crate::protocol::LayoutPreset::VerticalCameraTop => "Vertical · Camera top",
            crate::protocol::LayoutPreset::VerticalCameraBottom => "Vertical · Camera bottom",
            crate::protocol::LayoutPreset::VerticalSplit => "Vertical · Split",
            crate::protocol::LayoutPreset::VerticalScreenCamera => "Vertical · Screen + Camera",
            crate::protocol::LayoutPreset::VerticalScreenOnly => "Vertical · Screen only",
            crate::protocol::LayoutPreset::VerticalCameraOnly => "Vertical · Camera only",
        }
        .to_string(),
    )
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;

    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])?;
    Ok(())
}

#[allow(dead_code)]
fn normalized_scopes(scopes: Vec<String>) -> Vec<String> {
    let mut scopes = scopes
        .into_iter()
        .map(|scope| scope.trim().to_string())
        .filter(|scope| !scope.is_empty())
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

pub fn default_database_path() -> PathBuf {
    // Smokes and probes run alongside the owner's real instance; an isolated
    // database (secrets and preview dirs derive from its parent) keeps their
    // assertions away from real accounts and keys.
    if let Some(custom) = std::env::var_os("VIDEORC_DATABASE_PATH") {
        return PathBuf::from(custom);
    }

    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("Videorc")
            .join("videorc.sqlite3")
    }
    #[cfg(target_os = "windows")]
    {
        // %APPDATA% (roaming) is the conventional per-user app data root.
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("Videorc")
            .join("videorc.sqlite3")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home_dir().join(".videorc").join("videorc.sqlite3")
    }
}

fn home_dir() -> PathBuf {
    let var = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_preview_dir() -> PathBuf {
    default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Previews")
}

pub fn default_artifacts_dir() -> PathBuf {
    default_database_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Artifacts")
}

fn validate_screen_image_source(path: &Path) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("Screen image does not exist: {}", path.display());
    }
    if !path.is_file() {
        anyhow::bail!("Screen image is not a file: {}", path.display());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        anyhow::bail!("Screen image must be PNG, JPEG, or WebP.");
    }

    Ok(())
}

fn optimize_screen_image(
    source_path: &Path,
    destination_path: &Path,
    ffmpeg_path: &str,
) -> Result<()> {
    let filter = concat!(
        "[0:v]scale=3840:2160:force_original_aspect_ratio=increase,",
        "crop=3840:2160,gblur=sigma=30,format=rgba,colorchannelmixer=aa=1[bg];",
        "[0:v]scale=3840:2160:force_original_aspect_ratio=decrease[fg];",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24[out]"
    );
    let mut command = Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(source_path)
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg("[out]")
        .arg("-frames:v")
        .arg("1")
        .arg(destination_path);
    let output = output_owned_std(&mut command)
        .with_context(|| format!("Could not start {ffmpeg_path} for Screen image import"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!(
        "Could not optimize Screen image{}",
        if stderr.is_empty() {
            ".".to_string()
        } else {
            format!(": {stderr}")
        }
    );
}

fn screen_name_from_path(image_path: &str) -> String {
    let stem = Path::new(image_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Screen");
    let words = stem
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(title_case_word)
        .collect::<Vec<_>>();
    if words.is_empty() {
        "Screen".to_string()
    } else {
        words.join(" ")
    }
}

fn title_case_word(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::session_scene_label;

    #[test]
    fn scene_labels_map_presets_and_stream_presets() {
        let mut layout = crate::protocol::default_layout_settings();
        layout.layout_preset = crate::protocol::LayoutPreset::ScreenCamera;
        assert_eq!(
            session_scene_label(&layout, None, "recording").as_deref(),
            Some("Screen + Camera")
        );
        layout.layout_preset = crate::protocol::LayoutPreset::SideBySide;
        assert_eq!(
            session_scene_label(&layout, None, "recording").as_deref(),
            Some("Side by side")
        );
        // Stream-only sessions prefer the stream preset name.
        assert_eq!(
            session_scene_label(&layout, Some("1080p60"), "streaming").as_deref(),
            Some("1080p60")
        );
        // Blank stream presets fall through to the layout label.
        assert_eq!(
            session_scene_label(&layout, Some("  "), "streaming").as_deref(),
            Some("Side by side")
        );
    }

    use super::*;
    use crate::live_chat::{
        CommentsSendOperation, CommentsSendOperationPhase, DestinationDelivery,
        DestinationDeliveryPhase, LiveChatEventType, LiveChatMessage, LiveChatMessageFragment,
        live_chat_message_id,
    };
    use crate::protocol::{
        CameraCorner, CameraFit, CameraShape, CameraSize, CameraTransformMode, LayoutPreset,
        OutputSettings, PermissionPane, RtmpPreset, RtmpSettings, SideBySideCameraSide,
        SideBySideSplit, VideoPreset, VideoSettings,
    };
    use crate::streaming::{
        PlatformAccountStatus, StreamPlatform, StreamPrivacy, UpsertPlatformAccount,
        default_stream_metadata_draft,
    };

    fn test_database() -> Database {
        let database = Database {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            path: PathBuf::from(":memory:"),
        };
        database.migrate().unwrap();
        database
    }

    fn sampled_identity_collision_bytes(middle: u8) -> Vec<u8> {
        let mut bytes = vec![0x31; 192 * 1024];
        bytes[64 * 1024..128 * 1024].fill(middle);
        bytes
    }

    #[test]
    fn object_bound_identity_accepts_only_timestamp_drift_for_the_same_sampled_bytes() {
        let expected_content = SessionFileIdentity {
            len: 42,
            modified_unix_nanos: Some(100),
            sample_sha256: "sample-a".to_string(),
        };
        let expected_object = SessionFileObjectIdentity {
            volume_id: 7,
            file_id: 11,
        };
        let timestamp_drift = SessionFileBoundIdentity {
            content_identity: SessionFileIdentity {
                modified_unix_nanos: Some(200),
                ..expected_content.clone()
            },
            object_identity: expected_object.clone(),
        };

        assert!(session_file_bound_identity_matches(
            &timestamp_drift,
            &expected_content,
            Some(&expected_object),
        ));
        assert!(!session_file_bound_identity_matches(
            &timestamp_drift,
            &expected_content,
            None,
        ));

        let different_object = SessionFileBoundIdentity {
            object_identity: SessionFileObjectIdentity {
                volume_id: 7,
                file_id: 12,
            },
            ..timestamp_drift.clone()
        };
        assert!(!session_file_bound_identity_matches(
            &different_object,
            &expected_content,
            Some(&expected_object),
        ));

        let different_sample = SessionFileBoundIdentity {
            content_identity: SessionFileIdentity {
                sample_sha256: "sample-b".to_string(),
                ..timestamp_drift.content_identity
            },
            object_identity: expected_object.clone(),
        };
        assert!(!session_file_bound_identity_matches(
            &different_sample,
            &expected_content,
            Some(&expected_object),
        ));
    }

    fn oauth_account(account_id: &str, token_ref: &str) -> UpsertPlatformAccount {
        UpsertPlatformAccount {
            platform: StreamPlatform::X,
            account_id: account_id.to_string(),
            account_label: account_id.to_string(),
            account_handle: Some(format!("@{account_id}")),
            avatar_url: None,
            scopes: vec!["users.read".to_string()],
            token_secret_ref: Some(token_ref.to_string()),
            refresh_token_secret_ref: Some(format!("{token_ref}:refresh")),
            stream_key_secret_ref: None,
            expires_at: None,
            status: PlatformAccountStatus::Connected,
        }
    }

    fn file_database() -> (Database, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("videorc-storage-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("videorc.sqlite3");
        let database = Database {
            conn: Arc::new(Mutex::new(Connection::open(&path).unwrap())),
            path: path.clone(),
        };
        database.migrate().unwrap();
        (database, path)
    }

    fn create_owned_mp4_staging_directory(
        parent: &Path,
        label: &str,
        bytes: Option<&[u8]>,
    ) -> (PathBuf, PathBuf, PathBuf, SessionFileObjectIdentity) {
        let directory = parent.join(format!(".{label}.partial"));
        let output = directory.join("export.mp4");
        let cleanup = parent.join(format!(".{label}.cleanup"));
        std::fs::create_dir(&directory).unwrap();
        let directory_identity = capture_session_directory_object_identity(&directory)
            .unwrap()
            .unwrap();
        if let Some(bytes) = bytes {
            std::fs::write(&output, bytes).unwrap();
        }
        (directory, output, cleanup, directory_identity)
    }

    struct CommittedMp4RecoveryFixture {
        output: PathBuf,
        mp4: PathBuf,
        recovery: PathBuf,
    }

    fn create_committed_mp4_recovery_fixture(
        database: &Database,
        directory: &Path,
        session_id: &str,
    ) -> CommittedMp4RecoveryFixture {
        let output = directory.join(format!("{session_id}.mkv"));
        let staging = directory.join(format!(".{session_id}.partial.mp4"));
        let mp4 = directory.join(format!("{session_id}.mp4"));
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&mp4, b"owned mp4").unwrap();
        let output_ownership = capture_session_file_bound_identity(&output)
            .unwrap()
            .unwrap();
        let mut session = sample_session(session_id);
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        database
            .finish_session(
                session_id,
                "completed",
                Some("2026-07-12T12:00:00Z".to_string()),
                Some(mp4.display().to_string()),
                Some(9_876),
            )
            .unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(session_id, 30, "record");
        let intent = SessionFinalization::new(
            session_id,
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            Some(output_ownership.content_identity),
            Some(staging.display().to_string()),
            capture_session_file_identity(&mp4).unwrap(),
            true,
        )
        .with_output_file_object_identity(output_ownership.object_identity);
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        CommittedMp4RecoveryFixture {
            output,
            mp4,
            recovery,
        }
    }

    fn assert_file_object_identity_survives_write_and_rename() {
        let directory = std::env::temp_dir().join(format!("videorc-object-id-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let staging = directory.join("staging.partial");
        let published = directory.join("published.mp4");
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .unwrap();
        let before = capture_session_file_object_identity_from_file(&file, &staging).unwrap();
        file.write_all(b"content written after identity binding")
            .unwrap();
        file.sync_all().unwrap();
        drop(file);
        crate::session_ops::rename_session_file_no_replace(&staging, &published).unwrap();

        assert_eq!(
            capture_session_file_object_identity(&published).unwrap(),
            Some(before)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_file_object_identity_survives_write_and_rename() {
        assert_file_object_identity_survives_write_and_rename();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_file_object_identity_survives_write_and_rename() {
        assert_file_object_identity_survives_write_and_rename();
    }

    fn temp_screen_image(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("videorc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, b"not a real image").unwrap();
        path
    }

    fn import_stub_screen(database: &Database, name: &str) -> StreamScreen {
        let path = temp_screen_image(name);
        database
            .import_screen_image_with_optimizer(path.to_str().unwrap(), |_, destination| {
                std::fs::write(destination, b"optimized").unwrap();
                Ok(())
            })
            .unwrap()
    }

    fn sample_session(id: &str) -> NewSession {
        NewSession {
            id: id.to_string(),
            title: "Test session".to_string(),
            started_at: "2026-05-31T00:00:00Z".to_string(),
            mode: "record".to_string(),
            output_path: Some("/tmp/videorc-test.mkv".to_string()),
            container: Some("mkv".to_string()),
            stream_preset: None,
            sources: SourceSelection {
                screen_id: Some("screen:avfoundation:1".to_string()),
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: false,
            },
            layout: LayoutSettings {
                layout_preset: LayoutPreset::ScreenCamera,
                camera_transform_mode: CameraTransformMode::Preset,
                camera_transform: None,
                camera_corner: CameraCorner::BottomRight,
                camera_size: CameraSize::Medium,
                camera_shape: CameraShape::Rectangle,
                camera_corner_radius_pct: 12,
                camera_aspect: crate::protocol::CameraAspect::Source,
                camera_margin: 32,
                camera_fit: CameraFit::Fill,
                camera_mirror: false,
                camera_zoom: 100,
                camera_offset_x: 0,
                camera_offset_y: 0,
                side_by_side_split: SideBySideSplit::SeventyThirty,
                side_by_side_camera_side: SideBySideCameraSide::Right,
                camera_chroma_key_enabled: false,
                camera_chroma_key_color: "#00FF00".to_string(),
                camera_chroma_key_similarity_pct: 40,
                camera_chroma_key_smoothness_pct: 8,
                camera_chroma_key_spill_pct: 10,
            },
            output: OutputSettings {
                record_enabled: true,
                stream_enabled: false,
                output_directory: None,
                ffmpeg_path: None,
                video: VideoSettings {
                    preset: VideoPreset::Tutorial1440p30,
                    width: 2560,
                    height: 1440,
                    fps: 30,
                    bitrate_kbps: 8000,
                },
                rtmp: RtmpSettings {
                    preset: RtmpPreset::Custom,
                    server_url: String::new(),
                    stream_key: String::new(),
                },
            },
        }
    }

    fn sample_live_chat_message(session_id: &str, seq: u32) -> LiveChatMessage {
        let provider_message_id = format!("provider-{seq}");
        LiveChatMessage {
            id: live_chat_message_id(
                session_id,
                StreamPlatform::Youtube,
                Some("target-youtube"),
                &provider_message_id,
            ),
            provider_message_id,
            platform: StreamPlatform::Youtube,
            target_id: Some("target-youtube".to_string()),
            session_id: session_id.to_string(),
            author_id: Some(format!("author-{seq}")),
            author_name: format!("Viewer {seq}"),
            author_avatar_url: None,
            author_badges: vec!["member".to_string()],
            author_roles: Vec::new(),
            published_at: format!("2026-06-06T00:00:0{seq}Z"),
            received_at: format!("2026-06-06T00:00:1{seq}Z"),
            message_text: format!("hello {seq}"),
            fragments: vec![LiveChatMessageFragment {
                fragment_type: "text".to_string(),
                text: format!("hello {seq}"),
                image_url: None,
            }],
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: Some("textMessageEvent".to_string()),
        }
    }

    #[test]
    fn boot_reconcile_fails_orphaned_running_sessions_and_leaves_finished_ones() {
        let database = Database::open_in_memory_for_tests();
        database.create_session(&sample_session("orphan")).unwrap();
        database.create_session(&sample_session("done")).unwrap();
        database
            .finish_session(
                "done",
                "completed",
                Some("2026-05-31T00:01:00Z".to_string()),
                None,
                Some(60_000),
            )
            .unwrap();

        let reconciled = database.reconcile_orphaned_sessions().unwrap();
        assert_eq!(reconciled, 1);

        let sessions = database.list_sessions(10).unwrap();
        let orphan = sessions.iter().find(|s| s.id == "orphan").unwrap();
        let done = sessions.iter().find(|s| s.id == "done").unwrap();
        assert_eq!(orphan.status, "failed");
        assert!(orphan.ended_at.is_some());
        assert_eq!(done.status, "completed");

        // Second boot is a no-op.
        assert_eq!(database.reconcile_orphaned_sessions().unwrap(), 0);
    }

    #[test]
    fn default_database_path_uses_application_support_on_macos() {
        let path = default_database_path();
        let rendered = path.display().to_string();

        assert!(rendered.contains("Videorc"));
        assert!(rendered.ends_with("videorc.sqlite3"));
    }

    #[test]
    fn session_payload_round_trips_through_json() {
        let layout = LayoutSettings {
            layout_preset: LayoutPreset::ScreenOnly,
            camera_transform_mode: CameraTransformMode::Preset,
            camera_transform: None,
            camera_corner: CameraCorner::BottomRight,
            camera_size: CameraSize::Medium,
            camera_shape: CameraShape::Circle,
            camera_corner_radius_pct: 12,
            camera_aspect: crate::protocol::CameraAspect::Source,
            camera_margin: 32,
            camera_fit: CameraFit::Fill,
            camera_mirror: true,
            camera_zoom: 125,
            camera_offset_x: 10,
            camera_offset_y: -5,
            side_by_side_split: SideBySideSplit::SixtyForty,
            side_by_side_camera_side: SideBySideCameraSide::Left,
            camera_chroma_key_enabled: false,
            camera_chroma_key_color: "#00FF00".to_string(),
            camera_chroma_key_similarity_pct: 40,
            camera_chroma_key_smoothness_pct: 8,
            camera_chroma_key_spill_pct: 10,
        };
        let sources = SourceSelection {
            screen_id: Some("screen:avfoundation:1".to_string()),
            window_id: None,
            camera_id: Some("camera:avfoundation:0".to_string()),
            microphone_id: Some("microphone:avfoundation:0".to_string()),
            test_pattern: false,
        };
        let output = OutputSettings {
            record_enabled: true,
            stream_enabled: true,
            output_directory: None,
            ffmpeg_path: None,
            video: VideoSettings {
                preset: VideoPreset::Tutorial1440p30,
                width: 2560,
                height: 1440,
                fps: 30,
                bitrate_kbps: 8000,
            },
            rtmp: RtmpSettings {
                preset: RtmpPreset::YouTube,
                server_url: "rtmp://a.rtmp.youtube.com/live2".to_string(),
                stream_key: "abc".to_string(),
            },
        };

        assert!(
            serde_json::to_string(&layout)
                .unwrap()
                .contains("bottom-right")
        );
        assert!(serde_json::to_string(&sources).unwrap().contains("screen:"));
        assert!(serde_json::to_string(&output).unwrap().contains("youtube"));
    }

    #[test]
    fn session_logs_and_permission_actions_round_trip() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        database
            .add_health_event(
                Some("session-1"),
                HealthLevel::Warn,
                "camera-source-unavailable",
                "Camera permission denied.",
            )
            .unwrap();
        database
            .add_session_log(
                "session-1",
                HealthLevel::Error,
                "screen-capture-fallback",
                "Screen recording permission denied.",
                Some("screen:avfoundation:1"),
            )
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        let session = sessions.first().unwrap();

        assert_eq!(
            session.health_events[0].permission_pane,
            Some(PermissionPane::Camera)
        );
        assert_eq!(
            session.session_logs[0].permission_pane,
            Some(PermissionPane::ScreenRecording)
        );
        assert_eq!(
            session.session_logs[0].source_id.as_deref(),
            Some("screen:avfoundation:1")
        );
    }

    #[test]
    fn live_chat_messages_round_trip_and_count_on_session_summary() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        let error = database
            .save_live_chat_message(&sample_live_chat_message("missing-session", 9))
            .unwrap_err();
        assert!(error.to_string().contains("missing session"));
        database
            .save_live_chat_message(&sample_live_chat_message("session-1", 1))
            .unwrap();
        let mut updated = sample_live_chat_message("session-1", 1);
        updated.message_text = "edited/deleted text".to_string();
        updated.is_deleted = true;
        database.save_live_chat_message(&updated).unwrap();
        database
            .save_live_chat_message(&sample_live_chat_message("session-1", 2))
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(sessions[0].comment_count, 2);

        let messages = database.list_live_chat_messages("session-1").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].id,
            "session-1:youtube:target-youtube:provider-1"
        );
        assert_eq!(messages[0].message_text, "edited/deleted text");
        assert!(messages[0].is_deleted);
        assert_eq!(messages[1].fragments[0].text, "hello 2");
    }

    #[test]
    fn live_chat_batch_persistence_and_cursor_pages_are_bounded_and_stable() {
        let database = test_database();
        database
            .create_session(&sample_session("session-page"))
            .unwrap();
        let messages = (1..=5)
            .map(|sequence| sample_live_chat_message("session-page", sequence))
            .collect::<Vec<_>>();
        database.save_live_chat_messages(&messages).unwrap();

        let newest = database
            .list_live_chat_messages_page("session-page", None, 2)
            .unwrap();
        assert_eq!(
            newest
                .messages
                .iter()
                .map(|message| message.provider_message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["provider-4", "provider-5"]
        );
        let older = database
            .list_live_chat_messages_page("session-page", newest.next_cursor.as_deref(), 2)
            .unwrap();
        assert_eq!(
            older
                .messages
                .iter()
                .map(|message| message.provider_message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["provider-2", "provider-3"]
        );
        let oldest = database
            .list_live_chat_messages_page("session-page", older.next_cursor.as_deref(), 200)
            .unwrap();
        assert_eq!(oldest.messages.len(), 1);
        assert_eq!(oldest.messages[0].provider_message_id, "provider-1");
        assert!(oldest.next_cursor.is_none());

        let error = database
            .list_live_chat_messages_page("session-page", Some("not-a-cursor"), 2)
            .unwrap_err();
        assert!(error.to_string().contains("cursor"));
    }

    #[test]
    fn chat_send_operations_round_trip_and_recover_without_retrying() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();
        let operation = CommentsSendOperation {
            id: "5b0d17a0-8a49-4ef7-a187-6b115ec9cc48".to_string(),
            session_id: "session-1".to_string(),
            text: "hello all".to_string(),
            phase: CommentsSendOperationPhase::Sending,
            destinations: vec![DestinationDelivery {
                destination_id: "twitch".to_string(),
                platform: StreamPlatform::Twitch,
                phase: DestinationDeliveryPhase::Pending,
                provider_message_id: None,
                reason: None,
            }],
            created_at: "2026-07-10T00:00:00Z".to_string(),
            updated_at: "2026-07-10T00:00:00Z".to_string(),
        };
        database.save_chat_send_operation(&operation).unwrap();
        assert_eq!(
            database.get_chat_send_operation(&operation.id).unwrap(),
            Some(operation.clone())
        );

        assert_eq!(
            database.reconcile_orphaned_chat_send_operations().unwrap(),
            1
        );
        let recovered = database
            .get_chat_send_operation(&operation.id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.phase, CommentsSendOperationPhase::DeliveryUnknown);
        assert_eq!(
            recovered.destinations[0].phase,
            DestinationDeliveryPhase::TimedOutUnknown
        );
        assert_eq!(
            recovered.destinations[0].reason.as_deref(),
            Some("interrupted-before-confirmation")
        );
        assert_eq!(
            database.list_chat_send_operations("session-1").unwrap(),
            vec![recovered]
        );
    }

    #[test]
    fn same_provider_message_id_is_distinct_across_sessions() {
        let database = test_database();
        for session_id in ["session-1", "session-2"] {
            database
                .create_session(&sample_session(session_id))
                .unwrap();
            database
                .save_live_chat_message(&sample_live_chat_message(session_id, 1))
                .unwrap();
        }
        let first = database.list_live_chat_messages("session-1").unwrap();
        let second = database.list_live_chat_messages("session-2").unwrap();
        assert_ne!(first[0].id, second[0].id);
        assert_eq!(first[0].provider_message_id, second[0].provider_message_id);
    }

    #[test]
    fn session_recording_path_stays_on_the_original_container() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        assert_eq!(
            database
                .session_recording_path("session-1")
                .unwrap()
                .as_deref(),
            Some("/tmp/videorc-test.mkv")
        );

        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                None,
            )
            .unwrap();

        assert_eq!(
            database
                .session_recording_path("session-1")
                .unwrap()
                .as_deref(),
            Some("/tmp/videorc-test.mkv")
        );
    }

    #[test]
    fn session_media_candidates_lists_all_paths_in_preference_order() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        // Before the mp4 export exists: only the original container.
        assert_eq!(
            database.session_media_candidates("session-1").unwrap(),
            vec!["/tmp/videorc-test.mkv".to_string()]
        );

        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                None,
            )
            .unwrap();

        // mp4 preferred, but the original stays available as a fallback for
        // callers that check disk existence (AI extraction).
        assert_eq!(
            database.session_media_candidates("session-1").unwrap(),
            vec![
                "/tmp/videorc-test.mp4".to_string(),
                "/tmp/videorc-test.mkv".to_string()
            ]
        );

        assert!(
            database
                .session_media_candidates("missing-session")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn session_summary_includes_saved_final_diagnostics() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();

        let mut diagnostics = crate::diagnostics::starting_diagnostics("session-1", 30, "record");
        diagnostics.encoder_bridge_repeated_frames = 4;
        diagnostics.encoder_bridge_repeated_frame_bursts = 1;
        diagnostics.encoder_bridge_max_repeated_frame_run = 3;
        diagnostics.recording_at_risk = true;
        diagnostics
            .recording_risk_reasons
            .push("4 duplicate frame(s) re-fed to the encoder".to_string());
        database
            .save_session_diagnostics("session-1", &diagnostics)
            .unwrap();

        let sessions = database.list_sessions(1).unwrap();
        let final_diagnostics = sessions[0]
            .final_diagnostics
            .as_ref()
            .expect("final diagnostics");
        assert_eq!(final_diagnostics.session_id.as_deref(), Some("session-1"));
        assert_eq!(final_diagnostics.encoder_bridge_repeated_frames, 4);
        assert!(final_diagnostics.recording_at_risk);
        assert_eq!(
            final_diagnostics.recording_risk_reasons,
            vec!["4 duplicate frame(s) re-fed to the encoder".to_string()]
        );
    }

    #[test]
    fn terminal_session_writes_reject_a_missing_row() {
        let database = test_database();
        let diagnostics = crate::diagnostics::starting_diagnostics("missing", 30, "record");

        assert!(
            database
                .finish_session("missing", "completed", None, None, None)
                .unwrap_err()
                .to_string()
                .contains("row is missing")
        );
        assert!(
            database
                .save_session_diagnostics("missing", &diagnostics)
                .unwrap_err()
                .to_string()
                .contains("row is missing")
        );
    }

    #[test]
    fn finalization_commits_metadata_and_diagnostics_together() {
        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();
        let mut diagnostics = crate::diagnostics::starting_diagnostics("session-1", 30, "record");
        diagnostics.recording_at_risk = true;
        let finalization = SessionFinalization::new(
            "session-1",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some("/tmp/videorc-test.mp4".to_string()),
            Some(12_345),
            &diagnostics,
        )
        .unwrap();

        database
            .finalize_session_with_diagnostics(&finalization)
            .unwrap();

        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.status, "completed");
        assert_eq!(session.duration_ms, Some(12_345));
        assert_eq!(session.mp4_path.as_deref(), Some("/tmp/videorc-test.mp4"));
        assert!(session.final_diagnostics.unwrap().recording_at_risk);
    }

    #[test]
    fn startup_replays_a_persisted_finalization_recovery() {
        let (database, database_path) = file_database();
        database
            .create_session(&sample_session("session-recovery"))
            .unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-recovery", 30, "record");
        let finalization = SessionFinalization::new(
            "session-recovery",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some("/tmp/recovered.mp4".to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap();
        let recovery_path = database
            .persist_session_finalization_recovery(&finalization)
            .unwrap();
        drop(database);

        let reopened = Database {
            conn: Arc::new(Mutex::new(Connection::open(&database_path).unwrap())),
            path: database_path.clone(),
        };
        reopened.migrate().unwrap();
        let summary = reopened
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery_path.exists());
        let session = reopened.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.status, "completed");
        assert_eq!(session.duration_ms, Some(9_876));
        assert_eq!(session.mp4_path.as_deref(), Some("/tmp/recovered.mp4"));

        drop(reopened);
        std::fs::remove_dir_all(database_path.parent().unwrap()).unwrap();
    }

    #[test]
    fn startup_replays_write_ahead_intent_before_mp4_export_as_owned_mkv() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let preferred_mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mut session = sample_session("session-before-export");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-before-export", 30, "record");
        let intent = SessionFinalization::new(
            "session-before-export",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(preferred_mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            None,
            false,
        );
        database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.status, "completed");
        assert_eq!(session.mp4_path, None);
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_cleans_owned_mp4_directory_after_crash_before_ffmpeg_writes() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let preferred_mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(directory, "before-write", None);
        assert!(!staging.exists(), "FFmpeg child must start absent for -n");

        let mut session = sample_session("session-before-ffmpeg-write");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-before-ffmpeg-write", 30, "record");
        let intent = SessionFinalization::new(
            "session-before-ffmpeg-write",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(preferred_mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            None,
            false,
        )
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert!(!staging_directory.exists());
        assert!(!cleanup_directory.exists());
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_cleans_owned_mp4_directory_after_crash_during_ffmpeg_write() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let preferred_mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(
                directory,
                "during-write",
                Some(b"interrupted ffmpeg bytes"),
            );

        let mut session = sample_session("session-during-ffmpeg-write");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-during-ffmpeg-write", 30, "record");
        let intent = SessionFinalization::new(
            "session-during-ffmpeg-write",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(preferred_mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            None,
            false,
        )
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert!(!staging_directory.exists());
        assert!(!cleanup_directory.exists());
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_retires_journaled_mp4_candidate_collision_without_touching_candidate() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let candidate = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&candidate, b"unrelated existing candidate").unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(
                directory,
                "candidate-collision",
                Some(b"completed staged mp4"),
            );
        let staging_identity = capture_session_file_identity(&staging).unwrap();
        let staging_object_identity = capture_session_file_object_identity(&staging)
            .unwrap()
            .unwrap();

        let mut session = sample_session("session-candidate-collision");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-candidate-collision", 30, "record");
        let intent = SessionFinalization::new(
            "session-candidate-collision",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(candidate.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            staging_identity,
            true,
        )
        .with_mp4_staging_file_object_identity(staging_object_identity)
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists(), "collision recovery must retire");
        assert_eq!(
            std::fs::read(&candidate).unwrap(),
            b"unrelated existing candidate"
        );
        assert!(!staging_directory.exists());
        assert!(!cleanup_directory.exists());
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_adopts_published_mp4_through_owned_directory_then_cleans_workspace() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let published = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let output_ownership = capture_session_file_bound_identity(&output)
            .unwrap()
            .unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(directory, "published-crash", None);
        std::fs::write(&published, b"completed published mp4").unwrap();
        let published_identity = capture_session_file_identity(&published).unwrap();
        let published_object_identity = capture_session_file_object_identity(&published)
            .unwrap()
            .unwrap();

        let mut session = sample_session("session-published-owned-directory");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(
            "session-published-owned-directory",
            30,
            "record",
        );
        let intent = SessionFinalization::new(
            "session-published-owned-directory",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(published.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            Some(output_ownership.content_identity),
            Some(staging.display().to_string()),
            published_identity,
            true,
        )
        .with_output_file_object_identity(output_ownership.object_identity)
        .with_mp4_staging_file_object_identity(published_object_identity)
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert_eq!(
            std::fs::read(&published).unwrap(),
            b"completed published mp4"
        );
        assert!(!output.exists());
        assert!(!staging_directory.exists());
        assert!(!cleanup_directory.exists());
        assert_eq!(
            database.list_sessions(1).unwrap()[0].mp4_path.as_deref(),
            published.to_str()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_rehomes_and_adopts_identity_matched_mp4_when_original_workspace_is_missing() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let published = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let output_ownership = capture_session_file_bound_identity(&output)
            .unwrap()
            .unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(directory, "missing-published-workspace", None);
        std::fs::write(&published, b"completed published mp4").unwrap();
        let published_identity = capture_session_file_identity(&published).unwrap();
        let published_object_identity = capture_session_file_object_identity(&published)
            .unwrap()
            .unwrap();

        let mut session = sample_session("session-published-missing-workspace");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(
            "session-published-missing-workspace",
            30,
            "record",
        );
        let intent = SessionFinalization::new(
            "session-published-missing-workspace",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(published.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            Some(output_ownership.content_identity),
            Some(staging.display().to_string()),
            published_identity,
            true,
        )
        .with_output_file_object_identity(output_ownership.object_identity)
        .with_mp4_staging_file_object_identity(published_object_identity)
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_dir(&staging_directory).unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert_eq!(
            std::fs::read(&published).unwrap(),
            b"completed published mp4"
        );
        assert!(
            !output.exists(),
            "identity-matched MP4 commits before MKV cleanup"
        );
        assert_eq!(
            database.list_sessions(1).unwrap()[0].mp4_path.as_deref(),
            published.to_str()
        );
        assert!(directory.read_dir().unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.starts_with(".videorc-export-")
                && !name.starts_with(".videorc-recovery-validation-")
        }));
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_rehomes_but_never_adopts_replaced_mp4_when_original_workspace_is_missing() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let published = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(directory, "missing-replaced-workspace", None);
        std::fs::write(&published, b"owned published mp4").unwrap();
        let published_identity = capture_session_file_identity(&published).unwrap();
        let published_object_identity = capture_session_file_object_identity(&published)
            .unwrap()
            .unwrap();

        let mut session = sample_session("session-replaced-mp4-missing-workspace");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(
            "session-replaced-mp4-missing-workspace",
            30,
            "record",
        );
        let intent = SessionFinalization::new(
            "session-replaced-mp4-missing-workspace",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(published.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            published_identity,
            true,
        )
        .with_mp4_staging_file_object_identity(published_object_identity)
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_dir(&staging_directory).unwrap();
        std::fs::remove_file(&published).unwrap();
        std::fs::write(&published, b"unrelated replacement mp4").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert_eq!(
            std::fs::read(&published).unwrap(),
            b"unrelated replacement mp4"
        );
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        assert!(directory.read_dir().unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".videorc-recovery-validation-")
        }));
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_retains_replaced_staging_directory_and_candidate_then_retires_recovery() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let candidate = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&candidate, b"unrelated existing candidate").unwrap();
        let (staging_directory, staging, cleanup_directory, directory_identity) =
            create_owned_mp4_staging_directory(
                directory,
                "replaced-directory",
                Some(b"owned staged mp4"),
            );
        let staging_identity = capture_session_file_identity(&staging).unwrap();
        let staging_object_identity = capture_session_file_object_identity(&staging)
            .unwrap()
            .unwrap();

        let mut session = sample_session("session-replaced-staging-directory");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(
            "session-replaced-staging-directory",
            30,
            "record",
        );
        let intent = SessionFinalization::new(
            "session-replaced-staging-directory",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(candidate.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            staging_identity,
            true,
        )
        .with_mp4_staging_file_object_identity(staging_object_identity)
        .with_mp4_staging_directory_ownership(
            staging_directory.display().to_string(),
            directory_identity,
            cleanup_directory.display().to_string(),
        );
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_dir_all(&staging_directory).unwrap();
        std::fs::create_dir(&staging_directory).unwrap();
        std::fs::write(&staging, b"unrelated replacement staging").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert_eq!(
            std::fs::read(&candidate).unwrap(),
            b"unrelated existing candidate"
        );
        assert_eq!(
            std::fs::read(&staging).unwrap(),
            b"unrelated replacement staging"
        );
        assert!(!cleanup_directory.exists());
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_discards_object_bound_partial_mp4_after_interrupted_export() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let cleanup = directory.join(".recording.cleanup.mp4");
        let preferred_mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mut staging_file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .unwrap();
        let object_identity =
            capture_session_file_object_identity_from_file(&staging_file, &staging).unwrap();
        staging_file.write_all(b"interrupted ffmpeg bytes").unwrap();
        staging_file.sync_all().unwrap();
        drop(staging_file);
        let mut session = sample_session("session-interrupted-export");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-interrupted-export", 30, "record");
        let intent = SessionFinalization::new(
            "session-interrupted-export",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(preferred_mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            None,
            false,
        )
        .with_mp4_staging_object_ownership(object_identity, cleanup.display().to_string());
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!staging.exists());
        assert!(!cleanup.exists());
        assert!(!recovery.exists());
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_retains_replaced_partial_mp4_and_its_recovery_record() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let cleanup = directory.join(".recording.cleanup.mp4");
        let preferred_mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        let staging_file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .unwrap();
        let object_identity =
            capture_session_file_object_identity_from_file(&staging_file, &staging).unwrap();
        drop(staging_file);
        let mut session = sample_session("session-replaced-partial");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-replaced-partial", 30, "record");
        let intent = SessionFinalization::new(
            "session-replaced-partial",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(preferred_mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            capture_session_file_identity(&output).unwrap(),
            Some(staging.display().to_string()),
            None,
            false,
        )
        .with_mp4_staging_object_ownership(object_identity, cleanup.display().to_string());
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"replacement partial").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 0);
        assert_eq!(summary.pending, 1);
        assert!(recovery.exists());
        assert_eq!(std::fs::read(&staging).unwrap(), b"replacement partial");
        assert!(!cleanup.exists());
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_adopts_identity_matched_mp4_published_before_db_commit() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&mp4, b"published mp4").unwrap();
        let output_ownership = capture_session_file_bound_identity(&output)
            .unwrap()
            .unwrap();
        let mp4_identity = capture_session_file_identity(&mp4).unwrap();
        let mut session = sample_session("session-published-before-db");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-published-before-db", 30, "record");
        let intent = SessionFinalization::new(
            "session-published-before-db",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            Some(output_ownership.content_identity),
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        )
        .with_output_file_object_identity(output_ownership.object_identity);
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert!(
            !output.exists(),
            "owned MKV is removed only after DB commit"
        );
        assert_eq!(std::fs::read(&mp4).unwrap(), b"published mp4");
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.status, "completed");
        assert_eq!(session.mp4_path, Some(mp4.display().to_string()));
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_publishes_identity_matched_mp4_staged_before_a_crash() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&staging, b"staged mp4").unwrap();
        let output_ownership = capture_session_file_bound_identity(&output)
            .unwrap()
            .unwrap();
        let mp4_identity = capture_session_file_identity(&staging).unwrap();
        let mut session = sample_session("session-staged-before-crash");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-staged-before-crash", 30, "record");
        let intent = SessionFinalization::new(
            "session-staged-before-crash",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            Some(output_ownership.content_identity),
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        )
        .with_output_file_object_identity(output_ownership.object_identity);
        database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert!(!staging.exists());
        assert_eq!(std::fs::read(&mp4).unwrap(), b"staged mp4");
        assert!(!output.exists());
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.mp4_path, Some(mp4.display().to_string()));
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_restores_a_raced_staging_replacement_instead_of_adopting_it() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&staging, b"owned staged mp4").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mp4_identity = capture_session_file_identity(&staging).unwrap();
        let mut session = sample_session("session-raced-staging");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-raced-staging", 30, "record");
        let intent = SessionFinalization::new(
            "session-raced-staging",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        );
        database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"raced staging replacement").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!mp4.exists(), "replacement must not be adopted as the MP4");
        assert_eq!(
            std::fs::read(&staging).unwrap(),
            b"raced staging replacement"
        );
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_falls_back_to_mkv_without_adopting_or_deleting_a_replaced_mp4() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"authoritative mkv").unwrap();
        std::fs::write(&mp4, b"owned mp4").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mp4_identity = capture_session_file_identity(&mp4).unwrap();
        let mut session = sample_session("session-replaced-mp4");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-replaced-mp4", 30, "record");
        let intent = SessionFinalization::new(
            "session-replaced-mp4",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        );
        database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_file(&mp4).unwrap();
        std::fs::write(&mp4, b"replacement mp4").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(std::fs::read(&output).unwrap(), b"authoritative mkv");
        assert_eq!(std::fs::read(&mp4).unwrap(), b"replacement mp4");
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.status, "completed");
        assert_eq!(session.mp4_path, None);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_clears_committed_mp4_path_after_rejecting_replacement() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let fixture = create_committed_mp4_recovery_fixture(
            &database,
            directory,
            "session-committed-replaced-mp4",
        );
        std::fs::remove_file(&fixture.mp4).unwrap();
        std::fs::write(&fixture.mp4, b"unrelated replacement mp4").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!fixture.recovery.exists());
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        assert_eq!(
            std::fs::read(&fixture.mp4).unwrap(),
            b"unrelated replacement mp4"
        );
        assert_eq!(
            std::fs::read(&fixture.output).unwrap(),
            b"authoritative mkv"
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_clears_committed_mp4_path_after_published_file_disappears() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let fixture = create_committed_mp4_recovery_fixture(
            &database,
            directory,
            "session-committed-missing-mp4",
        );
        std::fs::remove_file(&fixture.mp4).unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!fixture.recovery.exists());
        assert_eq!(database.list_sessions(1).unwrap()[0].mp4_path, None);
        assert!(!fixture.mp4.exists());
        assert_eq!(
            std::fs::read(&fixture.output).unwrap(),
            b"authoritative mkv"
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_recovery_never_clears_a_newer_committed_mp4_path() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let fixture = create_committed_mp4_recovery_fixture(
            &database,
            directory,
            "session-newer-committed-mp4",
        );
        let newer_mp4 = directory.join("newer-recording.mp4");
        std::fs::write(&newer_mp4, b"newer committed mp4").unwrap();
        database
            .finish_session(
                "session-newer-committed-mp4",
                "completed",
                None,
                Some(newer_mp4.display().to_string()),
                None,
            )
            .unwrap();
        std::fs::remove_file(&fixture.mp4).unwrap();
        std::fs::write(&fixture.mp4, b"unrelated replacement mp4").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!fixture.recovery.exists());
        assert_eq!(
            database.list_sessions(1).unwrap()[0].mp4_path.as_deref(),
            newer_mp4.to_str()
        );
        assert_eq!(std::fs::read(&newer_mp4).unwrap(), b"newer committed mp4");
        assert_eq!(
            std::fs::read(&fixture.mp4).unwrap(),
            b"unrelated replacement mp4"
        );
        assert_eq!(
            std::fs::read(&fixture.output).unwrap(),
            b"authoritative mkv"
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_deletes_a_replacement_at_the_finalized_mkv_path() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"owned mkv").unwrap();
        std::fs::write(&mp4, b"owned mp4").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mp4_identity = capture_session_file_identity(&mp4).unwrap();
        let mut session = sample_session("session-replaced-mkv");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-replaced-mkv", 30, "record");
        let intent = SessionFinalization::new(
            "session-replaced-mkv",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        );
        let cleanup_path = PathBuf::from(intent.output_cleanup_path.as_ref().unwrap());
        database
            .persist_session_finalization_recovery(&intent)
            .unwrap();
        std::fs::remove_file(&output).unwrap();
        std::fs::write(&output, b"replacement mkv").unwrap();

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(std::fs::read(&output).unwrap(), b"replacement mkv");
        assert!(!cleanup_path.exists());
        assert_eq!(std::fs::read(&mp4).unwrap(), b"owned mp4");
        let session = database.list_sessions(1).unwrap().remove(0);
        assert_eq!(session.mp4_path, Some(mp4.display().to_string()));
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_deletes_same_content_replacement_at_finalized_mkv_path() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let replacement = directory.join("replacement.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"byte-identical mkv").unwrap();
        std::fs::write(&mp4, b"owned mp4").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let original_object_identity = capture_session_file_object_identity(&output)
            .unwrap()
            .unwrap();
        let original_modified = std::fs::metadata(&output).unwrap().modified().unwrap();
        let mp4_identity = capture_session_file_identity(&mp4).unwrap();
        let mut session = sample_session("session-same-content-replaced-mkv");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics = crate::diagnostics::starting_diagnostics(
            "session-same-content-replaced-mkv",
            30,
            "record",
        );
        let intent = SessionFinalization::new(
            "session-same-content-replaced-mkv",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity.clone(),
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        )
        .with_output_file_object_identity(original_object_identity.clone());
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        std::fs::write(&replacement, b"byte-identical mkv").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        let replacement_object_identity = capture_session_file_object_identity(&replacement)
            .unwrap()
            .unwrap();
        assert_ne!(replacement_object_identity, original_object_identity);
        std::fs::remove_file(&output).unwrap();
        crate::session_ops::rename_session_file_no_replace(&replacement, &output).unwrap();
        assert_eq!(
            capture_session_file_identity(&output).unwrap(),
            output_identity
        );

        let summary = database
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert_eq!(
            std::fs::read(&output).unwrap(),
            b"byte-identical mkv",
            "a new filesystem object must survive even when sampled bytes and mtime match"
        );
        assert_eq!(std::fs::read(&mp4).unwrap(), b"owned mp4");
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_recovery_persists_generated_mkv_cleanup_path_before_the_move() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let output = directory.join("recording.mkv");
        let staging = directory.join(".recording.partial.mp4");
        let mp4 = directory.join("recording.mp4");
        std::fs::write(&output, b"owned legacy mkv").unwrap();
        std::fs::write(&mp4, b"owned legacy mp4").unwrap();
        let output_identity = capture_session_file_identity(&output).unwrap();
        let mp4_identity = capture_session_file_identity(&mp4).unwrap();
        let mut session = sample_session("session-legacy-cleanup-path");
        session.output_path = Some(output.display().to_string());
        database.create_session(&session).unwrap();
        let diagnostics =
            crate::diagnostics::starting_diagnostics("session-legacy-cleanup-path", 30, "record");
        let mut intent = SessionFinalization::new(
            "session-legacy-cleanup-path",
            "completed",
            Some("2026-07-12T12:00:00Z".to_string()),
            Some(mp4.display().to_string()),
            Some(9_876),
            &diagnostics,
        )
        .unwrap()
        .with_media_ownership(
            Some(output.display().to_string()),
            output_identity,
            Some(staging.display().to_string()),
            mp4_identity,
            true,
        );
        intent.output_cleanup_path = None;
        let recovery = database
            .persist_session_finalization_recovery(&intent)
            .unwrap();

        let prepared = database
            .persist_missing_session_finalization_cleanup_path(&recovery, &intent)
            .unwrap();
        let cleanup = PathBuf::from(
            prepared
                .output_cleanup_path
                .as_deref()
                .expect("legacy cleanup path is now durable"),
        );
        let persisted: SessionFinalization =
            serde_json::from_slice(&std::fs::read(&recovery).unwrap()).unwrap();
        assert_eq!(
            persisted.output_cleanup_path,
            Some(cleanup.display().to_string())
        );

        // Simulate a crash after the MKV move but before unlink/record clear.
        crate::session_ops::rename_session_file_no_replace(&output, &cleanup).unwrap();
        drop(database);
        let reopened = Database {
            conn: Arc::new(Mutex::new(Connection::open(&database_path).unwrap())),
            path: database_path.clone(),
        };
        reopened.migrate().unwrap();

        let summary = reopened
            .reconcile_session_finalization_recoveries()
            .unwrap();

        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.pending, 0);
        assert!(!recovery.exists());
        assert!(!cleanup.exists());
        assert_eq!(
            std::fs::read(&output).unwrap(),
            b"owned legacy mkv",
            "legacy cleanup without object identity must restore, never delete"
        );
        assert_eq!(std::fs::read(&mp4).unwrap(), b"owned legacy mp4");
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_cleans_object_bound_copy_interrupted_before_content_binding() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".interrupted.partial");
        let final_path = directory.join("interrupted.mp4");
        let operation = database
            .begin_session_file_operation("import", "interrupted-row", &staging, &final_path)
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .unwrap();
        let object_identity =
            capture_session_file_object_identity_from_file(&file, &staging).unwrap();
        database
            .bind_session_file_operation_object_identity(&operation.id, &object_identity)
            .unwrap();
        file.write_all(b"interrupted copy bytes").unwrap();
        file.sync_all().unwrap();
        drop(file);
        let cleanup = PathBuf::from(operation.staging_cleanup_path.as_ref().unwrap());

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert!(!staging.exists());
        assert!(!cleanup.exists());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_quarantines_unbound_copy_without_path_only_deletion() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".unbound.partial");
        let final_path = directory.join("unbound.mp4");
        let operation = database
            .begin_session_file_operation("import", "unbound-row", &staging, &final_path)
            .unwrap();
        std::fs::write(&staging, b"bytes from the create-before-bind window").unwrap();
        let cleanup = PathBuf::from(operation.staging_cleanup_path.as_ref().unwrap());

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert!(!staging.exists());
        assert_eq!(
            std::fs::read(&cleanup).unwrap(),
            b"bytes from the create-before-bind window"
        );
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancellation_reloads_identity_bound_operation_before_cleanup() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".cancel.partial");
        let final_path = directory.join("cancel.mp4");
        let operation = database
            .begin_session_file_operation("duplicate", "cancel-row", &staging, &final_path)
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .unwrap();
        let object_identity =
            capture_session_file_object_identity_from_file(&file, &staging).unwrap();
        database
            .bind_session_file_operation_object_identity(&operation.id, &object_identity)
            .unwrap();
        file.write_all(b"completed staging bytes").unwrap();
        file.sync_all().unwrap();
        drop(file);
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();

        // `operation` is intentionally the stale value returned before either
        // identity bind. Cancellation must reload the durable row.
        database.cancel_session_file_operation(&operation).unwrap();

        assert!(!staging.exists());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_discards_an_unowned_published_library_file() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".orphan.partial");
        let final_path = directory.join("orphan.mp4");
        std::fs::write(&staging, b"orphan").unwrap();
        let operation = database
            .begin_session_file_operation("import", "missing-row", &staging, &final_path)
            .unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        crate::session_ops::rename_session_file_no_replace(&staging, &final_path).unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert!(!final_path.exists());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_removes_a_raced_external_destination() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".raced.partial");
        let final_path = directory.join("raced.mp4");
        std::fs::write(&staging, b"operation bytes").unwrap();
        let operation = database
            .begin_session_file_operation("import", "missing-row", &staging, &final_path)
            .unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        std::fs::write(&final_path, b"external bytes").unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(std::fs::read(&final_path).unwrap(), b"external bytes");
        assert!(!staging.exists());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_cleans_up_a_replacement_installed_after_publication() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".published.partial");
        let final_path = directory.join("published.mp4");
        std::fs::write(&staging, b"operation bytes").unwrap();
        let operation = database
            .begin_session_file_operation("import", "missing-row", &staging, &final_path)
            .unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        crate::session_ops::rename_session_file_no_replace(&staging, &final_path).unwrap();
        std::fs::remove_file(&final_path).unwrap();
        std::fs::write(&final_path, b"replacement bytes").unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(std::fs::read(&final_path).unwrap(), b"replacement bytes");
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_discards_an_owned_row_instead_of_adopting_a_replacement() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".owned-replaced.partial");
        let final_path = directory.join("owned-replaced.mp4");
        database
            .create_session(&sample_session("owned-replaced-row"))
            .unwrap();
        std::fs::write(&staging, b"operation bytes").unwrap();
        let operation = database
            .begin_session_file_operation("duplicate", "owned-replaced-row", &staging, &final_path)
            .unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        crate::session_ops::rename_session_file_no_replace(&staging, &final_path).unwrap();
        std::fs::remove_file(&final_path).unwrap();
        std::fs::write(&final_path, b"replacement bytes").unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 0);
        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(std::fs::read(&final_path).unwrap(), b"replacement bytes");
        assert!(database.list_sessions(10).unwrap().is_empty());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_publishes_staged_library_bytes_for_an_owned_row() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".owned.partial");
        let final_path = directory.join("owned.mp4");
        database
            .create_session(&sample_session("owned-row"))
            .unwrap();
        let operation = database
            .begin_session_file_operation("duplicate", "owned-row", &staging, &final_path)
            .unwrap();
        std::fs::write(&staging, b"owned").unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(std::fs::read(&final_path).unwrap(), b"owned");
        assert!(!staging.exists());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_publishes_object_bound_library_bytes_after_mtime_drift() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".owned-mtime.partial");
        let final_path = directory.join("owned-mtime.mp4");
        database
            .create_session(&sample_session("owned-mtime-row"))
            .unwrap();
        let operation = database
            .begin_session_file_operation("duplicate", "owned-mtime-row", &staging, &final_path)
            .unwrap();
        std::fs::write(&staging, b"owned timestamp-drift bytes").unwrap();
        let expected = capture_session_file_bound_identity(&staging)
            .unwrap()
            .unwrap();
        database
            .bind_session_file_operation_object_identity(&operation.id, &expected.object_identity)
            .unwrap();
        database
            .bind_session_file_operation_content_identity(&operation.id, &expected.content_identity)
            .unwrap();
        let changed_modified =
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_234_567_890);
        std::fs::File::options()
            .write(true)
            .open(&staging)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(changed_modified))
            .unwrap();
        let timestamp_drift = capture_session_file_bound_identity(&staging)
            .unwrap()
            .unwrap();
        assert_ne!(timestamp_drift.content_identity, expected.content_identity);
        assert_eq!(timestamp_drift.object_identity, expected.object_identity);

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 1);
        assert_eq!(summary.pending, 0);
        assert_eq!(
            std::fs::read(&final_path).unwrap(),
            b"owned timestamp-drift bytes"
        );
        assert!(!staging.exists());
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_adopts_a_raced_library_staging_replacement() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".owned-raced.partial");
        let final_path = directory.join("owned-raced.mp4");
        database
            .create_session(&sample_session("owned-raced-row"))
            .unwrap();
        std::fs::write(&staging, b"owned bytes").unwrap();
        let operation = database
            .begin_session_file_operation("duplicate", "owned-raced-row", &staging, &final_path)
            .unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        std::fs::remove_file(&staging).unwrap();
        std::fs::write(&staging, b"raced replacement").unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 0);
        assert_eq!(summary.pending, 1);
        assert!(!final_path.exists());
        assert_eq!(std::fs::read(&staging).unwrap(), b"raced replacement");
        assert_eq!(database.list_sessions(10).unwrap().len(), 1);
        assert_eq!(database.pending_session_file_operations().unwrap().len(), 1);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_keeps_a_completed_library_row_and_clears_its_journal() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".done.partial");
        let final_path = directory.join("done.mp4");
        database
            .create_session(&sample_session("done-row"))
            .unwrap();
        let operation = database
            .begin_session_file_operation("import", "done-row", &staging, &final_path)
            .unwrap();
        std::fs::write(&staging, b"done").unwrap();
        database
            .bind_session_file_operation_identity(&operation.id, &staging)
            .unwrap();
        crate::session_ops::rename_session_file_no_replace(&staging, &final_path).unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 1);
        assert_eq!(database.list_sessions(10).unwrap().len(), 1);
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_never_adopts_a_same_sample_replacement_for_a_completed_row() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let staging = directory.join(".same-sample.partial");
        let replacement = directory.join("same-sample-replacement.mp4");
        let final_path = directory.join("same-sample.mp4");
        database
            .create_session(&sample_session("same-sample-row"))
            .unwrap();
        let operation = database
            .begin_session_file_operation("import", "same-sample-row", &staging, &final_path)
            .unwrap();
        let mut staging_file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&staging)
            .unwrap();
        staging_file
            .write_all(&sampled_identity_collision_bytes(0x41))
            .unwrap();
        staging_file.sync_all().unwrap();
        let expected_object_identity =
            capture_session_file_object_identity_from_file(&staging_file, &staging).unwrap();
        let expected_content_identity =
            capture_session_file_content_identity_from_file(&mut staging_file, &staging).unwrap();
        let original_modified = staging_file.metadata().unwrap().modified().unwrap();
        database
            .bind_session_file_operation_object_identity(&operation.id, &expected_object_identity)
            .unwrap();
        database
            .bind_session_file_operation_content_identity(&operation.id, &expected_content_identity)
            .unwrap();
        drop(staging_file);
        crate::session_ops::rename_session_file_no_replace(&staging, &final_path).unwrap();

        std::fs::write(&replacement, sampled_identity_collision_bytes(0x42)).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        let replacement_ownership = capture_session_file_bound_identity(&replacement)
            .unwrap()
            .unwrap();
        assert_eq!(
            replacement_ownership.content_identity,
            expected_content_identity
        );
        assert_ne!(
            replacement_ownership.object_identity,
            expected_object_identity
        );
        std::fs::remove_file(&final_path).unwrap();
        crate::session_ops::rename_session_file_no_replace(&replacement, &final_path).unwrap();

        let summary = database.reconcile_session_file_operations().unwrap();

        assert_eq!(summary.published, 0);
        assert_eq!(summary.discarded, 1);
        assert_eq!(summary.pending, 0);
        assert!(database.list_sessions(10).unwrap().is_empty());
        assert!(
            database
                .pending_session_file_operations()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            capture_session_file_object_identity(&final_path)
                .unwrap()
                .unwrap(),
            replacement_ownership.object_identity
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn two_phase_session_delete_hides_then_retries_failed_trash_paths() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let media_path = directory.join("recording.mkv");
        std::fs::write(&media_path, b"recording").unwrap();
        let mut session = sample_session("delete-row");
        session.output_path = Some(media_path.display().to_string());
        database.create_session(&session).unwrap();
        database
            .finish_session("delete-row", "completed", None, None, None)
            .unwrap();

        let operations = database
            .prepare_session_deletions(&["delete-row".to_string()])
            .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].paths.len(), 1);
        let quarantined_path = PathBuf::from(&operations[0].paths[0]);
        assert_ne!(quarantined_path, media_path);
        assert!(!media_path.exists());
        assert_eq!(std::fs::read(&quarantined_path).unwrap(), b"recording");
        assert!(database.list_sessions(10).unwrap().is_empty());
        assert_eq!(database.session_storage_totals().unwrap().count, 0);

        let retained = database
            .complete_session_deletion(
                &operations[0].operation_id,
                &[quarantined_path.display().to_string()],
            )
            .unwrap();
        assert!(!retained.deleted);
        assert_eq!(retained.pending_paths.len(), 1);
        assert_eq!(database.pending_session_deletions().unwrap().len(), 1);

        std::fs::remove_file(&quarantined_path).unwrap();
        let recovered = database.reconcile_session_deletions().unwrap();
        assert_eq!(recovered.completed, 1);
        assert!(database.pending_session_deletions().unwrap().is_empty());
        assert!(
            database
                .session_media_candidates("delete-row")
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn session_delete_completion_rejects_paths_outside_its_tombstone() {
        let database = test_database();
        database
            .create_session(&sample_session("delete-guard"))
            .unwrap();
        database
            .finish_session("delete-guard", "completed", None, None, None)
            .unwrap();
        let operation = database
            .prepare_session_deletions(&["delete-guard".to_string()])
            .unwrap()
            .remove(0);

        let error = database
            .complete_session_deletion(
                &operation.operation_id,
                &["/tmp/not-owned-by-operation".to_string()],
            )
            .unwrap_err();
        assert!(error.to_string().contains("outside"));
        assert_eq!(database.pending_session_deletions().unwrap().len(), 1);
    }

    #[test]
    fn active_session_delete_is_rejected_without_hiding_the_row() {
        let database = test_database();
        database
            .create_session(&sample_session("active-delete"))
            .unwrap();

        let error = database
            .prepare_session_deletions(&["active-delete".to_string()])
            .unwrap_err();

        assert!(error.to_string().contains("still active"));
        assert_eq!(database.list_sessions(10).unwrap().len(), 1);
        assert!(database.pending_session_deletions().unwrap().is_empty());
    }

    #[test]
    fn delete_quarantine_never_trashes_a_replacement_at_the_original_path() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let media_path = directory.join("replacement.mp4");
        std::fs::write(&media_path, b"original recording").unwrap();
        let mut session = sample_session("replacement-delete");
        session.output_path = Some(media_path.display().to_string());
        database.create_session(&session).unwrap();
        database
            .finish_session("replacement-delete", "completed", None, None, None)
            .unwrap();
        let operation = database
            .prepare_session_deletions(&["replacement-delete".to_string()])
            .unwrap()
            .remove(0);

        assert!(!media_path.exists(), "phase one quarantines the owned file");
        std::fs::write(&media_path, b"unrelated replacement").unwrap();

        let pending = database.pending_session_deletions().unwrap().remove(0);
        assert_eq!(pending.paths, operation.paths);
        assert!(pending.blocked_paths.is_empty());
        std::fs::remove_file(&operation.paths[0]).unwrap();
        let completion = database
            .complete_session_deletion(&operation.operation_id, &[])
            .unwrap();
        assert!(completion.deleted);
        assert!(completion.pending_paths.is_empty());
        assert_eq!(
            std::fs::read(&media_path).unwrap(),
            b"unrelated replacement"
        );
        assert!(database.list_sessions(10).unwrap().is_empty());
        assert!(database.pending_session_deletions().unwrap().is_empty());

        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn delete_quarantine_retains_a_replacement_installed_before_the_rename() {
        let directory = std::env::temp_dir().join(format!(
            "videorc-delete-before-quarantine-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let original = directory.join("recording.mp4");
        let quarantine = directory.join(".recording.op.videorc-trash");
        std::fs::write(&original, b"owned recording").unwrap();
        let identity = capture_session_file_identity(&original).unwrap();
        let object_identity = capture_session_file_object_identity(&original).unwrap();
        let record = SessionDeletionPathRecord {
            original_path: original.display().to_string(),
            quarantine_path: Some(quarantine.display().to_string()),
            identity,
            object_identity,
        };
        std::fs::remove_file(&original).unwrap();
        std::fs::write(&original, b"replacement before quarantine").unwrap();

        assert_eq!(
            deletion_path_state(&record).unwrap(),
            DeletionPathState::Missing
        );
        assert!(!quarantine.exists());
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"replacement before quarantine"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn delete_quarantine_rejects_a_same_sample_replacement_before_the_move() {
        let directory =
            std::env::temp_dir().join(format!("videorc-delete-same-sample-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let original = directory.join("recording.mp4");
        let replacement = directory.join("replacement.mp4");
        let quarantine = directory.join(".recording.op.videorc-trash");
        std::fs::write(&original, sampled_identity_collision_bytes(0x41)).unwrap();
        let expected = capture_session_file_bound_identity(&original)
            .unwrap()
            .unwrap();
        let original_modified = std::fs::metadata(&original).unwrap().modified().unwrap();
        let record = SessionDeletionPathRecord {
            original_path: original.display().to_string(),
            quarantine_path: Some(quarantine.display().to_string()),
            identity: Some(expected.content_identity.clone()),
            object_identity: Some(expected.object_identity.clone()),
        };

        std::fs::write(&replacement, sampled_identity_collision_bytes(0x42)).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        let replacement_ownership = capture_session_file_bound_identity(&replacement)
            .unwrap()
            .unwrap();
        assert_eq!(
            replacement_ownership.content_identity,
            expected.content_identity
        );
        assert_ne!(
            replacement_ownership.object_identity,
            expected.object_identity
        );
        std::fs::remove_file(&original).unwrap();
        crate::session_ops::rename_session_file_no_replace(&replacement, &original).unwrap();

        assert_eq!(
            deletion_path_state(&record).unwrap(),
            DeletionPathState::Missing
        );
        assert!(!quarantine.exists());
        assert_eq!(
            capture_session_file_object_identity(&original)
                .unwrap()
                .unwrap(),
            replacement_ownership.object_identity
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_structured_delete_tombstone_blocks_every_existing_path() {
        let directory =
            std::env::temp_dir().join(format!("videorc-delete-legacy-object-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let original = directory.join("recording.mp4");
        let quarantine = directory.join(".recording.op.videorc-trash");
        std::fs::write(&original, b"legacy recording").unwrap();
        let identity = capture_session_file_identity(&original).unwrap().unwrap();
        let records = parse_session_deletion_path_records(
            &serde_json::json!([{
                "originalPath": original.display().to_string(),
                "quarantinePath": quarantine.display().to_string(),
                "identity": identity,
            }])
            .to_string(),
        )
        .unwrap();
        let record = &records[0];
        assert!(record.object_identity.is_none());

        assert_eq!(
            deletion_path_state(record).unwrap(),
            DeletionPathState::Blocked(original.display().to_string())
        );
        assert!(original.exists());
        assert!(!quarantine.exists());

        std::fs::remove_file(&original).unwrap();
        assert_eq!(
            deletion_path_state(record).unwrap(),
            DeletionPathState::Missing
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn delete_quarantine_restores_a_mismatch_instead_of_trashing_it() {
        let (database, database_path) = file_database();
        let directory = database_path.parent().unwrap();
        let media_path = directory.join("quarantine-replaced.mp4");
        std::fs::write(&media_path, b"owned recording").unwrap();
        let mut session = sample_session("quarantine-replaced");
        session.output_path = Some(media_path.display().to_string());
        database.create_session(&session).unwrap();
        database
            .finish_session("quarantine-replaced", "completed", None, None, None)
            .unwrap();
        let operation = database
            .prepare_session_deletions(&["quarantine-replaced".to_string()])
            .unwrap()
            .remove(0);
        let quarantine = PathBuf::from(&operation.paths[0]);
        std::fs::remove_file(&quarantine).unwrap();
        std::fs::write(&quarantine, b"unrelated quarantine replacement").unwrap();

        let pending = database.pending_session_deletions().unwrap().remove(0);
        assert!(pending.paths.is_empty());
        assert!(pending.blocked_paths.is_empty());
        let completion = database
            .complete_session_deletion(&operation.operation_id, &[])
            .unwrap();
        assert!(completion.deleted);
        assert!(!quarantine.exists());
        assert_eq!(
            std::fs::read(&media_path).unwrap(),
            b"unrelated quarantine replacement"
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn session_summary_includes_latest_completed_quality_gate_for_recording_file() {
        use crate::repair::{GateStatus, QualityExpectations, RepairOutcome};

        let database = test_database();
        database
            .create_session(&sample_session("session-1"))
            .unwrap();
        database
            .finish_session(
                "session-1",
                "completed",
                None,
                Some("/tmp/videorc-test.mp4".to_string()),
                Some(1000),
            )
            .unwrap();

        let expectations = QualityExpectations {
            intended_fps: Some(30.0),
            expect_audio: true,
        };
        let mut older_output_job = RepairJob::pending(
            "job-output-ready".to_string(),
            "/tmp/videorc-test.mkv".to_string(),
            &expectations,
            "t0".to_string(),
        );
        older_output_job.complete_with_gate(
            &GateStatus::Ready {
                path: "/tmp/videorc-test.mkv".to_string(),
            },
            "t1".to_string(),
        );
        let mut latest_mp4_gate = RepairJob::pending(
            "job-mp4-not-100".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        latest_mp4_gate.complete_with_gate(
            &GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Frozen video segment detected.".to_string()],
                needs_attention: false,
            },
            "t2".to_string(),
        );
        database.upsert_repair_job(&older_output_job).unwrap();
        database.upsert_repair_job(&latest_mp4_gate).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Frozen video segment detected.".to_string()],
                needs_attention: false,
            })
        );

        let mut running_fast_gate = RepairJob::pending(
            "job-running-fast-not-100".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        running_fast_gate.mark_running("t3".to_string());
        running_fast_gate.outcome = serde_json::to_value(&GateStatus::NotHundredPercent {
            path: "/tmp/videorc-test.mp4".to_string(),
            reasons: vec!["Only 8fps observed while live.".to_string()],
            needs_attention: false,
        })
        .ok();
        database.upsert_repair_job(&running_fast_gate).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Only 8fps observed while live.".to_string()],
                needs_attention: false,
            })
        );

        let mut stale_repair_outcome = RepairJob::pending(
            "job-stale-repaired".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        stale_repair_outcome.complete(
            &RepairOutcome::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            },
            "t3".to_string(),
        );
        stale_repair_outcome.reason =
            Some("quality check deferred because capture started".to_string());
        database.upsert_repair_job(&stale_repair_outcome).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::NotHundredPercent {
                path: "/tmp/videorc-test.mp4".to_string(),
                reasons: vec!["Only 8fps observed while live.".to_string()],
                needs_attention: false,
            })
        );

        let mut newer_repair_outcome = RepairJob::pending(
            "job-newer-repaired".to_string(),
            "/tmp/videorc-test.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        newer_repair_outcome.complete(
            &RepairOutcome::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            },
            "t4".to_string(),
        );
        database.upsert_repair_job(&newer_repair_outcome).unwrap();

        let sessions = database.list_sessions(1).unwrap();
        assert_eq!(
            sessions[0].quality_status,
            Some(GateStatus::Repaired {
                path: "/tmp/videorc-test.mp4".to_string(),
                interpolated: true,
            })
        );
    }

    #[test]
    fn imported_screen_images_infer_names_and_persist_in_order() {
        let database = test_database();
        let first = import_stub_screen(&database, "be-right_back.png");
        let second = import_stub_screen(&database, "ending.png");

        assert_eq!(first.name, "Be Right Back");
        assert_eq!(first.status, StreamScreenStatus::Ready);
        assert_eq!(first.sort_order, 0);
        assert!(first.image_path.ends_with(".png"));
        assert!(Path::new(&first.image_path).exists());
        assert_eq!(second.name, "Ending");
        assert_eq!(second.sort_order, 1);

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens.len(), 2);
        assert_eq!(screens[0].id, first.id);
        assert_eq!(screens[1].id, second.id);
    }

    #[test]
    fn imported_screen_images_reject_unsupported_formats() {
        let database = test_database();
        let path = temp_screen_image("notes.txt");

        let error = database
            .import_screen_image_with_optimizer(path.to_str().unwrap(), |_, _| {
                panic!("unsupported inputs should not be optimized");
            })
            .unwrap_err();

        assert!(error.to_string().contains("PNG, JPEG, or WebP"));
    }

    #[test]
    fn stream_screens_can_be_renamed_reordered_and_deleted() {
        let database = test_database();
        let first = import_stub_screen(&database, "first.png");
        let second = import_stub_screen(&database, "second.png");

        let renamed = database
            .rename_stream_screen(&first.id, "  Main Break  ")
            .unwrap();
        assert_eq!(renamed.name, "Main Break");

        let reordered = database
            .reorder_stream_screens(&[second.id.clone(), first.id.clone()])
            .unwrap();
        assert_eq!(reordered[0].id, second.id);
        assert_eq!(reordered[0].sort_order, 0);
        assert_eq!(reordered[1].id, first.id);
        assert_eq!(reordered[1].sort_order, 1);

        let first_image_path = renamed.image_path.clone();
        assert!(Path::new(&first_image_path).exists());
        database.delete_stream_screen(&first.id).unwrap();
        assert!(!Path::new(&first_image_path).exists());

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens.len(), 1);
        assert_eq!(screens[0].id, second.id);
    }

    #[test]
    fn stream_screens_report_missing_when_optimized_file_disappears() {
        let database = test_database();
        let screen = import_stub_screen(&database, "break.png");
        std::fs::remove_file(&screen.image_path).unwrap();

        let screens = database.list_stream_screens().unwrap();
        assert_eq!(screens[0].status, StreamScreenStatus::Missing);
    }

    #[test]
    fn persisted_screen_path_outside_managed_root_is_pathless_missing_everywhere() {
        let (database, database_path) = file_database();
        let screen = import_stub_screen(&database, "break.png");
        let outside = database_path.parent().unwrap().join("outside-screen.png");
        std::fs::write(&outside, b"must survive").unwrap();
        database
            .lock()
            .unwrap()
            .execute(
                "UPDATE stream_screens SET image_path = ?2 WHERE id = ?1",
                params![screen.id, outside.display().to_string()],
            )
            .unwrap();

        let listed = database.list_stream_screens().unwrap().remove(0);
        assert_eq!(listed.status, StreamScreenStatus::Missing);
        assert!(listed.image_path.is_empty(), "invalid paths must not leak");
        let fetched = database.stream_screen_by_id(&screen.id).unwrap();
        assert_eq!(fetched.status, StreamScreenStatus::Missing);
        assert!(fetched.image_path.is_empty());
        assert!(database.activate_stream_screen(&screen.id).is_err());

        let compositor = database.revalidate_stream_screen_for_compositor(StreamScreen {
            image_path: outside.display().to_string(),
            ..screen.clone()
        });
        assert_eq!(compositor.status, StreamScreenStatus::Missing);
        assert!(compositor.image_path.is_empty());

        database.delete_stream_screen(&screen.id).unwrap();
        assert!(
            outside.exists(),
            "invalid outside target must never be deleted"
        );
        assert!(database.stream_screen_by_id(&screen.id).is_err());
    }

    #[test]
    fn persisted_screen_nonregular_target_is_missing_and_never_removed() {
        let (database, _) = file_database();
        let screen = import_stub_screen(&database, "break.png");
        let managed_path = PathBuf::from(&screen.image_path);
        std::fs::remove_file(&managed_path).unwrap();
        std::fs::create_dir(&managed_path).unwrap();

        let listed = database.list_stream_screens().unwrap().remove(0);
        assert_eq!(listed.status, StreamScreenStatus::Missing);
        assert!(listed.image_path.is_empty());
        database.delete_stream_screen(&screen.id).unwrap();
        assert!(
            managed_path.is_dir(),
            "nonregular managed targets must not be consumed by file deletion"
        );
    }

    #[cfg(unix)]
    #[test]
    fn persisted_screen_symlink_and_managed_root_symlink_are_rejected() {
        use std::os::unix::fs::symlink;

        let (database, database_path) = file_database();
        let screen = import_stub_screen(&database, "break.png");
        let managed_path = PathBuf::from(&screen.image_path);
        let outside = database_path.parent().unwrap().join("outside.png");
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::remove_file(&managed_path).unwrap();
        symlink(&outside, &managed_path).unwrap();

        let listed = database.list_stream_screens().unwrap().remove(0);
        assert_eq!(listed.status, StreamScreenStatus::Missing);
        assert!(listed.image_path.is_empty());
        assert!(database.activate_stream_screen(&screen.id).is_err());

        let managed_root = database.screen_assets_dir();
        let original_root = managed_root.with_file_name("Screens-original");
        std::fs::rename(&managed_root, &original_root).unwrap();
        let outside_root = managed_root.with_file_name("Screens-outside");
        std::fs::create_dir(&outside_root).unwrap();
        std::fs::write(outside_root.join(format!("{}.png", screen.id)), b"outside").unwrap();
        symlink(&outside_root, &managed_root).unwrap();

        let listed = database.list_stream_screens().unwrap().remove(0);
        assert_eq!(listed.status, StreamScreenStatus::Missing);
        assert!(listed.image_path.is_empty());
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }

    #[test]
    fn active_stream_screen_persists_and_clears() {
        let database = test_database();
        let first = import_stub_screen(&database, "first.png");
        let second = import_stub_screen(&database, "second.png");

        assert!(database.active_stream_screen().unwrap().is_none());

        let active = database.activate_stream_screen(&first.id).unwrap();
        assert_eq!(active.id, first.id);
        assert_eq!(
            database.active_stream_screen().unwrap().unwrap().id,
            first.id
        );

        database.activate_stream_screen(&second.id).unwrap();
        assert_eq!(
            database.active_stream_screen().unwrap().unwrap().id,
            second.id
        );

        database.clear_active_stream_screen().unwrap();
        assert!(database.active_stream_screen().unwrap().is_none());
    }

    #[test]
    fn active_stream_screen_rejects_missing_images_and_clears_on_delete() {
        let database = test_database();
        let screen = import_stub_screen(&database, "break.png");

        database.activate_stream_screen(&screen.id).unwrap();
        database.delete_stream_screen(&screen.id).unwrap();
        assert!(database.active_stream_screen().unwrap().is_none());

        let missing = import_stub_screen(&database, "missing.png");
        std::fs::remove_file(&missing.image_path).unwrap();
        let error = database.activate_stream_screen(&missing.id).unwrap_err();
        assert!(error.to_string().contains("missing"));
    }

    #[test]
    fn stream_metadata_draft_defaults_and_persists() {
        let database = test_database();

        let default_draft = database.stream_metadata_draft().unwrap();
        assert_eq!(default_draft.default_privacy, StreamPrivacy::Private);
        assert_eq!(
            default_draft
                .target_overrides
                .iter()
                .map(|target| target.platform)
                .collect::<Vec<_>>(),
            vec![
                StreamPlatform::Youtube,
                StreamPlatform::Twitch,
                StreamPlatform::X
            ]
        );
        assert_eq!(
            default_draft
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Twitch)
                .unwrap()
                .twitch_language
                .as_deref(),
            Some("en")
        );

        let mut draft = default_stream_metadata_draft("old".to_string());
        draft.title = "Launch stream".to_string();
        draft.description = "Global description".to_string();
        draft.default_privacy = StreamPrivacy::Unlisted;
        let twitch = draft
            .target_overrides
            .iter_mut()
            .find(|target| target.platform == StreamPlatform::Twitch)
            .unwrap();
        twitch.customize = true;
        twitch.title = "Twitch launch".to_string();
        twitch.description = "Twitch description".to_string();
        twitch.privacy = StreamPrivacy::Public;
        twitch.twitch_category_id = Some("509658".to_string());
        twitch.twitch_category_name = Some("Just Chatting".to_string());
        twitch.twitch_language = Some("es".to_string());

        let saved = database.save_stream_metadata_draft(draft).unwrap();
        assert_ne!(saved.updated_at, "old");
        assert!(
            saved
                .target_overrides
                .iter()
                .all(|target| target.updated_at == saved.updated_at)
        );
        assert_eq!(
            saved
                .target_overrides
                .iter()
                .find(|target| target.platform == StreamPlatform::Twitch)
                .unwrap()
                .twitch_category_name
                .as_deref(),
            Some("Just Chatting")
        );

        assert_eq!(database.stream_metadata_draft().unwrap(), saved);
    }

    #[test]
    fn platform_accounts_persist_without_exposing_secret_refs() {
        let database = test_database();

        let account = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: Some("https://example.test/avatar.png".to_string()),
                scopes: vec![
                    "youtube.force-ssl".to_string(),
                    " youtube.readonly ".to_string(),
                    "youtube.force-ssl".to_string(),
                    "".to_string(),
                ],
                token_secret_ref: Some("platform:youtube:channel-123:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:channel-123:refresh".to_string()),
                stream_key_secret_ref: Some("platform:youtube:channel-123:stream-key".to_string()),
                expires_at: Some("2026-06-03T12:00:00Z".to_string()),
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert_eq!(account.platform, StreamPlatform::Youtube);
        assert_eq!(account.account_label, "Main Channel");
        assert_eq!(
            account.scopes,
            vec![
                "youtube.force-ssl".to_string(),
                "youtube.readonly".to_string()
            ]
        );
        assert!(account.access_token_present);
        assert!(account.refresh_token_present);
        assert!(account.stream_key_present);

        let json = serde_json::to_string(&account).unwrap();
        assert!(!json.contains("secretRef"));
        assert!(!json.contains("platform:youtube"));

        let accounts = database.list_platform_accounts().unwrap();
        assert_eq!(accounts, vec![account]);
    }

    #[test]
    fn platform_accounts_are_one_per_platform_and_disconnect_deletes_secrets() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Twitch,
                account_id: "first".to_string(),
                account_label: "First Twitch".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec!["channel:manage:broadcast".to_string()],
                token_secret_ref: Some("platform:twitch:first:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: Some("platform:twitch:first:stream-key".to_string()),
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();
        let updated = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Twitch,
                account_id: "second".to_string(),
                account_label: "Second Twitch".to_string(),
                account_handle: Some("second".to_string()),
                avatar_url: None,
                scopes: vec!["channel:read:stream_key".to_string()],
                token_secret_ref: Some("platform:twitch:second:access".to_string()),
                refresh_token_secret_ref: Some("platform:twitch:second:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::NeedsReconnect,
            })
            .unwrap();

        let accounts = database.list_platform_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, updated.id);
        assert_eq!(accounts[0].account_id, "second");
        assert!(accounts[0].refresh_token_present);
        assert!(!accounts[0].stream_key_present);

        let mut deleted = Vec::new();
        let disconnected = database
            .disconnect_platform_account_with_secret_deleter(StreamPlatform::Twitch, |secret_ref| {
                deleted.push(secret_ref.to_string());
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert_eq!(disconnected.account_id, "second");
        assert_eq!(
            deleted,
            vec![
                "platform:twitch:second:access".to_string(),
                "platform:twitch:second:refresh".to_string()
            ]
        );
        assert!(database.list_platform_accounts().unwrap().is_empty());
    }

    #[test]
    fn platform_account_reconnect_preserves_refresh_token_for_same_account() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:oauth:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        let reconnected = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: Some("https://example.test/avatar.png".to_string()),
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert!(reconnected.refresh_token_present);
        let credentials = database.list_platform_account_credentials().unwrap();
        assert_eq!(
            credentials[0].refresh_token_secret_ref.as_deref(),
            Some("platform:youtube:oauth:refresh")
        );
    }

    #[test]
    fn platform_account_reconnect_without_refresh_token_clears_other_account_token() {
        let database = test_database();
        database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-123".to_string(),
                account_label: "Main Channel".to_string(),
                account_handle: Some("@main".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: Some("platform:youtube:oauth:refresh".to_string()),
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        let switched = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Youtube,
                account_id: "channel-456".to_string(),
                account_label: "Brand Channel".to_string(),
                account_handle: Some("@brand".to_string()),
                avatar_url: None,
                scopes: vec!["youtube.force-ssl".to_string()],
                token_secret_ref: Some("platform:youtube:oauth:access".to_string()),
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap();

        assert!(!switched.refresh_token_present);
        let credentials = database.list_platform_account_credentials().unwrap();
        assert_eq!(credentials[0].refresh_token_secret_ref, None);
    }

    #[test]
    fn newer_oauth_generation_wins_even_when_pending_stages_replay_out_of_order() {
        let database = test_database();
        database
            .upsert_platform_account(oauth_account("original", "platform:x:oauth:original"))
            .unwrap();
        let original = database
            .platform_account_write_expectation(StreamPlatform::X)
            .unwrap();
        let account_a = oauth_account("account-a", "platform:x:oauth:candidate:a:access");
        let expected_a =
            PlatformAccountWriteExpectation::for_account(&account_a, original.generation + 1);
        let account_b = oauth_account("account-b", "platform:x:oauth:candidate:b:access");

        let b = database
            .compare_and_upsert_platform_account(
                account_b.clone(),
                Some(&expected_a),
                expected_a.generation + 1,
                true,
                true,
                || Ok(()),
            )
            .unwrap();
        assert!(matches!(b, PlatformAccountCasOutcome::Applied(_)));
        let a = database
            .compare_and_upsert_platform_account(
                account_a,
                Some(&original),
                original.generation + 1,
                true,
                true,
                || Ok(()),
            )
            .unwrap();
        assert!(matches!(a, PlatformAccountCasOutcome::Stale(_)));
        let credentials = database.list_platform_account_credentials().unwrap();
        assert_eq!(credentials[0].account.account_id, "account-b");
        assert_eq!(credentials[0].token_secret_ref, account_b.token_secret_ref);
    }

    #[test]
    fn disconnect_tombstone_rejects_stale_refresh_and_pre_disconnect_reconnect() {
        let database = test_database();
        database
            .upsert_platform_account(oauth_account("account-a", "platform:x:oauth:a"))
            .unwrap();
        let stale = database
            .platform_account_write_expectation(StreamPlatform::X)
            .unwrap();
        let pending_generation = stale.generation + 5;
        database
            .disconnect_platform_account_with_generation_and_secret_deleter(
                StreamPlatform::X,
                pending_generation,
                |_| Ok(()),
            )
            .unwrap();
        let tombstone = database
            .platform_account_write_expectation(StreamPlatform::X)
            .unwrap();
        assert!(!tombstone.exists);
        assert!(tombstone.generation > pending_generation);

        let stale_refresh = database
            .compare_and_upsert_platform_account(
                oauth_account("account-a", "platform:x:oauth:a"),
                Some(&stale),
                stale.generation + 1,
                false,
                false,
                || panic!("stale refresh must not rewrite deleted secrets"),
            )
            .unwrap();
        assert!(matches!(stale_refresh, PlatformAccountCasOutcome::Stale(_)));
        let stale_reconnect = database
            .compare_and_upsert_platform_account(
                oauth_account("account-b", "platform:x:oauth:b"),
                Some(&stale),
                stale.generation + 1,
                true,
                true,
                || Ok(()),
            )
            .unwrap();
        assert!(matches!(
            stale_reconnect,
            PlatformAccountCasOutcome::Stale(_)
        ));
        assert!(database.list_platform_accounts().unwrap().is_empty());

        let fresh_reconnect = database
            .compare_and_upsert_platform_account(
                oauth_account("account-c", "platform:x:oauth:c"),
                Some(&tombstone),
                tombstone.generation + 1,
                true,
                true,
                || Ok(()),
            )
            .unwrap();
        assert!(matches!(
            fresh_reconnect,
            PlatformAccountCasOutcome::Applied(_)
        ));
        assert_eq!(
            database.list_platform_accounts().unwrap()[0].account_id,
            "account-c"
        );
    }

    #[test]
    fn platform_accounts_reject_custom_and_blank_labels() {
        let database = test_database();
        let error = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::Custom,
                account_id: "custom".to_string(),
                account_label: "Custom".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec![],
                token_secret_ref: None,
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap_err();
        assert!(error.to_string().contains("Custom RTMP"));

        let error = database
            .upsert_platform_account(UpsertPlatformAccount {
                platform: StreamPlatform::X,
                account_id: "x-account".to_string(),
                account_label: " ".to_string(),
                account_handle: None,
                avatar_url: None,
                scopes: vec![],
                token_secret_ref: None,
                refresh_token_secret_ref: None,
                stream_key_secret_ref: None,
                expires_at: None,
                status: PlatformAccountStatus::Connected,
            })
            .unwrap_err();
        assert!(error.to_string().contains("label"));
    }

    #[test]
    fn incomplete_repair_jobs_round_trip_and_exclude_finished() {
        use crate::repair::{QualityExpectations, RepairOutcome};

        let database = test_database();
        let expectations = QualityExpectations {
            intended_fps: Some(30.0),
            expect_audio: true,
        };

        let pending = RepairJob::pending(
            "job-pending".to_string(),
            "/m/a.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        let mut running = RepairJob::pending(
            "job-running".to_string(),
            "/m/b.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        running.mark_running("t1".to_string());
        let mut done = RepairJob::pending(
            "job-done".to_string(),
            "/m/c.mp4".to_string(),
            &expectations,
            "t0".to_string(),
        );
        done.complete(
            &RepairOutcome::Repaired {
                path: "/m/c.mp4".to_string(),
                interpolated: true,
            },
            "t1".to_string(),
        );

        database.upsert_repair_job(&pending).unwrap();
        database.upsert_repair_job(&running).unwrap();
        database.upsert_repair_job(&done).unwrap();

        // Only pending + running come back for resume; the completed job is excluded.
        let mut incomplete = database.incomplete_repair_jobs().unwrap();
        incomplete.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = incomplete.iter().map(|job| job.id.clone()).collect();
        assert_eq!(
            ids,
            vec!["job-pending".to_string(), "job-running".to_string()]
        );

        // Fields round-trip through the DB.
        let running_back = incomplete
            .iter()
            .find(|job| job.id == "job-running")
            .unwrap();
        assert_eq!(running_back.status, RepairJobStatus::Running);
        assert_eq!(running_back.intended_fps, Some(30.0));
        assert!(running_back.expect_audio);

        // Upsert updates in place: cancelling the pending job removes it from the set.
        let mut cancelled = pending;
        cancelled.cancel("t2".to_string());
        database.upsert_repair_job(&cancelled).unwrap();
        let incomplete = database.incomplete_repair_jobs().unwrap();
        assert_eq!(incomplete.len(), 1);
        assert_eq!(incomplete[0].id, "job-running");
    }
}
