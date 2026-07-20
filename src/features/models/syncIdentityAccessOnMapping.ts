/**
 * 同名 identity 目标（alias === modelId）无法靠剪枝 alias 摘掉：
 * 客户端按模型原名就会命中原生路由。
 *
 * OAuth 优先用 fork=false「关闭原名入口」，模型仍可通过其它 alias 使用，
 * 其它手动渠道也能继续映射该模型。
 * 仅当该源模型没有任何非同名 alias 映射时，才回退到 excluded-models
 * （此时会全局不可用——是 identity 无 fork 可挂时的最后手段）。
 *
 * API Key 无 fork 字段：仍用 excludedModels / OpenAI catalog suspend。
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
  isIdentityMappingTarget,
  isMeaningfulAlias,
  mappingTargetKey,
  type MappingTargetRef,
} from './modelMapping';
import { toggleApiKeyExcludedList } from './modelAccessRows';
import { updateApiKeyExcludedModels } from './updateApiKeyExcludedModels';
import { updateApiKeyModels } from './updateApiKeyModels';

const lower = (value: string): string => value.trim().toLowerCase();

export type IdentityAccessSyncResult = {
  /** OAuth: 通过 fork=false 关闭了原名 */
  forked: number;
  /** 回退到 excluded / catalog 的数量（全局不可用） */
  excluded: number;
  /** 重新开放原名 / 去掉排除 */
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

/** 源模型上的非同名 alias 条目（fork 可作用的对象） */
export function listNonIdentityAliasesForModel(
  entries: OAuthModelAliasEntry[],
  modelId: string
): OAuthModelAliasEntry[] {
  const modelKey = lower(modelId);
  if (!modelKey) return [];
  return entries.filter((entry) => {
    const name = String(entry.name ?? '').trim();
    const alias = String(entry.alias ?? '').trim();
    if (!name || lower(name) !== modelKey) return false;
    return isMeaningfulAlias(alias, name);
  });
}

/**
 * 禁用原名：有非同名 alias → 全部 fork=false；否则标记需要 excluded。
 * 纯函数，便于测试。
 */
export function planOauthIdentityDisable(
  entries: OAuthModelAliasEntry[],
  modelId: string
): {
  next: OAuthModelAliasEntry[];
  usedFork: boolean;
  needsExclude: boolean;
  changed: boolean;
} {
  const related = listNonIdentityAliasesForModel(entries, modelId);
  if (!related.length) {
    return { next: entries, usedFork: false, needsExclude: true, changed: false };
  }

  let changed = false;
  const relatedKeys = new Set(
    related.map((e) => `${lower(String(e.name))}|${lower(String(e.alias))}`)
  );
  const next = entries.map((entry) => {
    const key = `${lower(String(entry.name))}|${lower(String(entry.alias))}`;
    if (!relatedKeys.has(key)) return entry;
    if (entry.fork === true) {
      changed = true;
      const cloned: OAuthModelAliasEntry = { ...entry };
      delete cloned.fork;
      return cloned;
    }
    // already fork off
    return entry;
  });

  return {
    next,
    usedFork: true,
    needsExclude: false,
    // even if already fork-off, we "used fork" successfully (no exclude needed)
    changed,
  };
}

/**
 * 启用原名：有非同名 alias → fork=true；并说明应去掉 excluded。
 */
export function planOauthIdentityEnable(
  entries: OAuthModelAliasEntry[],
  modelId: string
): {
  next: OAuthModelAliasEntry[];
  usedFork: boolean;
  clearExclude: boolean;
  changed: boolean;
} {
  const related = listNonIdentityAliasesForModel(entries, modelId);
  let changed = false;
  if (!related.length) {
    return { next: entries, usedFork: false, clearExclude: true, changed: false };
  }

  const relatedKeys = new Set(
    related.map((e) => `${lower(String(e.name))}|${lower(String(e.alias))}`)
  );
  const next = entries.map((entry) => {
    const key = `${lower(String(entry.name))}|${lower(String(entry.alias))}`;
    if (!relatedKeys.has(key)) return entry;
    if (entry.fork !== true) {
      changed = true;
      return { ...entry, fork: true };
    }
    return entry;
  });

  return { next, usedFork: true, clearExclude: true, changed };
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

/**
 * 同步同名 identity 目标的「原名可达性」。
 * OAuth: fork 优先；API Key: excluded/catalog。
 */
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

  // --- OAuth: fork first, exclude only as fallback ---
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

          // Disable identity originals
          for (const modelId of oauthDisableByChannel.get(channel) ?? []) {
            if (!aliasUnsupported) {
              const plan = planOauthIdentityDisable(entries, modelId);
              if (plan.usedFork) {
                if (plan.changed) {
                  entries = plan.next;
                  aliasDirty.add(channel);
                }
                result.forked += 1;
                // 若此前被 excluded，改用 fork 后应清掉精确排除，避免模型完全不可映射
                if (!excludedUnsupported) {
                  const before = rules.length;
                  rules = updateOAuthExcludedRule(rules, modelId, false);
                  if (rules.length < before) excludedDirty.add(channel);
                }
                continue;
              }
            }

            // Fallback: excluded (global — last resort when no non-identity alias exists)
            if (excludedUnsupported) {
              result.failed.push(`oauth-no-fork-or-exclude:${channel}:${modelId}`);
              continue;
            }
            rules = updateOAuthExcludedRule(rules, modelId, true);
            excludedDirty.add(channel);
            result.excluded += 1;
          }

          // Enable identity originals: fork=true + clear exact exclude
          for (const modelId of oauthEnableByChannel.get(channel) ?? []) {
            let handled = false;
            if (!aliasUnsupported) {
              const plan = planOauthIdentityEnable(entries, modelId);
              if (plan.changed) {
                entries = plan.next;
                aliasDirty.add(channel);
              }
              if (plan.usedFork) handled = true;
            }
            if (!excludedUnsupported) {
              const before = rules.length;
              rules = updateOAuthExcludedRule(rules, modelId, false);
              if (rules.length < before) {
                excludedDirty.add(channel);
                handled = true;
              }
            }
            if (handled) result.included += 1;
          }

          workingAlias[channel] = entries;
          workingExcluded[channel] = rules;
        }

        // Persist alias map
        for (const channel of aliasDirty) {
          const entries = workingAlias[channel] ?? [];
          if (entries.length) {
            await authFilesApi.saveOauthModelAlias(channel, entries);
          } else {
            await authFilesApi.deleteOauthModelAlias(channel);
          }
        }

        // Persist excluded map
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

  // --- API Key: no fork — excluded / catalog only ---
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
