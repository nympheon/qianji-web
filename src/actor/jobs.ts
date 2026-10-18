import type { ActorScope, Clock, Id } from '../shared/model';
import { parseWire, stringifyWire, type WireJson } from '../shared/wire-json';
import type { Repository } from '../storage/database';

export interface DurableJob { id: Id; scope: ActorScope; kind: string; payload: WireJson; dueMs: number }
type JobRow = { id: string; uid: string; connection_epoch: string; kind: string; payload: string; due_ms: number };

/** Every task shares one scheduler and one platform alarm. No idle polling. */
export class Jobs {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly repository: Repository, private readonly clock: Clock) {}
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn); this.#tail = next.catch(() => undefined); return next;
  }
  async persistWithWakeup<T>(fn: () => T): Promise<T> {
    return this.locked(async () => {
      // Alarm is durable BEFORE recording new work. A crash cannot strand an accepted write.
      const due = this.clock.nowMs() + 1000;
      const alarm = await this.repository.storage.getAlarm();
      if (alarm === null || alarm > due) await this.repository.storage.setAlarm(due);
      return this.repository.transaction(fn);
    });
  }
  put(id: Id, scope: ActorScope, kind: string, payload: WireJson, dueMs = this.clock.nowMs() + 1000): void {
    this.repository.sql.exec('INSERT INTO jobs(id,uid,connection_epoch,kind,payload,due_ms) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,due_ms=excluded.due_ms',
      id, scope.uid, scope.connectionEpoch, kind, stringifyWire(payload), dueMs).toArray();
  }
  remove(id: Id): void { this.repository.sql.exec('DELETE FROM jobs WHERE id=?', id).toArray(); }
  listDue(): DurableJob[] {
    return this.repository.sql.exec<JobRow>('SELECT * FROM jobs WHERE due_ms<=? ORDER BY due_ms,id LIMIT 50', this.clock.nowMs()).toArray().map((row) => ({ id: row.id, scope: { uid: row.uid, connectionEpoch: row.connection_epoch }, kind: row.kind, payload: parseWire(row.payload), dueMs: row.due_ms }));
  }
  refreshAlarm(): Promise<void> {
    return this.locked(async () => {
      const due = this.repository.sql.exec<{ due: number | null }>('SELECT MIN(due_ms) AS due FROM jobs').one().due;
      const alarm = await this.repository.storage.getAlarm();
      if (due === null) { if (alarm !== null) await this.repository.storage.deleteAlarm(); }
      else if (alarm !== due) await this.repository.storage.setAlarm(due);
    });
  }
}
