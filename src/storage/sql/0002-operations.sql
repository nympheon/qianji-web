CREATE TABLE operations (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  request_id TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL, prepared TEXT, items TEXT NOT NULL DEFAULT '[]',
  affected_ids TEXT NOT NULL DEFAULT '[]', id_map TEXT NOT NULL DEFAULT '{}', error TEXT,
  send_count INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE (uid,request_id)
);
CREATE INDEX operations_scope_state ON operations(uid,state,created_ms);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, due_ms INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(due_ms,id);
