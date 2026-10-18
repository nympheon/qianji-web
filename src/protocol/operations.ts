interface OperationDefinition {
  ctrl: string;
  act: string;
  constructor: 'normal' | 'sync-string';
  requiresSession: boolean;
  response: 'object' | 'optional';
  timeoutMs: number;
}

function op(ctrl: string, act: string, constructor: OperationDefinition['constructor'], requiresSession = true, response: OperationDefinition['response'] = 'object'): OperationDefinition {
  return Object.freeze({ ctrl, act, constructor, requiresSession, response, timeoutMs: 20_000 });
}

/** Only APK-confirmed paths; domain tasks extend this table with their evidence. */
export const OPERATIONS = {
  'account.login': op('account', 'login', 'normal', false),
  'account.refreshtoken': op('account', 'refreshtoken', 'normal'),
  'account.logout': op('account', 'logout', 'normal', true, 'optional'),
  'client.init': op('client', 'init', 'normal'),
  'syncv2.pull': op('syncv2', 'pull', 'sync-string'),
  'bill.syncall': op('bill', 'syncall', 'sync-string'),
  'tag.syncall': op('tag', 'syncall', 'sync-string'),
} as const;
export type ProtocolOperation = keyof typeof OPERATIONS;

export function operationDefinition(name: ProtocolOperation): OperationDefinition {
  if (!Object.hasOwn(OPERATIONS, name)) throw new Error('UNKNOWN_PROTOCOL_OPERATION');
  return OPERATIONS[name];
}
