use super::*;

/// Plan 253 S7: one minute of one figure of one show, as folded by
/// `cloud_latency::MinuteFolder`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LatencyMinuteRow {
    pub show_id: String,
    /// Unix time / 60.
    pub minute: i64,
    /// A room identity, `program` or `control`.
    pub subject: String,
    pub kind: String,
    /// The name a guest joined with (this computer only, D12).
    pub name: Option<String>,
    pub p50_ms: u32,
    pub p95_ms: u32,
    pub max_ms: u32,
    pub samples: u32,
    /// How many of the minute's samples are a floor.
    pub partial: u32,
}

impl Database {
    /// Writes each row over the one its minute already has: the folder holds
    /// the open minute's samples, so a later row is the whole minute again.
    pub(crate) fn save_cloud_latency_minutes(&self, rows: &[LatencyMinuteRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        {
            let mut upsert = tx.prepare_cached(
                "INSERT INTO cloud_latency_minutes
                 (show_id, minute, subject, kind, name, p50_ms, p95_ms, max_ms, samples, partial)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(show_id, minute, subject, kind) DO UPDATE SET
                 name = COALESCE(excluded.name, cloud_latency_minutes.name),
                 p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms, max_ms = excluded.max_ms,
                 samples = excluded.samples, partial = excluded.partial",
            )?;
            for row in rows {
                upsert.execute(params![
                    row.show_id,
                    row.minute,
                    row.subject,
                    row.kind,
                    row.name,
                    row.p50_ms,
                    row.p95_ms,
                    row.max_ms,
                    row.samples,
                    row.partial,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// A show's record, oldest minute first.
    #[cfg(test)]
    pub(crate) fn cloud_latency_minutes(&self, show_id: &str) -> Result<Vec<LatencyMinuteRow>> {
        let conn = self.lock()?;
        let mut query = conn.prepare(
            "SELECT show_id, minute, subject, kind, name, p50_ms, p95_ms, max_ms, samples, partial
             FROM cloud_latency_minutes WHERE show_id = ?1 ORDER BY minute, subject, kind",
        )?;
        Ok(query
            .query_map([show_id], |row| {
                Ok(LatencyMinuteRow {
                    show_id: row.get(0)?,
                    minute: row.get(1)?,
                    subject: row.get(2)?,
                    kind: row.get(3)?,
                    name: row.get(4)?,
                    p50_ms: row.get(5)?,
                    p95_ms: row.get(6)?,
                    max_ms: row.get(7)?,
                    samples: row.get(8)?,
                    partial: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(show: &str, minute: i64, subject: &str, max_ms: u32, samples: u32) -> LatencyMinuteRow {
        LatencyMinuteRow {
            show_id: show.to_string(),
            minute,
            subject: subject.to_string(),
            kind: "conversation".to_string(),
            name: Some("Ada".to_string()),
            p50_ms: max_ms,
            p95_ms: max_ms,
            max_ms,
            samples,
            partial: 0,
        }
    }

    #[test]
    fn a_later_row_of_the_same_minute_replaces_the_first() {
        let db = Database::open_in_memory_for_tests();
        db.save_cloud_latency_minutes(&[row("sh_a", 10, "g_ada", 180, 1)])
            .unwrap();
        let mut second = row("sh_a", 10, "g_ada", 240, 2);
        // A report without the name keeps the one the minute already has.
        second.name = None;
        db.save_cloud_latency_minutes(&[second, row("sh_a", 11, "g_ada", 200, 1)])
            .unwrap();
        let rows = db.cloud_latency_minutes("sh_a").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].max_ms, rows[0].samples), (240, 2));
        assert_eq!(rows[0].name.as_deref(), Some("Ada"));
        assert_eq!(rows[1].minute, 11);
    }

    /// D12: the record is deleted with its show, and only with its show.
    #[test]
    fn the_record_is_deleted_with_its_shows_library_entry() {
        let db = Database::open_in_memory_for_tests();
        let status = Database::cloud_show_status_for_tests();
        let show_id = status.show.as_ref().unwrap().id.clone();
        db.sync_cloud_show_session(&status).unwrap();
        db.save_cloud_latency_minutes(&[
            row(&show_id, 10, "g_ada", 180, 1),
            row(&show_id, 10, "control", 400, 1),
            row("sh_other", 10, "g_bob", 90, 1),
        ])
        .unwrap();
        assert_eq!(db.cloud_latency_minutes(&show_id).unwrap().len(), 2);
        db.lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id = ?1", [&show_id])
            .unwrap();
        assert!(db.cloud_latency_minutes(&show_id).unwrap().is_empty());
        assert_eq!(db.cloud_latency_minutes("sh_other").unwrap().len(), 1);
    }

    /// A room that never became a Library entry has nothing to be deleted
    /// with: its minutes go 30 days on, at the next launch.
    #[test]
    fn minutes_of_a_room_that_never_went_live_go_after_thirty_days() {
        let db = Database::open_in_memory_for_tests();
        let now = Utc::now().timestamp() / 60;
        let status = Database::cloud_show_status_for_tests();
        let kept_show = status.show.as_ref().unwrap().id.clone();
        db.sync_cloud_show_session(&status).unwrap();
        db.save_cloud_latency_minutes(&[
            row("sh_rehearsal", now - 43_300, "g_ada", 180, 1),
            row("sh_rehearsal", now - 5, "g_ada", 180, 1),
            row(&kept_show, now - 43_300, "g_ada", 180, 1),
        ])
        .unwrap();
        db.migrate().unwrap();
        let rehearsal = db.cloud_latency_minutes("sh_rehearsal").unwrap();
        assert_eq!(rehearsal.len(), 1);
        assert_eq!(rehearsal[0].minute, now - 5);
        // A show with a Library entry keeps its record however old it is.
        assert_eq!(db.cloud_latency_minutes(&kept_show).unwrap().len(), 1);
    }
}
