/**
 * 应用器：执行 modelOps 产出的 ModelOp[]。
 *
 * 语义：
 * - 按 queueKey（channel / resourceId）分组：同 key 串行（复刻今日 enqueueSerial），不同 key 并发。
 * - 同 key 内按 phase 排序：before-backend（同步 localStorage）-> backend（await API）-> after-backend（同步 localStorage）。
 *   同 phase 内保持 plan 时的 push 顺序（稳定排序）。
 * - 任一 op 失败 -> 记录 failure，跳过该 queueKey 的剩余 op；调用方据 failures 触发全量 baseline 重新同步。
 * - 跨调用的串行队列：传入的 queues Map 为模块级单例（store 持有），保证先后两次 apply 间同 key 仍串行。
 *
 * 无完整事务回滚（后端不支持）。before-backend 的 suspend 写入若成功但后续 backend 失败：
 * - 禁用场景：绑定已捕获（安全，恢复时可用）；resync 的 reconcile 会清理因失败留下的 ghost。
 * - 启用场景：take 落 after-backend，backend 失败时不会清 localStorage（安全）。
 */

import { authFilesApi } from '@/services/api/authFiles';
import type { ProviderResource } from '@/features/providers/types';
import {
  clearMappingDisabledForAlias,
  mergeMappingDisabled,
  markExplicitIdentity,
  putModelDisabledSnapshot,
  takeMappingDisabledForTarget,
  takeModelDisabledSnapshot,
  unmarkExplicitIdentity,
} from './modelDisabledState';
import { updateApiKeyExcludedModels } from './updateApiKeyExcludedModels';
import { updateApiKeyModels } from './updateApiKeyModels';
import type { ModelOp, ModelOpPhase } from './modelOps';
import type { MappingTargetRef } from './modelMapping';

export type ModelOpFailure = {
  op: ModelOp;
  error: unknown;
};

export type ApplyModelOperationsInput = {
  apiBase: string;
  ops: ModelOp[];
  resources: ProviderResource[];
  /** 模块级单例队列（跨调用存活）；省略则本次调用内独立 */
  queues?: Map<string, Promise<unknown>>;
};

export type ApplyModelOperationsResult = {
  failures: ModelOpFailure[];
};

const PHASE_ORDER: Record<ModelOpPhase, number> = {
  'before-backend': 0,
  backend: 1,
  'after-backend': 2,
};

export async function applyModelOperations(
  input: ApplyModelOperationsInput
): Promise<ApplyModelOperationsResult> {
  const queues = input.queues ?? new Map<string, Promise<unknown>>();
  const byQueue = groupByQueueKey(input.ops);
  const failures: ModelOpFailure[] = [];

  const tasks = Array.from(byQueue.entries()).map(([queueKey, ops]) => {
    const prev = queues.get(queueKey) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => runQueue(input, ops, failures))
      .catch(() => undefined);
    queues.set(queueKey, next);
    return next;
  });

  await Promise.all(tasks);
  return { failures };
}

function groupByQueueKey(ops: ModelOp[]): Map<string, ModelOp[]> {
  const map = new Map<string, ModelOp[]>();
  ops.forEach((op) => {
    const list = map.get(op.queueKey) ?? [];
    list.push(op);
    map.set(op.queueKey, list);
  });
  return map;
}

async function runQueue(
  input: ApplyModelOperationsInput,
  ops: ModelOp[],
  failures: ModelOpFailure[]
): Promise<void> {
  const sorted = [...ops].sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]);
  let failed = false;
  for (const op of sorted) {
    if (failed) continue;
    try {
      await runOp(input, op);
    } catch (error) {
      failures.push({ op, error });
      failed = true;
    }
  }
}

async function runOp(input: ApplyModelOperationsInput, op: ModelOp): Promise<void> {
  switch (op.kind) {
    case 'oauthAliasPatch':
      if (op.entries.length) {
        await authFilesApi.saveOauthModelAlias(op.channel, op.entries);
      } else {
        await authFilesApi.deleteOauthModelAlias(op.channel);
      }
      return;
    case 'oauthExcludedPatch':
      if (op.models.length) {
        await authFilesApi.saveOauthExcludedModels(op.channel, op.models);
      } else {
        await authFilesApi.deleteOauthExcludedEntry(op.channel);
      }
      return;
    case 'apiKeyModelsPut': {
      const resource = lookupResource(input.resources, op.resourceId);
      await updateApiKeyModels(resource, op.models);
      return;
    }
    case 'apiKeyExcludedPatch': {
      const resource = lookupResource(input.resources, op.resourceId);
      await updateApiKeyExcludedModels(resource, op.modelsWithoutStar);
      return;
    }
    case 'modelDisabledPut':
      putModelDisabledSnapshot(input.apiBase, op.snapshot);
      return;
    case 'modelDisabledTake':
      takeModelDisabledSnapshot(input.apiBase, op.target);
      return;
    case 'mappingDisabledMerge':
      mergeMappingDisabled(input.apiBase, op.targetKey, op.entries);
      return;
    case 'mappingDisabledTake':
      takeMappingDisabledForTarget(input.apiBase, op.alias, targetFromKey(op));
      return;
    case 'mappingDisabledClearAlias':
      clearMappingDisabledForAlias(input.apiBase, op.aliasKey);
      return;
    case 'explicitIdentityMark': {
      markExplicitIdentity(input.apiBase, op.target);
      return;
    }
    case 'explicitIdentityUnmark': {
      unmarkExplicitIdentity(input.apiBase, op.target);
      return;
    }
  }
}

function targetFromKey(op: Extract<ModelOp, { kind: 'mappingDisabledTake' }>): MappingTargetRef {
  // mappingDisabledTake carries only the stable access key; local storage also
  // accepts the target reference, so decode the key for both source kinds.
  const parts = op.targetKey.split(':');
  if (parts[0] === 'oauth') {
    return { source: 'oauth', channel: parts[1] ?? '', modelId: parts.slice(2).join(':') };
  }
  return {
    source: 'apiKey',
    resourceId: parts[1] ?? '',
    brand: 'openaiCompatibility',
    modelId: parts.slice(2).join(':'),
  };
}

function lookupResource(resources: ProviderResource[], resourceId: string): ProviderResource {
  const resource = resources.find((r) => r.id === resourceId);
  if (!resource) {
    throw new Error(`applyModelOperations: resource not found: ${resourceId}`);
  }
  return resource;
}
