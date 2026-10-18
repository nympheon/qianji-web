import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../worker/env';
import { createActorContext } from './context';

export class QianjiState extends DurableObject<Env> {
  readonly #instanceId: string;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const { repository } = createActorContext(state.storage);
    this.#instanceId = repository.sql.exec<{ value: string }>(
      'SELECT value FROM instance_meta WHERE key = ?', 'instance_id',
    ).one().value;
  }

  ping(): string {
    return this.#instanceId;
  }
}
