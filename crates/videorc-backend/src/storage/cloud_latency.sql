-- Plan 253 S7 is additive. A managed talk show's delays, one row per minute,
-- subject and kind (docs/cloud/253-latency-contract.md, section 10). `minute`
-- is Unix time / 60; `subject` is a room identity, `program` or `control`;
-- `partial` counts the minute's samples that are a floor. Every value is a
-- duration in milliseconds, never a timestamp (D1).
CREATE TABLE IF NOT EXISTS cloud_latency_minutes (
 show_id TEXT NOT NULL,
 minute INTEGER NOT NULL,
 subject TEXT NOT NULL,
 kind TEXT NOT NULL,
 name TEXT,
 p50_ms INTEGER NOT NULL,
 p95_ms INTEGER NOT NULL,
 max_ms INTEGER NOT NULL,
 samples INTEGER NOT NULL,
 partial INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (show_id, minute, subject, kind)
) WITHOUT ROWID;
-- The record dies with its show (D12): a show's Library entry is the
-- `sessions` row with the show's id. No foreign key, because a room measures
-- before it is live or recording, when that row does not exist yet.
CREATE TRIGGER IF NOT EXISTS trg_cloud_latency_show_deleted
AFTER DELETE ON sessions
BEGIN
 DELETE FROM cloud_latency_minutes WHERE show_id = OLD.id;
END;
-- A room that never went live or recorded never gets a Library entry to be
-- deleted with: its minutes go after 30 days.
DELETE FROM cloud_latency_minutes
 WHERE minute < CAST(strftime('%s', 'now') AS INTEGER) / 60 - 43200
 AND show_id NOT IN (SELECT id FROM sessions);
