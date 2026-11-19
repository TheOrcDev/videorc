//! S21b: one bounded, cancellable local extraction from the authorized program
//! ring. A server marker is not a media clock. No native capture or egress starts.
use crate::{
    storage::{Database, SessionFileObjectIdentity, capture_session_file_object_identity},
    videorc_api::VideorcApiClient,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::watch;
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Journal rows, the new job's included; the jobs list shows every one (L2).
const MAX_ROWS: usize = 16;
/// Clips that can still be retried at once (L2).
const MAX_RETRYABLE: usize = 16;
/// Clips that may keep staging files for Retry: 4 × `MAX_BYTES` (L2; was 1).
const MAX_STAGING: usize = 4;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub sequence: u64,
    pub sha256: String,
    pub bytes: u64,
    pub start_ms: f64,
    pub end_ms: f64,
    pub duration_ms: f64,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u32,
    pub id: String,
    pub owner_key: String,
    pub show_id: String,
    pub marker_id: String,
    pub generation: String,
    pub take_id: String,
    pub provider_egress_id: String,
    pub live_interval_id: Option<String>,
    pub show_origin: String,
    pub orientation: String,
    pub expires_at: i64,
    pub uncertainty_ms: f64,
    pub trim_start_ms: f64,
    pub duration_ms: f64,
    pub bytes: u64,
    pub trim: String,
    pub segments: Vec<Segment>,
    pub requested: Window,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub start_ms: f64,
    pub end_ms: f64,
}
impl Plan {
    pub fn validate(&self, show: &str, marker: &str, generation: &str, now: i64) -> Result<()> {
        ensure!(
            self.version == 1
                && self.show_id == show
                && self.marker_id == marker
                && self.generation == generation,
            "clip-scope-changed"
        );
        ensure!(
            self.id.starts_with("clip_")
                && self.id.len() == 69
                && self.id[5..].bytes().all(|b| b.is_ascii_hexdigit())
                && self.owner_key.len() == 64,
            "clip-invalid-identity"
        );
        ensure!(
            !self.take_id.is_empty()
                && !self.provider_egress_id.is_empty()
                && matches!(self.orientation.as_str(), "h" | "v"),
            "clip-invalid-source"
        );
        ensure!(
            self.expires_at > now && self.trim == "decode-trim-reencode-av",
            "clip-expired-or-unqualified"
        );
        ensure!(
            [
                self.duration_ms,
                self.trim_start_ms,
                self.uncertainty_ms,
                self.requested.start_ms,
                self.requested.end_ms
            ]
            .iter()
            .all(|v| v.is_finite())
                && self.duration_ms > 0.0
                && self.duration_ms <= 60000.0
                && self.trim_start_ms >= 0.0
                && (0.0..=50.0).contains(&self.uncertainty_ms)
                && self.requested.start_ms >= 0.0
                && (self.requested.end_ms - self.requested.start_ms - self.duration_ms).abs() < 1.0,
            "clip-invalid-window"
        );
        chrono::DateTime::parse_from_rfc3339(&self.show_origin)?;
        ensure!(
            !self.segments.is_empty() && self.segments.len() <= 64,
            "clip-invalid-segments"
        );
        let mut bytes = 0u64;
        let mut cursor = self.segments[0].start_ms;
        let mut sequence = self.segments[0].sequence;
        for s in &self.segments {
            ensure!(
                s.sequence == sequence
                    && [s.start_ms, s.end_ms, s.duration_ms]
                        .iter()
                        .all(|v| v.is_finite())
                    && s.start_ms >= 0.0
                    && s.duration_ms > 0.0
                    && s.duration_ms <= 10000.0
                    && (s.start_ms - cursor).abs() <= 1.0
                    && (s.end_ms - s.start_ms - s.duration_ms).abs() <= 1.0
                    && s.expires_at > now
                    && s.sha256.len() == 64
                    && s.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    && s.bytes > 0
                    && s.bytes <= 8 * 1024 * 1024,
                "clip-invalid-segment"
            );
            bytes = bytes.checked_add(s.bytes).context("clip-byte-overflow")?;
            cursor = s.end_ms;
            sequence = sequence.checked_add(1).context("clip-sequence-overflow")?;
        }
        ensure!(
            bytes == self.bytes
                && bytes <= MAX_BYTES
                && self.trim_start_ms + self.duration_ms
                    <= cursor - self.segments[0].start_ms + 1.0,
            "clip-bounds-exceeded"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedFile {
    name: String,
    identity: SessionFileObjectIdentity,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub plan: Plan,
    pub root: PathBuf,
    pub destination: PathBuf,
    pub files: Vec<OwnedFile>,
    pub state: String,
    pub reason: String,
    pub local_session_id: Option<String>,
    verified: Option<crate::storage::SessionFileBoundIdentity>,
}
impl Job {
    pub fn view(&self) -> Value {
        let running = workers().lock().unwrap().contains_key(&self.plan.id);
        json!({"id":self.plan.id,"showId":self.plan.show_id,"markerId":self.plan.marker_id,"state":if !running && matches!(self.state.as_str(),"downloading"|"trimming"){"interrupted"}else{&self.state},"reason":self.reason,"localSessionId":self.local_session_id})
    }
    fn check_root(&self) -> Result<()> {
        let m = std::fs::symlink_metadata(&self.root)?;
        ensure!(
            m.is_dir() && !m.file_type().is_symlink(),
            "clip-directory-changed"
        );
        Ok(())
    }
    fn create(&mut self, db: &Database, name: &str) -> Result<std::fs::File> {
        self.check_root()?;
        ensure!(
            !name.contains('/') && !name.contains('\\'),
            "clip-invalid-filename"
        );
        let path = self.root.join(name);
        let f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        self.files.push(OwnedFile {
            name: name.into(),
            identity: capture_session_file_object_identity(&path)?.context("clip-file-missing")?,
        });
        db.save_cloud_clip(self)?;
        Ok(f)
    }
    fn cleanup(&mut self, db: &Database) -> Result<()> {
        self.check_root()?;
        while let Some(f) = self.files.last().cloned() {
            let path = self.root.join(&f.name);
            if path.try_exists()? {
                let quarantine = self.root.join(format!(".delete-{}", uuid::Uuid::new_v4()));
                crate::session_ops::rename_session_file_no_replace(&path, &quarantine)?;
                if capture_session_file_object_identity(&quarantine)?.as_ref() != Some(&f.identity)
                {
                    crate::session_ops::rename_session_file_no_replace(&quarantine, &path)?;
                    bail!("clip-file-changed");
                }
                std::fs::remove_file(quarantine)?;
            }
            self.files.pop();
            db.save_cloud_clip(self)?;
        }
        // Never recursively remove a folder containing an unowned object.
        std::fs::remove_dir(&self.root)?;
        Ok(())
    }
}
fn workers() -> &'static Mutex<BTreeMap<String, watch::Sender<bool>>> {
    static W: OnceLock<Mutex<BTreeMap<String, watch::Sender<bool>>>> = OnceLock::new();
    W.get_or_init(Default::default)
}
pub fn cancel(id: &str) -> Result<()> {
    let w = workers().lock().unwrap();
    w.get(id)
        .context("clip-not-running")?
        .send(true)
        .map_err(Into::into)
}
pub fn discard(db: &Database, id: &str) -> Result<()> {
    ensure!(!workers().lock().unwrap().contains_key(id), "clip-running");
    if let Some(mut j) = db.cloud_clip(id)? {
        if j.root.exists() {
            j.cleanup(db)?;
        }
        db.delete_cloud_clip(id)?;
    }
    Ok(())
}
fn valid(token: &str, stop: &watch::Receiver<bool>) -> Result<()> {
    ensure!(!*stop.borrow(), "clip-cancelled");
    ensure!(
        crate::account::stored_session_token().as_deref() == Some(token),
        "clip-account-changed"
    );
    Ok(())
}
fn finished(j: &Job) -> bool {
    matches!(j.state.as_str(), "complete" | "cancelled")
}
/// L2: room for one new clip. Clips used to be capped for the app's lifetime:
/// finished jobs kept their rows, so the 17th clip was refused. Now a row
/// leaves the journal, oldest first, once nothing can come of it: a finished
/// clip (its Library entry stays) or one whose cloud segments expired (Retry
/// re-fetches and validates the plan, so it can never succeed; its staging
/// files go first). Only clips that can still be retried, and the staging
/// files on disk, count against the caps. A running job is never touched.
fn admit(db: &Database, own: &str, now: i64) -> Result<()> {
    let running: Vec<String> = workers().lock().unwrap().keys().cloned().collect();
    let mut jobs = db.all_cloud_clips()?;
    let mut rows = jobs.len();
    jobs.retain(|j| j.plan.id != own && !running.contains(&j.plan.id));
    for j in jobs
        .iter_mut()
        .filter(|j| !finished(j) && j.plan.expires_at <= now)
    {
        if !j.files.is_empty() {
            if !j.root.exists() {
                j.files.clear();
            } else if let Err(error) = j.cleanup(db) {
                tracing::warn!(
                    "expired cloud clip {} keeps its staging: {error}",
                    j.plan.id
                );
                continue;
            }
        }
        j.reason = "Clip not saved. Its program segments expired in the cloud buffer.".into();
        db.save_cloud_clip(j)?;
    }
    for j in jobs.iter().rev() {
        if rows < MAX_ROWS {
            break;
        }
        if j.files.is_empty() && (finished(j) || j.plan.expires_at <= now) {
            db.delete_cloud_clip(&j.plan.id)?;
            rows -= 1;
        }
    }
    ensure!(
        jobs.iter()
            .filter(|j| !finished(j) && j.plan.expires_at > now)
            .count()
            < MAX_RETRYABLE,
        "clip-journal-full"
    );
    ensure!(
        jobs.iter().filter(|j| !j.files.is_empty()).count() < MAX_STAGING,
        "clip-staging-full-discard-or-retry"
    );
    Ok(())
}
pub struct Save {
    pub show: String,
    pub marker: String,
    pub generation: String,
    pub folder: PathBuf,
    pub ffmpeg: String,
}
pub async fn save(
    state: crate::state::AppState,
    api: VideorcApiClient,
    token: String,
    input: Save,
) -> Result<Value> {
    let Save {
        show,
        marker,
        generation,
        folder,
        ffmpeg,
    } = input;
    let db = state.database.clone();
    let plan: Plan = serde_json::from_value(
        api.clips_json(&token, &show, "GET", Some(&generation), Some(&marker), None)
            .await?,
    )?;
    plan.validate(
        &show,
        &marker,
        &generation,
        chrono::Utc::now().timestamp_millis(),
    )?;
    let session = format!("cloud-{}", plan.id);
    if let Some(path) = db.cloud_clip_session_path(&session)? {
        ensure!(Path::new(&path).is_file(), "clip-library-file-missing");
        return Ok(
            json!({"id":plan.id,"showId":plan.show_id,"markerId":plan.marker_id,"state":"complete","reason":"Program clip is already in Library.","localSessionId":session}),
        );
    }
    let (tx, rx) = watch::channel(false);
    {
        let mut workers = workers().lock().unwrap();
        if workers.contains_key(&plan.id) {
            drop(workers);
            return Ok(db
                .cloud_clip(&plan.id)?
                .context("clip-journal-missing")?
                .view());
        }
        ensure!(workers.is_empty(), "clip-already-running");
        workers.insert(plan.id.clone(), tx);
    }
    let prepared: Result<Job> = (|| {
        if let Some(j) = db.cloud_clip(&plan.id)? {
            ensure!(
                j.plan.owner_key == plan.owner_key && j.plan.id == plan.id,
                "clip-account-changed"
            );
            return Ok(j);
        }
        admit(&db, &plan.id, chrono::Utc::now().timestamp_millis())?;
        let folder = folder.join("Clips");
        std::fs::create_dir_all(&folder)?;
        let root = folder.join(format!(".cloud-clip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let j = Job {
            destination: folder.join(format!("{}.mp4", plan.id)),
            root,
            plan: plan.clone(),
            files: vec![],
            state: "downloading".into(),
            reason: "Downloading a marked program window.".into(),
            local_session_id: None,
            verified: None,
        };
        db.save_cloud_clip(&j)?;
        Ok(j)
    })();
    let mut job = match prepared {
        Ok(j) => j,
        Err(e) => {
            workers().lock().unwrap().remove(&plan.id);
            return Err(e);
        }
    };
    if job.state == "complete" {
        workers().lock().unwrap().remove(&plan.id);
        return Ok(job.view());
    }
    let view = job.view();
    tokio::spawn(async move {
        let result = run(&db, &api, &token, &mut job, &ffmpeg, rx).await;
        if let Err(error) = result {
            job.state = if error.to_string() == "clip-cancelled" {
                "cancelled"
            } else {
                "interrupted"
            }
            .into();
            job.reason =
                "Clip not saved. Retry while segments remain, or discard local staging files."
                    .into();
            let _ = db.save_cloud_clip(&job);
            // No partial artifact enters Library; retained retry files are bounded.
            if job.state == "cancelled" {
                let _ = job.cleanup(&db);
            }
        }
        workers().lock().unwrap().remove(&job.plan.id);
        state.emit_event("cloud.clip.job", job.view());
    });
    Ok(view)
}
pub fn trim_args(input: &Path, output: &Path, start_ms: f64, duration_ms: f64) -> Vec<OsString> {
    // Decode from the independent segment boundary, then trim both tracks on
    // the same timeline. Stream copy would leak video before a non-keyframe mark.
    let filter = format!(
        "[0:v:0]trim=start={:.6}:duration={:.6},setpts=PTS-STARTPTS[v];[0:a:0]atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS[a]",
        start_ms / 1000.0,
        duration_ms / 1000.0,
        start_ms / 1000.0,
        duration_ms / 1000.0
    );
    [
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-i",
    ]
    .into_iter()
    .map(OsString::from)
    .chain([input.as_os_str().to_owned()])
    .chain(
        [
            "-filter_complex",
            &filter,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-maxrate",
            "8M",
            "-bufsize",
            "16M",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-fs",
            "134217728",
            "-f",
            "mp4",
        ]
        .into_iter()
        .map(OsString::from),
    )
    .chain([output.as_os_str().to_owned()])
    .collect()
}
async fn ffmpeg_job(
    ffmpeg: &str,
    args: Vec<OsString>,
    token: &str,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let (tx, rx) = watch::channel(false);
    let task = crate::cloud_control_web::run_ffmpeg_remux(ffmpeg.into(), args, rx);
    tokio::pin!(task);
    let deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(deadline);
    let mut account = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            r=&mut task=>{ensure!(r?.success,"clip-invalid-media");return Ok(());},
            _=&mut deadline=>{let _=tx.send(true);let _=task.await;bail!("clip-processing-timeout");},
            _=stop.changed()=>{if *stop.borrow(){let _=tx.send(true);let _=task.await;bail!("clip-cancelled");}},
            _=account.tick()=>{if let Err(e)=valid(token,&stop){let _=tx.send(true);let _=task.await;return Err(e);}}
        }
    }
}
async fn run(
    db: &Database,
    api: &VideorcApiClient,
    token: &str,
    j: &mut Job,
    ffmpeg: &str,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    valid(token, &stop)?;
    if j.verified.is_some() {
        return publish(db, j, token, &stop);
    }
    if !j.root.exists() {
        std::fs::create_dir(&j.root)?;
    }
    // Retrying never appends to an unknown partial or trusts a stale hash.
    if !j.files.is_empty() {
        j.cleanup(db)?;
        std::fs::create_dir(&j.root)?;
    }
    j.state = "downloading".into();
    db.save_cloud_clip(j)?;
    let mut playlist = String::from(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n",
    );
    for s in j.plan.segments.clone() {
        valid(token, &stop)?;
        let bytes = tokio::select! {
            r=api.clips_segment(token,&j.plan,&s)=>r?,
            _=stop.changed()=>bail!("clip-cancelled")
        };
        valid(token, &stop)?;
        ensure!(
            bytes.len() as u64 == s.bytes && format!("{:x}", Sha256::digest(&bytes)) == s.sha256,
            "clip-hash-mismatch"
        );
        let name = format!("seg-{}.ts", s.sequence);
        let mut f = j.create(db, &name)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        playlist.push_str(&format!(
            "#EXTINF:{:.6},\n{}\n",
            s.duration_ms / 1000.0,
            name
        ));
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    let mut f = j.create(db, "index.m3u8")?;
    f.write_all(playlist.as_bytes())?;
    f.sync_all()?;
    j.create(db, "clip.part")?.sync_all()?;
    j.state = "trimming".into();
    j.reason = "Trimming and validating program video and mixed audio.".into();
    db.save_cloud_clip(j)?;
    let out = j.root.join("clip.part");
    ffmpeg_job(
        ffmpeg,
        trim_args(
            &j.root.join("index.m3u8"),
            &out,
            j.plan.trim_start_ms,
            j.plan.duration_ms,
        ),
        token,
        stop.clone(),
    )
    .await?;
    let decode = ["-v", "error", "-xerror", "-nostdin", "-i"]
        .into_iter()
        .map(OsString::from)
        .chain([out.as_os_str().to_owned()])
        .chain(
            ["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]
                .into_iter()
                .map(OsString::from),
        )
        .collect();
    ffmpeg_job(ffmpeg, decode, token, stop.clone()).await?;
    let actual = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(12),crate::session_ops::probe_duration_ms(ffmpeg,&out))=>result.context("clip-probe-timeout")?.context("clip-duration-unavailable")?,
        _=stop.changed()=>bail!("clip-cancelled")
    };
    ensure!(
        (actual as f64 - j.plan.duration_ms).abs() <= 100.0,
        "clip-trim-duration-mismatch"
    );
    valid(token, &stop)?;
    j.verified = crate::storage::capture_session_file_bound_identity(&out)?;
    ensure!(j.verified.is_some(), "clip-file-missing");
    publish(db, j, token, &stop)
}
fn publish(db: &Database, j: &mut Job, token: &str, stop: &watch::Receiver<bool>) -> Result<()> {
    valid(token, stop)?;
    let session = format!("cloud-{}", j.plan.id);
    let out = j.root.join("clip.part");
    // Publication journal is persisted before a no-replace rename; a crash can
    // recover exactly this object, never overwrite a canonical take or archive.
    j.state = "publishing".into();
    db.save_cloud_clip(j)?;
    if !j.destination.exists() {
        crate::session_ops::rename_session_file_no_replace(&out, &j.destination)?;
    }
    let expected = j.verified.as_ref().context("clip-verification-missing")?;
    let actual = crate::storage::capture_session_file_bound_identity(&j.destination)?
        .context("clip-file-missing")?;
    ensure!(
        crate::storage::session_file_bound_identity_matches(
            &actual,
            &expected.content_identity,
            Some(&expected.object_identity)
        ),
        "clip-destination-changed"
    );
    crate::session_ops::sync_session_file_parent(&j.destination)?;
    db.register_cloud_clip(j, &session)?;
    j.files.retain(|f| f.name != "clip.part");
    j.state = "complete".into();
    j.reason = "Program clip saved in Library.".into();
    j.local_session_id = Some(session);
    db.save_cloud_clip(j)?;
    j.cleanup(db)?;
    Ok(())
}

pub async fn control(
    state: &crate::state::AppState,
    token: String,
    show: String,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let api = VideorcApiClient::new()?;
    let before = api
        .clips_json(&token, &show, "GET", None, None, None)
        .await?;
    if method == "cloud.clips.status" {
        if before.get("enabled").and_then(Value::as_bool) == Some(true)
            && crate::cloud_markers::owns_show(state, &show)
            && let Some(generation) = before.get("generation").and_then(Value::as_str)
        {
            pump(
                state.clone(),
                api.clone(),
                token.clone(),
                show.clone(),
                generation.into(),
            );
        }
        return Ok(status(&before));
    }
    ensure!(
        crate::cloud_controller::ownership_allows(&show),
        "cloud-controller-stale"
    );
    let generation = params.get("generation").and_then(Value::as_str);
    if method == "cloud.clips.enable" {
        ensure!(
            params.get("consent").and_then(Value::as_bool) == Some(true),
            "clips-consent-required"
        );
        let orientation = params
            .get("orientation")
            .and_then(Value::as_str)
            .unwrap_or("h");
        ensure!(matches!(orientation, "h" | "v"), "invalid-orientation");
        let request = params
            .get("requestId")
            .and_then(Value::as_str)
            .context("clip-request-required")?;
        uuid::Uuid::parse_str(request)?;
        let armed=api.clips_json(&token,&show,"POST",None,None,Some(json!({"consent":true,"orientation":orientation,"requestId":request,"expectedGeneration":before.get("generation").cloned().unwrap_or(Value::Null),"byteCeiling":256*1024*1024,"costCeilingMicros":100000}))).await?;
        let generation = armed
            .get("generation")
            .and_then(Value::as_str)
            .context("clip-generation-missing")?
            .to_string();
        let folder = crate::recording::resolve_output_directory(
            params.get("outputDirectory").and_then(Value::as_str),
        )?;
        state
            .database
            .save_setting("cloud.clips.output", &json!({"showId":show,"path":folder}))?;
        pump(
            state.clone(),
            api.clone(),
            token.clone(),
            show.clone(),
            generation,
        );
    } else if method == "cloud.clips.disable" {
        api.clips_json(&token, &show, "DELETE", generation, None, None)
            .await?;
    } else {
        bail!("invalid-clip-control");
    }
    Ok(status(
        &api.clips_json(&token, &show, "GET", None, None, None)
            .await?,
    ))
}
fn pumps() -> &'static Mutex<std::collections::BTreeSet<(String, String)>> {
    static P: OnceLock<Mutex<std::collections::BTreeSet<(String, String)>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
/// Resume only a persisted, explicitly consented ring with its existing budget.
/// Status never arms/renews an expired generation or starts recording.
fn pump(
    state: crate::state::AppState,
    api: VideorcApiClient,
    token: String,
    show: String,
    generation: String,
) {
    let key = (show.clone(), generation.clone());
    {
        let mut p = pumps().lock().unwrap();
        if !p.is_empty() {
            return;
        }
        p.insert(key.clone());
    }
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        while tokio::time::Instant::now() < deadline
            && crate::account::stored_session_token().as_deref() == Some(token.as_str())
            && crate::cloud_markers::owns_show(&state, &show)
        {
            if let Err(error) = api
                .clips_json(&token, &show, "PUT", Some(&generation), None, None)
                .await
                && !matches!(
                    error.to_string().as_str(),
                    "active-segment-egress-required" | "replay-source-not-bound"
                )
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        pumps().lock().unwrap().remove(&key);
    });
}
fn status(value: &Value) -> Value {
    crate::replay_buffer::cloud_capability(value)
}

/// What a clip mark got besides the mark itself.
pub enum ClipOutcome {
    /// Clips are off for this show (or there is no account): a mark only.
    Off,
    /// The clip job, queued or already known.
    Job(Value),
    /// The clip was refused; the host must hear it (L2): `busy` (another clip
    /// is still saving), `full` (unfinished clips fill the journal or hold
    /// staging) or `failed` (anything else, such as the cloud refusing).
    Refused(&'static str),
}
pub fn refusal(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "clip-already-running" => "busy",
        "clip-journal-full" | "clip-staging-full-discard-or-retry" => "full",
        _ => "failed",
    }
}
/// Every existing clip owner (UI/remote/agent/consented host voice) reaches the
/// same mark creation path. An extraction failure never discards that mark,
/// and is never silent either.
pub async fn maybe_save(state: &crate::state::AppState, mark: &Value) -> ClipOutcome {
    let Some((show, marker)) = mark
        .get("showId")
        .and_then(Value::as_str)
        .zip(mark.get("id").and_then(Value::as_str))
    else {
        return ClipOutcome::Off;
    };
    if let Ok(jobs) = state.database.cloud_clips()
        && let Some(job) = jobs
            .iter()
            .find(|j| j.plan.show_id == show && j.plan.marker_id == marker)
    {
        return if job.state == "cancelled" {
            ClipOutcome::Off
        } else {
            ClipOutcome::Job(job.view())
        };
    }
    let Some(started) = start_save(state, show, marker).await else {
        return ClipOutcome::Off;
    };
    match started {
        Ok(job) => ClipOutcome::Job(job),
        Err(error) => {
            tracing::warn!("cloud clip for marker {marker} not saved: {error}");
            ClipOutcome::Refused(refusal(&error))
        }
    }
}
/// `None` while Clips are off for the show; otherwise what `save` said.
async fn start_save(
    state: &crate::state::AppState,
    show: &str,
    marker: &str,
) -> Option<Result<Value>> {
    let token = crate::account::stored_session_token()?;
    let api = VideorcApiClient::new().ok()?;
    let status = api
        .clips_json(&token, show, "GET", None, None, None)
        .await
        .ok()?;
    if status.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let generation = status.get("generation")?.as_str()?;
    let folder = match output_folder(&state.database, show, None) {
        Ok(folder) => folder,
        Err(error) => return Some(Err(error)),
    };
    let saved = save(
        state.clone(),
        api,
        token,
        Save {
            show: show.into(),
            marker: marker.into(),
            generation: generation.into(),
            folder,
            ffmpeg: crate::resolve_trusted_ffmpeg_path(
                None,
                crate::BackendRole::Renderer,
                state.smoke_rpc_enabled,
            ),
        },
    )
    .await;
    Some(saved)
}

pub fn output_folder(db: &Database, show: &str, configured: Option<&str>) -> Result<PathBuf> {
    if configured.is_some() {
        return crate::recording::resolve_output_directory(configured);
    }
    let saved = db.load_setting::<Value>("cloud.clips.output")?;
    let selected = saved
        .as_ref()
        .filter(|v| v.get("showId").and_then(Value::as_str) == Some(show))
        .and_then(|v| v.get("path"))
        .and_then(Value::as_str);
    crate::recording::resolve_output_directory(selected)
}

/// A local stand-in for the account API in tests: answers every request with
/// whatever `answer` returns for its path and query, then closes the connection.
#[cfg(test)]
pub(crate) mod test_api {
    use std::{net::SocketAddr, sync::Arc};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    pub(crate) type Answer = Arc<dyn Fn(&reqwest::Url) -> (u16, Vec<u8>) + Send + Sync>;
    pub(crate) async fn serve(answer: Answer) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let answer = answer.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&head);
                    let target = text.split_whitespace().nth(1).unwrap_or("/");
                    let url = reqwest::Url::parse(&format!("http://fixture{target}")).unwrap();
                    let (status, body) = answer(&url);
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        address
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Plan {
        let segments = (0..20)
            .map(|i| Segment {
                sequence: i,
                sha256: "a".repeat(64),
                bytes: 16,
                start_ms: i as f64 * 2000.0,
                end_ms: (i + 1) as f64 * 2000.0,
                duration_ms: 2000.0,
                expires_at: 90000,
            })
            .collect();
        Plan {
            version: 1,
            id: format!("clip_{}", "a".repeat(64)),
            owner_key: "b".repeat(64),
            show_id: "sh_fixture".into(),
            marker_id: uuid::Uuid::nil().to_string(),
            generation: "generation".into(),
            take_id: "tk_fixture".into(),
            provider_egress_id: "EG_fixture".into(),
            live_interval_id: None,
            show_origin: "2026-11-17T12:00:00Z".into(),
            orientation: "h".into(),
            expires_at: 90000,
            uncertainty_ms: 0.0,
            trim_start_ms: 5250.0,
            duration_ms: 30000.0,
            bytes: 320,
            trim: "decode-trim-reencode-av".into(),
            segments,
            requested: Window {
                start_ms: 5250.0,
                end_ms: 35250.0,
            },
        }
    }
    #[test]
    fn refuses_gap_changed_generation_expiry_and_unbounded_trim() {
        let p = plan();
        let check = |p: &Plan| {
            p.validate(
                "sh_fixture",
                &uuid::Uuid::nil().to_string(),
                "generation",
                0,
            )
        };
        assert!(check(&p).is_ok());
        let mut p = plan();
        p.segments.remove(4);
        assert!(check(&p).is_err());
        let mut p = plan();
        p.generation = "other".into();
        assert!(check(&p).is_err());
        let mut p = plan();
        p.expires_at = 0;
        assert!(check(&p).is_err());
        let mut p = plan();
        p.trim_start_ms = f64::NAN;
        assert!(check(&p).is_err());
        let mut p = plan();
        p.uncertainty_ms = 51.0;
        assert!(check(&p).is_err());
    }
    #[test]
    fn clip_journal_is_additive_and_take_identity_is_not_a_local_session() {
        let db = Database::open_in_memory_for_tests();
        let j = Job {
            plan: plan(),
            root: PathBuf::from("/unused"),
            destination: PathBuf::from("/unused.mp4"),
            files: vec![],
            state: "interrupted".into(),
            reason: "test".into(),
            local_session_id: None,
            verified: None,
        };
        db.save_cloud_clip(&j).unwrap();
        db.save_cloud_clip(&j).unwrap();
        let jobs = db.cloud_clips().unwrap();
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0].local_session_id.is_none());
        assert_eq!(jobs[0].plan.take_id, "tk_fixture");
    }

    /// A journal row for `n`, its plan expiring at `expires_at`, with one
    /// real staging file when `staged`.
    fn job_row(
        db: &Database,
        dir: &Path,
        n: u32,
        state: &str,
        expires_at: i64,
        staged: bool,
    ) -> Job {
        let mut p = plan();
        p.id = format!("clip_{:064x}", n);
        p.marker_id = format!("marker-{n}");
        p.expires_at = expires_at;
        let mut j = Job {
            root: dir.join(format!(".cloud-clip-{n}")),
            destination: dir.join(format!("{n}.mp4")),
            plan: p,
            files: vec![],
            state: state.into(),
            reason: "test".into(),
            local_session_id: None,
            verified: None,
        };
        db.save_cloud_clip(&j).unwrap();
        if staged {
            std::fs::create_dir_all(&j.root).unwrap();
            j.create(db, "seg-0.ts")
                .unwrap()
                .write_all(&[1; 4096])
                .unwrap();
        }
        j
    }

    /// L2: one interrupted clip holding staging files used to refuse every
    /// later clip; an expired one could never be retried yet blocked forever.
    #[test]
    fn interrupted_clips_no_longer_block_new_ones_and_expired_staging_goes() {
        let temp = crate::test_temp_dir::TestTempDir::new("cloud-clips-admit");
        let db = Database::open_in_memory_for_tests();
        let now = 1_000_000;
        let live = job_row(&db, &temp, 1, "interrupted", now + 60_000, true);
        admit(&db, "new", now).expect("one interrupted clip must not block the next");
        let expired = job_row(&db, &temp, 2, "trimming", now - 1, true);
        for n in 3..=4 {
            job_row(&db, &temp, n, "interrupted", now + 60_000, true);
        }
        // Live 1, 3, 4 hold staging; the expired 2 is cleaned, not counted.
        admit(&db, "new", now).expect("three retryable staging holders fit");
        assert!(!expired.root.exists(), "expired staging must be removed");
        let row = db.cloud_clip(&expired.plan.id).unwrap().unwrap();
        assert!(row.files.is_empty());
        assert!(row.reason.contains("expired"), "{}", row.reason);
        assert!(
            live.root.join("seg-0.ts").exists(),
            "a retryable clip keeps its staging"
        );
        job_row(&db, &temp, 5, "interrupted", now + 60_000, true);
        let refused = admit(&db, "new", now).unwrap_err().to_string();
        assert_eq!(refused, "clip-staging-full-discard-or-retry");
        assert_eq!(refusal(&anyhow::anyhow!(refused)), "full");
    }

    /// L2: finished rows leave oldest first, so the journal (and the jobs
    /// list) stays at 16 rows with the new job, and retryable rows stay.
    #[test]
    fn finished_clip_rows_are_pruned_oldest_first() {
        let temp = crate::test_temp_dir::TestTempDir::new("cloud-clips-prune");
        let db = Database::open_in_memory_for_tests();
        let now = 1_000_000;
        let first = job_row(&db, &temp, 1, "interrupted", now + 60_000, false);
        for n in 2..=30 {
            job_row(
                &db,
                &temp,
                n,
                if n % 2 == 0 { "complete" } else { "cancelled" },
                now + 60_000,
                false,
            );
        }
        admit(&db, "new", now).unwrap();
        let rows = db.all_cloud_clips().unwrap();
        assert_eq!(rows.len(), MAX_ROWS - 1);
        assert_eq!(rows[0].plan.id, format!("clip_{:064x}", 30), "newest kept");
        assert!(
            rows.iter().any(|j| j.plan.id == first.plan.id),
            "retryable kept"
        );
        for n in 0..MAX_RETRYABLE as u32 {
            job_row(&db, &temp, 100 + n, "interrupted", now + 60_000, false);
        }
        assert_eq!(
            admit(&db, "new", now).unwrap_err().to_string(),
            "clip-journal-full"
        );
    }

    fn ffmpeg_for_tests() -> Option<String> {
        let path = crate::ffmpeg::resolve_ffmpeg_path(None);
        match std::process::Command::new(&path).arg("-version").output() {
            Ok(output) if output.status.success() => Some(path),
            _ => {
                eprintln!("skipping: no FFmpeg at {path} on this machine");
                None
            }
        }
    }

    fn clip_rows(db: &Database) -> i64 {
        db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM cloud_program_clips", [], |r| r.get(0))
            .unwrap()
    }

    /// Real 2 s HLS segments (picture + tone) the fake API serves.
    fn fixture_segments(ffmpeg: &str, dir: &Path) -> Option<(Vec<Segment>, Vec<Vec<u8>>)> {
        std::fs::create_dir_all(dir).unwrap();
        let made = std::process::Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "6",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "30",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "0",
                "-hls_segment_filename",
            ])
            .arg(dir.join("part-%d.ts"))
            .arg(dir.join("index.m3u8"))
            .output()
            .unwrap();
        if !made.status.success() {
            eprintln!(
                "skipping: this FFmpeg cannot make H.264/AAC HLS: {}",
                String::from_utf8_lossy(&made.stderr)
            );
            return None;
        }
        let playlist = std::fs::read_to_string(dir.join("index.m3u8")).unwrap();
        let (mut segments, mut data, mut cursor) = (vec![], vec![], 0.0);
        let mut lines = playlist.lines();
        while let Some(line) = lines.next() {
            let Some(rest) = line.strip_prefix("#EXTINF:") else {
                continue;
            };
            let duration_ms = rest.trim_end_matches(',').parse::<f64>().unwrap() * 1000.0;
            let bytes = std::fs::read(dir.join(lines.next().unwrap())).unwrap();
            segments.push(Segment {
                sequence: segments.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                bytes: bytes.len() as u64,
                start_ms: cursor,
                end_ms: cursor + duration_ms,
                duration_ms,
                expires_at: chrono::Utc::now().timestamp_millis() + 3_600_000,
            });
            cursor += duration_ms;
            data.push(bytes);
        }
        Some((segments, data))
    }

    /// L2: the 17th clip of the app's lifetime was refused (`clip-journal-full`)
    /// because finished jobs kept their rows forever. Twenty marks in a row
    /// through the real download, FFmpeg trim, decode check and publish must
    /// each put a decodable MP4 in Library, and the journal must stay bounded.
    #[tokio::test]
    async fn twenty_clips_in_a_row_each_save_video() {
        let temp = crate::test_temp_dir::TestTempDir::new("cloud-clips-twenty");
        let Some(ffmpeg) = ffmpeg_for_tests() else {
            return;
        };
        let Some((segments, data)) = fixture_segments(&ffmpeg, &temp.join("media")) else {
            return;
        };
        crate::secrets::scope_memory_secret_store_for_tests();
        let token = "clip-fixture-token".to_string();
        crate::secrets::put_secret(crate::account::SESSION_TOKEN_SECRET, &token).unwrap();
        let mut template = plan();
        template.bytes = segments.iter().map(|s| s.bytes).sum();
        template.expires_at = chrono::Utc::now().timestamp_millis() + 3_600_000;
        template.trim_start_ms = 500.0;
        template.duration_ms = 2000.0;
        template.requested = Window {
            start_ms: 500.0,
            end_ms: 2500.0,
        };
        template.segments = segments;
        let address = test_api::serve(std::sync::Arc::new(move |url: &reqwest::Url| {
            let query: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
            if let Some(n) = query.get("segment") {
                return (200, data[n.parse::<usize>().unwrap()].clone());
            }
            let marker = query.get("marker").cloned().unwrap_or_default();
            let mut p = template.clone();
            p.marker_id = marker.clone();
            p.id = format!("clip_{:x}", Sha256::digest(marker.as_bytes()));
            (200, serde_json::to_vec(&p).unwrap())
        }))
        .await;
        let api = VideorcApiClient::for_base_url(format!("http://{address}"));
        let (events, _) = tokio::sync::broadcast::channel(64);
        let db = Database::open_in_memory_for_tests();
        let state = crate::state::AppState::new("t".into(), 1, events, db.clone());
        let folder = temp.join("output");
        std::fs::create_dir_all(&folder).unwrap();
        for n in 1..=20 {
            let started = std::time::Instant::now();
            let marker = uuid::Uuid::new_v4().to_string();
            let view = save(
                state.clone(),
                api.clone(),
                token.clone(),
                Save {
                    show: "sh_fixture".into(),
                    marker,
                    generation: "generation".into(),
                    folder: folder.clone(),
                    ffmpeg: ffmpeg.clone(),
                },
            )
            .await
            .unwrap_or_else(|e| panic!("clip {n} refused: {e} (rows {})", clip_rows(&db)));
            let id = view["id"].as_str().unwrap().to_string();
            while workers().lock().unwrap().contains_key(&id) {
                assert!(started.elapsed() < Duration::from_secs(90), "clip {n} hung");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let job = db.cloud_clip(&id).unwrap().unwrap();
            assert_eq!(job.state, "complete", "clip {n}: {}", job.reason);
            let session = job.local_session_id.unwrap();
            let path = db.cloud_clip_session_path(&session).unwrap().unwrap();
            let decoded = std::process::Command::new(&ffmpeg)
                .args([
                    "-v", "error", "-xerror", "-i", &path, "-map", "0:v:0", "-map", "0:a:0",
                ])
                .args(["-f", "null", "-"])
                .output()
                .unwrap();
            assert!(decoded.status.success(), "clip {n} does not decode");
            let ms = crate::session_ops::probe_duration_ms(&ffmpeg, Path::new(&path))
                .await
                .unwrap();
            assert!((ms - 2000).abs() <= 100, "clip {n} lasts {ms} ms");
            eprintln!(
                "clip {n}: saved {ms} ms of video in {} ms, journal rows {}",
                started.elapsed().as_millis(),
                clip_rows(&db)
            );
        }
        assert!(clip_rows(&db) <= 16, "journal rows {}", clip_rows(&db));
    }
}
