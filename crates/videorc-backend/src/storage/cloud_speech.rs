use super::*;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostTranscriptCue {
    source_id: String,
    speech_session_id: String,
    seq: u64,
    offset_seconds: f64,
    duration_seconds: f64,
    text: String,
    clock_basis: &'static str,
    clock: serde_json::Value,
}
impl Database {
    pub(crate) fn save_host_transcript(
        &self,
        show: &str,
        source: &str,
        session: &str,
        record: &crate::captions::CaptionChunkRecord,
        clock: &serde_json::Value,
    ) -> Result<()> {
        anyhow::ensure!(
            record.text.len() <= 16_384
                && record.offset_seconds.is_finite()
                && record.offset_seconds >= 0.0
                && record.duration_seconds.is_finite()
                && record.duration_seconds >= 0.0,
            "Invalid host transcript."
        );
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO cloud_host_transcript(show_id,source_id,speech_session_id,seq,offset_seconds,duration_seconds,text,clock_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(show_id,source_id,speech_session_id,seq) DO UPDATE SET text=excluded.text,duration_seconds=excluded.duration_seconds", params![show,source,session,record.seq,record.offset_seconds,record.duration_seconds,record.text,serde_json::to_string(clock)?])?;
        // Bounded local history, independent of cloud object retention. Never store PCM.
        tx.execute("DELETE FROM cloud_host_transcript WHERE rowid NOT IN (SELECT rowid FROM cloud_host_transcript ORDER BY rowid DESC LIMIT 10000)", [])?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn host_transcript(&self, show: &str) -> Result<Vec<HostTranscriptCue>> {
        let db = self.lock()?;
        let mut q = db.prepare("SELECT source_id,speech_session_id,seq,offset_seconds,duration_seconds,text,clock_json FROM cloud_host_transcript WHERE show_id=?1 ORDER BY rowid DESC LIMIT 500")?;
        Ok(q.query_map([show], |r| {
            Ok(HostTranscriptCue {
                source_id: r.get(0)?,
                speech_session_id: r.get(1)?,
                seq: r.get(2)?,
                offset_seconds: r.get(3)?,
                duration_seconds: r.get(4)?,
                text: r.get(5)?,
                clock_basis: "processed-host-source",
                clock: serde_json::from_str(&r.get::<_, String>(6)?)
                    .unwrap_or(serde_json::Value::Null),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub(crate) fn clear_host_transcript(&self) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM cloud_host_transcript", [])?;
        Ok(())
    }
}
