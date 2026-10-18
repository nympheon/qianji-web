interface OperationDefinition {
  ctrl: string;
  act: string;
  constructor: 'normal' | 'sync-string';
  requiresSession: boolean;
  response: 'object' | 'array' | 'optional';
  timeoutMs: number;
  readOnly: boolean;
}

function op(ctrl: string, act: string, constructor: OperationDefinition['constructor'], requiresSession = true, response: OperationDefinition['response'] = 'object', readOnly = false): OperationDefinition {
  return Object.freeze({ ctrl, act, constructor, requiresSession, response, readOnly, timeoutMs: 20_000 });
}

/** Only APK-confirmed paths; domain tasks extend this table with their evidence. */
export const OPERATIONS = {
  'account.login': op('account', 'login', 'normal', false),
  'account.refreshtoken': op('account', 'refreshtoken', 'normal'),
  'account.logout': op('account', 'logout', 'normal', true, 'optional'),
  'client.init': op('client', 'init', 'normal', true, 'object', true),
  'syncv2.pull': op('syncv2', 'pull', 'sync-string', true, 'object', true),
  'bill.syncall': op('bill', 'syncall', 'sync-string'),
  'bill.refund': op('bill', 'refund2', 'normal', true, 'array'),
  'tag.syncall': op('tag', 'syncall', 'sync-string'),
  'tag.pull': op('tag', 'syncall', 'sync-string', true, 'object', true),
  'tag.list': op('tag', 'list', 'sync-string', true, 'array', true),
} as const;
export type ProtocolOperation = keyof typeof OPERATIONS;

export function operationDefinition(name: ProtocolOperation): OperationDefinition {
  if (!Object.hasOwn(OPERATIONS, name)) throw new Error('UNKNOWN_PROTOCOL_OPERATION');
  return OPERATIONS[name];
}
