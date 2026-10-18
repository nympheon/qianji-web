interface OperationDefinition {
  ctrl: string;
  act: string;
  constructor: 'normal' | 'sync-string';
  requiresSession: boolean;
  response: 'object' | 'array' | 'native-list' | 'native-object' | 'optional';
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
  'bill.refund': op('bill', 'refund2', 'normal', true, 'native-list'),
  'bill.reimburse': op('baoxiao', 'baoxiao', 'normal'),
  'bill.cancelReimbursement': op('baoxiao', 'cancelbaoxiao', 'normal', true, 'optional'),
  'asset.list': op('asset', 'list', 'normal', true, 'object', true),
  'asset.info': op('asset', 'info', 'normal', true, 'native-object', true),
  'asset.submit': op('asset', 'submit', 'normal'),
  'asset.finish': op('asset', 'finish', 'normal', true, 'optional'),
  'asset.visible': op('asset', 'visible', 'normal', true, 'optional'),
  'asset.reorder': op('asset', 'reorder', 'normal', true, 'optional'),
  'asset.deleteCheck': op('asset', 'deletecheck', 'normal', true, 'native-object', true),
  'asset.delete': op('asset', 'delete', 'normal', true, 'native-list'),
  'asset.types': op('asset', 'typelist', 'normal', true, 'native-list', true),
  'asset.loans': op('asset', 'listloan', 'normal', true, 'native-list', true),
  'asset.trend': op('assetline', 'list', 'normal', true, 'native-list', true),
  'assetGroup.list': op('asset_group', 'list', 'normal', true, 'native-list', true),
  'assetGroup.submit': op('asset_group', 'submit', 'normal', true, 'native-object'),
  'assetGroup.delete': op('asset_group', 'delete', 'normal', true, 'optional'),
  'assetGroup.reorder': op('asset_group', 'reorder', 'normal', true, 'optional'),
  'assetGroup.add': op('asset_group', 'addasset', 'normal', true, 'optional'),
  'assetGroup.remove': op('asset_group', 'removeasset', 'normal', true, 'optional'),
  'book.list': op('book', 'list', 'normal', true, 'native-list', true),
  'book.types': op('book', 'typelist', 'normal', true, 'native-list', true),
  'book.submit': op('book', 'submit', 'normal', true, 'native-object'),
  'book.configure': op('book', 'config', 'normal', true, 'native-object'),
  'book.visible': op('book', 'visible', 'normal', true, 'optional'),
  'book.deleteCheck': op('book', 'deletecheck', 'normal', true, 'native-object', true),
  'book.delete': op('book', 'delete', 'normal', true, 'optional'),
  'book.quit': op('book', 'quit', 'normal', true, 'optional'),
  'book.reorder': op('book', 'reorder', 'normal', true, 'optional'),
  'book.members': op('book', 'members', 'normal', true, 'native-list', true),
  'user.configure': op('user', 'updateconfig', 'normal', true, 'optional'),
  'tag.syncall': op('tag', 'syncall', 'sync-string'),
  'tag.pull': op('tag', 'syncall', 'sync-string', true, 'object', true),
  'tag.list': op('tag', 'list', 'sync-string', true, 'array', true),
} as const;
export type ProtocolOperation = keyof typeof OPERATIONS;

export function operationDefinition(name: ProtocolOperation): OperationDefinition {
  if (!Object.hasOwn(OPERATIONS, name)) throw new Error('UNKNOWN_PROTOCOL_OPERATION');
  return OPERATIONS[name];
}
