/**
 * 计算模块（纯函数）：基于 ModelManagementState diff 出后端修改步骤。
 *
 * 设计：
 * - 无 React、无 localStorage、无 API。所有副作用编码为 ModelOp，由 modelOpApplier 执行。
 * - 每个 op 自带 phase + queueKey：同 queueKey（channel / resourceId）串行，不同 key 并发；
 *   phase 控制同 key 内顺序：before-backend（同步 localStorage）→ backend（await API）→ after-backend（同步 localStorage）。
 * - 暂停数据（suspend merge/take）的 payload 一律在 plan 时从 baseline 计算好，写入时机由 phase 决定：
 *   - 禁用：mappingSuspendMerge/catalogSuspendMerge = before-backend（先于剪枝 PUT 捕获绑定，
 *     否则剪枝成功但后续 op 失败时绑定丢失）。
 *   - 启用：mappingSuspendTake/catalogSuspendTake = after-backend（仅当恢复 PUT 成功才清 localStorage，
 *     否则恢复失败时 localStorage 被清空→绑定永久丢失）。
 * - managedExcludeUnmark（用户主动 toggle）= before-backend，匹配现有 useModelAccessList L467。
 *
 * 复用既有纯函数（不重写）：collectMappingsForTarget / prune* / restore* / updateOAuthExcludedRule /
 * toggleApiKeyExcludedList / removeModelFromCatalog / restoreModelToCatalog / diffMappingTargets /
 * planAliasTargetAssignments / applyOauthAliasTargetChanges / applyApiKeyModelAliasChanges /
 * partitionIdentityAccessTargets / planOauthIdentityDisable / planOauthIdentityEnable。
 */

import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { stripDisableAllModelsRule } from '@/components/providers/utils';
import {
  normalizeOAuthExcludedRules,
  updateOAuthExcludedRule,
} from '@/features/authFiles/oauthExcludedRules';
import { toggleApiKeyExcludedList } from './modelAccessRows';
import {
  accessEnabledKey,
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  collectConfiguredApiKeyResourceIdsForAlias,
  collectConfiguredOauthChannelsForAlias,
  filterPersistableMappingTargets,
  mappingTargetKey,
  planAliasTargetAssignments,
  toAliasKey,
  type MappingTargetRef,
} from './modelMapping';
import {
  collectMappingsForTarget,
  pruneApiKeyModelsForModel,
  pruneOauthEntriesForModel,
  restoreApiKeyModels,
  restoreOauthEntries,
  type SuspendedMapping,
} from './mappingSuspend';
import { removeModelFromCatalog, restoreModelToCatalog } from './catalogSuspend';
import { collectSuspendedBindingsForTarget, type ModelManagementState } from './modelManagementState';
import { planIdentityAccessSync } from './modelOpsIdentity';
import {
  partitionIdentityAccessTargets,
  planOauthIdentityDisable,
  planOauthIdentityEnable,
} from './syncIdentityAccessOnMapping';

const lower = (value: string): string => value.trim().toLowerCase();

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models;
}

// ---------------------------------------------------------------------------
// Op 判别联合
// ---------------------------------------------------------------------------

export type ModelOpPhase = 'before-backend' | 'backend' | 'after-backend';

export type ModelOp =
  | {
      kind: 'oauthAliasPatch';
      phase: ModelOpPhase;
      queueKey: string;
      channel: string;
      entries: OAuthModelAliasEntry[];
    }
  | {
      kind: 'oauthExcludedPatch';
      phase: ModelOpPhase;
      queueKey: string;
      channel: string;
      models: string[];
    }
  | {
      kind: 'apiKeyModelsPut';
      phase: ModelOpPhase;
      queueKey: string;
      resourceId: string;
      brand: ProviderBrand;
      models: ModelAlias[];
    }
  | {
      kind: 'apiKeyExcludedPatch';
      phase: ModelOpPhase;
      queueKey: string;
      resourceId: string;
      brand: ProviderBrand;
      modelsWithoutStar: string[];
    }
  | {
      kind: 'mappingSuspendMerge';
      phase: ModelOpPhase;
      queueKey: string;
      targetKey: string;
      entries: SuspendedMapping[];
    }
  | { kind: 'mappingSuspendTake'; phase: ModelOpPhase; queueKey: string; targetKey: string }
  | { kind: 'mappingSuspendClearAlias'; phase: ModelOpPhase; queueKey: string; aliasKey: string }
  | {
      kind: 'catalogSuspendMerge';
      phase: ModelOpPhase;
      queueKey: string;
      resourceId: string;
      modelId: string;
      entries: ModelAlias[];
    }
  | {
      kind: 'catalogSuspendTake';
      phase: ModelOpPhase;
      queueKey: string;
      resourceId: string;
      modelId: string;
    }
  | { kind: 'managedExcludeMark'; phase: ModelOpPhase; queueKey: string; key: string }
  | { kind: 'managedExcludeUnmark'; phase: ModelOpPhase; queueKey: string; key: string }
  | { kind: 'mappingClaim'; phase: ModelOpPhase; queueKey: string; aliasKey: string }
  | { kind: 'mappingUnclaim'; phase: ModelOpPhase; queueKey: string; aliasKey: string };

// ---------------------------------------------------------------------------
// 子规划器 1：模型禁用 toggle（即时）
// ---------------------------------------------------------------------------

export type PlanAccessToggleInput = {
  state: ModelManagementState;
  ref: MappingTargetRef;
  nextEnabled: boolean;
};

export function planAccessToggle(input: PlanAccessToggleInput): ModelOp[] {
  const { state, ref, nextEnabled } = input;
  const wantExclude = !nextEnabled;
  const targetKey = accessEnabledKey(ref);
  const ops: ModelOp[] = [];
  const push = (op: ModelOp) => ops.push(op);

  if (ref.source === 'oauth') {
    planOauthAccessToggle(state, ref, targetKey, wantExclude, push);
    return ops;
  }

  const resource = state.catalogs.resources.find((r) => r.id === ref.resourceId);
  if (!resource) return ops;

  if (resource.brand === 'openaiCompatibility') {
    planOpenAiCatalogToggle(state, resource, ref, targetKey, wantExclude, push);
  } else {
    planApiKeyExcludedToggle(state, resource, ref, targetKey, wantExclude, push);
  }
  return ops;
}

function planOauthAccessToggle(
  state: ModelManagementState,
  ref: Extract<MappingTargetRef, { source: 'oauth' }>,
  targetKey: string,
  wantExclude: boolean,
  push: (op: ModelOp) => void
): void {
  const channel = normalizeProviderKey(ref.channel);
  const queueKey = channel;
  if (state.managedExcludeKeys.has(targetKey)) {
    push({ kind: 'managedExcludeUnmark', phase: 'before-backend', queueKey, key: targetKey });
  }
  const entries = state.oauthAliasMap[channel] ?? [];
  const currentRules = normalizeOAuthExcludedRules(state.oauthExcludedMap[channel] ?? []);

  if (wantExclude) {
    const bindings = collectMappingsForTarget({
      modelAlias: { [channel]: entries },
      resources: [],
      target: ref,
    });
    if (bindings.length) {
      push({
        kind: 'mappingSuspendMerge',
        phase: 'before-backend',
        queueKey,
        targetKey,
        entries: bindings,
      });
      const { next } = pruneOauthEntriesForModel(entries, ref.modelId);
      push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey, channel, entries: next });
    }
    const nextRules = updateOAuthExcludedRule(currentRules, ref.modelId, true);
    push({ kind: 'oauthExcludedPatch', phase: 'backend', queueKey, channel, models: nextRules });
    return;
  }

  // 启用：清 exclude，再恢复 alias（恢复数据 take 落 after-backend）
  const suspended = collectSuspendedBindingsForTarget(state.mapping, targetKey);
  const nextRules = updateOAuthExcludedRule(currentRules, ref.modelId, false);
  push({ kind: 'oauthExcludedPatch', phase: 'backend', queueKey, channel, models: nextRules });
  if (suspended.length) {
    const { next } = restoreOauthEntries(entries, suspended, channel);
    push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey, channel, entries: next });
    push({ kind: 'mappingSuspendTake', phase: 'after-backend', queueKey, targetKey });
  }
}

function planApiKeyExcludedToggle(
  state: ModelManagementState,
  resource: ProviderResource,
  ref: Extract<MappingTargetRef, { source: 'apiKey' }>,
  targetKey: string,
  wantExclude: boolean,
  push: (op: ModelOp) => void
): void {
  const queueKey = resource.id;
  const models = readApiKeyModels(resource);
  const raw = resource.raw as { excludedModels?: string[] };
  const baseList = stripDisableAllModelsRule(
    Array.isArray(raw.excludedModels) ? raw.excludedModels : []
  );

  if (wantExclude) {
    // 先剪枝 alias（before-backend 捕获绑定），再写 exclude（plan 规则 #2）
    const bindings = collectMappingsForTarget({
      modelAlias: {},
      resources: [resource],
      target: ref,
    });
    if (bindings.length) {
      push({
        kind: 'mappingSuspendMerge',
        phase: 'before-backend',
        queueKey,
        targetKey,
        entries: bindings,
      });
      const { next } = pruneApiKeyModelsForModel(models, ref.modelId);
      push({
        kind: 'apiKeyModelsPut',
        phase: 'backend',
        queueKey,
        resourceId: resource.id,
        brand: resource.brand,
        models: next,
      });
    }
    const nextList = toggleApiKeyExcludedList(baseList, ref.modelId, true);
    push({
      kind: 'apiKeyExcludedPatch',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      modelsWithoutStar: nextList,
    });
    return;
  }

  // 启用：清 exclude，再恢复 alias
  const suspended = collectSuspendedBindingsForTarget(state.mapping, targetKey);
  const nextList = toggleApiKeyExcludedList(baseList, ref.modelId, false);
  push({
    kind: 'apiKeyExcludedPatch',
    phase: 'backend',
    queueKey,
    resourceId: resource.id,
    brand: resource.brand,
    modelsWithoutStar: nextList,
  });
  if (suspended.length) {
    const { next } = restoreApiKeyModels(models, suspended, resource.id);
    push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: next,
    });
    push({ kind: 'mappingSuspendTake', phase: 'after-backend', queueKey, targetKey });
  }
}

function planOpenAiCatalogToggle(
  state: ModelManagementState,
  resource: ProviderResource,
  ref: Extract<MappingTargetRef, { source: 'apiKey' }>,
  targetKey: string,
  wantExclude: boolean,
  push: (op: ModelOp) => void
): void {
  const queueKey = resource.id;
  const models = readApiKeyModels(resource);

  if (wantExclude) {
    // 先捕获映射绑定（before-backend），再把「剪枝别名 + 摘除条目」合并为一次 models PUT
    const bindings = collectMappingsForTarget({
      modelAlias: {},
      resources: [resource],
      target: ref,
    });
    if (bindings.length) {
      push({
        kind: 'mappingSuspendMerge',
        phase: 'before-backend',
        queueKey,
        targetKey,
        entries: bindings,
      });
    }
    const { next: pruned } = pruneApiKeyModelsForModel(models, ref.modelId);
    const { next: finalModels, removed } = removeModelFromCatalog(pruned, ref.modelId);
    const bareEntry = removed.length > 0 ? removed : ([{ name: ref.modelId }] as ModelAlias[]);
    push({
      kind: 'catalogSuspendMerge',
      phase: 'before-backend',
      queueKey,
      resourceId: resource.id,
      modelId: ref.modelId,
      entries: bareEntry,
    });
    push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: finalModels,
    });
    return;
  }

  // 启用：合并「恢复条目 + 恢复别名」为一次 models PUT；take 落 after-backend
  const suspended = collectSuspendedBindingsForTarget(state.mapping, targetKey);
  const catalogEntries = state.access.byKey.get(targetKey)?.suspendedCatalogEntries;
  const toRestore =
    catalogEntries && catalogEntries.length
      ? catalogEntries
      : ([{ name: ref.modelId }] as ModelAlias[]);
  const { next: withEntry } = restoreModelToCatalog(models, toRestore);
  const { next: finalModels } = restoreApiKeyModels(withEntry, suspended, resource.id);
  push({
    kind: 'apiKeyModelsPut',
    phase: 'backend',
    queueKey,
    resourceId: resource.id,
    brand: resource.brand,
    models: finalModels,
  });
  push({
    kind: 'catalogSuspendTake',
    phase: 'after-backend',
    queueKey,
    resourceId: resource.id,
    modelId: ref.modelId,
  });
  if (suspended.length) {
    push({ kind: 'mappingSuspendTake', phase: 'after-backend', queueKey, targetKey });
  }
}

// ---------------------------------------------------------------------------
// 子规划器 2/3/4：alias save / alias delete / provider 表单 deltas
// （Phase 3-5 接线时实现；此处占位以保证 Phase 1 类型完整、可编译）
// ---------------------------------------------------------------------------

export type AliasDraft = {
  /** 最终写入的 alias（aliasLiteral || baselineAlias） */
  alias: string;
  /** toAliasKey(baselineAlias || aliasLiteral)；用于查找后端已配置的 channel/resource */
  previousAliasKey: string | null;
  /** 编辑前的旧 alias 字面量；创建时为 '' */
  baselineAlias: string;
  isEditing: boolean;
  selectedTargets: MappingTargetRef[];
  /** 本地挂起目标（含 fork/forceMapping，保存时按 finalAlias 重写 alias 字段） */
  suspendedTargets: SuspendedMapping[];
};

export type PlanAliasSaveResult = {
  ops: ModelOp[];
  /** identity-access 同步中走 fork 路径的原名数（仅 OAuth） */
  forked: number;
  /** identity-access 同步中走 excluded/catalog 路径的原名数 */
  excluded: number;
};

function groupOauthByChannel(targets: MappingTargetRef[]): Map<string, string[]> {
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
}

function groupApiKeyByResource(targets: MappingTargetRef[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  targets.forEach((t) => {
    if (t.source !== 'apiKey') return;
    const list = map.get(t.resourceId) ?? [];
    if (!list.some((id) => lower(id) === lower(t.modelId))) list.push(t.modelId);
    map.set(t.resourceId, list);
  });
  return map;
}

/**
 * 子规划器 2：保存映射草稿。
 *
 * 关键不变量（计划最高风险点 #3）：每个 oauth channel / apiKey resource 的「清旧 + 写新 + identity 同步」
 * 必须合并为一次 oauthAliasPatch / apiKeyModelsPut，绝不能拆成两次（中间空状态会触发后端 DELETE）。
 * 做法：先在内存 working 数组上应用 main-save（清旧+写新），再在其上应用 identity-access（fork/exclude/catalog），
 * 最后只发一次合并后的 patch。identity 未触及的 channel/resource 才单独发 main-save patch。
 *
 * phase 语义与 planAccessToggle 一致；forked/excluded 在 plan 时确定（页面保证 oauth 已支持，不走 unsupported 分支）。
 */
export function planAliasSave(input: {
  state: ModelManagementState;
  draft: AliasDraft;
}): PlanAliasSaveResult {
  const { state, draft } = input;
  const ops: ModelOp[] = [];
  const push = (op: ModelOp) => ops.push(op);
  let forked = 0;
  let excluded = 0;

  const finalAlias = draft.alias.trim();
  const prevAliasKey = draft.previousAliasKey;
  const baselineAlias = draft.baselineAlias;
  const isEditing = draft.isEditing;
  const isRename =
    isEditing && Boolean(baselineAlias) && toAliasKey(baselineAlias) !== toAliasKey(finalAlias);

  const baselineChannel =
    isEditing && prevAliasKey ? state.mapping.byAliasKey.get(prevAliasKey) : undefined;
  const baselineTargets = baselineChannel ? baselineChannel.targets : [];

  const persistableSelected = filterPersistableMappingTargets(finalAlias, draft.selectedTargets);
  const persistableBaseline = filterPersistableMappingTargets(
    baselineAlias || finalAlias,
    baselineTargets
  );

  const selectedKeys = new Set(draft.selectedTargets.map(mappingTargetKey));
  const suspendedKeys = new Set(draft.suspendedTargets.map((s) => mappingTargetKey(s.target)));
  const claimedKeys = new Set<string>([...selectedKeys, ...suspendedKeys]);
  // abandoned 区分「原已渠道禁用（suspended）」与「原活跃」：
  // 前者须继续禁用（走 suspendedTargets -> toDisable，保持 excludedModels 排除 / catalog 移除），
  // 不能走 abandonedTargets -> toClearExclude 把 claude apikey 的 excludedModels 摘掉而复活成裸条目。
  const abandonedSuspended: MappingTargetRef[] = [];
  const abandonedActive: MappingTargetRef[] = [];
  baselineTargets.forEach((t) => {
    if (claimedKeys.has(mappingTargetKey(t))) return;
    if (t.suspended) abandonedSuspended.push(t);
    else abandonedActive.push(t);
  });

  const fullyDeleted = draft.selectedTargets.length === 0 && draft.suspendedTargets.length === 0;

  const nextPlan = planAliasTargetAssignments(persistableSelected, finalAlias);
  const baselinePlan = planAliasTargetAssignments(persistableBaseline, baselineAlias || finalAlias);

  // --- main-save working 数组 ---
  const mainOauthChannels = new Set<string>([
    ...nextPlan.oauthByChannel.keys(),
    ...baselinePlan.oauthByChannel.keys(),
    ...(prevAliasKey ? collectConfiguredOauthChannelsForAlias(state.oauthAliasMap, prevAliasKey) : []),
  ]);
  const workingOauth = new Map<string, OAuthModelAliasEntry[]>();
  mainOauthChannels.forEach((ch) => {
    let entries = state.oauthAliasMap[ch] ?? [];
    if (isRename) {
      entries = applyOauthAliasTargetChanges({ entries, alias: baselineAlias, nextModelIds: [] });
    }
    const nextIds = nextPlan.oauthByChannel.get(ch) ?? [];
    entries = applyOauthAliasTargetChanges({ entries, alias: finalAlias, nextModelIds: nextIds });
    workingOauth.set(ch, entries);
  });

  const mainApiKeyResources = new Set<string>([
    ...nextPlan.apiKeyByResource.keys(),
    ...baselinePlan.apiKeyByResource.keys(),
    ...(prevAliasKey
      ? collectConfiguredApiKeyResourceIdsForAlias(state.catalogs.resources, prevAliasKey)
      : []),
  ]);
  const workingModels = new Map<string, ModelAlias[]>();
  mainApiKeyResources.forEach((rid) => {
    const resource = state.catalogs.resources.find((r) => r.id === rid);
    if (!resource) return;
    let models = readApiKeyModels(resource);
    const prevIds = baselinePlan.apiKeyByResource.get(rid)?.modelIds ?? [];
    if (isRename) {
      models = applyApiKeyModelAliasChanges({
        models,
        alias: baselineAlias,
        nextModelIds: [],
        previousModelIds: prevIds,
        previousAliasKey: prevAliasKey ?? undefined,
      });
    }
    const nextIds = nextPlan.apiKeyByResource.get(rid)?.modelIds ?? [];
    models = applyApiKeyModelAliasChanges({
      models,
      alias: finalAlias,
      nextModelIds: nextIds,
      previousModelIds: prevIds,
      previousAliasKey: prevAliasKey ?? undefined,
    });
    workingModels.set(rid, models);
  });

  // --- identity-access 同步（在 working 数组上合并） ---
  const { toEnable, toDisable, toClearExclude } = partitionIdentityAccessTargets({
    alias: finalAlias,
    selectedTargets: draft.selectedTargets,
    suspendedTargets: [
      ...draft.suspendedTargets.map((s) => ({ target: s.target })),
      ...abandonedSuspended.map((t) => ({ target: t })),
    ],
    abandonedTargets: abandonedActive,
  });

  const identityOauthTouched = new Set<string>();
  const oauthDisable = groupOauthByChannel(toDisable);
  const oauthEnable = groupOauthByChannel(toEnable);
  const oauthClear = groupOauthByChannel(toClearExclude);
  new Set([...oauthDisable.keys(), ...oauthEnable.keys(), ...oauthClear.keys()]).forEach((ch) => {
    let entries = workingOauth.get(ch) ?? state.oauthAliasMap[ch] ?? [];
    let rules = normalizeOAuthExcludedRules(state.oauthExcludedMap[ch] ?? []);
    let aliasDirty = false;
    let excludedDirty = false;
    const managedMark: string[] = [];
    const managedUnmark: string[] = [];

    (oauthDisable.get(ch) ?? []).forEach((modelId) => {
      const plan = planOauthIdentityDisable(entries, modelId);
      if (plan.changed) {
        entries = plan.next;
        aliasDirty = true;
      }
      if (plan.usedFork) {
        forked += 1;
        managedUnmark.push(accessEnabledKey({ source: 'oauth', channel: ch, modelId }));
        const before = rules.length;
        rules = updateOAuthExcludedRule(rules, modelId, false);
        if (rules.length < before) excludedDirty = true;
        return;
      }
      rules = updateOAuthExcludedRule(rules, modelId, true);
      excludedDirty = true;
      excluded += 1;
      managedMark.push(accessEnabledKey({ source: 'oauth', channel: ch, modelId }));
    });
    (oauthEnable.get(ch) ?? []).forEach((modelId) => {
      const plan = planOauthIdentityEnable(entries, modelId);
      if (plan.changed) {
        entries = plan.next;
        aliasDirty = true;
      }
      const before = rules.length;
      rules = updateOAuthExcludedRule(rules, modelId, false);
      if (rules.length < before) excludedDirty = true;
      managedUnmark.push(accessEnabledKey({ source: 'oauth', channel: ch, modelId }));
    });
    (oauthClear.get(ch) ?? []).forEach((modelId) => {
      if ((oauthEnable.get(ch) ?? []).some((id) => lower(id) === lower(modelId))) return;
      const before = rules.length;
      rules = updateOAuthExcludedRule(rules, modelId, false);
      if (rules.length < before) excludedDirty = true;
      managedUnmark.push(accessEnabledKey({ source: 'oauth', channel: ch, modelId }));
    });

    if (aliasDirty) {
      push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey: ch, channel: ch, entries });
      identityOauthTouched.add(ch);
      workingOauth.set(ch, entries);
    }
    if (excludedDirty) {
      push({ kind: 'oauthExcludedPatch', phase: 'backend', queueKey: ch, channel: ch, models: rules });
    }
    managedMark.forEach((k) =>
      push({ kind: 'managedExcludeMark', phase: 'after-backend', queueKey: ch, key: k })
    );
    managedUnmark.forEach((k) =>
      push({ kind: 'managedExcludeUnmark', phase: 'after-backend', queueKey: ch, key: k })
    );
  });

  // main-save oauthAliasPatch：仅 identity 未触及的 channel
  mainOauthChannels.forEach((ch) => {
    if (identityOauthTouched.has(ch)) return;
    const entries = workingOauth.get(ch) ?? [];
    const initial = state.oauthAliasMap[ch] ?? [];
    const nextIds = nextPlan.oauthByChannel.get(ch) ?? [];
    if (!initial.length && !nextIds.length) return;
    push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey: ch, channel: ch, entries });
  });

  // API Key identity + main
  const identityOpenAiTouched = new Set<string>();
  const apiDisable = groupApiKeyByResource(toDisable);
  const apiEnableIdentity = groupApiKeyByResource(toEnable);
  const apiEnableClear = groupApiKeyByResource(toClearExclude);
  const apiEnable = groupApiKeyByResource([...toEnable, ...toClearExclude]);
  new Set([...apiDisable.keys(), ...apiEnable.keys()]).forEach((rid) => {
    const resource = state.catalogs.resources.find((r) => r.id === rid);
    if (!resource) return;
    const disableIds = apiDisable.get(rid) ?? [];
    const enableIds = apiEnable.get(rid) ?? [];

    if (resource.brand === 'openaiCompatibility') {
      let models = workingModels.get(rid) ?? readApiKeyModels(resource);
      let dirty = false;
      const managedMark: string[] = [];
      const managedUnmark: string[] = [];
      disableIds.forEach((modelId) => {
        const { next, removed } = removeModelFromCatalog(models, modelId);
        const entries = removed.length > 0 ? removed : ([{ name: modelId }] as ModelAlias[]);
        push({
          kind: 'catalogSuspendMerge',
          phase: 'before-backend',
          queueKey: rid,
          resourceId: rid,
          modelId,
          entries,
        });
        managedMark.push(
          accessEnabledKey({ source: 'apiKey', resourceId: rid, brand: resource.brand, modelId })
        );
        models = next;
        dirty = true;
        excluded += 1;
      });
      const accessKey = (modelId: string) =>
        accessEnabledKey({ source: 'apiKey', resourceId: rid, brand: resource.brand, modelId });
      // identity 重新启用：恢复挂起的原名条目（重新暴露原名）
      const identityIds = new Set((apiEnableIdentity.get(rid) ?? []).map((id) => lower(id)));
      (apiEnableIdentity.get(rid) ?? []).forEach((modelId) => {
        const suspendedEntries = state.access.byKey.get(accessKey(modelId))?.suspendedCatalogEntries;
        const toRestore =
          suspendedEntries && suspendedEntries.length
            ? suspendedEntries
            : ([{ name: modelId }] as ModelAlias[]);
        const { next } = restoreModelToCatalog(models, toRestore);
        models = next;
        managedUnmark.push(accessKey(modelId));
        dirty = true;
        push({
          kind: 'catalogSuspendTake',
          phase: 'after-backend',
          queueKey: rid,
          resourceId: rid,
          modelId,
        });
      });
      // 跨名/abandoned：catalog 已由 main-save 写入手动 alias；仅清受管 exclude + 挂起存储。
      // 不恢复旧条目，否则会回填原名/旧别名，导致「自动渠道不显示但原名仍出现在模型列表」。
      (apiEnableClear.get(rid) ?? []).forEach((modelId) => {
        if (identityIds.has(lower(modelId))) return; // 已在 identity 恢复路径处理
        managedUnmark.push(accessKey(modelId));
        push({
          kind: 'catalogSuspendTake',
          phase: 'after-backend',
          queueKey: rid,
          resourceId: rid,
          modelId,
        });
      });
      if (dirty) {
        push({
          kind: 'apiKeyModelsPut',
          phase: 'backend',
          queueKey: rid,
          resourceId: rid,
          brand: resource.brand,
          models,
        });
        identityOpenAiTouched.add(rid);
        workingModels.set(rid, models);
      }
      managedMark.forEach((k) =>
        push({ kind: 'managedExcludeMark', phase: 'after-backend', queueKey: rid, key: k })
      );
      managedUnmark.forEach((k) =>
        push({ kind: 'managedExcludeUnmark', phase: 'after-backend', queueKey: rid, key: k })
      );
      return;
    }

    const raw = resource.raw as { excludedModels?: string[] };
    let list = stripDisableAllModelsRule(raw.excludedModels);
    let excludedDirty = false;
    const managedMark: string[] = [];
    const managedUnmark: string[] = [];
    disableIds.forEach((modelId) => {
      list = toggleApiKeyExcludedList(list, modelId, true);
      managedMark.push(
        accessEnabledKey({ source: 'apiKey', resourceId: rid, brand: resource.brand, modelId })
      );
      excludedDirty = true;
      excluded += 1;
    });
    enableIds.forEach((modelId) => {
      const next = toggleApiKeyExcludedList(list, modelId, false);
      if (next.length !== list.length) excludedDirty = true;
      list = next;
      managedUnmark.push(
        accessEnabledKey({ source: 'apiKey', resourceId: rid, brand: resource.brand, modelId })
      );
    });
    if (excludedDirty) {
      push({
        kind: 'apiKeyExcludedPatch',
        phase: 'backend',
        queueKey: rid,
        resourceId: rid,
        brand: resource.brand,
        modelsWithoutStar: list,
      });
    }
    managedMark.forEach((k) =>
      push({ kind: 'managedExcludeMark', phase: 'after-backend', queueKey: rid, key: k })
    );
    managedUnmark.forEach((k) =>
      push({ kind: 'managedExcludeUnmark', phase: 'after-backend', queueKey: rid, key: k })
    );
  });

  // main-save apiKeyModelsPut：仅 identity-openai 未触及的资源（非 openai 资源 identity 用 excludedModels 独立字段，不冲突）
  mainApiKeyResources.forEach((rid) => {
    if (identityOpenAiTouched.has(rid)) return;
    const resource = state.catalogs.resources.find((r) => r.id === rid);
    if (!resource) return;
    if (resource.brand === 'openaiCompatibility') {
      const models = workingModels.get(rid) ?? [];
      const initial = readApiKeyModels(resource);
      const nextIds = nextPlan.apiKeyByResource.get(rid)?.modelIds ?? [];
      if (!initial.length && !nextIds.length) return;
      push({
        kind: 'apiKeyModelsPut',
        phase: 'backend',
        queueKey: rid,
        resourceId: rid,
        brand: resource.brand,
        models,
      });
    } else {
      const models = workingModels.get(rid) ?? [];
      push({
        kind: 'apiKeyModelsPut',
        phase: 'backend',
        queueKey: rid,
        resourceId: rid,
        brand: resource.brand,
        models,
      });
    }
  });

  // --- 认领 / 取消认领 ---
  const finalAliasKey = toAliasKey(finalAlias);
  if (finalAliasKey) {
    const claimQueue = `alias:${finalAliasKey}`;
    if (fullyDeleted) {
      push({ kind: 'mappingUnclaim', phase: 'after-backend', queueKey: claimQueue, aliasKey: finalAliasKey });
    } else {
      push({ kind: 'mappingClaim', phase: 'after-backend', queueKey: claimQueue, aliasKey: finalAliasKey });
    }
  }

  // --- 挂起标签同步（syncSuspendedTags 等价）：清旧名 / 清新名(改名) / 按新名 merge ---
  const suspendQueue = `alias-sync:${finalAliasKey}`;
  if (isEditing && baselineAlias) {
    push({
      kind: 'mappingSuspendClearAlias',
      phase: 'before-backend',
      queueKey: suspendQueue,
      aliasKey: toAliasKey(baselineAlias),
    });
  }
  if (finalAlias && toAliasKey(finalAlias) !== toAliasKey(baselineAlias || '')) {
    push({
      kind: 'mappingSuspendClearAlias',
      phase: 'before-backend',
      queueKey: suspendQueue,
      aliasKey: finalAliasKey,
    });
  }
  if (draft.suspendedTargets.length > 0 && finalAlias) {
    draft.suspendedTargets.forEach((entry) => {
      const targetKey = accessEnabledKey(entry.target);
      push({
        kind: 'mappingSuspendMerge',
        phase: 'before-backend',
        queueKey: suspendQueue,
        targetKey,
        entries: [{ ...entry, alias: finalAlias }],
      });
    });
  }

  return { ops, forked, excluded };
}

export function planAliasDelete(input: {
  state: ModelManagementState;
  aliasKey: string;
}): ModelOp[] {
  const { state, aliasKey } = input;
  const channel = state.mapping.byAliasKey.get(aliasKey);
  if (!channel) return [];
  const alias = channel.alias;
  const ops: ModelOp[] = [];
  const push = (op: ModelOp) => ops.push(op);

  // 1. 清挂起 + 清认领（before-backend，独立队列）
  const aliasQueue = `alias:${aliasKey}`;
  push({ kind: 'mappingSuspendClearAlias', phase: 'before-backend', queueKey: aliasQueue, aliasKey });
  push({ kind: 'mappingUnclaim', phase: 'before-backend', queueKey: aliasQueue, aliasKey });

  // 2. 从后端 oauth alias map 摘掉该 alias
  collectConfiguredOauthChannelsForAlias(state.oauthAliasMap, aliasKey).forEach((channelName) => {
    const entries = state.oauthAliasMap[channelName] ?? [];
    const next = applyOauthAliasTargetChanges({ entries, alias, nextModelIds: [] });
    push({
      kind: 'oauthAliasPatch',
      phase: 'backend',
      queueKey: channelName,
      channel: channelName,
      entries: next,
    });
  });

  // 3. 从后端 apiKey models[] 摘掉该 alias（保留原名条目）
  collectConfiguredApiKeyResourceIdsForAlias(state.catalogs.resources, aliasKey).forEach((resourceId) => {
    const resource = state.catalogs.resources.find((r) => r.id === resourceId);
    if (!resource) return;
    const models = readApiKeyModels(resource);
    const previousModelIds = models
      .filter((m) => {
        const name = String(m.name ?? '').trim();
        const a = String(m.alias ?? '').trim();
        return name && a && toAliasKey(a) === aliasKey && toAliasKey(a) !== name.trim().toLowerCase();
      })
      .map((m) => String(m.name).trim());
    const nextModels = applyApiKeyModelAliasChanges({
      models,
      alias,
      nextModelIds: [],
      previousModelIds,
    });
    push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey: resourceId,
      resourceId,
      brand: resource.brand,
      models: nextModels,
    });
  });

  // 4. 曾持有的目标恢复原名入口：活跃目标 re-expose 原名（toClearExclude）；
  //    渠道内挂起（已禁用）目标必须保持禁用（toDisable：excludedModels 仍排除 / catalog 仍移除），
  //    不能因删除 alias 而复活成可调用的裸条目（claude apikey 的 excludedModels 会被 toClearExclude 摘掉）。
  const heldActive: MappingTargetRef[] = [];
  const heldSuspended: MappingTargetRef[] = [];
  const seen = new Set<string>();
  channel.targets.forEach((t) => {
    const ref: MappingTargetRef =
      t.source === 'oauth'
        ? { source: 'oauth', channel: t.channel, modelId: t.modelId }
        : { source: 'apiKey', resourceId: t.resourceId, brand: t.brand, modelId: t.modelId };
    const key = mappingTargetKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    if (t.suspended) heldSuspended.push(ref);
    else heldActive.push(ref);
  });
  if (heldActive.length || heldSuspended.length) {
    ops.push(
      ...planIdentityAccessSync({
        state,
        alias,
        selectedTargets: [],
        suspendedTargets: heldSuspended,
        abandonedTargets: heldActive,
      })
    );
  }
  return ops;
}

export type ProviderFormDelta = {
  ref: MappingTargetRef;
  nextEnabled: boolean;
};

/**
 * 计算模块（纯函数）：AI 提供商页表单保存产生的模型启停 delta -> 映射剪枝/恢复 ops。
 *
 * 泛化自 useProviderWorkbench.syncMappingsAfterFormSave（impure）。与 planAccessToggle 的
 * 关键区别：表单保存本身已写 excludedModels / models[]（原生启停由 buildProviderKeyConfig /
 * applyOpenAICatalogSuspendOnSave 完成），这里只负责映射绑定的剪枝（禁用）/ 恢复（启用）
 * + mappingSuspend 存取，不重复写 exclude / catalog / managedExclude。
 *
 * `resource` 为 workbench 捕获的 provider 资源（apiKey models[] 读取来源，匹配旧实现
 * pruneMappingsForDisabledTarget / restoreMappingsForEnabledTarget 接收 resources: [resource]）；
 * oauth entries 取自 state.oauthAliasMap；挂起绑定取自 state.mapping。
 */
export function planProviderFormDeltas(input: {
  state: ModelManagementState;
  resource: ProviderResource;
  deltas: ProviderFormDelta[];
}): ModelOp[] {
  const ops: ModelOp[] = [];
  for (const delta of input.deltas) {
    planSingleProviderFormDelta(input.state, input.resource, delta, ops);
  }
  return ops;
}

function planSingleProviderFormDelta(
  state: ModelManagementState,
  resource: ProviderResource,
  delta: ProviderFormDelta,
  out: ModelOp[]
): void {
  const { ref, nextEnabled } = delta;
  const targetKey = accessEnabledKey(ref);

  if (ref.source === 'oauth') {
    const channel = normalizeProviderKey(ref.channel);
    const queueKey = channel;
    const entries = state.oauthAliasMap[channel] ?? [];
    if (!nextEnabled) {
      const bindings = collectMappingsForTarget({
        modelAlias: { [channel]: entries },
        resources: [],
        target: ref,
      });
      if (!bindings.length) return;
      const { next } = pruneOauthEntriesForModel(entries, ref.modelId);
      out.push({
        kind: 'mappingSuspendMerge',
        phase: 'before-backend',
        queueKey,
        targetKey,
        entries: bindings,
      });
      out.push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey, channel, entries: next });
      return;
    }
    const suspended = collectSuspendedBindingsForTarget(state.mapping, targetKey);
    if (!suspended.length) return;
    const { next } = restoreOauthEntries(entries, suspended, channel);
    if (JSON.stringify(entries) !== JSON.stringify(next)) {
      out.push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey, channel, entries: next });
    }
    out.push({ kind: 'mappingSuspendTake', phase: 'after-backend', queueKey, targetKey });
    return;
  }

  // apiKey
  const queueKey = resource.id;
  const models = readApiKeyModels(resource);
  if (!nextEnabled) {
    const bindings = collectMappingsForTarget({
      modelAlias: {},
      resources: [resource],
      target: ref,
    });
    if (!bindings.length) return;
    // openaiCompatibility 无 excludedModels：裸 {name} 条目仍可被路由调用，禁用须整条摘除
    // （与 planOpenAiCatalogToggle 一致）；其它 apiKey brand 保留裸条目，由 excludedModels 关闭路由。
    const { next } =
      resource.brand === 'openaiCompatibility'
        ? removeModelFromCatalog(models, ref.modelId)
        : pruneApiKeyModelsForModel(models, ref.modelId);
    out.push({
      kind: 'mappingSuspendMerge',
      phase: 'before-backend',
      queueKey,
      targetKey,
      entries: bindings,
    });
    out.push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: next,
    });
    return;
  }
  const suspended = collectSuspendedBindingsForTarget(state.mapping, targetKey);
  if (!suspended.length) return;
  const { next } = restoreApiKeyModels(models, suspended, resource.id);
  if (JSON.stringify(models) !== JSON.stringify(next)) {
    out.push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: next,
    });
  }
  out.push({ kind: 'mappingSuspendTake', phase: 'after-backend', queueKey, targetKey });
}

export { lower };
