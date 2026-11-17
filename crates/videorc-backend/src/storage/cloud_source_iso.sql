-- Plan 249 S22 is additive. One download journal per program take (the JSON of
-- cloud_source_iso::IsoDownloadJournal), and one row per ISO file this desktop
-- staged, so recovery removes only files its own journal created. No
-- historical session, take start or retention is rewritten.
CREATE TABLE IF NOT EXISTS cloud_iso_imports (
 take_id TEXT PRIMARY KEY,
 show_id TEXT NOT NULL,
 program_recording_id TEXT NOT NULL,
 journal_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_iso_import_files (
 take_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 object_key TEXT NOT NULL,
 staging_path TEXT,
 staging_object_json TEXT,
 final_path TEXT,
 identity_json TEXT,
 registration_json TEXT,
 session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
 PRIMARY KEY (take_id, entry_id)
);
