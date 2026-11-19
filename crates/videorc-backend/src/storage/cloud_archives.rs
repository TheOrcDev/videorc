use super::*;
use crate::cloud_archive::Journal;
impl Database {
    pub(crate) fn save_cloud_archive(&self, journal: &Journal) -> Result<()> {
        let json = serde_json::to_string(journal)?;
        anyhow::ensure!(json.len() <= 512 * 1024, "archive-journal-too-large");
        self.lock()?.execute("INSERT INTO cloud_program_archives(id,journal_json) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET journal_json=excluded.journal_json",params![journal.id,json])?;
        Ok(())
    }
    pub(crate) fn cloud_archive(&self, id: &str) -> Result<Option<Journal>> {
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT journal_json FROM cloud_program_archives WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub(crate) fn cloud_archives(&self) -> Result<Vec<Journal>> {
        let conn = self.lock()?;
        let mut query = conn.prepare(
            "SELECT journal_json FROM cloud_program_archives ORDER BY rowid DESC LIMIT 16",
        )?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|s| serde_json::from_str(s).map_err(Into::into))
            .collect()
    }
    /// Every archive journal, newest first: what admission prunes from (L3).
    pub(crate) fn all_cloud_archives(&self) -> Result<Vec<Journal>> {
        let conn = self.lock()?;
        let mut query =
            conn.prepare("SELECT journal_json FROM cloud_program_archives ORDER BY rowid DESC")?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|s| serde_json::from_str(s).map_err(Into::into))
            .collect()
    }
    pub(crate) fn delete_cloud_archive(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM cloud_program_archives WHERE id=?1", [id])?;
        Ok(())
    }
}
