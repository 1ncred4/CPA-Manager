/**
 * v1 identity-access synchronization was folded into modelOps.ts.
 * Kept as a compatibility export for integrations that imported the helper.
 */
import type { MappingTargetRef } from './modelMapping';
import type { ModelManagementState } from './modelManagementState';
import type { ModelOp } from './modelOps';

export function planIdentityAccessSync(input: {
  state: ModelManagementState;
  alias: string;
  selectedTargets: MappingTargetRef[];
  suspendedTargets: MappingTargetRef[];
  abandonedTargets?: MappingTargetRef[];
}): ModelOp[] {
  void input;
  return [];
}
