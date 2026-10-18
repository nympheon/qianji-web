import { actionDefinitions, type ActionName } from '../contracts/actions';
import type { CapabilityView } from '../contracts/capabilities';
import type { UseCaseContext } from './use-case';
export function listCapabilities(context: UseCaseContext): CapabilityView[] {
  const hasAccount = context.connection.scope() !== null;
  return (Object.keys(actionDefinitions) as ActionName[]).map((action) => {
    const definition = actionDefinitions[action], reason = definition.unavailable?.reason ?? (definition.requiresAccount && !hasAccount ? '请先连接钱迹' : null);
    return { action, kind: definition.kind, evidence: definition.evidence, enabled: reason === null, reason };
  });
}
