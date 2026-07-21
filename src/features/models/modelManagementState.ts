/** Derived model-management state for the v2 alias model. */

import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import {
  accessEnabledKey,
  mappingTargetKey,
  toAliasKey,
  type MappingTargetRef,
} from './modelMapping';
import type { ModelAccessRow } from './modelAccessRows';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  sortModelAccessRows,
} from './modelAccessRows';
import {
  clearLegacyModelManagementState,
  loadExplicitIdentityKeys,
  loadMappingDisabled,
  loadModelDisabledSnapshots,
  type DisabledMapping,
  type DisabledModelSnapshot,
} from './modelDisabledState';

const lower = (value: string): string => value.trim().toLowerCase();

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models.map((model) => ({
    ...model,
    name: String(model.name ?? '').trim(),
    alias: String(model.alias ?? model.name ?? '').trim(),
  }));
}

export type ModelDisplayContext = {
  oauthProviderLabel: (channel: string) => string;
  apiKeyProviderLabel: (resourceId: string, brand: ProviderBrand) => string;
  oauthIcon: (channel: string) => string | null;
  apiKeyIcon: (resourceId: string, brand: ProviderBrand) => string | null;
  oauthDisplayNames: Record<string, Record<string, string>>;
};

export type ModelManagementSources = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
};

export type ModelManagementMirrors = {
  mappingDisabled: Map<string, DisabledMapping[]>;
  modelDisabled: Map<string, DisabledModelSnapshot>;
  explicitIdentityKeys: Set<string>;
};

export function emptyMirrors(): ModelManagementMirrors {
  return {
    mappingDisabled: new Map(),
    modelDisabled: new Map(),
    explicitIdentityKeys: new Set(),
  };
}

export function loadMirrorsFromAdapters(apiBase: string): ModelManagementMirrors {
  clearLegacyModelManagementState(apiBase);
  return {
    mappingDisabled: loadMappingDisabled(apiBase),
    modelDisabled: loadModelDisabledSnapshots(apiBase),
    explicitIdentityKeys: loadExplicitIdentityKeys(apiBase),
  };
}

export type ModelAccessEntry = ModelAccessRow & {
  ref: MappingTargetRef;
  suspendedCatalogEntries?: ModelAlias[];
};

export type ModelAccessState = {
  byKey: Map<string, ModelAccessEntry>;
};

export type ModelMappingTarget = MappingTargetRef & {
  displayName: string;
  providerLabel: string;
  iconSrc: string | null;
  suspended: boolean;
  disabledReason?: 'model' | 'mapping';
  aliasOrigin?: 'auto' | 'explicit';
  fork?: boolean;
  forceMapping?: boolean;
};

export type ModelMappingChannel = {
  alias: string;
  aliasKey: string;
  targets: ModelMappingTarget[];
};

export type ModelMappingState = {
  byAliasKey: Map<string, ModelMappingChannel>;
};

export type ModelCatalogs = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
};

export type ModelManagementState = {
  access: ModelAccessState;
  mapping: ModelMappingState;
  explicitIdentityKeys: Set<string>;
  modelDisabled: Map<string, DisabledModelSnapshot>;
  mappingDisabled: Map<string, DisabledMapping[]>;
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  catalogs: ModelCatalogs;
};

export function buildStateFromSources(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelManagementState {
  return {
    access: buildAccessState(sources, mirrors, ctx),
    mapping: buildMappingState(sources, mirrors, ctx),
    explicitIdentityKeys: new Set(mirrors.explicitIdentityKeys),
    modelDisabled: new Map(mirrors.modelDisabled),
    mappingDisabled: new Map(mirrors.mappingDisabled),
    oauthAliasMap: sources.oauthAliasMap,
    oauthExcludedMap: sources.oauthExcludedMap,
    catalogs: { oauthModels: sources.oauthModels, resources: sources.resources },
  };
}

function buildAccessState(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelAccessState {
  const rows: ModelAccessRow[] = [];
  const modelDisabledKeys = new Set(mirrors.modelDisabled.keys());

  Object.entries(sources.oauthModels ?? {}).forEach(([channelRaw, models]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(models)) return;
    rows.push(
      ...buildOAuthAccessRows({
        channel,
        models,
        excluded: sources.oauthExcludedMap,
        providerLabel: ctx.oauthProviderLabel(channel),
        iconSrc: ctx.oauthIcon(channel),
      }).map((row) => (modelDisabledKeys.has(row.key) ? { ...row, enabled: false } : row))
    );
  });

  const suspendedByResource = new Map<string, string[]>();
  mirrors.modelDisabled.forEach((snapshot) => {
    if (snapshot.target.source !== 'apiKey') return;
    const modelId = snapshot.target.modelId.trim();
    if (!modelId) return;
    const list = suspendedByResource.get(snapshot.target.resourceId) ?? [];
    list.push(modelId);
    suspendedByResource.set(snapshot.target.resourceId, list);
  });

  sources.resources.forEach((resource) => {
    const disabledIds = new Set(
      Array.from(mirrors.modelDisabled.values())
        .filter(
          (snapshot) =>
            snapshot.target.source === 'apiKey' && snapshot.target.resourceId === resource.id
        )
        .map((snapshot) => lower(snapshot.target.modelId))
    );
    rows.push(
      ...buildApiKeyAccessRows({
        resource: disabledIds.size
          ? {
              ...resource,
              models: resource.models.filter((model) => !disabledIds.has(lower(model))),
            }
          : resource,
        providerLabel: ctx.apiKeyProviderLabel(resource.id, resource.brand),
        iconSrc: ctx.apiKeyIcon(resource.id, resource.brand),
        suspendedCatalogModelIds: suspendedByResource.get(resource.id) ?? [],
      })
    );
  });

  const sorted = sortModelAccessRows(rows);
  const byKey = new Map<string, ModelAccessEntry>();
  sorted.forEach((row) => {
    const ref = accessRowToRef(row);
    if (!ref) return;
    byKey.set(row.key, {
      ...row,
      ref,
      suspendedCatalogEntries:
        ref.source === 'apiKey' ? (mirrors.modelDisabled.get(row.key)?.entries as ModelAlias[]) : undefined,
    });
  });
  return { byKey };
}

function accessRowToRef(row: ModelAccessRow): MappingTargetRef | null {
  const modelId = row.modelId.trim();
  if (!modelId) return null;
  if (row.source === 'oauth') {
    const channel = normalizeProviderKey(row.oauthChannel ?? row.channelOrBrand);
    return channel ? { source: 'oauth', channel, modelId } : null;
  }
  if (!row.resourceId || !row.brand) return null;
  return { source: 'apiKey', resourceId: row.resourceId, brand: row.brand, modelId };
}

type MappingCandidate = {
  alias: string;
  target: MappingTargetRef;
  displayName: string;
  providerLabel: string;
  iconSrc: string | null;
  suspended: boolean;
  disabledReason?: 'model' | 'mapping';
  aliasOrigin: 'auto' | 'explicit';
  fork?: boolean;
  forceMapping?: boolean;
};

function buildMappingState(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelMappingState {
  const candidates: MappingCandidate[] = [];
  const modelDisabledKeys = new Set(mirrors.modelDisabled.keys());
  const explicitKeys = mirrors.explicitIdentityKeys;
  const push = (candidate: MappingCandidate) => {
    if (!candidate.alias || !candidate.target.modelId) return;
    candidates.push(candidate);
  };

  Object.entries(sources.oauthModels ?? {}).forEach(([channelRaw, models]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(models)) return;
    const configured = sources.oauthAliasMap[channel] ?? [];
    const configuredByModel = new Map<string, OAuthModelAliasEntry[]>();
    configured.forEach((entry) => {
      const modelId = String(entry.name ?? '').trim();
      if (!modelId) return;
      const list = configuredByModel.get(lower(modelId)) ?? [];
      list.push(entry);
      configuredByModel.set(lower(modelId), list);
      const ref: MappingTargetRef = { source: 'oauth', channel, modelId };
      push({
        alias: String(entry.alias ?? modelId).trim() || modelId,
        target: ref,
        displayName: (ctx.oauthDisplayNames[channel]?.[lower(modelId)] || modelId).trim() || modelId,
        providerLabel: ctx.oauthProviderLabel(channel),
        iconSrc: ctx.oauthIcon(channel),
        suspended: false,
        disabledReason: modelDisabledKeys.has(accessEnabledKey(ref)) ? 'model' : undefined,
        aliasOrigin:
          toAliasKey(String(entry.alias ?? modelId)) === lower(modelId) &&
          !explicitKeys.has(accessEnabledKey(ref))
            ? 'auto'
            : 'explicit',
        fork: entry.fork === true ? true : undefined,
        forceMapping: typeof entry.forceMapping === 'boolean' ? entry.forceMapping : undefined,
      });
    });
    models.forEach((model) => {
      const modelId = String(model.id ?? '').trim();
      if (!modelId || configuredByModel.has(lower(modelId))) return;
      const ref: MappingTargetRef = { source: 'oauth', channel, modelId };
      push({
        alias: modelId,
        target: ref,
        displayName: (ctx.oauthDisplayNames[channel]?.[lower(modelId)] || modelId).trim() || modelId,
        providerLabel: ctx.oauthProviderLabel(channel),
        iconSrc: ctx.oauthIcon(channel),
        suspended: false,
        disabledReason: modelDisabledKeys.has(accessEnabledKey(ref)) ? 'model' : undefined,
        aliasOrigin: explicitKeys.has(accessEnabledKey(ref)) ? 'explicit' : 'auto',
      });
    });
  });

  sources.resources.forEach((resource) => {
    const models = readApiKeyModels(resource);
    const providerLabel = ctx.apiKeyProviderLabel(resource.id, resource.brand);
    const iconSrc = ctx.apiKeyIcon(resource.id, resource.brand);
    models.forEach((model) => {
      const modelId = String(model.name ?? '').trim();
      if (!modelId) return;
      const alias = String(model.alias ?? modelId).trim() || modelId;
      const ref: MappingTargetRef = {
        source: 'apiKey',
        resourceId: resource.id,
        brand: resource.brand,
        modelId,
      };
      if (modelDisabledKeys.has(accessEnabledKey(ref))) return;
      push({
        alias,
        target: ref,
        displayName: modelId,
        providerLabel,
        iconSrc,
        suspended: false,
        disabledReason: modelDisabledKeys.has(accessEnabledKey(ref)) ? 'model' : undefined,
        aliasOrigin:
          toAliasKey(alias) === lower(modelId) && !explicitKeys.has(accessEnabledKey(ref))
            ? 'auto'
            : 'explicit',
      });
    });
  });

  mirrors.modelDisabled.forEach((snapshot) => {
    const t = snapshot.target;
    const displayName =
      t.source === 'oauth'
        ? (ctx.oauthDisplayNames[t.channel]?.[lower(t.modelId)] || t.modelId).trim() || t.modelId
        : t.modelId;
    const providerLabel =
      t.source === 'oauth'
        ? ctx.oauthProviderLabel(t.channel)
        : ctx.apiKeyProviderLabel(t.resourceId, t.brand);
    const iconSrc =
      t.source === 'oauth' ? ctx.oauthIcon(t.channel) : ctx.apiKeyIcon(t.resourceId, t.brand);
    snapshot.entries.forEach((entry) => {
      const modelId = String(entry.name ?? t.modelId).trim() || t.modelId;
      const alias = String(entry.alias ?? modelId).trim() || modelId;
      push({
        alias,
        target: { ...t, modelId },
        displayName,
        providerLabel,
        iconSrc,
        suspended: true,
        disabledReason: 'model',
        aliasOrigin:
          toAliasKey(alias) === lower(modelId) && !explicitKeys.has(accessEnabledKey({ ...t, modelId }))
            ? 'auto'
            : 'explicit',
      });
    });
  });

  mirrors.mappingDisabled.forEach((items) => {
    items.forEach((item) => {
      const t = item.target;
      const alias = item.alias.trim();
      if (!alias) return;
      push({
        alias,
        target: t,
        displayName:
          t.source === 'oauth'
            ? (ctx.oauthDisplayNames[t.channel]?.[lower(t.modelId)] || t.modelId).trim() || t.modelId
            : t.modelId,
        providerLabel:
          t.source === 'oauth'
            ? ctx.oauthProviderLabel(t.channel)
            : ctx.apiKeyProviderLabel(t.resourceId, t.brand),
        iconSrc: t.source === 'oauth' ? ctx.oauthIcon(t.channel) : ctx.apiKeyIcon(t.resourceId, t.brand),
        suspended: true,
        disabledReason: 'mapping',
        aliasOrigin:
          toAliasKey(alias) === lower(t.modelId) && !explicitKeys.has(accessEnabledKey(t))
            ? 'auto'
            : 'explicit',
        fork: item.fork === true ? true : undefined,
        forceMapping: typeof item.forceMapping === 'boolean' ? item.forceMapping : undefined,
      });
    });
  });

  const hasNonIdentity = new Set<string>();
  candidates.forEach((candidate) => {
    if (toAliasKey(candidate.alias) !== lower(candidate.target.modelId)) {
      hasNonIdentity.add(mappingTargetKey(candidate.target));
    }
  });

  const byAliasKey = new Map<string, ModelMappingChannel>();
  candidates.forEach((candidate) => {
    if (
      candidate.aliasOrigin === 'auto' &&
      toAliasKey(candidate.alias) === lower(candidate.target.modelId) &&
      hasNonIdentity.has(mappingTargetKey(candidate.target)) &&
      !candidate.suspended
    ) {
      return;
    }
    const aliasKey = toAliasKey(candidate.alias);
    const channel =
      byAliasKey.get(aliasKey) ?? { alias: candidate.alias, aliasKey, targets: [] };
    if (!channel.targets.some((target) => mappingTargetKey(target) === mappingTargetKey(candidate.target))) {
      channel.targets.push({
        ...candidate.target,
        displayName: candidate.displayName,
        providerLabel: candidate.providerLabel,
        iconSrc: candidate.iconSrc,
        suspended: candidate.suspended,
        disabledReason: candidate.disabledReason,
        aliasOrigin: candidate.aliasOrigin,
        fork: candidate.fork,
        forceMapping: candidate.forceMapping,
      });
    }
    byAliasKey.set(aliasKey, channel);
  });

  return { byAliasKey };
}

export type BuildModelManagementStateInput = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  apiBase: string;
  ctx: ModelDisplayContext;
};

export function buildModelManagementState(input: BuildModelManagementStateInput): ModelManagementState {
  const sources: ModelManagementSources = {
    oauthModels: input.oauthModels ?? {},
    resources: input.resources ?? [],
    oauthAliasMap: input.oauthAliasMap ?? {},
    oauthExcludedMap: input.oauthExcludedMap ?? {},
  };
  return buildStateFromSources(sources, loadMirrorsFromAdapters(input.apiBase), input.ctx);
}

export function collectEnabledAccessKeys(access: ModelAccessState): Set<string> {
  const keys = new Set<string>();
  access.byKey.forEach((entry) => {
    if (entry.enabled) keys.add(entry.key);
  });
  return keys;
}

export function collectDisabledMappingsForTarget(
  mapping: ModelMappingState,
  targetKey: string
): DisabledMapping[] {
  const out: DisabledMapping[] = [];
  mapping.byAliasKey.forEach((channel) => {
    channel.targets.forEach((target) => {
      if (!target.suspended || target.disabledReason !== 'mapping') return;
      if (mappingTargetKey(target) !== targetKey) return;
      out.push({
        alias: channel.alias,
        target: stripTarget(target),
        fork: target.fork === true ? true : undefined,
        forceMapping: typeof target.forceMapping === 'boolean' ? target.forceMapping : undefined,
      });
    });
  });
  return out;
}

function stripTarget(target: ModelMappingTarget): MappingTargetRef {
  if (target.source === 'oauth') {
    return { source: 'oauth', channel: target.channel, modelId: target.modelId };
  }
  return {
    source: 'apiKey',
    resourceId: target.resourceId,
    brand: target.brand,
    modelId: target.modelId,
  };
}

export { accessEnabledKey };
