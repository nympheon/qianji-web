import type { ActorScope, Clock } from '../../shared/model';
import type { Repository } from '../../storage/database';
import type { SyncDomain } from '../../storage/mirror';
import type { SyncService } from './service';
import type { FreshnessMode, FreshnessResult } from './contract';
import type { JobView } from './contract';
import { DomainError } from '../../shared/errors';

export interface FreshnessDependencies { repository: Repository; clock: Clock; sync: SyncService }
/** Reconciliation still checks its own post-send watermark and matching records. */
export function sourceCheckCompleted(result:{job:Pick<JobView,'state'>|null},dataset:{complete:boolean;validatedAt:string|null}|null,nowMs:number):boolean{
  if(result.job)return result.job.state==='succeeded';
  if(!dataset?.complete||!dataset.validatedAt)return false;
  const elapsed=nowMs-Date.parse(dataset.validatedAt);
  return elapsed>=0&&elapsed<=5000;
}
export class FreshnessService {
  readonly #pending = new Map<string, Promise<JobView>>();
  constructor(private readonly dependencies: FreshnessDependencies) {}
  async ensureFresh(scope: ActorScope, domains: SyncDomain[], mode: FreshnessMode): Promise<FreshnessResult> {
    const { repository, sync, clock } = this.dependencies;
    repository.assertScope(scope);
    if (!['normal', 'manual-incremental'].includes(mode) || domains.length === 0) throw new DomainError('INVALID_FRESHNESS_INPUT', '刷新范围或模式无效');
    const selected = [...new Set(domains)];
    if (selected.some((domain) => domain !== 'ledger' && domain !== 'tags')) throw new DomainError('SOURCE_REFRESH_UNAVAILABLE', '该资源需要按查询范围校验');
    const jobs: JobView[] = [];
    const connected = repository.sql.exec<{ state: string }>('SELECT state FROM connection WHERE singleton=1').one().state === 'connected';
    // The APK refreshes tags before bills; failures remain independent by domain.
    selected.sort((a, b) => a === b ? 0 : a === 'tags' ? -1 : 1);
    for (const domain of selected) {
      if (!connected) continue;
      const key = JSON.stringify([scope.uid, scope.connectionEpoch, domain]);
      const pending = this.#pending.get(key);
      if (pending) { jobs.push(await pending); continue; }
      const dataset = repository.dataset(scope, domain);
      const checked = dataset?.validatedAt === null || dataset?.validatedAt === undefined ? null : Date.parse(dataset.validatedAt);
      const needsCheck = mode === 'manual-incremental' || !dataset?.complete || checked === null || clock.nowMs() - checked >= 60_000;
      if (!needsCheck) continue;
      const lastFinished = repository.sql.exec<{ finished: number | null }>('SELECT MAX(finished_ms) AS finished FROM sync_jobs WHERE uid=? AND domain=?', scope.uid, domain).one().finished;
      if (lastFinished !== null && clock.nowMs() - lastFinished < 5000) continue;
      const request = sync.start({ domain: domain as 'ledger' | 'tags', mode: 'incremental' });
      this.#pending.set(key, request);
      try { jobs.push(await request); } finally { this.#pending.delete(key); }
    }
    repository.assertScope(scope);
    const snapshots = selected.map((domain) => ({ domain, dataset: repository.dataset(scope, domain), uncertain: repository.hasUncertainty(scope, domain) }));
    const complete = snapshots.every((item) => item.dataset?.complete && !item.uncertain);
    const times = snapshots.map((item) => item.dataset?.validatedAt ? Date.parse(item.dataset.validatedAt) : null);
    const syncedAt = times.every((time) => time !== null) ? new Date(Math.min(...times as number[])).toISOString() : null;
    const stale = !connected || !complete || times.some((time) => time === null || clock.nowMs() - time >= 60_000);
    return { freshness: { revision: snapshots.map(({ domain, dataset }) => `${domain}:${dataset?.id ?? 'unloaded'}:${dataset?.revision ?? '0'}`).join('|'), complete, stale, syncedAt }, job: jobs.at(-1) ?? null, jobs };
  }
}
