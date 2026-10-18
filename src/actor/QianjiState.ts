import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../worker/env';
import { createActorContext } from './context';
import type { ConnectionView, PasswordLoginInput } from '../features/connection/contract';
import type { ImageReferenceInput } from '../features/attachments/contract';
import { AppRegistry } from '../app/registry';

export class QianjiState extends DurableObject<Env> {
  readonly #instanceId: string;
  readonly #context: ReturnType<typeof createActorContext>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#context = createActorContext(state.storage, env, { waitUntil: (task) => state.waitUntil(task) });
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

  async login(input: PasswordLoginInput): Promise<ConnectionView> {
    return this.#context.connection.login(input);
  }
  imageSource(input: ImageReferenceInput): string { return this.#context.attachments.source(input); }
  async call(action: string, input: unknown, meta: unknown = {}): Promise<string> {
    return JSON.stringify(await new AppRegistry(this.#context).invoke(action, input, meta));
  }
}
