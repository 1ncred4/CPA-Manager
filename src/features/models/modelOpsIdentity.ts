/**
 * 计算模块（纯函数）：渠道内禁用/启用映射目标时，同步隐藏或恢复「原名」入口。
 *
 * 泛化自 syncIdentityAccessOnMapping.ts 的 syncIdentityAccessOnMappingSave（impure），
 * 消费 ModelManagementState，产出 ModelOp[]（不调 API、不写 localStorage）。
 * 供 planAliasSave（Phase 4）/ planAliasDelete（Phase 3）复用。
 *
 * phase 语义（与 planAccessToggle 一致）：
 * - oauthAliasPatch / oauthExcludedPatch / apiKeyModelsPut / apiKeyExcludedPatch = backend。
 * - catalogSuspendMerge = before-backend（摘除前先捕获条目）；catalogSuspendTake = after-backend。
 * - managedExcludeMark / Unmark = after-backend（掩码反映后端实际结果；失败时不留幽灵）。
 */

import { stripDisableAllModelsRule } from '@/components/providers/utils';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import {
  normalizeOAuthExcludedRules,
  updateOAuthExcludedRule,
} from '@/features/authFiles/oauthExcludedRules';
import type { ModelAlias } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import { accessEnabledKey, type MappingTargetRef } from './modelMapping';
import { toggleApiKeyExcludedList } from './modelAccessRows';
import { removeModelFromCatalog, restoreModelToCatalog } from './catalogSuspend';
import {
  partitionIdentityAccessTargets,
  planOauthIdentityDisable,
  planOauthIdentityEnable,
} from './syncIdentityAccessOnMapping';
import type { ModelManagementState } from './modelManagementState';
import type { ModelOp, ModelOpPhase } from './modelOps';

const lower = (value: string): string => value.trim().toLowerCase();

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models;
}

export function planIdentityAccessSync(input: {
  state: ModelManagementState;
  alias: string;
  selectedTargets: MappingTargetRef[];
  suspendedTargets: MappingTargetRef[];
  abandonedTargets?: MappingTargetRef[];
}): ModelOp[] {
  const ops: ModelOp[] = [];
  const push = (op: ModelOp) => ops.push(op);

  const { toEnable, toDisable, toClearExclude } = partitionIdentityAccessTargets({
    alias: input.alias,
    selectedTargets: input.selectedTargets,
    suspendedTargets: input.suspendedTargets.map((t) => ({ target: t })),
    abandonedTargets: input.abandonedTargets,
  });
  if (!toEnable.length && !toDisable.length && !toClearExclude.length) return ops;

  planOauthIdentityAccess(input.state, toEnable, toDisable, toClearExclude, push);
  planApiKeyIdentityAccess(input.state, toEnable, toDisable, toClearExclude, push);
  return ops;
}

function planOauthIdentityAccess(
  state: ModelManagementState,
  toEnable: MappingTargetRef[],
  toDisable: MappingTargetRef[],
  toClearExclude: MappingTargetRef[],
  push: (op: ModelOp) => void
): void {
  const groupByChannel = (targets: MappingTargetRef[]) => {
    const map = new Map<string, string[]>();
    targets.forEach((t) => {
      if (t.source !== 'oauth') return;
      const channel = normalizeProviderKey(t.channel);
      if (!channel) return;
      const list = map.get(channel) ?? [];
      if (!list.some((id) => lower(id) === lower(t.modelId))) list.push(t.modelId);
      map.set(channel, list);
    });
    return map;
  };

  const disableByChannel = groupByChannel(toDisable);
  const enableByChannel = groupByChannel(toEnable);
  const clearByChannel = groupByChannel(toClearExclude);
  const channels = new Set([
    ...disableByChannel.keys(),
    ...enableByChannel.keys(),
    ...clearByChannel.keys(),
  ]);
  if (!channels.size) return;

  const BACKEND: ModelOpPhase = 'backend';
  const AFTER: ModelOpPhase = 'after-backend';

  channels.forEach((channel) => {
    let entries = [...(state.oauthAliasMap[channel] ?? [])];
    let rules = normalizeOAuthExcludedRules(state.oauthExcludedMap[channel] ?? []);
    let aliasDirty = false;
    let excludedDirty = false;
    const managedUnmarkKeys: string[] = [];
    const managedMarkKeys: string[] = [];

    const disableIds = disableByChannel.get(channel) ?? [];
    const enableIds = enableByChannel.get(channel) ?? [];
    const clearIds = clearByChannel.get(channel) ?? [];

    disableIds.forEach((modelId) => {
      const plan = planOauthIdentityDisable(entries, modelId);
      if (plan.changed) {
        entries = plan.next;
        aliasDirty = true;
      }
      if (plan.usedFork) {
        managedUnmarkKeys.push(accessEnabledKey({ source: 'oauth', channel, modelId }));
        const before = rules.length;
        rules = updateOAuthExcludedRule(rules, modelId, false);
        if (rules.length < before) excludedDirty = true;
        return;
      }
      rules = updateOAuthExcludedRule(rules, modelId, true);
      excludedDirty = true;
      managedMarkKeys.push(accessEnabledKey({ source: 'oauth', channel, modelId }));
    });

    enableIds.forEach((modelId) => {
      const plan = planOauthIdentityEnable(entries, modelId);
      if (plan.changed) {
        entries = plan.next;
        aliasDirty = true;
      }
      const before = rules.length;
      rules = updateOAuthExcludedRule(rules, modelId, false);
      if (rules.length < before) excludedDirty = true;
      managedUnmarkKeys.push(accessEnabledKey({ source: 'oauth', channel, modelId }));
    });

    clearIds.forEach((modelId) => {
      if (enableIds.some((id) => lower(id) === lower(modelId))) return;
      const before = rules.length;
      rules = updateOAuthExcludedRule(rules, modelId, false);
      if (rules.length < before) excludedDirty = true;
      managedUnmarkKeys.push(accessEnabledKey({ source: 'oauth', channel, modelId }));
    });

    if (aliasDirty) {
      push({ kind: 'oauthAliasPatch', phase: BACKEND, queueKey: channel, channel, entries });
    }
    if (excludedDirty) {
      push({
        kind: 'oauthExcludedPatch',
        phase: BACKEND,
        queueKey: channel,
        channel,
        models: rules,
      });
    }
    managedMarkKeys.forEach((key) =>
      push({ kind: 'managedExcludeMark', phase: AFTER, queueKey: channel, key })
    );
    managedUnmarkKeys.forEach((key) =>
      push({ kind: 'managedExcludeUnmark', phase: AFTER, queueKey: channel, key })
    );
  });
}

function planApiKeyIdentityAccess(
  state: ModelManagementState,
  toEnable: MappingTargetRef[],
  toDisable: MappingTargetRef[],
  toClearExclude: MappingTargetRef[],
  push: (op: ModelOp) => void
): void {
  const groupByResource = (targets: MappingTargetRef[]) => {
    const map = new Map<string, string[]>();
    targets.forEach((t) => {
      if (t.source !== 'apiKey') return;
      const list = map.get(t.resourceId) ?? [];
      if (!list.some((id) => lower(id) === lower(t.modelId))) list.push(t.modelId);
      map.set(t.resourceId, list);
    });
    return map;
  };

  const disableByResource = groupByResource(toDisable);
  const enableByResource = groupByResource([...toEnable, ...toClearExclude]);
  const resourceIds = new Set([
    ...disableByResource.keys(),
    ...enableByResource.keys(),
  ]);

  const BACKEND: ModelOpPhase = 'backend';
  const BEFORE: ModelOpPhase = 'before-backend';
  const AFTER: ModelOpPhase = 'after-backend';

  resourceIds.forEach((resourceId) => {
    const resource = state.catalogs.resources.find((r) => r.id === resourceId);
    if (!resource) return;
    const queueKey = resource.id;
    const disableIds = disableByResource.get(resourceId) ?? [];
    const enableIds = enableByResource.get(resourceId) ?? [];

    if (resource.brand === 'openaiCompatibility') {
      let models = [...readApiKeyModels(resource)];
      let dirty = false;
      const beforeKeys: string[] = [];
      const afterTake: Array<{ modelId: string }> = [];
      const managedUnmark: string[] = [];
      const managedMark: string[] = [];

      disableIds.forEach((modelId) => {
        const { next, removed } = removeModelFromCatalog(models, modelId);
        const entries = removed.length > 0 ? removed : ([{ name: modelId }] as ModelAlias[]);
        push({
          kind: 'catalogSuspendMerge',
          phase: BEFORE,
          queueKey,
          resourceId,
          modelId,
          entries,
        });
        managedMark.push(accessEnabledKey({ source: 'apiKey', resourceId, brand: resource.brand, modelId }));
        models = next;
        dirty = true;
      });
      enableIds.forEach((modelId) => {
        // 取出当前镜像中的 catalog 挂起条目用于恢复（reducer 已把它放在 access.byKey）
        const suspendedEntries = state.access.byKey.get(
          accessEnabledKey({ source: 'apiKey', resourceId, brand: resource.brand, modelId })
        )?.suspendedCatalogEntries;
        const toRestore =
          suspendedEntries && suspendedEntries.length
            ? suspendedEntries
            : ([{ name: modelId }] as ModelAlias[]);
        const { next } = restoreModelToCatalog(models, toRestore);
        models = next;
        afterTake.push({ modelId });
        managedUnmark.push(accessEnabledKey({ source: 'apiKey', resourceId, brand: resource.brand, modelId }));
        dirty = true;
      });

      if (dirty) {
        push({
          kind: 'apiKeyModelsPut',
          phase: BACKEND,
          queueKey,
          resourceId,
          brand: resource.brand,
          models,
        });
      }
      afterTake.forEach(({ modelId }) =>
        push({ kind: 'catalogSuspendTake', phase: AFTER, queueKey, resourceId, modelId })
      );
      managedMark.forEach((key) =>
        push({ kind: 'managedExcludeMark', phase: AFTER, queueKey, key })
      );
      managedUnmark.forEach((key) =>
        push({ kind: 'managedExcludeUnmark', phase: AFTER, queueKey, key })
      );
      void beforeKeys;
      return;
    }

    const raw = resource.raw as { excludedModels?: string[] };
    let list = stripDisableAllModelsRule(raw.excludedModels);
    let dirty = false;
    const managedMark: string[] = [];
    const managedUnmark: string[] = [];

    disableIds.forEach((modelId) => {
      list = toggleApiKeyExcludedList(list, modelId, true);
      managedMark.push(accessEnabledKey({ source: 'apiKey', resourceId, brand: resource.brand, modelId }));
      dirty = true;
    });
    enableIds.forEach((modelId) => {
      const next = toggleApiKeyExcludedList(list, modelId, false);
      if (next.length !== list.length) dirty = true;
      list = next;
      managedUnmark.push(accessEnabledKey({ source: 'apiKey', resourceId, brand: resource.brand, modelId }));
    });

    if (dirty) {
      push({
        kind: 'apiKeyExcludedPatch',
        phase: BACKEND,
        queueKey,
        resourceId,
        brand: resource.brand,
        modelsWithoutStar: list,
      });
    }
    managedMark.forEach((key) =>
      push({ kind: 'managedExcludeMark', phase: AFTER, queueKey, key })
    );
    managedUnmark.forEach((key) =>
      push({ kind: 'managedExcludeUnmark', phase: AFTER, queueKey, key })
    );
  });
}
