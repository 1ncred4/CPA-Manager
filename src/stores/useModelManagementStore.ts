/**
 * 模型管理 Zustand store：单一状态来源。
 *
 * 架构（Phase 2）：
 * - 持有 current/baseline 两套 sources + mirrors + ctx；access/mapping/catalogs/managedExcludeKeys
 *   是 buildStateFromSources 派生的视图（每次变更重算）。
 * - toggleAccess：planAccessToggle（消费派生态）-> applyModelOpsToSources（乐观 current）->
 *   applyModelOperations（后端 + localStorage）-> 成功 commitBaseline / 失败 clearGhosts + revertToBaseline。
 * - 失败不回滚后端（无事务），仅清掉本次 before-backend 写入的 localStorage 挂起幽灵 + 内存回滚到 baseline；
 *   调用方（hook）再触发一次 fetch + load 做权威重同步。
 *
 * saveAlias / deleteAlias / applyProviderFormDeltas 在 Phase 3-5 实现。
 */

import { create } from 'zustand';
import type { OAuthModelAliasEntry } from '@/types';
import type { AuthFileModelItem, OAuthConfigLoadError } from '@/features/authFiles/constants';
import type { ProviderResource } from '@/features/providers/types';
import {
  buildStateFromSources,
  emptyMirrors,
  loadMirrorsFromAdapters,
  type ModelAccessState,
  type ModelCatalogs,
  type ModelDisplayContext,
  type ModelManagementMirrors,
  type ModelManagementSources,
  type ModelManagementState,
  type ModelMappingState,
} from '@/features/models/modelManagementState';
import { accessEnabledKey, type MappingTargetRef } from '@/features/models/modelMapping';
import {
  planAccessToggle,
  planAliasDelete,
  planAliasSave,
  planProviderFormDeltas,
  type AliasDraft,
  type ModelOp,
  type ProviderFormDelta,
} from '@/features/models/modelOps';
import { applyModelOpsToSources } from '@/features/models/modelOpReducer';
import { applyModelOperations } from '@/features/models/modelOpApplier';
import { clearSuspendedForTarget } from '@/features/models/mappingSuspend';
import { takeSuspendedCatalog } from '@/features/models/catalogSuspend';
import { markManagedIdentityExclude } from '@/features/models/managedIdentityExclude';

export type RefreshInput = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  oauthAliasError: OAuthConfigLoadError;
  apiBase: string;
  ctx: ModelDisplayContext;
};

export type ToggleAccessResult = {
  ok: boolean;
  pruned: number;
  restored: number;
};

export type DeleteAliasResult = {
  ok: boolean;
};

export type SaveAliasResult = {
  ok: boolean;
  forked: number;
  excluded: number;
};

export type ModelManagementStore = {
  currentSources: ModelManagementSources;
  currentMirrors: ModelManagementMirrors;
  baselineSources: ModelManagementSources;
  baselineMirrors: ModelManagementMirrors;
  ctx: ModelDisplayContext | null;
  apiBase: string;
  loading: boolean;
  oauthAliasError: OAuthConfigLoadError;
  pendingKeys: Set<string>;

  accessCurrent: ModelAccessState;
  accessBaseline: ModelAccessState;
  mappingCurrent: ModelMappingState;
  mappingBaseline: ModelMappingState;
  managedExcludeKeys: Set<string>;
  catalogs: ModelCatalogs;
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;

  /** 从原始数据 + 显示上下文构建缓存态，baseline = current。hook fetch 完成后调用。 */
  load: (input: RefreshInput) => void;
  /** fetch 开始/结束时切 loading（两 tab 共享）。 */
  setLoading: (loading: boolean) => void;
  /** 即时切换模型启停（模型禁用 tab）。 */
  toggleAccess: (ref: MappingTargetRef, enabled: boolean) => Promise<ToggleAccessResult>;
  /** 保存映射草稿（映射编辑页保存按钮）。 */
  saveAlias: (draft: AliasDraft) => Promise<SaveAliasResult>;
  /** 删除整条映射渠道。 */
  deleteAlias: (aliasKey: string) => Promise<DeleteAliasResult>;
  /** AI 提供商页表单保存产生的启停 delta。Phase 5 实现。 */
  applyProviderFormDeltas: (
    deltas: ProviderFormDelta[],
    resource: ProviderResource
  ) => Promise<void>;
};

const EMPTY_SOURCES: ModelManagementSources = {
  oauthModels: {},
  resources: [],
  oauthAliasMap: {},
  oauthExcludedMap: {},
};

const EMPTY_ACCESS: ModelAccessState = { byKey: new Map() };
const EMPTY_MAPPING: ModelMappingState = { byAliasKey: new Map() };

/** 模块级串行队列单例（跨调用存活，不在 Zustand state 中）。 */
export const modelOpQueues: Map<string, Promise<unknown>> = new Map();

function derive(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelManagementState {
  return buildStateFromSources(sources, mirrors, ctx);
}

/** 清掉本次 toggle 的 before-backend localStorage 幽灵（失败回滚用）。 */
function clearBeforeBackendGhosts(apiBase: string, ops: ModelOp[]): void {
  for (const op of ops) {
    if (op.phase !== 'before-backend') continue;
    if (op.kind === 'mappingSuspendMerge') {
      clearSuspendedForTarget(apiBase, op.targetKey);
    } else if (op.kind === 'catalogSuspendMerge') {
      takeSuspendedCatalog(apiBase, op.resourceId, op.modelId);
    } else if (op.kind === 'managedExcludeUnmark') {
      markManagedIdentityExclude(apiBase, op.key);
    }
  }
}

export const useModelManagementStore = create<ModelManagementStore>((set, get) => {
  /** 内存回滚到 baseline（失败时调用）。在闭包内定义以访问 set/get。 */
  const revertToBaseline = (): void => {
    const { baselineSources, baselineMirrors, ctx } = get();
    if (!ctx) return;
    const state = derive(baselineSources, baselineMirrors, ctx);
    set({
      currentSources: baselineSources,
      currentMirrors: baselineMirrors,
      accessCurrent: state.access,
      mappingCurrent: state.mapping,
      managedExcludeKeys: state.managedExcludeKeys,
      catalogs: state.catalogs,
      oauthAliasMap: state.oauthAliasMap,
      oauthExcludedMap: state.oauthExcludedMap,
    });
  };

  return {
    currentSources: EMPTY_SOURCES,
    currentMirrors: emptyMirrors(),
    baselineSources: EMPTY_SOURCES,
    baselineMirrors: emptyMirrors(),
    ctx: null,
    apiBase: '',
    loading: false,
    oauthAliasError: 'loading',
    pendingKeys: new Set(),

    accessCurrent: EMPTY_ACCESS,
    accessBaseline: EMPTY_ACCESS,
    mappingCurrent: EMPTY_MAPPING,
    mappingBaseline: EMPTY_MAPPING,
    managedExcludeKeys: new Set(),
    catalogs: { oauthModels: {}, resources: [] },
    oauthAliasMap: {},
    oauthExcludedMap: {},

    load: (input) => {
      const sources: ModelManagementSources = {
        oauthModels: input.oauthModels ?? {},
        resources: input.resources ?? [],
        oauthAliasMap: input.oauthAliasMap ?? {},
        oauthExcludedMap: input.oauthExcludedMap ?? {},
      };
      const mirrors = loadMirrorsFromAdapters(input.apiBase);
      const state = derive(sources, mirrors, input.ctx);
      set({
        currentSources: sources,
        baselineSources: sources,
        currentMirrors: mirrors,
        baselineMirrors: mirrors,
        ctx: input.ctx,
        apiBase: input.apiBase,
        oauthAliasError: input.oauthAliasError,
        accessCurrent: state.access,
        accessBaseline: state.access,
        mappingCurrent: state.mapping,
        mappingBaseline: state.mapping,
        managedExcludeKeys: state.managedExcludeKeys,
        catalogs: state.catalogs,
        oauthAliasMap: state.oauthAliasMap,
        oauthExcludedMap: state.oauthExcludedMap,
      });
    },

    toggleAccess: async (ref, enabled) => {
      const { currentSources, currentMirrors, ctx, apiBase } = get();
      if (!ctx) return { ok: false, pruned: 0, restored: 0 };

      const state = derive(currentSources, currentMirrors, ctx);
      const ops = planAccessToggle({ state, ref, nextEnabled: enabled });
      if (!ops.length) return { ok: true, pruned: 0, restored: 0 };

      const targetKey = accessEnabledKey(ref);
      const pruned = ops
        .filter(
          (o): o is Extract<ModelOp, { kind: 'mappingSuspendMerge' }> =>
            o.kind === 'mappingSuspendMerge'
        )
        .reduce((n, o) => n + (o.entries?.length ?? 0), 0);
      const restored = enabled
        ? (currentMirrors.mappingSuspend.get(targetKey)?.length ?? 0)
        : 0;

      const setPending = (pending: boolean) => {
        set((s) => {
          const next = new Set(s.pendingKeys);
          if (pending) next.add(targetKey);
          else next.delete(targetKey);
          return { pendingKeys: next };
        });
      };

      // 乐观 current
      const { sources: nextSources, mirrors: nextMirrors } = applyModelOpsToSources(
        currentSources,
        currentMirrors,
        ops
      );
      const optimistic = derive(nextSources, nextMirrors, ctx);
      set({
        currentSources: nextSources,
        currentMirrors: nextMirrors,
        accessCurrent: optimistic.access,
        mappingCurrent: optimistic.mapping,
        managedExcludeKeys: optimistic.managedExcludeKeys,
        catalogs: optimistic.catalogs,
        oauthAliasMap: optimistic.oauthAliasMap,
        oauthExcludedMap: optimistic.oauthExcludedMap,
      });
      setPending(true);

      // apply（resources 用 pre-toggle 快照，applier 按 op.models 写回）
      try {
        const { failures } = await applyModelOperations({
          apiBase,
          ops,
          resources: currentSources.resources,
          queues: modelOpQueues,
        });
        if (failures.length) {
          clearBeforeBackendGhosts(apiBase, ops);
          revertToBaseline();
          setPending(false);
          return { ok: false, pruned: 0, restored: 0 };
        }
      } catch {
        clearBeforeBackendGhosts(apiBase, ops);
        revertToBaseline();
        setPending(false);
        return { ok: false, pruned: 0, restored: 0 };
      }

      // 成功：current 提交为 baseline
      set((s) => ({
        baselineSources: s.currentSources,
        baselineMirrors: s.currentMirrors,
        accessBaseline: s.accessCurrent,
        mappingBaseline: s.mappingCurrent,
      }));
      setPending(false);
      return { ok: true, pruned, restored };
    },

    saveAlias: async (draft) => {
      const { currentSources, currentMirrors, ctx, apiBase } = get();
      if (!ctx) return { ok: false, forked: 0, excluded: 0 };

      const state = derive(currentSources, currentMirrors, ctx);
      const { ops, forked, excluded } = planAliasSave({ state, draft });
      if (!ops.length) return { ok: true, forked, excluded };

      const { sources: nextSources, mirrors: nextMirrors } = applyModelOpsToSources(
        currentSources,
        currentMirrors,
        ops
      );
      const optimistic = derive(nextSources, nextMirrors, ctx);
      set({
        currentSources: nextSources,
        currentMirrors: nextMirrors,
        accessCurrent: optimistic.access,
        mappingCurrent: optimistic.mapping,
        managedExcludeKeys: optimistic.managedExcludeKeys,
        catalogs: optimistic.catalogs,
        oauthAliasMap: optimistic.oauthAliasMap,
        oauthExcludedMap: optimistic.oauthExcludedMap,
      });

      try {
        const { failures } = await applyModelOperations({
          apiBase,
          ops,
          resources: currentSources.resources,
          queues: modelOpQueues,
        });
        if (failures.length) {
          clearBeforeBackendGhosts(apiBase, ops);
          revertToBaseline();
          return { ok: false, forked: 0, excluded: 0 };
        }
      } catch {
        clearBeforeBackendGhosts(apiBase, ops);
        revertToBaseline();
        return { ok: false, forked: 0, excluded: 0 };
      }

      set((s) => ({
        baselineSources: s.currentSources,
        baselineMirrors: s.currentMirrors,
        accessBaseline: s.accessCurrent,
        mappingBaseline: s.mappingCurrent,
      }));
      return { ok: true, forked, excluded };
    },
    setLoading: (loading) => set({ loading }),

    deleteAlias: async (aliasKey) => {
      const { currentSources, currentMirrors, ctx, apiBase } = get();
      if (!ctx) return { ok: false };

      const state = derive(currentSources, currentMirrors, ctx);
      const ops = planAliasDelete({ state, aliasKey });
      if (!ops.length) return { ok: true };

      const { sources: nextSources, mirrors: nextMirrors } = applyModelOpsToSources(
        currentSources,
        currentMirrors,
        ops
      );
      const optimistic = derive(nextSources, nextMirrors, ctx);
      set({
        currentSources: nextSources,
        currentMirrors: nextMirrors,
        accessCurrent: optimistic.access,
        mappingCurrent: optimistic.mapping,
        managedExcludeKeys: optimistic.managedExcludeKeys,
        catalogs: optimistic.catalogs,
        oauthAliasMap: optimistic.oauthAliasMap,
        oauthExcludedMap: optimistic.oauthExcludedMap,
      });

      try {
        const { failures } = await applyModelOperations({
          apiBase,
          ops,
          resources: currentSources.resources,
          queues: modelOpQueues,
        });
        if (failures.length) {
          clearBeforeBackendGhosts(apiBase, ops);
          revertToBaseline();
          return { ok: false };
        }
      } catch {
        clearBeforeBackendGhosts(apiBase, ops);
        revertToBaseline();
        return { ok: false };
      }

      set((s) => ({
        baselineSources: s.currentSources,
        baselineMirrors: s.currentMirrors,
        accessBaseline: s.accessCurrent,
        mappingBaseline: s.mappingCurrent,
      }));
      return { ok: true };
    },

    applyProviderFormDeltas: async (deltas, resource) => {
      const { currentSources, currentMirrors, ctx, apiBase } = get();
      if (!ctx) return;

      const state = derive(currentSources, currentMirrors, ctx);
      const ops = planProviderFormDeltas({ state, resource, deltas });
      if (!ops.length) return;

      const { sources: nextSources, mirrors: nextMirrors } = applyModelOpsToSources(
        currentSources,
        currentMirrors,
        ops
      );
      const optimistic = derive(nextSources, nextMirrors, ctx);
      set({
        currentSources: nextSources,
        currentMirrors: nextMirrors,
        accessCurrent: optimistic.access,
        mappingCurrent: optimistic.mapping,
        managedExcludeKeys: optimistic.managedExcludeKeys,
        catalogs: optimistic.catalogs,
        oauthAliasMap: optimistic.oauthAliasMap,
        oauthExcludedMap: optimistic.oauthExcludedMap,
      });

      try {
        const { failures } = await applyModelOperations({
          apiBase,
          ops,
          resources: currentSources.resources,
          queues: modelOpQueues,
        });
        if (failures.length) {
          clearBeforeBackendGhosts(apiBase, ops);
          revertToBaseline();
          return;
        }
      } catch {
        clearBeforeBackendGhosts(apiBase, ops);
        revertToBaseline();
        return;
      }

      set((s) => ({
        baselineSources: s.currentSources,
        baselineMirrors: s.currentMirrors,
        accessBaseline: s.accessCurrent,
        mappingBaseline: s.mappingCurrent,
      }));
    },
  };
});
