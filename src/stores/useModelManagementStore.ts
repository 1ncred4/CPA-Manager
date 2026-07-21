/** Single Zustand store for v2 model access and alias management. */

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
import {
  putMappingDisabled,
  putModelDisabledSnapshot,
  takeModelDisabledSnapshot,
} from '@/features/models/modelDisabledState';

export type RefreshInput = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  oauthAliasError: OAuthConfigLoadError;
  apiBase: string;
  ctx: ModelDisplayContext;
};

export type ToggleAccessResult = { ok: boolean; pruned: number; restored: number };
export type DeleteAliasResult = { ok: boolean };
export type SaveAliasResult = { ok: boolean; forked: number; excluded: number };

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
  explicitIdentityKeys: Set<string>;
  catalogs: ModelCatalogs;
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  load: (input: RefreshInput) => void;
  setLoading: (loading: boolean) => void;
  toggleAccess: (ref: MappingTargetRef, enabled: boolean) => Promise<ToggleAccessResult>;
  saveAlias: (draft: AliasDraft) => Promise<SaveAliasResult>;
  deleteAlias: (aliasKey: string) => Promise<DeleteAliasResult>;
  applyProviderFormDeltas: (deltas: ProviderFormDelta[], resource: ProviderResource) => Promise<void>;
};

const EMPTY_SOURCES: ModelManagementSources = {
  oauthModels: {},
  resources: [],
  oauthAliasMap: {},
  oauthExcludedMap: {},
};
const EMPTY_ACCESS: ModelAccessState = { byKey: new Map() };
const EMPTY_MAPPING: ModelMappingState = { byAliasKey: new Map() };
export const modelOpQueues: Map<string, Promise<unknown>> = new Map();

function derive(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelManagementState {
  return buildStateFromSources(sources, mirrors, ctx);
}

function applyDerived(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
) {
  const state = derive(sources, mirrors, ctx);
  return {
    currentSources: sources,
    currentMirrors: mirrors,
    accessCurrent: state.access,
    mappingCurrent: state.mapping,
    explicitIdentityKeys: state.explicitIdentityKeys,
    catalogs: state.catalogs,
    oauthAliasMap: state.oauthAliasMap,
    oauthExcludedMap: state.oauthExcludedMap,
  };
}

function restoreBeforeBackendLocalState(
  apiBase: string,
  ops: ModelOp[],
  baselineMirrors: ModelManagementMirrors
): void {
  ops.forEach((op) => {
    if (op.phase !== 'before-backend') return;
    if (op.kind === 'modelDisabledPut') {
      const previous = baselineMirrors.modelDisabled.get(op.targetKey);
      if (previous) putModelDisabledSnapshot(apiBase, previous);
      else takeModelDisabledSnapshot(apiBase, op.snapshot.target);
    } else if (op.kind === 'mappingDisabledMerge') {
      putMappingDisabled(apiBase, op.targetKey, baselineMirrors.mappingDisabled.get(op.targetKey) ?? []);
    }
  });
}

export const useModelManagementStore = create<ModelManagementStore>((set, get) => {
  const revertToBaseline = () => {
    const { baselineSources, baselineMirrors, ctx } = get();
    if (!ctx) return;
    set({ ...applyDerived(baselineSources, baselineMirrors, ctx), baselineSources, baselineMirrors });
  };

  const runOps = async (ops: ModelOp[], resources: ProviderResource[]): Promise<boolean> => {
    const { apiBase, baselineMirrors } = get();
    try {
      const result = await applyModelOperations({ apiBase, ops, resources, queues: modelOpQueues });
      if (result.failures.length) {
        restoreBeforeBackendLocalState(apiBase, ops, baselineMirrors);
        revertToBaseline();
        return false;
      }
      return true;
    } catch {
      restoreBeforeBackendLocalState(apiBase, ops, baselineMirrors);
      revertToBaseline();
      return false;
    }
  };

  const optimistic = (sources: ModelManagementSources, mirrors: ModelManagementMirrors) => {
    const ctx = get().ctx;
    if (!ctx) return;
    set(applyDerived(sources, mirrors, ctx));
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
    explicitIdentityKeys: new Set(),
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
        ...applyDerived(sources, mirrors, input.ctx),
        baselineSources: sources,
        baselineMirrors: mirrors,
        accessBaseline: state.access,
        mappingBaseline: state.mapping,
        ctx: input.ctx,
        apiBase: input.apiBase,
        oauthAliasError: input.oauthAliasError,
      });
    },
    setLoading: (loading) => set({ loading }),

    toggleAccess: async (ref, enabled) => {
      const { currentSources, currentMirrors, ctx } = get();
      if (!ctx) return { ok: false, pruned: 0, restored: 0 };
      const state = derive(currentSources, currentMirrors, ctx);
      const ops = planAccessToggle({ state, ref, nextEnabled: enabled });
      if (!ops.length) return { ok: true, pruned: 0, restored: 0 };
      const targetKey = accessEnabledKey(ref);
      const pruned = ops
        .filter((op) => op.kind === 'modelDisabledPut')
        .reduce((count, op) => count + (op.kind === 'modelDisabledPut' ? op.snapshot.entries.length : 0), 0);
      const restored = enabled ? currentMirrors.modelDisabled.get(targetKey)?.entries.length ?? 0 : 0;
      const next = applyModelOpsToSources(currentSources, currentMirrors, ops);
      optimistic(next.sources, next.mirrors);
      set((s) => ({ pendingKeys: new Set(s.pendingKeys).add(targetKey) }));
      const ok = await runOps(ops, currentSources.resources);
      if (!ok) {
        set((s) => {
          const pending = new Set(s.pendingKeys);
          pending.delete(targetKey);
          return { pendingKeys: pending };
        });
        return { ok: false, pruned: 0, restored: 0 };
      }
      set((s) => ({
        baselineSources: s.currentSources,
        baselineMirrors: s.currentMirrors,
        accessBaseline: s.accessCurrent,
        mappingBaseline: s.mappingCurrent,
        pendingKeys: new Set([...s.pendingKeys].filter((key) => key !== targetKey)),
      }));
      return { ok: true, pruned, restored };
    },

    saveAlias: async (draft) => {
      const { currentSources, currentMirrors, ctx } = get();
      if (!ctx) return { ok: false, forked: 0, excluded: 0 };
      const { ops, forked, excluded } = planAliasSave({ state: derive(currentSources, currentMirrors, ctx), draft });
      if (!ops.length) return { ok: true, forked, excluded };
      const next = applyModelOpsToSources(currentSources, currentMirrors, ops);
      optimistic(next.sources, next.mirrors);
      const ok = await runOps(ops, currentSources.resources);
      if (!ok) return { ok: false, forked: 0, excluded: 0 };
      set((s) => ({ baselineSources: s.currentSources, baselineMirrors: s.currentMirrors, accessBaseline: s.accessCurrent, mappingBaseline: s.mappingCurrent }));
      return { ok: true, forked, excluded };
    },

    deleteAlias: async (aliasKey) => {
      const { currentSources, currentMirrors, ctx } = get();
      if (!ctx) return { ok: false };
      const ops = planAliasDelete({ state: derive(currentSources, currentMirrors, ctx), aliasKey });
      if (!ops.length) return { ok: true };
      const next = applyModelOpsToSources(currentSources, currentMirrors, ops);
      optimistic(next.sources, next.mirrors);
      const ok = await runOps(ops, currentSources.resources);
      if (!ok) return { ok: false };
      set((s) => ({ baselineSources: s.currentSources, baselineMirrors: s.currentMirrors, accessBaseline: s.accessCurrent, mappingBaseline: s.mappingCurrent }));
      return { ok: true };
    },

    applyProviderFormDeltas: async (deltas, resource) => {
      const { currentSources, currentMirrors, ctx } = get();
      if (!ctx) return;
      const ops = planProviderFormDeltas({ state: derive(currentSources, currentMirrors, ctx), resource, deltas });
      if (!ops.length) return;
      const next = applyModelOpsToSources(currentSources, currentMirrors, ops);
      optimistic(next.sources, next.mirrors);
      if (await runOps(ops, currentSources.resources)) {
        set((s) => ({ baselineSources: s.currentSources, baselineMirrors: s.currentMirrors, accessBaseline: s.accessCurrent, mappingBaseline: s.mappingCurrent }));
      }
    },
  };
});
