/**
 * 模型禁用/启用时同步剪枝或恢复联邦映射目标。
 * 失败不回滚 excluded 写入（主操作已成功），只上报 mapping 同步结果。
 */

import { authFilesApi } from '@/services/api';
import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import {
  accessEnabledKey,
  clearSuspendedForTarget,
  collectMappingsForTarget,
  groupSuspendedByApiKeyResource,
  groupSuspendedByOauthChannel,
  mergeSuspendedForTarget,
  pruneApiKeyModelsForModel,
  pruneOauthEntriesForModel,
  restoreApiKeyModels,
  restoreOauthEntries,
  takeSuspendedForTarget,
  type SuspendedMapping,
} from './mappingSuspend';
import type { MappingTargetRef } from './modelMapping';
import { updateApiKeyModels } from './updateApiKeyModels';

export type MappingSyncResult = {
  pruned: number;
  restored: number;
  skipped: number;
  failed: boolean;
  errorMessage?: string;
};

const emptyResult = (): MappingSyncResult => ({
  pruned: 0,
  restored: 0,
  skipped: 0,
  failed: false,
});

async function loadOauthAliasSafe(): Promise<{
  map: Record<string, OAuthModelAliasEntry[]>;
  unsupported: boolean;
}> {
  try {
    const map = await authFilesApi.getOauthModelAlias();
    return { map: map ?? {}, unsupported: false };
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: unknown }).status
        : undefined;
    if (status === 404) return { map: {}, unsupported: true };
    throw err;
  }
}

function oauthBindingPresent(
  map: Record<string, OAuthModelAliasEntry[]>,
  item: SuspendedMapping
): boolean {
  if (item.target.source !== 'oauth') return false;
  const entries = map[item.target.channel] ?? [];
  const aliasKey = item.alias.trim().toLowerCase();
  const modelKey = item.target.modelId.trim().toLowerCase();
  return entries.some(
    (e) =>
      String(e.alias ?? '').trim().toLowerCase() === aliasKey &&
      String(e.name ?? '').trim().toLowerCase() === modelKey
  );
}

/**
 * 禁用：从当前映射配置中摘掉指向 target 的 alias，并挂起以便启用时恢复。
 */
export async function pruneMappingsForDisabledTarget(input: {
  apiBase: string;
  target: MappingTargetRef;
  resources: ProviderResource[];
}): Promise<MappingSyncResult> {
  const result = emptyResult();
  const targetKey = accessEnabledKey(input.target);

  try {
    if (input.target.source === 'oauth') {
      const { map, unsupported } = await loadOauthAliasSafe();
      if (unsupported) return result;

      const channel = input.target.channel;
      const entries = map[channel] ?? [];
      if (!entries.length) return result;

      const bindings = collectMappingsForTarget({
        modelAlias: { [channel]: entries },
        resources: [],
        target: input.target,
      });
      if (!bindings.length) return result;

      const { next } = pruneOauthEntriesForModel(entries, input.target.modelId);
      if (next.length) {
        await authFilesApi.saveOauthModelAlias(channel, next);
      } else {
        await authFilesApi.deleteOauthModelAlias(channel);
      }

      mergeSuspendedForTarget(input.apiBase, targetKey, bindings);
      result.pruned = bindings.length;
      return result;
    }

    const apiKeyTarget = input.target;
    if (apiKeyTarget.source !== 'apiKey') return result;

    const resource = input.resources.find((r) => r.id === apiKeyTarget.resourceId);
    if (!resource) return result;

    const rawModels = ((resource.raw as { models?: ModelAlias[] })?.models ??
      []) as ModelAlias[];
    const bindings = collectMappingsForTarget({
      modelAlias: {},
      resources: [resource],
      target: apiKeyTarget,
    });
    if (!bindings.length) return result;

    const { next } = pruneApiKeyModelsForModel(rawModels, apiKeyTarget.modelId);
    await updateApiKeyModels(resource, next);
    mergeSuspendedForTarget(input.apiBase, targetKey, bindings);
    result.pruned = bindings.length;
    return result;
  } catch (err) {
    result.failed = true;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    return result;
  }
}

/**
 * 启用：取出挂起映射写回配置。
 */
export async function restoreMappingsForEnabledTarget(input: {
  apiBase: string;
  target: MappingTargetRef;
  resources: ProviderResource[];
}): Promise<MappingSyncResult> {
  const result = emptyResult();
  const targetKey = accessEnabledKey(input.target);
  const suspended = takeSuspendedForTarget(input.apiBase, targetKey);
  if (!suspended.length) return result;

  const putBackAll = () => {
    mergeSuspendedForTarget(input.apiBase, targetKey, suspended);
  };

  try {
    if (input.target.source === 'oauth') {
      const { map, unsupported } = await loadOauthAliasSafe();
      if (unsupported) {
        putBackAll();
        result.skipped = suspended.length;
        return result;
      }

      const byChannel = groupSuspendedByOauthChannel(suspended);
      const workingMap: Record<string, OAuthModelAliasEntry[]> = { ...map };
      let restored = 0;
      let skipped = 0;

      for (const [channel, items] of byChannel) {
        const entries = workingMap[channel] ?? [];
        const applied = restoreOauthEntries(entries, items, channel);
        restored += applied.restored;
        skipped += applied.skipped;

        const beforeSig = JSON.stringify(entries);
        const afterSig = JSON.stringify(applied.next);
        if (beforeSig !== afterSig) {
          if (applied.next.length) {
            await authFilesApi.saveOauthModelAlias(channel, applied.next);
          } else {
            await authFilesApi.deleteOauthModelAlias(channel);
          }
          workingMap[channel] = applied.next;
        }
      }

      const stillPending = suspended.filter((item) => !oauthBindingPresent(workingMap, item));
      if (stillPending.length) {
        mergeSuspendedForTarget(input.apiBase, targetKey, stillPending);
      }

      result.restored = restored;
      result.skipped = skipped;
      return result;
    }

    const byResource = groupSuspendedByApiKeyResource(suspended);
    let restored = 0;
    let skipped = 0;
    const stillPending: SuspendedMapping[] = [];

    for (const [resourceId, group] of byResource) {
      const resource = input.resources.find((r) => r.id === resourceId) ?? null;
      if (!resource) {
        skipped += group.items.length;
        stillPending.push(...group.items);
        continue;
      }

      const rawModels = ((resource.raw as { models?: ModelAlias[] })?.models ??
        []) as ModelAlias[];
      const applied = restoreApiKeyModels(rawModels, group.items, resourceId);
      restored += applied.restored;
      skipped += applied.skipped;

      if (JSON.stringify(rawModels) !== JSON.stringify(applied.next)) {
        await updateApiKeyModels(resource, applied.next);
      }

      group.items.forEach((item) => {
        if (item.target.source !== 'apiKey') return;
        const modelKey = item.target.modelId.trim().toLowerCase();
        const model = applied.next.find(
          (m) => String(m.name ?? '').trim().toLowerCase() === modelKey
        );
        const alias = String(model?.alias ?? '').trim();
        if (!model || alias.toLowerCase() !== item.alias.trim().toLowerCase()) {
          stillPending.push(item);
        }
      });
    }

    if (stillPending.length) {
      mergeSuspendedForTarget(input.apiBase, targetKey, stillPending);
    }

    result.restored = restored;
    result.skipped = skipped;
    return result;
  } catch (err) {
    putBackAll();
    result.failed = true;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    return result;
  }
}

/** 丢弃某目标上的挂起（例如用户手动删了映射后不需要再恢复） */
export function discardSuspendedMappings(apiBase: string, target: MappingTargetRef): void {
  clearSuspendedForTarget(apiBase, accessEnabledKey(target));
}
