import type { createActorContext } from '../actor/context';
import type { ActionInput, ActionName } from '../contracts/actions';
import { actionSchemas } from '../contracts/actions';
import { DomainError } from '../shared/errors';

export type UseCaseContext = ReturnType<typeof createActorContext>;
export interface UseCase { invoke(context: UseCaseContext, input: unknown): Promise<unknown> }
export function useCase<A extends ActionName>(action: A, run: (context: UseCaseContext, input: ActionInput<A>) => unknown | Promise<unknown>): UseCase {
  return { async invoke(context, input) {
    const parsed = actionSchemas[action].safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_ACTION_INPUT', '操作参数无效，请检查筛选或输入');
    // Schema and callback share the same action key; parsing is the runtime type boundary.
    return run(context, parsed.data as ActionInput<A>);
  } };
}
