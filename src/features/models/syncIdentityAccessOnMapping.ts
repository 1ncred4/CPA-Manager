/**
 * 渠道内禁用映射目标时，同步隐藏「原名」入口，避免剪枝 alias 后原名重新出现在模型列表。
 *
 * 同名 identity（alias === modelId）无法靠剪枝 alias 摘掉；
 * 跨名目标剪枝 alias 后若无其它别名，原名同样会回到网关列表--两边都要处理。
 *
 * OAuth：
 * 1. 已有用户非同名 alias -> fork=false 关原名（不 excluded，不污染列表）
 * 2. 没有任何用户别名 -> oauth-excluded 关路由 + localStorage 受管标记
 *    管理端显示仍为「启用」，其它渠道 picker 仍可见可选
 * 3. 同名目标重新启用：fork=true / 清 exclude / 清受管标记
 * 4. 跨名目标重新启用：只清 exclude / 受管标记（alias 由映射保存写回，保持 fork 关）
 *
 * API Key 无 fork：excludedModels / OpenAI catalog + 受管标记（UI 仍显示启用）。
 *
 * Phase 6：impure 入口 syncIdentityAccessOnMappingSave 已移除（逻辑迁入 modelOpsIdentity
 * 的 planIdentityAccessSync，由 modelOpApplier 执行）。本文件仅保留纯 helper。
 */

import type { OAuthModelAliasEntry } from '@/types';
import {
  isIdentityMappingTarget,
  isMeaningfulAlias,
  mappingTargetKey,
  type MappingTargetRef,
} from './modelMapping';
import { isManagedNativeOffAlias } from './managedNativeOffAlias';

const lower = (value: string): string => value.trim().toLowerCase();

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
   * 跨名目标重新勾选不在此列--原名应继续隐藏（仅靠自定义 alias 暴露）。
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
