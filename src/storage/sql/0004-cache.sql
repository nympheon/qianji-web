CREATE TABLE source_domains (
  uid TEXT NOT NULL, domain TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(uid,domain)
);
CREATE TABLE source_queries (
  uid TEXT NOT NULL, domain TEXT NOT NULL, query_key TEXT NOT NULL,
  dataset_id TEXT NOT NULL, resource_kind TEXT,
  validated_ms INTEGER, changed_ms INTEGER, complete INTEGER NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0, membership_revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(uid,domain,query_key)
);
CREATE TABLE source_members (
  uid TEXT NOT NULL, domain TEXT NOT NULL, query_key TEXT NOT NULL,
  kind TEXT NOT NULL, resource_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(uid,domain,query_key,kind,resource_id)
);
CREATE TABLE operation_domains (
  operation_id TEXT NOT NULL, uid TEXT NOT NULL, domain TEXT NOT NULL,
  PRIMARY KEY(operation_id,domain),
  FOREIGN KEY(operation_id) REFERENCES operations(id)
);
CREATE TABLE rebuild_jobs (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, connection_epoch TEXT NOT NULL,
  domains TEXT NOT NULL, child_ids TEXT NOT NULL, state TEXT NOT NULL,
  catalog_done INTEGER NOT NULL DEFAULT 0, error TEXT, started_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX rebuild_running ON rebuild_jobs(uid) WHERE state='running';
CREATE TABLE sync_barrier (
  uid TEXT PRIMARY KEY, connection_epoch TEXT NOT NULL, job_id TEXT NOT NULL
);
