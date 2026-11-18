use super::*;
use crate::cloud_clips::Job;
impl Database {
    pub(crate) fn save_cloud_clip(&self, j: &Job) -> Result<()> {
        let text = serde_json::to_string(j)?;
        anyhow::ensure!(text.len() <= 65536, "clip-journal-too-large");
        self.lock()?.execute("INSERT INTO cloud_program_clips(id,journal_json) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET journal_json=excluded.journal_json",params![j.plan.id,text])?;
        Ok(())
    }
    pub(crate) fn cloud_clip(&self, id: &str) -> Result<Option<Job>> {
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT journal_json FROM cloud_program_clips WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub(crate) fn cloud_clips(&self) -> Result<Vec<Job>> {
        let c = self.lock()?;
        let mut q =
            c.prepare("SELECT journal_json FROM cloud_program_clips ORDER BY rowid DESC LIMIT 16")?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|s| serde_json::from_str(s).map_err(Into::into))
            .collect()
    }
    pub(crate) fn delete_cloud_clip(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM cloud_program_clips WHERE id=?1", [id])?;
        Ok(())
    }
    pub(crate) fn cloud_clip_session_path(&self, id: &str) -> Result<Option<String>> {
        self.lock()?.query_row("SELECT s.mp4_path FROM sessions s JOIN cloud_clip_sources c ON c.session_id=s.id WHERE s.id=?1",[id],|r|r.get(0)).optional().map_err(Into::into)
    }
    pub(crate) fn register_cloud_clip(&self, j: &Job, id: &str) -> Result<()> {
        let start = chrono::DateTime::parse_from_rfc3339(&j.plan.show_origin)?
            + chrono::Duration::milliseconds(j.plan.requested.start_ms.round() as i64);
        let duration = j.plan.duration_ms.round() as i64;
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let sources = SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: false,
        };
        let output = OutputSettings {
            record_enabled: false,
            stream_enabled: false,
            output_directory: None,
            ffmpeg_path: None,
            keep_original_mkv: false,
            separate_source_recordings: None,
            video: crate::protocol::VideoSettings {
                preset: crate::protocol::VideoPreset::StreamSafe1080p30,
                width: if j.plan.orientation == "v" {
                    1080
                } else {
                    1920
                },
                height: if j.plan.orientation == "v" {
                    1920
                } else {
                    1080
                },
                fps: 30,
                bitrate_kbps: 6000,
            },
            rtmp: crate::protocol::RtmpSettings {
                preset: crate::protocol::RtmpPreset::Custom,
                server_url: String::new(),
                stream_key: String::new(),
            },
        };
        tx.execute("INSERT OR IGNORE INTO sessions(id,title,started_at,ended_at,status,mode,mp4_path,container,duration_ms,sources_json,layout_json,output_json,file_size_bytes) VALUES (?1,'Program clip',?2,?3,'completed','cloud-recording',?4,'mp4',?5,?6,?7,?8,?9)",params![id,start.to_rfc3339(),(start+chrono::Duration::milliseconds(duration)).to_rfc3339(),j.destination.to_string_lossy(),duration,serde_json::to_string(&sources)?,serde_json::to_string(&crate::protocol::default_layout_settings())?,session_output_json(&output)?,std::fs::metadata(&j.destination)?.len() as i64])?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_session_associations(session_id,show_id) VALUES (?1,?2)",
            params![id, j.plan.show_id],
        )?;
        tx.execute("INSERT OR IGNORE INTO cloud_clip_sources(session_id,show_id,marker_id,generation,take_id,provider_egress_id,live_interval_id,show_origin,start_ms,end_ms,uncertainty_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,j.plan.show_id,j.plan.marker_id,j.plan.generation,j.plan.take_id,j.plan.provider_egress_id,j.plan.live_interval_id,j.plan.show_origin,j.plan.requested.start_ms,j.plan.requested.end_ms,j.plan.uncertainty_ms])?;
        tx.commit()?;
        Ok(())
    }
}
