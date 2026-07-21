/** Immutable optimistic reducer for v2 model operations. */

import {
  hasDisableAllModelsRule,
  withDisableAllModelsRule,
} from '@/components/providers/utils';
import type { ModelAlias } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import { accessEnabledKey, mappingTargetKey } from './modelMapping';
import type { ModelManagementMirrors, ModelManagementSources } from './modelManagementState';
import type { ModelOp } from './modelOps';
import type { DisabledMapping } from './modelDisabledState';

const lower = (value: string): string => value.trim().toLowerCase();

export function applyModelOpsToSources(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ops: ModelOp[]
): { sources: ModelManagementSources; mirrors: ModelManagementMirrors } {
  let oauthAliasMap = { ...sources.oauthAliasMap };
  let oauthExcludedMap = { ...sources.oauthExcludedMap };
  let resources = sources.resources;
  const modelDisabled = new Map(mirrors.modelDisabled);
  const mappingDisabled = new Map(mirrors.mappingDisabled);
  const explicitIdentityKeys = new Set(mirrors.explicitIdentityKeys);

  for (const op of ops) {
    switch (op.kind) {
      case 'oauthAliasPatch':
        oauthAliasMap = { ...oauthAliasMap, [op.channel]: op.entries };
        break;
      case 'oauthExcludedPatch':
        oauthExcludedMap = { ...oauthExcludedMap, [op.channel]: op.models };
        break;
      case 'apiKeyModelsPut':
        resources = resources.map((resource) =>
          resource.id === op.resourceId ? applyModelsPut(resource, op.models) : resource
        );
        break;
      case 'apiKeyExcludedPatch':
        resources = resources.map((resource) =>
          resource.id === op.resourceId ? applyExcludedPatch(resource, op.modelsWithoutStar) : resource
        );
        break;
      case 'modelDisabledPut':
        modelDisabled.set(op.targetKey, op.snapshot);
        break;
      case 'modelDisabledTake':
        modelDisabled.delete(accessEnabledKey(op.target));
        break;
      case 'mappingDisabledMerge': {
        const current = mappingDisabled.get(op.targetKey) ?? [];
        const merged = new Map<string, DisabledMapping>();
        [...current, ...op.entries].forEach((entry) => {
          merged.set(`${lower(entry.alias)}|${mappingTargetKey(entry.target)}`, entry);
        });
        mappingDisabled.set(op.targetKey, Array.from(merged.values()));
        break;
      }
      case 'mappingDisabledTake': {
        const current = mappingDisabled.get(op.targetKey) ?? [];
        const next = current.filter((entry) => lower(entry.alias) !== lower(op.alias));
        if (next.length) mappingDisabled.set(op.targetKey, next);
        else mappingDisabled.delete(op.targetKey);
        break;
      }
      case 'mappingDisabledClearAlias':
        mappingDisabled.forEach((entries, key) => {
          const next = entries.filter((entry) => lower(entry.alias) !== op.aliasKey);
          if (next.length) mappingDisabled.set(key, next);
          else mappingDisabled.delete(key);
        });
        break;
      case 'explicitIdentityMark':
        explicitIdentityKeys.add(accessEnabledKey(op.target));
        break;
      case 'explicitIdentityUnmark':
        explicitIdentityKeys.delete(accessEnabledKey(op.target));
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
    mirrors: { mappingDisabled, modelDisabled, explicitIdentityKeys },
  };
}

function applyModelsPut(resource: ProviderResource, models: ModelAlias[]): ProviderResource {
  const raw = (resource.raw ?? {}) as Record<string, unknown>;
  const names = models.map((model) => String(model.name ?? '').trim()).filter(Boolean);
  return {
    ...resource,
    raw: { ...raw, models: models.length ? models : undefined },
    models: names,
    modelCount: names.length,
  };
}

function applyExcludedPatch(resource: ProviderResource, withoutStar: string[]): ProviderResource {
  const raw = (resource.raw ?? {}) as { excludedModels?: string[] } & Record<string, unknown>;
  const disabled = hasDisableAllModelsRule(raw.excludedModels);
  const cleaned = withoutStar.map((value) => String(value ?? '').trim()).filter((value) => value && value !== '*');
  const nextExcluded = disabled
    ? withDisableAllModelsRule(cleaned)
    : cleaned.length
      ? cleaned
      : undefined;
  return { ...resource, raw: { ...raw, excludedModels: nextExcluded } };
}
