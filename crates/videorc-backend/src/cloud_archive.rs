//! S21c: bounded local copy of authorized cloud program segments. No capture,
//! recording/control ownership, source deletion, or automatic paid activation.
use crate::{
    cloud_control_web::CloudRecordingItem,
    storage::{Database, SessionFileObjectIdentity, capture_session_file_object_identity},
    videorc_api::VideorcApiClient,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::watch;

pub const MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_SEGMENTS: usize = 512;
/// Finished archives (complete, cancelled) kept for the list (L3). Each keeps
/// only its owner file in an otherwise empty hidden folder.
const KEEP_FINISHED: usize = 8;
/// partial/corrupt archives that keep their staging, ≤ `MAX_BYTES` each (L3).
/// Neither can be resumed; Discard was their only way out.
const KEEP_RETAINED: usize = 2;
/// Interrupted archives waiting for Resume or Discard (L3).
const MAX_RESUMABLE: usize = 4;
/// The refusal when `MAX_RESUMABLE` archives wait, and its words.
pub const RESUME_OR_DISCARD: &str = "archive-resume-or-discard";
pub const RESUME_OR_DISCARD_WORDS: &str =
    "Resume or discard the unfinished archives below before starting another.";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub sequence: u64,
    pub sha256: String,
    pub bytes: u64,
    pub start_ms: f64,
    pub end_ms: f64,
    pub duration_ms: f64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub qualified: bool,
    pub owner_key: String,
    pub show_id: String,
    pub generation: String,
    pub expires_at: i64,
    pub recording_active: bool,
    pub recording_complete: bool,
    pub recording: Option<CloudRecordingItem>,
    pub segments: Vec<Segment>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFile {
    pub name: String,
    pub identity: SessionFileObjectIdentity,
    #[serde(default)]
    pub pending_delete: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub id: String,
    pub show_id: String,
    pub generation: String,
    pub owner_key: String,
    pub expires_at: i64,
    pub folder: PathBuf,
    pub root: PathBuf,
    pub state: String,
    pub reason: String,
    pub recording: Option<CloudRecordingItem>,
    pub segments: Vec<Segment>,
    pub files: Vec<OwnedFile>,
    pub bytes: u64,
    pub complete_source: bool,
    pub local_session_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveView {
    pub id: String,
    pub show_id: String,
    pub state: String,
    pub reason: String,
    pub bytes: u64,
    pub segments: usize,
    pub local_session_id: Option<String>,
}
impl Journal {
    pub fn view(&self) -> ArchiveView {
        let active = workers().lock().is_ok_and(|w| w.contains_key(&self.id));
        ArchiveView {
            id: self.id.clone(),
            show_id: self.show_id.clone(),
            state: if !active && matches!(self.state.as_str(), "waiting" | "copying" | "finalizing")
            {
                "interrupted".into()
            } else {
                self.state.clone()
            },
            reason: self.reason.clone(),
            bytes: self.bytes,
            segments: self.segments.len(),
            local_session_id: self.local_session_id.clone(),
        }
    }
    fn save(&self, db: &Database) -> Result<()> {
        db.save_cloud_archive(self)
    }
    fn check_root(&self) -> Result<()> {
        ensure!(
            self.root.parent() == Some(self.folder.as_path())
                && self.root.file_name().and_then(|v| v.to_str())
                    == Some(format!(".videorc-archive-{}", self.id).as_str()),
            "archive-directory-changed"
        );
        ensure!(
            !std::fs::symlink_metadata(&self.root)?
                .file_type()
                .is_symlink(),
            "archive-directory-changed"
        );
        self.check_file("owner")?;
        ensure!(
            std::fs::read_to_string(self.owned_path("owner")?)? == self.id,
            "archive-owner-changed"
        );
        Ok(())
    }
    fn owned_path(&self, name: &str) -> Result<PathBuf> {
        let file = self
            .files
            .iter()
            .find(|f| f.name == name)
            .context("archive-file-not-owned")?;
        if let Some(q) = &file.pending_delete {
            ensure!(
                q.starts_with(".remove-") && !q.contains('/') && !q.contains('\\'),
                "archive-invalid-cleanup"
            );
            let path = self.root.join(q);
            if path.try_exists()? {
                return Ok(path);
            }
        }
        Ok(self.root.join(name))
    }
    fn check_file(&self, name: &str) -> Result<()> {
        let expected = self
            .files
            .iter()
            .find(|f| f.name == name)
            .context("archive-file-not-owned")?;
        let path = self.owned_path(name)?;
        ensure!(
            !std::fs::symlink_metadata(&path)?.file_type().is_symlink()
                && capture_session_file_object_identity(&path)? == Some(expected.identity.clone()),
            "archive-file-changed"
        );
        Ok(())
    }
    fn create(&mut self, db: &Database, name: &str) -> Result<std::fs::File> {
        ensure!(
            !name.contains('/') && !name.contains('\\') && name != "..",
            "invalid-archive-file"
        );
        let path = self.root.join(name);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let identity =
            crate::storage::capture_session_file_object_identity_from_file(&file, &path)?;
        self.files.push(OwnedFile {
            name: name.into(),
            identity,
            pending_delete: None,
        });
        self.save(db)?;
        Ok(file)
    }
    fn remove(&mut self, db: &Database, name: &str) -> Result<()> {
        self.check_root()?;
        let expected = self
            .files
            .iter()
            .find(|f| f.name == name)
            .context("archive-file-not-owned")?
            .clone();
        let original = self.root.join(name);
        let quarantine = expected
            .pending_delete
            .clone()
            .unwrap_or_else(|| format!(".remove-{}", uuid::Uuid::new_v4()));
        let q = self.root.join(&quarantine);
        if expected.pending_delete.is_some() && !original.try_exists()? && !q.try_exists()? {
            self.files.retain(|f| f.name != name);
            return self.save(db);
        }
        self.check_file(name)?;
        if !q.try_exists()? {
            self.files
                .iter_mut()
                .find(|f| f.name == name)
                .unwrap()
                .pending_delete = Some(quarantine);
            self.save(db)?;
            crate::session_ops::rename_session_file_no_replace(&original, &q)?;
        }
        if std::fs::symlink_metadata(&q)?.file_type().is_symlink()
            || capture_session_file_object_identity(&q)? != Some(expected.identity)
        {
            if !original.try_exists()? {
                crate::session_ops::rename_session_file_no_replace(&q, &original)?;
            }
            bail!("archive-file-changed");
        }
        std::fs::remove_file(&q)?;
        crate::session_ops::sync_session_file_parent(&q)?;
        self.files.retain(|f| f.name != name);
        self.save(db)
    }
    fn validate_snapshot(&self, s: &Snapshot) -> Result<()> {
        ensure!(s.version == 1 && s.qualified, "managed-replay-unqualified");
        ensure!(
            s.owner_key == self.owner_key
                && s.show_id == self.show_id
                && s.generation == self.generation
                && s.expires_at == self.expires_at,
            "archive-owner-generation-changed"
        );
        if let (Some(a), Some(b)) = (&self.recording, &s.recording) {
            ensure!(
                a.id == b.id && a.take_id == b.take_id && a.started_at == b.started_at,
                "archive-take-changed"
            );
        }
        ensure!(s.segments.len() <= 64, "archive-manifest-too-large");
        Ok(())
    }
}
fn workers() -> &'static Mutex<BTreeMap<String, watch::Sender<u8>>> {
    static W: OnceLock<Mutex<BTreeMap<String, watch::Sender<u8>>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(BTreeMap::new()))
}
/// Shared with S20: only one publisher may own a take's local Library journal.
pub(crate) struct TakeFileClaim(String);
fn file_claims() -> &'static Mutex<std::collections::BTreeSet<String>> {
    static C: OnceLock<Mutex<std::collections::BTreeSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::BTreeSet::new()))
}
pub(crate) fn claim_take_file(id: &str) -> Result<TakeFileClaim> {
    ensure!(
        file_claims().lock().unwrap().insert(id.into()),
        "This take already has a local file operation running."
    );
    Ok(TakeFileClaim(id.into()))
}
impl Drop for TakeFileClaim {
    fn drop(&mut self) {
        file_claims().lock().unwrap().remove(&self.0);
    }
}

pub fn signal(id: &str, cancel: bool) -> Result<()> {
    let map = workers()
        .lock()
        .map_err(|_| anyhow::anyhow!("archive-worker-unavailable"))?;
    map.get(id)
        .context("archive-not-running")?
        .send(if cancel { 2 } else { 1 })
        .map_err(|_| anyhow::anyhow!("archive-not-running"))
}
/// Contiguous from source sequence zero, with exact byte hashes. Late joins and
/// missing windows must remain partial; media time never comes from wall time.
pub fn check_next(j: &Journal, s: &Segment) -> Result<()> {
    ensure!(
        s.bytes > 0
            && s.bytes <= 8 * 1024 * 1024
            && s.sha256.len() == 64
            && s.sha256.bytes().all(|c| c.is_ascii_hexdigit()),
        "archive-invalid-segment"
    );
    ensure!(
        s.start_ms.is_finite()
            && s.end_ms.is_finite()
            && s.duration_ms.is_finite()
            && s.end_ms > s.start_ms
            && (s.end_ms - s.start_ms - s.duration_ms).abs() <= 0.01
            && s.duration_ms <= 10000.0,
        "archive-invalid-clock"
    );
    ensure!(
        j.segments.len() < MAX_SEGMENTS
            && j.bytes.checked_add(s.bytes).is_some_and(|n| n <= MAX_BYTES),
        "archive-limit"
    );
    let (seq, end) = j
        .segments
        .last()
        .map(|p| (p.sequence + 1, p.end_ms))
        .unwrap_or((0, 0.0));
    ensure!(
        s.sequence == seq && (s.start_ms - end).abs() <= 0.01,
        "archive-gap"
    );
    Ok(())
}
pub fn full_coverage(j: &Journal) -> bool {
    j.complete_source
        && j.recording.as_ref().is_some_and(|r| {
            r.seconds.is_finite()
                && r.seconds > 0.0
                && j.segments
                    .last()
                    .is_some_and(|s| (s.end_ms - r.seconds * 1000.0).abs() <= 100.0)
        })
}

/// L3: room for one new archive. Archives used to be capped at 16 for the
/// app's lifetime, and every partial one kept up to 256 MiB in a hidden folder
/// until the user discarded it. Now the oldest finished and partial/corrupt
/// archives are discarded (the same owned-file removal as Discard), a row
/// whose folder is gone leaves (nothing of it is on disk), and only archives
/// that can still be resumed count against the cap. Never touches a running one.
fn admit(db: &Database) -> Result<()> {
    let running: Vec<String> = workers().lock().unwrap().keys().cloned().collect();
    let (mut finished, mut retained, mut resumable) = (0, 0, 0);
    for j in db.all_cloud_archives()? {
        if running.contains(&j.id) {
            continue;
        }
        if !j.root.exists() {
            db.delete_cloud_archive(&j.id)?;
            continue;
        }
        let over = match j.state.as_str() {
            "complete" | "cancelled" => {
                finished += 1;
                finished > KEEP_FINISHED
            }
            "partial" | "corrupt" => {
                retained += 1;
                retained > KEEP_RETAINED
            }
            _ => {
                resumable += 1;
                false
            }
        };
        if over && let Err(error) = discard(db, &j.id) {
            tracing::warn!("old cloud archive {} was not discarded: {error}", j.id);
        }
    }
    ensure!(resumable < MAX_RESUMABLE, RESUME_OR_DISCARD);
    Ok(())
}
pub async fn start(
    db: Database,
    api: VideorcApiClient,
    token: String,
    show: String,
    orientation: String,
    folder: PathBuf,
    ffmpeg: String,
) -> Result<ArchiveView> {
    ensure!(
        workers().lock().unwrap().is_empty(),
        "archive-already-running"
    );
    admit(&db)?;
    let id = uuid::Uuid::new_v4().to_string();
    let availability: serde_json::Value =
        api.archive_json(&token, &show, None, "GET", None).await?;
    ensure!(
        availability.get("available").and_then(|v| v.as_bool()) == Some(true),
        "managed-replay-unqualified"
    );
    let expected = availability
        .get("generation")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let s:Snapshot=api.archive_json(&token,&show,None,"POST",Some(serde_json::json!({"consent":true,"orientation":orientation,"requestId":id,"expectedGeneration":expected,"byteCeiling":MAX_BYTES,"costCeilingMicros":100000}))).await?;
    ensure!(
        s.version == 1 && s.qualified && s.show_id == show,
        "managed-replay-unqualified"
    );
    let root = folder.join(format!(".videorc-archive-{id}"));
    if let Err(error) = std::fs::create_dir(&root) {
        let _: Result<serde_json::Value> = api
            .archive_json(&token, &show, Some(&s.generation), "DELETE", None)
            .await;
        return Err(error.into());
    }
    let mut j = Journal {
        id,
        show_id: show,
        generation: s.generation,
        owner_key: s.owner_key,
        expires_at: s.expires_at,
        folder,
        root,
        state: "waiting".into(),
        reason: "Waiting for a separately started cloud recording.".into(),
        recording: None,
        segments: vec![],
        files: vec![],
        bytes: 0,
        complete_source: false,
        local_session_id: None,
    };
    let prepared: Result<()> = (|| {
        let mut marker = j.create(&db, "owner")?;
        marker.write_all(j.id.as_bytes())?;
        marker.sync_all()?;
        Ok(())
    })();
    if let Err(error) = prepared {
        let _: Result<serde_json::Value> = api
            .archive_json(&token, &j.show_id, Some(&j.generation), "DELETE", None)
            .await;
        return Err(error);
    }
    launch(db, api, token, j, ffmpeg)
}
pub fn resume(
    db: Database,
    api: VideorcApiClient,
    token: String,
    id: &str,
    ffmpeg: String,
) -> Result<ArchiveView> {
    let j = db.cloud_archive(id)?.context("archive-not-found")?;
    ensure!(
        matches!(
            j.state.as_str(),
            "waiting" | "copying" | "interrupted" | "finalizing"
        ),
        "archive-not-resumable"
    );
    j.check_root()?;
    launch(db, api, token, j, ffmpeg)
}
fn launch(
    db: Database,
    api: VideorcApiClient,
    token: String,
    mut j: Journal,
    ffmpeg: String,
) -> Result<ArchiveView> {
    let (tx, rx) = watch::channel(0);
    {
        let mut map = workers().lock().unwrap();
        ensure!(map.is_empty(), "archive-already-running");
        map.insert(j.id.clone(), tx);
    }
    let view = j.view();
    tokio::spawn(async move {
        if let Err(error) = run(&db, &api, &token, &mut j, &ffmpeg, rx).await {
            let code = error.to_string();
            if code == "archive-cancelled" {
                j.state = "cancelled".into();
                j.reason = "Archive cancelled; cloud recording is unchanged.".into();
                let _ = j.save(&db);
                let _ = cleanup(&db, &mut j);
                let _: Result<serde_json::Value> = api
                    .archive_json(&token, &j.show_id, Some(&j.generation), "DELETE", None)
                    .await;
                workers().lock().unwrap().remove(&j.id);
                return;
            }
            j.state = if code == "archive-account-changed" {
                "interrupted"
            } else if code.contains("hash") || code.contains("changed") || code.contains("invalid")
            {
                "corrupt"
            } else if code.contains("budget")
                || code.contains("ceiling")
                || code.contains("expired")
                || code.contains("stale-generation")
                || code.contains("gap")
                || code.contains("limit")
                || chrono::Utc::now().timestamp_millis() >= j.expires_at
            {
                "partial"
            } else {
                "interrupted"
            }
            .into();
            // No URL/token/provider response or local path in public diagnostics.
            j.reason=if code.contains("gap") {"Some program segments are missing. Download the finished cloud take to recover the full recording."} else if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind()==std::io::ErrorKind::StorageFull) || code.contains("No space") {"Disk is full. Free space, then resume before the cloud buffer expires."} else {"Archive stopped before completion. Retained files require explicit resume or discard."}.into();
            let _ = j.save(&db);
        }
        if matches!(
            j.state.as_str(),
            "complete" | "cancelled" | "partial" | "corrupt"
        ) {
            // Closing only this owned generation never stops its source recording.
            let _: Result<serde_json::Value> = api
                .archive_json(&token, &j.show_id, Some(&j.generation), "DELETE", None)
                .await;
        }
        workers().lock().unwrap().remove(&j.id);
    });
    Ok(view)
}
async fn run(
    db: &Database,
    api: &VideorcApiClient,
    token: &str,
    j: &mut Journal,
    ffmpeg: &str,
    mut stop: watch::Receiver<u8>,
) -> Result<()> {
    j.check_root()?;
    // A crash during a write owns that inode but not a completed segment.
    let incomplete: Vec<String> = j
        .files
        .iter()
        .filter(|f| {
            f.name.starts_with("seg-")
                && !j
                    .segments
                    .iter()
                    .any(|s| f.name == format!("seg-{}.ts", s.sequence))
        })
        .map(|f| f.name.clone())
        .collect();
    for name in incomplete {
        j.remove(db, &name)?;
    }
    for s in &j.segments {
        j.check_file(&format!("seg-{}.ts", s.sequence))?;
        let bytes = std::fs::read(j.root.join(format!("seg-{}.ts", s.sequence)))?;
        ensure!(
            bytes.len() as u64 == s.bytes && format!("{:x}", Sha256::digest(&bytes)) == s.sha256,
            "archive-hash-changed"
        );
    }
    if full_coverage(j) {
        let item = j.recording.as_ref().context("archive-take-missing")?;
        let _claim = claim_take_file(&item.id)?;
        if db.recover_cloud_recording_file(item)?.is_some() {
            j.local_session_id = db.cloud_recording_session(&item.id)?;
            j.files
                .retain(|f| f.name != "archive.part" || j.root.join("archive.part").exists());
            j.state = "complete".into();
            j.reason = "Recovered the completed local cloud-program copy.".into();
            j.save(db)?;
            return cleanup(db, j);
        }
        // All bytes and final take facts were already authorized and persisted;
        // local recovery after cloud expiry needs no provider request.
        return finalize(db, j, ffmpeg, stop).await;
    }
    let mut inactive_polls = 0;
    let mut failures = 0;
    'acquire: loop {
        ensure!(
            crate::account::stored_session_token().as_deref() == Some(token),
            "archive-account-changed"
        );
        let command = *stop.borrow();
        if command == 2 {
            j.state = "cancelled".into();
            j.reason = "Archive cancelled; cloud recording continues independently.".into();
            j.save(db)?;
            return cleanup(db, j);
        }
        if command == 1 {
            j.complete_source = false;
            break;
        }
        ensure!(
            chrono::Utc::now().timestamp_millis() < j.expires_at,
            "archive-limit"
        );
        let snap: Result<Snapshot> = api
            .archive_json(token, &j.show_id, Some(&j.generation), "PUT", None)
            .await;
        let s = match snap {
            Ok(s) => {
                failures = 0;
                s
            }
            Err(error) => {
                failures += 1;
                if failures >= 5 {
                    return Err(error);
                }
                tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=stop.changed()=>{}}
                continue;
            }
        };
        ensure!(
            crate::account::stored_session_token().as_deref() == Some(token),
            "archive-account-changed"
        );
        if *stop.borrow() != 0 {
            continue;
        }
        j.validate_snapshot(&s)?;
        if let Some(recording) = s.recording {
            j.recording = Some(recording);
        }
        j.complete_source = s.recording_complete;
        for segment in s.segments {
            if let Some(prior) = j.segments.iter().find(|p| p.sequence == segment.sequence) {
                ensure!(
                    prior.sha256 == segment.sha256
                        && prior.bytes == segment.bytes
                        && prior.start_ms == segment.start_ms
                        && prior.end_ms == segment.end_ms,
                    "archive-segment-changed"
                );
                continue;
            }
            check_next(j, &segment)?;
            let bytes = api
                .archive_segment(
                    token,
                    &j.show_id,
                    &j.generation,
                    segment.sequence,
                    segment.bytes,
                )
                .await?;
            ensure!(
                crate::account::stored_session_token().as_deref() == Some(token),
                "archive-account-changed"
            );
            if *stop.borrow() != 0 {
                continue 'acquire;
            }
            ensure!(
                bytes.len() as u64 == segment.bytes
                    && format!("{:x}", Sha256::digest(&bytes)) == segment.sha256,
                "archive-hash-mismatch"
            );
            j.check_root()?;
            let mut file = j.create(db, &format!("seg-{}.ts", segment.sequence))?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            crate::session_ops::sync_session_file_parent(
                &j.root.join(format!("seg-{}.ts", segment.sequence)),
            )?;
            j.bytes += segment.bytes;
            j.segments.push(segment);
            j.state = "copying".into();
            j.reason = "Copying the cloud program to this computer.".into();
            j.save(db)?;
        }
        if s.recording_active {
            inactive_polls = 0;
        } else if j.recording.is_some() {
            inactive_polls += 1;
        }
        if j.complete_source || inactive_polls >= 5 {
            break;
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=stop.changed()=>{}}
    }
    ensure!(
        crate::account::stored_session_token().as_deref() == Some(token),
        "archive-account-changed"
    );
    finalize(db, j, ffmpeg, stop).await
}
async fn finalize(
    db: &Database,
    j: &mut Journal,
    ffmpeg: &str,
    mut stop: watch::Receiver<u8>,
) -> Result<()> {
    ensure!(!j.segments.is_empty(), "archive-empty");
    j.check_root()?;
    j.state = "finalizing".into();
    j.save(db)?;
    for name in ["index.m3u8", "archive.part"] {
        if j.files.iter().any(|f| f.name == name) {
            j.remove(db, name)?;
        }
    }
    let mut playlist = String::from(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n",
    );
    for s in &j.segments {
        playlist.push_str(&format!(
            "#EXTINF:{:.3},\nseg-{}.ts\n",
            s.duration_ms / 1000.0,
            s.sequence
        ));
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    let mut f = j.create(db, "index.m3u8")?;
    f.write_all(playlist.as_bytes())?;
    f.sync_all()?;
    let output = j.root.join("archive.part");
    j.create(db, "archive.part")?.sync_all()?;
    let result = bounded_remux(
        ffmpeg,
        crate::cloud_control_web::remux_args(&j.root.join("index.m3u8"), &output),
        &mut stop,
    )
    .await?;
    ensure!(result.success, "archive-invalid-media");
    // Decode the finished artifact with the trusted FFmpeg, including audio/video.
    let args = ["-v", "error", "-xerror", "-nostdin", "-i"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .chain(std::iter::once(output.as_os_str().to_owned()))
        .chain(
            ["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]
                .into_iter()
                .map(std::ffi::OsString::from),
        )
        .collect();
    let checked = bounded_remux(ffmpeg, args, &mut stop).await?;
    ensure!(checked.success, "archive-invalid-media");
    let actual_ms = crate::session_ops::probe_duration_ms(ffmpeg, &output)
        .await
        .context("archive-invalid-duration")?;
    let expected_ms = j.segments.last().context("archive-empty")?.end_ms as i64;
    ensure!(
        (actual_ms - expected_ms).abs() <= 250,
        "archive-invalid-duration"
    );
    if *stop.borrow() == 2 {
        j.state = "cancelled".into();
        j.reason = "Archive cancelled.".into();
        j.save(db)?;
        return cleanup(db, j);
    }
    if !full_coverage(j) {
        j.state = "partial".into();
        j.reason="Partial cloud-program copy retained. Download the finished cloud take for complete coverage.".into();
        return j.save(db);
    }
    let item = j.recording.as_ref().context("archive-take-missing")?;
    let _claim = claim_take_file(&item.id)?;
    if db.cloud_recording_session(&item.id)?.is_none() {
        let destination = j.folder.join(format!("cloud-archive-{}.mp4", j.id));
        db.prepare_cloud_recording_file(item, &output, &destination)?;
        db.recover_cloud_recording_file(item)?
            .context("archive-publication-failed")?;
        j.files.retain(|f| f.name != "archive.part");
    }
    j.local_session_id = db.cloud_recording_session(&item.id)?;
    j.state = "complete".into();
    j.reason = "Local cloud-program copy is in Library.".into();
    j.save(db)?;
    cleanup(db, j)
}
async fn bounded_remux(
    ffmpeg: &str,
    args: Vec<std::ffi::OsString>,
    stop: &mut watch::Receiver<u8>,
) -> Result<crate::cloud_control_web::RemuxOutcome> {
    let (cancel, rx) = watch::channel(false);
    let mut task = Box::pin(crate::cloud_control_web::run_ffmpeg_remux(
        ffmpeg.into(),
        args,
        rx,
    ));
    let deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result=&mut task=>return Ok(result?),
            _=&mut deadline=>{let _=cancel.send(true);let _=task.await;bail!("archive-remux-timeout");},
            result=stop.changed()=>{if result.is_err() || *stop.borrow()==2 {let _=cancel.send(true);let _=task.await;bail!("archive-cancelled");}}
        }
    }
}
fn cleanup(db: &Database, j: &mut Journal) -> Result<()> {
    let files: Vec<String> = j
        .files
        .iter()
        .filter(|f| f.name != "owner")
        .map(|f| f.name.clone())
        .collect();
    for name in files {
        if j.owned_path(&name)?.try_exists()?
            || j.files
                .iter()
                .any(|f| f.name == name && f.pending_delete.is_some())
        {
            j.remove(db, &name)?;
        }
    }
    // Keep the small ownership marker/journal for idempotent status; never remove_dir_all.
    j.save(db)
}
pub fn discard(db: &Database, id: &str) -> Result<()> {
    ensure!(
        !workers().lock().unwrap().contains_key(id),
        "archive-still-running"
    );
    let mut j = db.cloud_archive(id)?.context("archive-not-found")?;
    cleanup(db, &mut j)?;
    j.remove(db, "owner")?;
    std::fs::remove_dir(&j.root)?;
    db.delete_cloud_archive(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn journal() -> Journal {
        Journal {
            id: "fixture".into(),
            show_id: "show".into(),
            generation: "generation".into(),
            owner_key: "owner".into(),
            expires_at: 300000,
            folder: PathBuf::new(),
            root: PathBuf::new(),
            state: "copying".into(),
            reason: String::new(),
            recording: None,
            segments: vec![],
            files: vec![],
            bytes: 0,
            complete_source: false,
            local_session_id: None,
        }
    }
    fn segment(n: u64) -> Segment {
        Segment {
            sequence: n,
            sha256: "a".repeat(64),
            bytes: 1024,
            start_ms: (n * 2000) as f64,
            end_ms: ((n + 1) * 2000) as f64,
            duration_ms: 2000.0,
        }
    }
    #[test]
    fn late_start_gap_clock_and_budget_never_become_complete() {
        let mut j = journal();
        assert!(check_next(&j, &segment(1)).is_err());
        assert!(check_next(&j, &segment(0)).is_ok());
        j.segments.push(segment(0));
        j.bytes = 1024;
        assert!(check_next(&j, &segment(2)).is_err());
        let mut bad = segment(1);
        bad.start_ms += 1.0;
        assert!(check_next(&j, &bad).is_err());
        j.bytes = MAX_BYTES;
        assert!(check_next(&j, &segment(1)).is_err());
        assert!(!full_coverage(&j));
        j.complete_source = true;
        j.recording = Some(CloudRecordingItem {
            seconds: 4.0,
            ..Default::default()
        });
        assert!(!full_coverage(&j));
        j.segments.push(segment(1));
        assert!(full_coverage(&j));
    }
    #[test]
    fn replaced_files_are_preserved_and_journal_survives_restart() {
        let db = Database::open_in_memory_for_tests();
        let temp = crate::test_temp_dir::TestTempDir::new("archive-owned");
        let mut j = journal();
        j.folder = temp.join("output");
        std::fs::create_dir(&j.folder).unwrap();
        j.root = j.folder.join(".videorc-archive-fixture");
        std::fs::create_dir(&j.root).unwrap();
        j.create(&db, "owner")
            .unwrap()
            .write_all(b"fixture")
            .unwrap();
        j.create(&db, "seg-0.ts")
            .unwrap()
            .write_all(b"owned")
            .unwrap();
        let old = j.root.join("seg-0.ts");
        let moved = j.root.join("held-by-test");
        std::fs::rename(&old, &moved).unwrap();
        std::fs::write(&old, b"unrelated").unwrap();
        assert!(j.remove(&db, "seg-0.ts").is_err());
        assert_eq!(std::fs::read(&old).unwrap(), b"unrelated");
        let restored = db.cloud_archive(&j.id).unwrap().unwrap();
        assert_eq!(restored.view().state, "interrupted");
        assert_eq!(restored.files.len(), 2);
    }
    #[test]
    fn fractional_hls_durations_survive_without_fabricating_clock_ticks() {
        let mut j = journal();
        let mut first = segment(0);
        first.duration_ms = 2016.667;
        first.end_ms = 2016.667;
        assert!(check_next(&j, &first).is_ok());
        j.segments.push(first);
        let mut next = segment(1);
        next.start_ms = 2016.667;
        next.end_ms = 4033.334;
        next.duration_ms = 2016.667;
        assert!(check_next(&j, &next).is_ok());
        next.duration_ms = f64::NAN;
        assert!(check_next(&j, &next).is_err());
    }
    #[test]
    fn take_publisher_claim_is_shared_and_released_on_failure() {
        let a = claim_take_file("archive-test-take").unwrap();
        assert!(claim_take_file("archive-test-take").is_err());
        drop(a);
        assert!(claim_take_file("archive-test-take").is_ok());
    }

    fn archive_rows(db: &Database) -> i64 {
        db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM cloud_program_archives", [], |r| {
                r.get(0)
            })
            .unwrap()
    }

    /// Hidden archive folders under `folder` and the bytes inside them.
    fn staging_on_disk(folder: &std::path::Path) -> (usize, u64) {
        let (mut folders, mut bytes) = (0, 0);
        for entry in std::fs::read_dir(folder).unwrap() {
            let entry = entry.unwrap();
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".videorc-archive-")
            {
                continue;
            }
            folders += 1;
            for file in std::fs::read_dir(entry.path()).unwrap() {
                bytes += file.unwrap().metadata().unwrap().len();
            }
        }
        (folders, bytes)
    }

    /// L3: after 16 archives in the app's lifetime every start was refused
    /// (`archive-journal-full`), and each partial archive kept its staging
    /// files in a hidden folder until the user discarded it. Twenty cycles of
    /// a partial archive with real staging files, each followed by a start:
    /// no start may be refused for the journal, and rows, hidden folders and
    /// staging bytes must stay bounded.
    #[tokio::test]
    async fn twenty_partial_archives_never_fill_the_journal_or_the_disk() {
        let temp = crate::test_temp_dir::TestTempDir::new("archive-twenty");
        let folder = temp.join("output");
        std::fs::create_dir(&folder).unwrap();
        let db = Database::open_in_memory_for_tests();
        let address =
            crate::cloud_clips::test_api::serve(std::sync::Arc::new(|_: &reqwest::Url| {
                (200, br#"{"available":false}"#.to_vec())
            }))
            .await;
        let api = VideorcApiClient::for_base_url(format!("http://{address}"));
        let staging = vec![7u8; 1024 * 1024];
        for n in 1..=20 {
            let mut j = journal();
            j.id = uuid::Uuid::new_v4().to_string();
            j.show_id = "sh_fixture".into();
            j.folder = folder.clone();
            j.root = folder.join(format!(".videorc-archive-{}", j.id));
            std::fs::create_dir(&j.root).unwrap();
            let mut owner = j.create(&db, "owner").unwrap();
            owner.write_all(j.id.as_bytes()).unwrap();
            for name in ["seg-0.ts", "archive.part"] {
                j.create(&db, name).unwrap().write_all(&staging).unwrap();
            }
            j.segments.push(segment(0));
            j.state = "partial".into();
            j.save(&db).unwrap();
            let refused = start(
                db.clone(),
                api.clone(),
                "token".into(),
                "sh_fixture".into(),
                "h".into(),
                folder.clone(),
                "ffmpeg".into(),
            )
            .await
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
            let (folders, bytes) = staging_on_disk(&folder);
            eprintln!(
                "archive {n}: start said {refused:?}; rows {}, hidden folders {folders}, {:.1} MiB staged",
                archive_rows(&db),
                bytes as f64 / 1048576.0
            );
            assert_ne!(refused, "archive-journal-full", "archive {n}");
            assert_eq!(refused, "managed-replay-unqualified", "archive {n}");
        }
        let (folders, bytes) = staging_on_disk(&folder);
        assert!(archive_rows(&db) <= 3, "rows {}", archive_rows(&db));
        assert!(folders <= 3, "hidden folders {folders}");
        assert!(bytes <= 3 * 2 * 1024 * 1024 + 4096, "staged bytes {bytes}");
    }

    /// L3: archives that can still be resumed are the user's: never discarded,
    /// capped, and the refusal says what to do.
    #[tokio::test]
    async fn resumable_archives_are_kept_and_capped_in_words() {
        let temp = crate::test_temp_dir::TestTempDir::new("archive-resumable");
        let folder = temp.join("output");
        std::fs::create_dir(&folder).unwrap();
        let db = Database::open_in_memory_for_tests();
        for n in 0..MAX_RESUMABLE {
            let mut j = journal();
            j.id = format!("resumable-{n}");
            j.folder = folder.clone();
            j.root = folder.join(format!(".videorc-archive-{}", j.id));
            std::fs::create_dir(&j.root).unwrap();
            j.create(&db, "owner")
                .unwrap()
                .write_all(j.id.as_bytes())
                .unwrap();
            j.state = "interrupted".into();
            j.save(&db).unwrap();
        }
        let mut gone = journal();
        gone.id = "folder-deleted".into();
        gone.root = folder.join(".videorc-archive-folder-deleted");
        gone.state = "interrupted".into();
        gone.save(&db).unwrap();
        assert_eq!(admit(&db).unwrap_err().to_string(), RESUME_OR_DISCARD);
        assert!(db.cloud_archive("folder-deleted").unwrap().is_none());
        assert_eq!(archive_rows(&db), MAX_RESUMABLE as i64);
        discard(&db, "resumable-0").unwrap();
        admit(&db).expect("room after a discard");
    }
}
