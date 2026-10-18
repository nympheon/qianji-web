CREATE TABLE IF NOT EXISTS instance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE connection (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  uid TEXT, connection_epoch TEXT, token_cipher TEXT,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  route TEXT NOT NULL DEFAULT 'main', device_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'disconnected', profile_raw TEXT,
  CHECK ((uid IS NULL) = (connection_epoch IS NULL))
);
CREATE TABLE datasets (
  uid TEXT NOT NULL, domain TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
  validated_at TEXT,
  PRIMARY KEY (uid, domain, id)
);
CREATE TABLE active_datasets (
  uid TEXT NOT NULL, domain TEXT NOT NULL, dataset_id TEXT NOT NULL,
  PRIMARY KEY (uid, domain),
  FOREIGN KEY (uid, domain, dataset_id) REFERENCES datasets(uid, domain, id)
);
CREATE TABLE sync_state (
  uid TEXT NOT NULL, domain TEXT NOT NULL, dataset_id TEXT NOT NULL,
  page_state TEXT NOT NULL DEFAULT 'null', cursor TEXT NOT NULL DEFAULT 'null',
  PRIMARY KEY (uid, domain, dataset_id),
  FOREIGN KEY (uid, domain, dataset_id) REFERENCES datasets(uid, domain, id)
);
CREATE TABLE bills (
  uid TEXT NOT NULL, domain TEXT NOT NULL CHECK(domain = 'ledger'), dataset_id TEXT NOT NULL,
  id TEXT NOT NULL, book_id TEXT NOT NULL, type INTEGER NOT NULL,
  time_sec INTEGER NOT NULL, money TEXT NOT NULL, raw TEXT NOT NULL,
  PRIMARY KEY (uid, domain, dataset_id, id),
  FOREIGN KEY (uid, domain, dataset_id) REFERENCES datasets(uid, domain, id)
);
CREATE INDEX bills_book_time ON bills(uid, dataset_id, book_id, time_sec, id);
CREATE INDEX bills_time ON bills(uid, dataset_id, time_sec, id);
CREATE TABLE bill_relations (
  uid TEXT NOT NULL, domain TEXT NOT NULL, dataset_id TEXT NOT NULL,
  bill_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, raw TEXT NOT NULL,
  PRIMARY KEY (uid, domain, dataset_id, bill_id, kind, target_id),
  FOREIGN KEY (uid, domain, dataset_id, bill_id) REFERENCES bills(uid, domain, dataset_id, id) ON DELETE CASCADE
);
CREATE INDEX relations_target ON bill_relations(uid, dataset_id, kind, target_id);
CREATE TABLE resources (
  uid TEXT NOT NULL, domain TEXT NOT NULL, dataset_id TEXT NOT NULL,
  kind TEXT NOT NULL, id TEXT NOT NULL, raw TEXT NOT NULL,
  PRIMARY KEY (uid, domain, dataset_id, kind, id),
  FOREIGN KEY (uid, domain, dataset_id) REFERENCES datasets(uid, domain, id)
);
CREATE TABLE drafts (
  uid TEXT NOT NULL, id TEXT NOT NULL, raw TEXT NOT NULL,
  PRIMARY KEY (uid, id)
);
