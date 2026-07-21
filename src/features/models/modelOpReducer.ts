/**
 * 纯函数 reducer：把 modelOps 产出的 ModelOp[] 应用到 sources + mirrors，产出乐观 current。
 *
 * 设计：
 * - 不读 localStorage、不发 API。仅 mutate sources（oauthAliasMap / oauthExcludedMap / resources）
 *   与 mirrors（mappingSuspend / catalogSuspend / managedExcludeKeys / claims）的不可变副本。
 * - phase 字段对 reducer 无意义（phase 只控制 applier 的执行时机）；reducer 应用全部 op 的净效果，
 *   得到「全部 op 成功后」的终态作为乐观 current。失败时由 store revertToBaseline 丢弃。
 * - apiKey 资源写回语义与 updateApiKeyModels / updateApiKeyExcludedModels 对齐：
 *   models[] 空时写 undefined；excludedModels 保留 `*`（整条目禁用）语义。
 */

import {
  hasDisableAllModelsRule,
  withDisableAllModelsRule,
} from '@/components/providers/utils';
import type { ModelAlias } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import { suspendedMappingIdentity, type SuspendedMapping } from './mappingSuspend';
import type { ModelManagementMirrors, ModelManagementSources } from './modelManagementState';
import type { ModelOp } from './modelOps';

const lower = (value: string): string => value.trim().toLowerCase();

function catalogAccessKey(resourceId: string, modelId: string): string {
  return `apiKey:${resourceId}:${lower(modelId)}`;
}

export function applyModelOpsToSources(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ops: ModelOp[]
): { sources: ModelManagementSources; mirrors: ModelManagementMirrors } {
  let oauthAliasMap = { ...sources.oauthAliasMap };
  let oauthExcludedMap = { ...sources.oauthExcludedMap };
  let resources = sources.resources;
  const mappingSuspend = new Map(mirrors.mappingSuspend);
  const catalogSuspend = new Map(mirrors.catalogSuspend);
  const managedExcludeKeys = new Set(mirrors.managedExcludeKeys);
  const claims = new Set(mirrors.claims);

  for (const op of ops) {
    switch (op.kind) {
      case 'oauthAliasPatch':
        oauthAliasMap = { ...oauthAliasMap, [op.channel]: op.entries };
        break;
      case 'oauthExcludedPatch':
        oauthExcludedMap = { ...oauthExcludedMap, [op.channel]: op.models };
        break;
      case 'apiKeyModelsPut':
        resources = resources.map((r) =>
          r.id === op.resourceId ? applyModelsPut(r, op.models) : r
        );
        break;
      case 'apiKeyExcludedPatch':
        resources = resources.map((r) =>
          r.id === op.resourceId ? applyExcludedPatch(r, op.modelsWithoutStar) : r
        );
        break;
      case 'mappingSuspendMerge': {
        const existing = mappingSuspend.get(op.targetKey) ?? [];
        const dedup = new Map<string, SuspendedMapping>();
        existing.forEach((e) => dedup.set(suspendedMappingIdentity(e), e));
        op.entries.forEach((e) => dedup.set(suspendedMappingIdentity(e), e));
        mappingSuspend.set(op.targetKey, Array.from(dedup.values()));
        break;
      }
      case 'mappingSuspendTake':
        mappingSuspend.delete(op.targetKey);
        break;
      case 'mappingSuspendClearAlias':
        mappingSuspend.forEach((items, key) => {
          const filtered = items.filter((it) => lower(it.alias) !== op.aliasKey);
          if (filtered.length === 0) mappingSuspend.delete(key);
          else if (filtered.length !== items.length) mappingSuspend.set(key, filtered);
        });
        break;
      case 'catalogSuspendMerge': {
        const key = catalogAccessKey(op.resourceId, op.modelId);
        const existing = catalogSuspend.get(key) ?? [];
        const names = new Set(
          existing.map((e) => String(e?.name ?? '').trim().toLowerCase())
        );
        const merged = [...existing];
        op.entries.forEach((e) => {
          const n = String(e?.name ?? '').trim().toLowerCase();
          if (n && !names.has(n)) {
            names.add(n);
            merged.push(e);
          }
        });
        catalogSuspend.set(key, merged);
        break;
      }
      case 'catalogSuspendTake':
        catalogSuspend.delete(catalogAccessKey(op.resourceId, op.modelId));
        break;
      case 'managedExcludeMark':
        managedExcludeKeys.add(op.key);
        break;
      case 'managedExcludeUnmark':
        managedExcludeKeys.delete(op.key);
        break;
      case 'mappingClaim':
        claims.add(op.aliasKey);
        break;
      case 'mappingUnclaim':
        claims.delete(op.aliasKey);
        break;
    }
  }

  return {
    sources: {
      oauthModels: sources.oauthModels,
      resources,
      oauthAliasMap,
      oauthExcludedMap,
    },
    mirrors: {
      mappingSuspend,
      catalogSuspend,
      managedExcludeKeys,
      claims,
    },
  };
}

function applyModelsPut(
  resource: ProviderResource,
  models: ModelAlias[]
): ProviderResource {
  const raw = (resource.raw ?? {}) as Record<string, unknown>;
  const names = models
    .map((m) => String(m?.name ?? '').trim())
    .filter(Boolean);
  return {
    ...resource,
    raw: { ...raw, models: models.length ? models : undefined },
    models: names,
    modelCount: names.length,
  };
}

function applyExcludedPatch(
  resource: ProviderResource,
  withoutStar: string[]
): ProviderResource {
  const raw = (resource.raw ?? {}) as { excludedModels?: string[] } & Record<
    string,
    unknown
  >;
  const disabled = hasDisableAllModelsRule(raw.excludedModels);
  const cleaned = withoutStar
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && v !== '*');
  const nextExcluded = disabled
    ? withDisableAllModelsRule(cleaned)
    : cleaned.length
      ? cleaned
      : undefined;
  return {
    ...resource,
    raw: { ...raw, excludedModels: nextExcluded },
  };
}
