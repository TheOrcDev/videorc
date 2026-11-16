-- S21c is additive. No historical session/take start or retention is rewritten.
CREATE TABLE IF NOT EXISTS cloud_program_archives (
  id TEXT PRIMARY KEY,
  journal_json TEXT NOT NULL CHECK(length(journal_json) <= 524288)
);
