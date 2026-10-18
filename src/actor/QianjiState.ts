import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../worker/env';

export class QianjiState extends DurableObject<Env> {
  readonly #instanceId: string;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#instanceId = state.storage.transactionSync(() => {
      state.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS instance_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      state.storage.sql.exec(
        'INSERT OR IGNORE INTO instance_meta(key, value) VALUES (?, ?)',
        'instance_id', crypto.randomUUID(),
      );
      return state.storage.sql.exec<{ value: string }>(
        'SELECT value FROM instance_meta WHERE key = ?', 'instance_id',
      ).one().value;
    });
  }

  ping(): string {
    return this.#instanceId;
  }
}
