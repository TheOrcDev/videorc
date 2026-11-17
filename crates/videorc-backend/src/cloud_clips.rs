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
        ensure!(db.cloud_clips()?.len() < 16, "clip-journal-full");
        ensure!(
            db.cloud_clips()?.iter().all(|j| j.files.is_empty()),
            "clip-staging-full-discard-or-retry"
        );
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

pub async fn control(token: String, show: String, method: &str, params: &Value) -> Result<Value> {
    let api = VideorcApiClient::new()?;
    let before = api
        .clips_json(&token, &show, "GET", None, None, None)
        .await?;
    if method == "cloud.clips.status" {
        if before.get("enabled").and_then(Value::as_bool) == Some(true)
            && crate::cloud_markers::owns_show(state, &show)
        {
            if let Some(generation) = before.get("generation").and_then(Value::as_str) {
                pump(
                    state.clone(),
                    api.clone(),
                    token.clone(),
                    show.clone(),
                    generation.into(),
                );
            }
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
            {
                if !matches!(
                    error.to_string().as_str(),
                    "active-segment-egress-required" | "replay-source-not-bound"
                ) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        pumps().lock().unwrap().remove(&key);
    });
}
fn status(value: &Value) -> Value {
    crate::replay_buffer::cloud_capability(value)
}

/// Every existing clip owner (UI/remote/agent/consented host voice) reaches the
/// same mark creation path. An extraction failure never discards that mark.
pub async fn maybe_save(state: &crate::state::AppState, mark: &Value) -> Option<Value> {
    let show = mark.get("showId")?.as_str()?;
    let marker = mark.get("id")?.as_str()?;
    if let Ok(jobs) = state.database.cloud_clips() {
        if let Some(job) = jobs
            .iter()
            .find(|j| j.plan.show_id == show && j.plan.marker_id == marker)
        {
            return if job.state == "cancelled" {
                None
            } else {
                Some(job.view())
            };
        }
    }
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
    let folder = output_folder(&state.database, show, None).ok()?;
    save(
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
    .await
    .ok()
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
