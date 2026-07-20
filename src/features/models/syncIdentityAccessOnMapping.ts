/**
 * 渠道内禁用映射目标时，同步隐藏「原名」入口，避免剪枝 alias 后原名重新出现在模型列表。
 *
 * 同名 identity（alias === modelId）无法靠剪枝 alias 摘掉；
 * 跨名目标剪枝 alias 后若无其它别名，原名同样会回到网关列表——两边都要处理。
 *
 * OAuth：
 * 1. 已有用户非同名 alias → fork=false 关原名（不 excluded，不污染列表）
 * 2. 没有任何用户别名 → oauth-excluded 关路由 + localStorage 受管标记
 *    管理端显示仍为「启用」，其它渠道 picker 仍可见可选
 * 3. 同名目标重新启用：fork=true / 清 exclude / 清受管标记
 * 4. 跨名目标重新启用：只清 exclude / 受管标记（alias 由映射保存写回，保持 fork 关）
 *
 * API Key 无 fork：excludedModels / OpenAI catalog + 受管标记（UI 仍显示启用）。
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
  listManagedIdentityExcludeKeys,
  managedOauthExcludeKey,
  markManagedApiKeyIdentityExclude,
  markManagedOauthIdentityExclude,
  unmarkManagedApiKeyIdentityExclude,
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
  /**
   * 本 alias 上一轮曾持有、现已彻底移除的目标（永久 × / 删除整个渠道）。
   * 渠道内禁用写过的受管 exclude 必须清掉，否则原名永久消失。
   */
  abandonedTargets?: MappingTargetRef[];
}): {
  /**
   * 同名 identity 重新勾选/被彻底移除后恢复：fork=true 开原名。
   * 跨名目标重新勾选不在此列——原名应继续隐藏（仅靠自定义 alias 暴露）。
   */
  toEnable: MappingTargetRef[];
  /**
   * 渠道内禁用的全部目标（含跨名）：隐藏原名。
   * 跨名剪枝 alias 后若只靠挂起灰标，原名会回到自动/网关列表。
   */
  toDisable: MappingTargetRef[];
  /**
   * 活跃选中的跨名目标 + 已彻底移除的目标：清掉渠道禁用时写入的受管 exclude。
   * 不强制 fork=true（新建映射默认 fork 关）。
   */
  toClearExclude: MappingTargetRef[];
} {
  const alias = input.alias.trim();
  if (!alias) return { toEnable: [], toDisable: [], toClearExclude: [] };

  const suspendedAll = input.suspendedTargets
    .map((entry) => entry.target)
    .filter((target) => Boolean(target?.modelId?.trim()));
  const suspendedKeys = new Set(suspendedAll.map(mappingTargetKey));

  const activeSelected = input.selectedTargets.filter(
    (target) => !suspendedKeys.has(mappingTargetKey(target))
  );
  const selectedIdentity = identityTargets(alias, activeSelected);
  const selectedIdentityKeys = new Set(selectedIdentity.map(mappingTargetKey));
  const activeCrossName = activeSelected.filter(
    (target) => !selectedIdentityKeys.has(mappingTargetKey(target))
  );

  const claimedKeys = new Set([
    ...activeSelected.map(mappingTargetKey),
    ...suspendedAll.map(mappingTargetKey),
  ]);
  const abandoned = (input.abandonedTargets ?? []).filter((target) => {
    if (!target?.modelId?.trim()) return false;
    return !claimedKeys.has(mappingTargetKey(target));
  });
  const abandonedIdentity = identityTargets(alias, abandoned);
  const abandonedIdentityKeys = new Set(abandonedIdentity.map(mappingTargetKey));
  const abandonedCrossName = abandoned.filter(
    (target) => !abandonedIdentityKeys.has(mappingTargetKey(target))
  );

  // 去重合并
  const mergeUnique = (list: MappingTargetRef[]): MappingTargetRef[] => {
    const seen = new Set<string>();
    const out: MappingTargetRef[] = [];
    list.forEach((target) => {
      const key = mappingTargetKey(target);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(target);
    });
    return out;
  };

  return {
    toEnable: mergeUnique([...selectedIdentity, ...abandonedIdentity]),
    toDisable: suspendedAll,
    toClearExclude: mergeUnique([...activeCrossName, ...abandonedCrossName, ...abandonedIdentity]),
  };
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
  /** 上一轮目标中现已彻底移除的项（见 partitionIdentityAccessTargets） */
  abandonedTargets?: MappingTargetRef[];
}): Promise<IdentityAccessSyncResult> {
  const result: IdentityAccessSyncResult = {
    forked: 0,
    excluded: 0,
    included: 0,
    failed: [],
  };
  const { toEnable, toDisable, toClearExclude } = partitionIdentityAccessTargets({
    alias: input.alias,
    selectedTargets: input.selectedTargets,
    suspendedTargets: input.suspendedTargets,
    abandonedTargets: input.abandonedTargets,
  });
  if (!toEnable.length && !toDisable.length && !toClearExclude.length) return result;

  const oauthDisableByChannel = new Map<string, string[]>();
  const oauthEnableByChannel = new Map<string, string[]>();
  const oauthClearExcludeByChannel = new Map<string, string[]>();
  const pushModelId = (map: Map<string, string[]>, key: string, modelId: string) => {
    const list = map.get(key) ?? [];
    if (!list.some((id) => lower(id) === lower(modelId))) list.push(modelId);
    map.set(key, list);
  };
  toDisable.forEach((target) => {
    if (target.source !== 'oauth') return;
    const channel = normalizeProviderKey(target.channel);
    if (!channel) return;
    pushModelId(oauthDisableByChannel, channel, target.modelId);
  });
  toEnable.forEach((target) => {
    if (target.source !== 'oauth') return;
    const channel = normalizeProviderKey(target.channel);
    if (!channel) return;
    pushModelId(oauthEnableByChannel, channel, target.modelId);
  });
  toClearExclude.forEach((target) => {
    if (target.source !== 'oauth') return;
    const channel = normalizeProviderKey(target.channel);
    if (!channel) return;
    pushModelId(oauthClearExcludeByChannel, channel, target.modelId);
  });

  if (
    oauthDisableByChannel.size ||
    oauthEnableByChannel.size ||
    oauthClearExcludeByChannel.size
  ) {
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
          ...oauthClearExcludeByChannel.keys(),
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

            // 无用户别名（含跨名剪枝后仅挂起）：excluded 关路由 + 受管标记（UI 仍显示启用）
            if (excludedUnsupported) {
              result.failed.push(`oauth-no-fork-or-exclude:${channel}:${modelId}`);
              continue;
            }
            rules = updateOAuthExcludedRule(rules, modelId, true);
            excludedDirty.add(channel);
            markManagedOauthIdentityExclude(input.apiBase, channel, modelId);
            result.excluded += 1;
          }

          // 同名目标重新启用：fork=true + 清 exclude
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

          // 跨名目标重新启用：只清受管 exclude，不强制 fork=true
          for (const modelId of oauthClearExcludeByChannel.get(channel) ?? []) {
            // 若同批 identity enable 已处理过，跳过
            if (
              (oauthEnableByChannel.get(channel) ?? []).some(
                (id) => lower(id) === lower(modelId)
              )
            ) {
              continue;
            }
            let handled = false;
            if (!excludedUnsupported) {
              const before = rules.length;
              rules = updateOAuthExcludedRule(rules, modelId, false);
              if (rules.length < before) {
                excludedDirty.add(channel);
                handled = true;
              }
            }
            const wasManaged = listManagedIdentityExcludeKeys(input.apiBase).has(
              managedOauthExcludeKey(channel, modelId)
            );
            unmarkManagedOauthIdentityExclude(input.apiBase, channel, modelId);
            if (handled || wasManaged) result.included += 1;
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
  // 渠道内禁用：写 excluded / catalog 挂起，避免原名继续出现在模型列表。
  // 重新启用：
  //   - 同名 identity：恢复 catalog / 清 exclude
  //   - 跨名：同样清 exclude（映射 alias 由保存路径写回）
  const apiDisableByResource = new Map<string, string[]>();
  const apiEnableByResource = new Map<string, string[]>();
  toDisable.forEach((target) => {
    if (target.source !== 'apiKey') return;
    pushModelId(apiDisableByResource, target.resourceId, target.modelId);
  });
  // API Key 无 fork：同名/跨名重新启用都需要从 excluded/catalog 恢复
  [...toEnable, ...toClearExclude].forEach((target) => {
    if (target.source !== 'apiKey') return;
    pushModelId(apiEnableByResource, target.resourceId, target.modelId);
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
          // UI 仍显示启用；映射编辑 picker 仍可选
          markManagedApiKeyIdentityExclude(input.apiBase, resourceId, modelId);
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
          unmarkManagedApiKeyIdentityExclude(input.apiBase, resourceId, modelId);
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
        markManagedApiKeyIdentityExclude(input.apiBase, resourceId, modelId);
        result.excluded += 1;
      });
      enableIds.forEach((modelId) => {
        const next = toggleApiKeyExcludedList(list, modelId, false);
        if (next.length !== list.length) result.included += 1;
        list = next;
        unmarkManagedApiKeyIdentityExclude(input.apiBase, resourceId, modelId);
      });
      await updateApiKeyExcludedModels(resource, list);
    } catch (err) {
      result.failed.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
