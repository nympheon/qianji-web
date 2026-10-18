import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../worker/env';
import { createActorContext } from './context';

export class QianjiState extends DurableObject<Env> {
  readonly #instanceId: string;
  readonly #context: ReturnType<typeof createActorContext>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#context = createActorContext(state.storage);
    const { repository } = this.#context;
    this.#instanceId = repository.sql.exec<{ value: string }>(
      'SELECT value FROM instance_meta WHERE key = ?', 'instance_id',
    ).one().value;
    state.blockConcurrencyWhile(() => this.#context.coordinator.recover());
  }

  ping(): string {
    return this.#instanceId;
  }

  async alarm(): Promise<void> {
    await this.#context.coordinator.resumeJobs();
  }
}
