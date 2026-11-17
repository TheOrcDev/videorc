CREATE TABLE IF NOT EXISTS cloud_program_clips (
 id TEXT PRIMARY KEY NOT NULL,
 journal_json TEXT NOT NULL
);
-- A clip remains a derived local file, never a new provider take. Provenance
-- outlives dismissal of its transfer job and follows Library deletion.
CREATE TABLE IF NOT EXISTS cloud_clip_sources (
 session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 show_id TEXT NOT NULL,
 marker_id TEXT NOT NULL,
 generation TEXT NOT NULL,
 take_id TEXT NOT NULL,
 provider_egress_id TEXT NOT NULL,
 live_interval_id TEXT,
 show_origin TEXT NOT NULL,
 start_ms REAL NOT NULL,
 end_ms REAL NOT NULL,
 uncertainty_ms REAL NOT NULL CHECK(uncertainty_ms >= 0 AND uncertainty_ms <= 50)
);
