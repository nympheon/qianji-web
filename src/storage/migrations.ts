import baseSql from './sql/0001-base.sql?raw';
import operationsSql from './sql/0002-operations.sql?raw';
import syncSql from './sql/0003-sync.sql?raw';
import cacheSql from './sql/0004-cache.sql?raw';
import ledgerQuerySql from './sql/0005-ledger-query.sql?raw';
import accountingConfigSql from './sql/0006-accounting-config.sql?raw';
import { DomainError } from '../shared/errors';

export interface Migration { version: number; name: string; sql: string }
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'base', sql: baseSql },
  { version: 2, name: 'operations', sql: operationsSql },
  { version: 3, name: 'sync', sql: syncSql },
  { version: 4, name: 'cache', sql: cacheSql },
  { version: 5, name: 'ledger-query', sql: ledgerQuerySql },
  { version: 6, name: 'accounting-config', sql: accountingConfigSql },
];

/** Each schema step and its version marker commit together, including DDL. */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[] = MIGRATIONS): void {
  storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL)').toArray();
  });
  let version = storage.sql.exec<{ version: number }>('SELECT COALESCE(MAX(version),0) AS version FROM schema_version').one().version;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) throw new DomainError('MIGRATION_GAP', '数据库迁移顺序不完整');
    storage.transactionSync(() => {
      storage.sql.exec(migration.sql).toArray();
      storage.sql.exec('INSERT INTO schema_version(version,name) VALUES (?,?)', migration.version, migration.name).toArray();
    });
    version = migration.version;
  }
}
