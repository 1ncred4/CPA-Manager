/**
 * 同名 identity 目标（alias === modelId）无法靠剪枝 alias 摘掉。
 *
 * OAuth：
 * 1. 已有用户非同名 alias → fork=false 关原名（不 excluded，不污染列表）
 * 2. 没有任何用户别名 → oauth-excluded 关路由 + localStorage 受管标记
 *    管理端显示仍为「启用」，其它渠道 picker 仍可见可选
 * 3. 启用时：fork=true / 清 exclude / 清受管标记
 *
 * API Key 无 fork：excludedModels / OpenAI catalog（显示层暂不伪装）。
 */

import { stripDisableAllModelsRule } from '@/components/providers/utils';
import {
  normalizeOAuthExcludedRules,
  updateOAuthExcludedRule,
} from '@/features/authFiles/oauthExcludedRules';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { authFilesApi } from '@/services/api';
import type { ModelAlias, OAuthModelAliasEntry, OpenAIProviderConfig } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import {
  mergeSuspendedCatalog,
  removeModelFromCatalog,
  restoreModelToCatalog,
  takeSuspendedCatalog,
} from './catalogSuspend';
import {
  markManagedOauthIdentityExclude,
  unmarkManagedOauthIdentityExclude,
} from './managedIdentityExclude';
import {
  isIdentityMappingTarget,
  isMeaningfulAlias,
  mappingTargetKey,
  type MappingTargetRef,
} from './modelMapping';
import { isManagedNativeOffAlias } from './managedNativeOffAlias';
import { toggleApiKeyExcludedList } from './modelAccessRows';
import { updateApiKeyExcludedModels } from './updateApiKeyExcludedModels';
import { updateApiKeyModels } from './updateApiKeyModels';

const lower = (value: string): string => value.trim().toLowerCase();

export type IdentityAccessSyncResult = {
  forked: number;
  /** OAuth 无别名时 excluded，或 API Key 路径 */
  excluded: number;
  included: number;
  failed: string[];
};

function identityTargets(alias: string, targets: MappingTargetRef[]): MappingTargetRef[] {
  return targets.filter((target) => isIdentityMappingTarget(alias, target));
}

export function partitionIdentityAccessTargets(input: {
  alias: string;
  selectedTargets: MappingTargetRef[];
  suspendedTargets: Array<{ target: MappingTargetRef }>;
}): {
  toEnable: MappingTargetRef[];
  toDisable: MappingTargetRef[];
} {
  const alias = input.alias.trim();
  if (!alias) return { toEnable: [], toDisable: [] };

  const selectedIdentity = identityTargets(alias, input.selectedTargets);
  const suspendedIdentity = identityTargets(
    alias,
    input.suspendedTargets.map((entry) => entry.target)
  );

  const suspendedKeys = new Set(suspendedIdentity.map(mappingTargetKey));
  const toEnable = selectedIdentity.filter((t) => !suspendedKeys.has(mappingTargetKey(t)));
  const toDisable = suspendedIdentity;

  return { toEnable, toDisable };
}

/** 用户侧非同名 alias（排除历史 cpa.off 锚点） */
export function listUserNonIdentityAliasesForModel(
  entries: OAuthModelAliasEntry[],
  modelId: string
): OAuthModelAliasEntry[] {
  const modelKey = lower(modelId);
  if (!modelKey) return [];
  return entries.filter((entry) => {
    const name = String(entry.name ?? '').trim();
    const alias = String(entry.alias ?? '').trim();
    if (!name || lower(name) !== modelKey) return false;
    if (!isMeaningfulAlias(alias, name)) return false;
    if (isManagedNativeOffAlias(alias)) return false;
    return true;
  });
}

/** @deprecated 兼容测试旧名 */
export function listNonIdentityAliasesForModel(
  entries: OAuthModelAliasEntry[],
  modelId: string
): OAuthModelAliasEntry[] {
  return listUserNonIdentityAliasesForModel(entries, modelId);
}

export function planOauthIdentityDisable(
  entries: OAuthModelAliasEntry[],
  modelId: string
): {
  next: OAuthModelAliasEntry[];
  usedFork: boolean;
  needsExclude: boolean;
  changed: boolean;
} {
  const related = listUserNonIdentityAliasesForModel(entries, modelId);
  // 顺带丢掉历史 cpa.off 锚点，避免污染
  let next = entries.filter(
    (entry) =>
      !(
        lower(String(entry.name ?? '')) === lower(modelId) &&
        isManagedNativeOffAlias(String(entry.alias ?? ''))
      )
  );
  const droppedAnchor = next.length !== entries.length;

  if (!related.length) {
    return {
      next,
      usedFork: false,
      needsExclude: true,
      changed: droppedAnchor,
    };
  }

  let changed = droppedAnchor;
  const relatedKeys = new Set(
    related.map((e) => `${lower(String(e.name))}|${lower(String(e.alias))}`)
  );
  next = next.map((entry) => {
    const key = `${lower(String(entry.name))}|${lower(String(entry.alias))}`;
    if (!relatedKeys.has(key)) return entry;
    if (entry.fork === true) {
      changed = true;
      const cloned: OAuthModelAliasEntry = { ...entry };
      delete cloned.fork;
      return cloned;
    }
    return entry;
  });

  return {
    next,
    usedFork: true,
    needsExclude: false,
    changed,
  };
}

export function planOauthIdentityEnable(
  entries: OAuthModelAliasEntry[],
  modelId: string
): {
  next: OAuthModelAliasEntry[];
  usedFork: boolean;
  clearExclude: boolean;
  changed: boolean;
} {
  const modelKey = lower(modelId);
  if (!modelKey) {
    return { next: entries, usedFork: false, clearExclude: true, changed: false };
  }

  let changed = false;
  let usedFork = false;
  const next: OAuthModelAliasEntry[] = [];

  entries.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    const alias = String(entry.alias ?? '').trim();
    if (!name) return;

    // 清理历史受管锚点
    if (lower(name) === modelKey && isManagedNativeOffAlias(alias)) {
      changed = true;
      return;
    }

    if (lower(name) === modelKey && isMeaningfulAlias(alias, name)) {
      usedFork = true;
      if (entry.fork !== true) {
        changed = true;
        next.push({ ...entry, fork: true });
        return;
      }
    }
    next.push(entry);
  });

  return { next, usedFork, clearExclude: true, changed };
}

async function loadOauthExcludedSafe(): Promise<{
  map: Record<string, string[]>;
  unsupported: boolean;
}> {
  try {
    const map = await authFilesApi.getOauthExcludedModels();
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

export async function syncIdentityAccessOnMappingSave(input: {
  apiBase: string;
  alias: string;
  selectedTargets: MappingTargetRef[];
  suspendedTargets: Array<{ target: MappingTargetRef }>;
  resources: ProviderResource[];
}): Promise<IdentityAccessSyncResult> {
  const result: IdentityAccessSyncResult = {
    forked: 0,
    excluded: 0,
    included: 0,
    failed: [],
  };
  const { toEnable, toDisable } = partitionIdentityAccessTargets({
    alias: input.alias,
    selectedTargets: input.selectedTargets,
    suspendedTargets: input.suspendedTargets,
  });
  if (!toEnable.length && !toDisable.length) return result;

  const oauthDisableByChannel = new Map<string, string[]>();
  const oauthEnableByChannel = new Map<string, string[]>();
  toDisable.forEach((target) => {
    if (target.source !== 'oauth') return;
    const channel = normalizeProviderKey(target.channel);
    if (!channel) return;
    const list = oauthDisableByChannel.get(channel) ?? [];
    if (!list.some((id) => lower(id) === lower(target.modelId))) list.push(target.modelId);
    oauthDisableByChannel.set(channel, list);
  });
  toEnable.forEach((target) => {
    if (target.source !== 'oauth') return;
    const channel = normalizeProviderKey(target.channel);
    if (!channel) return;
    const list = oauthEnableByChannel.get(channel) ?? [];
    if (!list.some((id) => lower(id) === lower(target.modelId))) list.push(target.modelId);
    oauthEnableByChannel.set(channel, list);
  });

  if (oauthDisableByChannel.size || oauthEnableByChannel.size) {
    try {
      const { map: aliasMap, unsupported: aliasUnsupported } = await loadOauthAliasSafe();
      const { map: excludedMap, unsupported: excludedUnsupported } =
        await loadOauthExcludedSafe();

      if (aliasUnsupported && excludedUnsupported) {
        result.failed.push('oauth-identity-unsupported');
      } else {
        const channels = new Set([
          ...oauthDisableByChannel.keys(),
          ...oauthEnableByChannel.keys(),
        ]);
        const workingAlias: Record<string, OAuthModelAliasEntry[]> = { ...aliasMap };
        const workingExcluded: Record<string, string[]> = { ...excludedMap };
        const aliasDirty = new Set<string>();
        const excludedDirty = new Set<string>();

        for (const channel of channels) {
          let entries = [...(workingAlias[channel] ?? [])];
          let rules = normalizeOAuthExcludedRules(workingExcluded[channel] ?? []);

          for (const modelId of oauthDisableByChannel.get(channel) ?? []) {
            if (!aliasUnsupported) {
              const plan = planOauthIdentityDisable(entries, modelId);
              if (plan.changed) {
                entries = plan.next;
                aliasDirty.add(channel);
              }
              if (plan.usedFork) {
                result.forked += 1;
                // fork 路径：确保不残留 excluded + 清受管标记
                unmarkManagedOauthIdentityExclude(input.apiBase, channel, modelId);
                if (!excludedUnsupported) {
                  const before = rules.length;
                  rules = updateOAuthExcludedRule(rules, modelId, false);
                  if (rules.length < before) excludedDirty.add(channel);
                }
                continue;
              }
            }

            // 无用户别名：excluded 关路由 + 受管标记（UI 仍显示启用）
            if (excludedUnsupported) {
              result.failed.push(`oauth-no-fork-or-exclude:${channel}:${modelId}`);
              continue;
            }
            rules = updateOAuthExcludedRule(rules, modelId, true);
            excludedDirty.add(channel);
            markManagedOauthIdentityExclude(input.apiBase, channel, modelId);
            result.excluded += 1;
          }

          for (const modelId of oauthEnableByChannel.get(channel) ?? []) {
            let handled = false;
            if (!aliasUnsupported) {
              const plan = planOauthIdentityEnable(entries, modelId);
              if (plan.changed) {
                entries = plan.next;
                aliasDirty.add(channel);
              }
              if (plan.usedFork || plan.changed) handled = true;
            }
            if (!excludedUnsupported) {
              const before = rules.length;
              rules = updateOAuthExcludedRule(rules, modelId, false);
              if (rules.length < before) {
                excludedDirty.add(channel);
                handled = true;
              }
            }
            unmarkManagedOauthIdentityExclude(input.apiBase, channel, modelId);
            if (handled) result.included += 1;
          }

          workingAlias[channel] = entries;
          workingExcluded[channel] = rules;
        }

        if (!aliasUnsupported) {
          for (const channel of aliasDirty) {
            const entries = workingAlias[channel] ?? [];
            if (entries.length) {
              await authFilesApi.saveOauthModelAlias(channel, entries);
            } else {
              await authFilesApi.deleteOauthModelAlias(channel);
            }
          }
        }

        if (!excludedUnsupported) {
          for (const channel of excludedDirty) {
            const rules = normalizeOAuthExcludedRules(workingExcluded[channel] ?? []);
            if (rules.length) {
              await authFilesApi.saveOauthExcludedModels(channel, rules);
            } else {
              await authFilesApi.deleteOauthExcludedEntry(channel);
            }
          }
        }
      }
    } catch (err) {
      result.failed.push(err instanceof Error ? err.message : String(err));
    }
  }

  // --- API Key ---
  const apiDisableByResource = new Map<string, string[]>();
  const apiEnableByResource = new Map<string, string[]>();
  toDisable.forEach((target) => {
    if (target.source !== 'apiKey') return;
    const list = apiDisableByResource.get(target.resourceId) ?? [];
    if (!list.some((id) => lower(id) === lower(target.modelId))) list.push(target.modelId);
    apiDisableByResource.set(target.resourceId, list);
  });
  toEnable.forEach((target) => {
    if (target.source !== 'apiKey') return;
    const list = apiEnableByResource.get(target.resourceId) ?? [];
    if (!list.some((id) => lower(id) === lower(target.modelId))) list.push(target.modelId);
    apiEnableByResource.set(target.resourceId, list);
  });

  const resourceIds = new Set([
    ...apiDisableByResource.keys(),
    ...apiEnableByResource.keys(),
  ]);

  for (const resourceId of resourceIds) {
    const resource = input.resources.find((r) => r.id === resourceId);
    if (!resource) {
      result.failed.push(`resource-missing:${resourceId}`);
      continue;
    }

    try {
      if (resource.brand === 'openaiCompatibility') {
        const cfg = resource.raw as OpenAIProviderConfig;
        let models = [...((cfg.models ?? []) as ModelAlias[])];
        const disableIds = apiDisableByResource.get(resourceId) ?? [];
        const enableIds = apiEnableByResource.get(resourceId) ?? [];

        for (const modelId of disableIds) {
          const { next, removed } = removeModelFromCatalog(models, modelId);
          const entries =
            removed.length > 0 ? removed : ([{ name: modelId }] as ModelAlias[]);
          mergeSuspendedCatalog(input.apiBase, resourceId, modelId, entries);
          models = next;
          result.excluded += 1;
        }
        for (const modelId of enableIds) {
          const suspended = takeSuspendedCatalog(input.apiBase, resourceId, modelId);
          const toRestore = suspended?.entries?.length
            ? suspended.entries
            : ([{ name: modelId }] as ModelAlias[]);
          const restored = restoreModelToCatalog(models, toRestore);
          models = restored.next;
          result.included += 1;
        }
        await updateApiKeyModels(resource, models);
        continue;
      }

      const raw = resource.raw as { excludedModels?: string[] };
      let list = stripDisableAllModelsRule(raw.excludedModels);
      const disableIds = apiDisableByResource.get(resourceId) ?? [];
      const enableIds = apiEnableByResource.get(resourceId) ?? [];

      disableIds.forEach((modelId) => {
        list = toggleApiKeyExcludedList(list, modelId, true);
        result.excluded += 1;
      });
      enableIds.forEach((modelId) => {
        const next = toggleApiKeyExcludedList(list, modelId, false);
        if (next.length !== list.length) result.included += 1;
        list = next;
      });
      await updateApiKeyExcludedModels(resource, list);
    } catch (err) {
      result.failed.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
