-- Additive S20 cache and durable completed-download journal. No historical
-- session start is changed. Account ownership is verified by web before use.
CREATE TABLE IF NOT EXISTS cloud_recording_library (
 recording_id TEXT PRIMARY KEY,
 show_id TEXT NOT NULL,
 take_id TEXT NOT NULL,
 metadata_json TEXT NOT NULL,
 session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
 staging_path TEXT,
 staging_object_json TEXT,
 final_path TEXT,
 identity_json TEXT
);
CREATE INDEX IF NOT EXISTS cloud_recording_library_show ON cloud_recording_library(show_id);
CREATE TABLE IF NOT EXISTS cloud_session_associations (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 show_id TEXT NOT NULL
);
INSERT OR IGNORE INTO cloud_session_associations(session_id, show_id)
 SELECT id, id FROM sessions WHERE mode IN ('cloud-stream', 'cloud-room');

CREATE TABLE IF NOT EXISTS cloud_live_intervals (
 id TEXT PRIMARY KEY,
 show_id TEXT NOT NULL,
 requested_at TEXT NOT NULL,
 live_since TEXT,
 end_requested_at TEXT,
 ended_at TEXT
);
