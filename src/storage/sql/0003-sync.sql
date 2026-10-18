CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  domain TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0, changed_records INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT NOT NULL, error TEXT, started_ms INTEGER NOT NULL, finished_ms INTEGER
);
CREATE UNIQUE INDEX sync_job_running ON sync_jobs(uid,domain) WHERE state='running';
