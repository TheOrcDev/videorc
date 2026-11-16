-- Local host-only transcript, never a native capture/session or a guest transcript.
CREATE TABLE IF NOT EXISTS cloud_host_transcript (
  show_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  speech_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  offset_seconds REAL NOT NULL,
  duration_seconds REAL NOT NULL,
  text TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (show_id, source_id, speech_session_id, seq)
);
