CREATE TABLE accounting_config (
  uid TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  validated_ms INTEGER NOT NULL
);
