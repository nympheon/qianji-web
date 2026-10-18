import type { Coordinator } from '../../actor/coordinator';
import type { Repository } from '../../storage/database';
import type { ConnectionService } from '../connection/service';
import { DomainError } from '../../shared/errors';
import type { MutationCommand, OperationView } from '../../operations/contract';
import { billDraftSchema, type BillDraft, type BillDraftView, type CreateBillsInput, type DeleteBillsInput, type EditBillsInput } from './write-contract';
import { asBillObject } from '../../shared/bill-wire';
import { restoreBillInput } from './write';

export class LedgerWriteService {
  constructor(private readonly dependencies: { repository: Repository; coordinator: Coordinator; connection: Pick<ConnectionService, 'scope'> }) {}
  private scope() { const scope = this.dependencies.connection.scope(); if (!scope) throw new DomainError('CONNECTION_REQUIRED', '请先连接钱迹'); return scope; }
  private submit(action: string, input: MutationCommand['input'], meta: { requestId: string }): Promise<OperationView> {
    return this.dependencies.coordinator.submit({ action, input, requestId: meta.requestId, scope: this.scope() });
  }
  create(input: CreateBillsInput, meta: { requestId: string }) { return this.submit('ledger.create', input, meta); }
  edit(input: EditBillsInput, meta: { requestId: string }) { return this.submit('ledger.edit', input, meta); }
  remove(input: DeleteBillsInput, meta: { requestId: string }) { return this.submit('ledger.delete', input, meta); }
  getDraft(key: string): BillDraftView | null {
    const scope = this.scope(), raw = this.dependencies.repository.readDraft(scope, `bill:${key}`);
    if (raw === null) return null;
    // Draft fields contain only safe integers, text money and text IDs, never upstream raw data.
    const draft = billDraftSchema.parse(restoreBillInput(raw));
    const operation = this.dependencies.coordinator.store.find(scope, draft.requestId);
    return { draft, operationId: operation?.id ?? null };
  }
  saveDraft(key: string, draft: BillDraft): BillDraftView {
    draft = billDraftSchema.parse(draft);
    const scope = this.scope(), previous = this.getDraft(key);
    const operation = previous?.operationId ? this.dependencies.coordinator.getOperation(scope, previous.operationId) : null;
    if (operation && !['succeeded', 'failed'].includes(operation.state)) throw new DomainError('DRAFT_OPERATION_PENDING', '草稿已有在途或待核查操作，请查看原操作');
    const existing = this.dependencies.coordinator.store.find(scope, draft.requestId);
    if (existing) throw new DomainError('DRAFT_ALREADY_SUBMITTED', '该草稿已提交，请查看原操作后再建立新草稿');
    this.dependencies.repository.saveDraft(scope, `bill:${key}`, asBillObject({ ...draft, fields: { ...draft.fields } }));
    return { draft, operationId: null };
  }
}
