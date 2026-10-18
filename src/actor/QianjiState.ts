import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../worker/env';
import { createActorContext } from './context';
import type { ConnectionView, PasswordLoginInput } from '../features/connection/contract';
import type { ImageReferenceInput } from '../features/attachments/contract';
import { AppRegistry } from '../app/registry';
import {maintenanceCommandSchema} from './maintenance-command';
import {verifyMaintenance} from './maintenance-verify';
import {DomainError} from '../shared/errors';

export class QianjiState extends DurableObject<Env> {
  readonly #instanceId: string;
  readonly #context: ReturnType<typeof createActorContext>;
  readonly #maintenanceEnvironment:{paused:boolean;restoreId:string|null};
  #maintenanceCheck:Promise<unknown>|null=null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#maintenanceEnvironment={paused:env.QIANJI_MAINTENANCE==='paused',restoreId:env.QIANJI_RESTORE_ID??null};
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
  /** Binding-only RPC. No public HTTP route, MCP tool, SQL text or arbitrary script is accepted. */
  async operate(input:unknown):Promise<unknown>{
    const command=maintenanceCommandSchema.parse(input),{maintenance,coordinator}=this.#context;
    if(command.action==='status')return maintenance.view();
    if(command.action==='pause')return coordinator.changeConnection(async()=>{const view=maintenance.pause();await this.ctx.storage.deleteAlarm();return view;});
    if(command.action==='verify'){this.#maintenanceCheck??=verifyMaintenance(this.#context);try{return await this.#maintenanceCheck;}finally{this.#maintenanceCheck=null;}}
    if(command.action==='resume')return coordinator.changeConnection(async()=>{const view=maintenance.resume(command.reviewDigest);await coordinator.recover();return view;});
    if(!maintenance.paused())throw new DomainError('MAINTENANCE_NOT_PAUSED','PITR操作要求先暂停写入');
    if(command.action==='bookmark')return {bookmark:command.at?await this.ctx.storage.getBookmarkForTime(new Date(command.at)):await this.ctx.storage.getCurrentBookmark()};
    if(!this.#maintenanceEnvironment.paused||!this.#maintenanceEnvironment.restoreId||command.restoreId!==this.#maintenanceEnvironment.restoreId)throw new DomainError('RESTORE_ENV_REQUIRED','PITR前须在Cloudflare环境持久设置暂停与新的恢复批次');
    if(command.action==='restore')return coordinator.changeConnection(async()=>({undoBookmark:await this.ctx.storage.onNextSessionRestoreBookmark(command.bookmark),restartRequired:true}));
    this.ctx.abort('Controlled PITR restart',{retryAlarm:false});return {restarting:true};
  }
  async call(action: string, input: unknown, meta: unknown = {}): Promise<string> {
    return JSON.stringify(await new AppRegistry(this.#context).invoke(action, input, meta));
  }
}
