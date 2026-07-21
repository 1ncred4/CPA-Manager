/** Pure planner for the v2 model-management state. */

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
  mappingTargetKey,
  toAliasKey,
  type MappingTargetRef,
} from './modelMapping';
import {
  collectDisabledMappingsForTarget,
  type ModelManagementState,
} from './modelManagementState';
import type { DisabledMapping, DisabledModelSnapshot } from './modelDisabledState';

const lower = (value: string): string => value.trim().toLowerCase();
const same = (a: string, b: string): boolean => lower(a) === lower(b);

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
      kind: 'modelDisabledPut';
      phase: ModelOpPhase;
      queueKey: string;
      targetKey: string;
      snapshot: DisabledModelSnapshot;
    }
  | {
      kind: 'modelDisabledTake';
      phase: ModelOpPhase;
      queueKey: string;
      target: MappingTargetRef;
    }
  | {
      kind: 'mappingDisabledMerge';
      phase: ModelOpPhase;
      queueKey: string;
      targetKey: string;
      entries: DisabledMapping[];
    }
  | {
      kind: 'mappingDisabledTake';
      phase: ModelOpPhase;
      queueKey: string;
      targetKey: string;
      alias: string;
    }
  | {
      kind: 'mappingDisabledClearAlias';
      phase: ModelOpPhase;
      queueKey: string;
      aliasKey: string;
    }
  | {
      kind: 'explicitIdentityMark';
      phase: ModelOpPhase;
      queueKey: string;
      target: MappingTargetRef;
    }
  | {
      kind: 'explicitIdentityUnmark';
      phase: ModelOpPhase;
      queueKey: string;
      target: MappingTargetRef;
    };

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!Array.isArray(raw?.models)) return [];
  return raw.models
    .map((entry) => {
      const name = String(entry?.name ?? '').trim();
      if (!name) return null;
      return { ...entry, name, alias: String(entry?.alias ?? name).trim() || name };
    })
    .filter((entry): entry is ModelAlias => Boolean(entry));
}

function supportsExcludedModels(resource: ProviderResource): boolean {
  // Capability is a provider contract, not whether the optional field happened
  // to be present in the last response.
  return resource.brand !== 'openaiCompatibility';
}

function stripTarget(target: MappingTargetRef): MappingTargetRef {
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

function modelEntriesForTarget(models: ModelAlias[], modelId: string): ModelAlias[] {
  return models.filter((entry) => same(entry.name, modelId));
}

function removeAliases<T extends { alias: string }>(entries: T[], aliases: string[]): T[] {
  const keys = new Set(aliases.map(toAliasKey).filter(Boolean));
  return entries.filter((entry) => !keys.has(toAliasKey(entry.alias)));
}

function upsertAliasBindings(
  entries: OAuthModelAliasEntry[],
  alias: string,
  targets: MappingTargetRef[],
  disabledKeys: Set<string>
): OAuthModelAliasEntry[] {
  const result = removeAliases(entries, [alias]);
  const seen = new Set(
    result.map((entry) => `${lower(entry.name)}|${lower(entry.alias)}`)
  );
  targets
    .filter((target) => target.source === 'oauth' && !disabledKeys.has(mappingTargetKey(target)))
    .forEach((target) => {
      const entryKey = `${lower(target.modelId)}|${lower(alias)}`;
      if (seen.has(entryKey)) return;
      seen.add(entryKey);
      result.push({ name: target.modelId.trim(), alias: alias.trim() });
    });
  return result;
}

function normalizeOauthIdentityEntries(
  entries: OAuthModelAliasEntry[],
  modelIds: string[],
  explicitIdentityKeys: Set<string>,
  channel: string
): OAuthModelAliasEntry[] {
  const normalized = entries
    .map((entry) => ({
      ...entry,
      name: String(entry.name ?? '').trim(),
      alias: String(entry.alias ?? entry.name ?? '').trim() || String(entry.name ?? '').trim(),
    }))
    .filter((entry) => entry.name && entry.alias);
  const ids = new Map<string, string>();
  [...modelIds, ...normalized.map((entry) => entry.name)].forEach((id) => {
    const trimmed = id.trim();
    if (trimmed) ids.set(lower(trimmed), trimmed);
  });
  const result = normalized.filter((entry) => {
    if (!same(entry.name, entry.alias)) return true;
    const key = accessEnabledKey({ source: 'oauth', channel, modelId: entry.name });
    return explicitIdentityKeys.has(key) ||
      !normalized.some((other) => same(other.name, entry.name) && !same(other.name, other.alias));
  });
  ids.forEach((modelId, modelKey) => {
    if (result.some((entry) => same(entry.name, modelId) && same(entry.alias, modelId))) return;
    const key = accessEnabledKey({ source: 'oauth', channel, modelId });
    if (
      explicitIdentityKeys.has(key) ||
      !normalized.some((entry) => same(entry.name, modelKey) && !same(entry.name, entry.alias))
    ) {
      result.push({ name: modelId, alias: modelId });
    }
  });
  return dedupeEntries(result);
}

function upsertApiKeyBindings(
  models: ModelAlias[],
  alias: string,
  targets: MappingTargetRef[],
  disabledKeys: Set<string>
): ModelAlias[] {
  let result = models.map((entry) => ({
    ...entry,
    name: String(entry.name ?? '').trim(),
    alias: String(entry.alias ?? entry.name ?? '').trim() || String(entry.name ?? '').trim(),
  }));
  result = result.filter((entry) => entry.name && !same(entry.alias, alias));
  const seen = new Set(result.map((entry) => `${lower(entry.name)}|${lower(entry.alias)}`));
  targets
    .filter((target) => target.source === 'apiKey' && !disabledKeys.has(mappingTargetKey(target)))
    .forEach((target) => {
      const key = `${lower(target.modelId)}|${lower(alias)}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ name: target.modelId.trim(), alias: alias.trim() });
    });
  return dedupeEntries(result);
}

function normalizeApiKeyIdentityEntries(
  models: ModelAlias[],
  resource: ProviderResource,
  explicitIdentityKeys: Set<string>
): ModelAlias[] {
  const normalized = models
    .map((entry) => ({
      ...entry,
      name: String(entry.name ?? '').trim(),
      alias: String(entry.alias ?? entry.name ?? '').trim() || String(entry.name ?? '').trim(),
    }))
    .filter((entry) => entry.name && entry.alias);
  const ids = new Map<string, string>();
  [...(resource.models ?? []), ...normalized.map((entry) => entry.name)].forEach((id) => {
    const trimmed = String(id ?? '').trim();
    if (trimmed) ids.set(lower(trimmed), trimmed);
  });
  const result = normalized.filter((entry) => {
    if (!same(entry.name, entry.alias)) return true;
    const key = accessEnabledKey({
      source: 'apiKey',
      resourceId: resource.id,
      brand: resource.brand,
      modelId: entry.name,
    });
    return explicitIdentityKeys.has(key) ||
      !normalized.some((other) => same(other.name, entry.name) && !same(other.name, other.alias));
  });
  ids.forEach((modelId, modelKey) => {
    if (result.some((entry) => same(entry.name, modelId) && same(entry.alias, modelId))) return;
    const key = accessEnabledKey({
      source: 'apiKey',
      resourceId: resource.id,
      brand: resource.brand,
      modelId,
    });
    if (
      explicitIdentityKeys.has(key) ||
      !normalized.some((entry) => same(entry.name, modelKey) && !same(entry.name, entry.alias))
    ) {
      result.push({ name: modelId, alias: modelId });
    }
  });
  return dedupeEntries(result);
}

function dedupeEntries<T extends { name: string; alias: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${lower(entry.name)}|${lower(entry.alias)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function snapshotWithAlias(
  snapshot: DisabledModelSnapshot,
  baselineAlias: string,
  finalAlias: string,
  selected: Set<string>,
  disabledMappingKeys: Set<string>
): DisabledModelSnapshot {
  const entries = snapshot.entries.map((entry) => ({
    ...entry,
    name: String(entry.name ?? '').trim(),
    alias: String(entry.alias ?? entry.name ?? '').trim() || String(entry.name ?? '').trim(),
  }));
  const withoutOld = entries.filter((entry) => {
    if (same(entry.alias, baselineAlias)) return false;
    if (baselineAlias !== finalAlias && same(entry.alias, finalAlias)) return false;
    return true;
  });
  if (selected.has(mappingTargetKey(snapshot.target)) && !disabledMappingKeys.has(mappingTargetKey(snapshot.target))) {
    withoutOld.push({ name: snapshot.target.modelId, alias: finalAlias });
  }
  const normalized =
    snapshot.target.source === 'oauth'
      ? normalizeOauthIdentityEntries(
          withoutOld as OAuthModelAliasEntry[],
          [],
          new Set(),
          snapshot.target.channel
        )
      : (withoutOld as ModelAlias[]);
  if (
    !normalized.some((entry) => same(entry.name, snapshot.target.modelId) && same(entry.alias, entry.name)) &&
    !normalized.some((entry) => same(entry.name, snapshot.target.modelId) && !same(entry.alias, entry.name))
  ) {
    normalized.push({ name: snapshot.target.modelId, alias: snapshot.target.modelId });
  }
  return { target: snapshot.target, entries: dedupeEntries(normalized) };
}

function isSameEntries(a: Array<{ name: string; alias: string }>, b: Array<{ name: string; alias: string }>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function currentDisabledMappingEntries(state: ModelManagementState, targetKey: string): DisabledMapping[] {
  return collectDisabledMappingsForTarget(state.mapping, targetKey);
}

function addExplicitIdentityOps(
  state: ModelManagementState,
  baselineAlias: string,
  finalAlias: string,
  baselineTargets: MappingTargetRef[],
  selectedTargets: MappingTargetRef[],
  queueKey: string,
  out: ModelOp[]
): void {
  const selected = new Set(selectedTargets.map(mappingTargetKey));
  const candidates = new Map<string, MappingTargetRef>();
  [...baselineTargets, ...selectedTargets].forEach((target) => candidates.set(mappingTargetKey(target), target));
  candidates.forEach((target, targetKey) => {
    const identityBefore = same(baselineAlias, target.modelId);
    const identityAfter = same(finalAlias, target.modelId) && selected.has(targetKey);
    if (identityAfter && !state.explicitIdentityKeys.has(targetKey)) {
      out.push({ kind: 'explicitIdentityMark', phase: 'after-backend', queueKey, target: stripTarget(target) });
    } else if (identityBefore && !selected.has(targetKey) && state.explicitIdentityKeys.has(targetKey)) {
      out.push({ kind: 'explicitIdentityUnmark', phase: 'after-backend', queueKey, target: stripTarget(target) });
    }
  });
}

export type PlanAccessToggleInput = {
  state: ModelManagementState;
  ref: MappingTargetRef;
  nextEnabled: boolean;
};

export function planAccessToggle(input: PlanAccessToggleInput): ModelOp[] {
  const { state, ref, nextEnabled } = input;
  const modelDisabled = state.modelDisabled ?? new Map<string, DisabledModelSnapshot>();
  const targetKey = accessEnabledKey(ref);
  const queueKey = ref.source === 'oauth' ? normalizeProviderKey(ref.channel) : ref.resourceId;
  const ops: ModelOp[] = [];
  if (ref.source === 'oauth') {
    const channel = normalizeProviderKey(ref.channel);
    const rules = normalizeOAuthExcludedRules(state.oauthExcludedMap[channel] ?? []);
    const nextRules = updateOAuthExcludedRule(rules, ref.modelId, !nextEnabled);
    if (JSON.stringify(rules) !== JSON.stringify(nextRules)) {
      ops.push({ kind: 'oauthExcludedPatch', phase: 'backend', queueKey, channel, models: nextRules });
    }
    return ops;
  }
  const resource = state.catalogs.resources.find((item) => item.id === ref.resourceId);
  if (!resource) return ops;
  if (supportsExcludedModels(resource)) {
    const raw = resource.raw as { excludedModels?: string[] };
    const current = stripDisableAllModelsRule(Array.isArray(raw.excludedModels) ? raw.excludedModels : []);
    const next = toggleApiKeyExcludedList(current, ref.modelId, !nextEnabled);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      ops.push({
        kind: 'apiKeyExcludedPatch',
        phase: 'backend',
        queueKey,
        resourceId: resource.id,
        brand: resource.brand,
        modelsWithoutStar: next,
      });
    }
    return ops;
  }

  const models = readApiKeyModels(resource);
  if (!nextEnabled) {
    const removed = modelEntriesForTarget(models, ref.modelId);
    if (!removed.length) return ops;
    ops.push({
      kind: 'modelDisabledPut',
      phase: 'before-backend',
      queueKey,
      targetKey,
      snapshot: { target: stripTarget(ref), entries: removed },
    });
    ops.push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: models.filter((entry) => !same(entry.name, ref.modelId)),
    });
  } else {
    const snapshot = modelDisabled.get(targetKey);
    if (!snapshot) return ops;
    ops.push({
      kind: 'apiKeyModelsPut',
      phase: 'backend',
      queueKey,
      resourceId: resource.id,
      brand: resource.brand,
      models: dedupeEntries([...models, ...(snapshot.entries as ModelAlias[])]),
    });
    ops.push({ kind: 'modelDisabledTake', phase: 'after-backend', queueKey, target: stripTarget(ref) });
  }
  return ops;
}

export type AliasDraft = {
  alias: string;
  previousAliasKey: string | null;
  baselineAlias: string;
  isEditing: boolean;
  selectedTargets: MappingTargetRef[];
  /** Exact non-identity bindings that should remain locally disabled. */
  disabledTargets: DisabledMapping[];
  /** Kept as an input compatibility alias for older callers during rollout. */
  suspendedTargets?: DisabledMapping[];
};

export type PlanAliasSaveResult = { ops: ModelOp[]; forked: number; excluded: number };

function allTargetsForAlias(state: ModelManagementState, aliasKey: string): MappingTargetRef[] {
  return (state.mapping.byAliasKey.get(aliasKey)?.targets ?? []).map(stripTarget);
}

function sourceKeysForTargets(targets: MappingTargetRef[]): Set<string> {
  return new Set(
    targets.map((target) =>
      target.source === 'oauth' ? `oauth:${normalizeProviderKey(target.channel)}` : `apiKey:${target.resourceId}`
    )
  );
}

function targetQueueKey(target: MappingTargetRef): string {
  return target.source === 'oauth'
    ? normalizeProviderKey(target.channel)
    : target.resourceId;
}

function planAliasBackendForSource(
  state: ModelManagementState,
  finalAlias: string,
  baselineAlias: string,
  targets: MappingTargetRef[],
  disabledKeys: Set<string>,
  explicitIdentityKeys: Set<string>,
  out: ModelOp[]
): void {
  const aliasNames = baselineAlias && !same(baselineAlias, finalAlias)
    ? [baselineAlias, finalAlias]
    : [finalAlias];
  const selectedBySource = new Map<string, MappingTargetRef[]>();
  targets.forEach((target) => {
    const sourceKey = target.source === 'oauth'
      ? `oauth:${normalizeProviderKey(target.channel)}`
      : `apiKey:${target.resourceId}`;
    const list = selectedBySource.get(sourceKey) ?? [];
    list.push(target);
    selectedBySource.set(sourceKey, list);
  });
  const sourceKeys = new Set<string>([
    ...sourceKeysForTargets(targets),
    ...sourceKeysForTargets(allTargetsForAlias(state, toAliasKey(baselineAlias))),
  ]);

  sourceKeys.forEach((sourceKey) => {
    if (sourceKey.startsWith('oauth:')) {
      const channel = sourceKey.slice('oauth:'.length);
      let entries = state.oauthAliasMap[channel] ?? [];
      entries = removeAliases(entries, aliasNames);
      entries = upsertAliasBindings(entries, finalAlias, selectedBySource.get(sourceKey) ?? [], disabledKeys);
      const modelIds = state.catalogs.oauthModels[channel]?.map((model) => model.id) ?? [];
      entries = normalizeOauthIdentityEntries(entries, modelIds, explicitIdentityKeys, channel);
      if (JSON.stringify(entries) !== JSON.stringify(state.oauthAliasMap[channel] ?? [])) {
        out.push({ kind: 'oauthAliasPatch', phase: 'backend', queueKey: channel, channel, entries });
      }
      return;
    }

    const resourceId = sourceKey.slice('apiKey:'.length);
    const resource = state.catalogs.resources.find((item) => item.id === resourceId);
    if (!resource || !supportsExcludedModels(resource)) {
      // A catalog-disabled model has no backend entry; its snapshot is handled below.
      if (!resource) return;
      let models = readApiKeyModels(resource);
      models = upsertApiKeyBindings(models, finalAlias, selectedBySource.get(sourceKey) ?? [], disabledKeys);
      models = normalizeApiKeyIdentityEntries(models, resource, explicitIdentityKeys);
      if (JSON.stringify(models) !== JSON.stringify(readApiKeyModels(resource))) {
        out.push({ kind: 'apiKeyModelsPut', phase: 'backend', queueKey: resourceId, resourceId, brand: resource.brand, models });
      }
      return;
    }
    let models = readApiKeyModels(resource);
    models = upsertApiKeyBindings(models, finalAlias, selectedBySource.get(sourceKey) ?? [], disabledKeys);
    models = normalizeApiKeyIdentityEntries(models, resource, explicitIdentityKeys);
    if (JSON.stringify(models) !== JSON.stringify(readApiKeyModels(resource))) {
      out.push({ kind: 'apiKeyModelsPut', phase: 'backend', queueKey: resourceId, resourceId, brand: resource.brand, models });
    }
  });
}

export function planAliasSave(input: { state: ModelManagementState; draft: AliasDraft }): PlanAliasSaveResult {
  const { state, draft } = input;
  const modelDisabled = state.modelDisabled ?? new Map<string, DisabledModelSnapshot>();
  const finalAlias = draft.alias.trim();
  const baselineAlias = draft.baselineAlias.trim();
  if (!finalAlias) return { ops: [], forked: 0, excluded: 0 };
  const baselineAliasKey = toAliasKey(baselineAlias);
  const baselineTargets = baselineAliasKey ? allTargetsForAlias(state, baselineAliasKey) : [];
  const selectedTargets = draft.selectedTargets.map(stripTarget);
  const disabledTargets = draft.disabledTargets ?? draft.suspendedTargets ?? [];
  const disabledKeys = new Set(disabledTargets.map((entry) => mappingTargetKey(entry.target)));
  const selectedKeys = new Set(selectedTargets.map(mappingTargetKey));
  const ops: ModelOp[] = [];

  const allAffected = new Map<string, MappingTargetRef>();
  [...baselineTargets, ...selectedTargets, ...disabledTargets.map((entry) => entry.target)].forEach((target) => {
    allAffected.set(mappingTargetKey(target), target);
  });

  const explicitIdentityKeys = new Set(state.explicitIdentityKeys);
  allAffected.forEach((target, targetKey) => {
    if (same(finalAlias, target.modelId) && selectedKeys.has(targetKey)) explicitIdentityKeys.add(targetKey);
    if (same(baselineAlias, target.modelId) && !selectedKeys.has(targetKey)) explicitIdentityKeys.delete(targetKey);
  });

  // Active source bindings are written once per source.  Model-disabled targets
  // are omitted from the backend and updated in their v2 snapshots below.
  planAliasBackendForSource(
    state,
    finalAlias,
    baselineAlias,
    selectedTargets,
    new Set([...disabledKeys, ...Array.from(modelDisabled.keys())]),
    explicitIdentityKeys,
    ops
  );

  // Update snapshots even when the model is currently disabled; this is the
  // important "edit while disabled, restore latest mapping" behavior.
  // The state exposes disabled snapshots through access entries.  Build a
  // snapshot from each affected disabled access target and preserve all aliases.
  allAffected.forEach((_target, targetKey) => {
    const snapshot = modelDisabled.get(targetKey);
    if (!snapshot?.entries.length) return;
    const next = snapshotWithAlias(snapshot, baselineAlias, finalAlias, selectedKeys, disabledKeys);
    if (!isSameEntries(snapshot.entries as Array<{ name: string; alias: string }>, next.entries as Array<{ name: string; alias: string }>)) {
      ops.push({ kind: 'modelDisabledPut', phase: 'after-backend', queueKey: targetQueueKey(next.target), targetKey, snapshot: next });
    }
  });

  // Non-identity mapping disables are exact alias/target records.  Active
  // selection restores the record; remaining disabled records are rewritten.
  const disabledByTarget = new Map<string, DisabledMapping[]>();
  disabledTargets.forEach((entry) => {
    if (same(entry.alias, finalAlias)) {
      const key = accessEnabledKey(entry.target);
      const list = disabledByTarget.get(key) ?? [];
      list.push({ ...entry, alias: finalAlias });
      disabledByTarget.set(key, list);
    }
  });
  baselineTargets.forEach((target) => {
    const targetKey = mappingTargetKey(target);
    if (selectedKeys.has(targetKey) || target.source === 'oauth' && same(finalAlias, target.modelId)) return;
    if (target.source === 'oauth' && same(finalAlias, target.modelId)) return;
    if (disabledKeys.has(targetKey)) return;
    if (target.source === 'oauth' || target.source === 'apiKey') {
      const existing = currentDisabledMappingEntries(state, accessEnabledKey(target));
      if (existing.some((entry) => same(entry.alias, baselineAlias))) return;
      disabledByTarget.set(accessEnabledKey(target), [{ alias: finalAlias, target }]);
    }
  });
  disabledByTarget.forEach((entries, targetKey) => {
    if (entries.length) {
      ops.push({ kind: 'mappingDisabledMerge', phase: 'before-backend', queueKey: targetQueueKey(entries[0].target), targetKey, entries });
    }
  });
  const currentDisabled = new Map<string, DisabledMapping[]>();
  state.mapping.byAliasKey.forEach((channel) => {
    channel.targets.forEach((target) => {
      if (!target.suspended || target.disabledReason !== 'mapping') return;
      const targetKey = accessEnabledKey(target);
      const desired = disabledTargets.some((entry) => same(entry.alias, finalAlias) && mappingTargetKey(entry.target) === mappingTargetKey(target));
      if (!desired && same(channel.alias, baselineAlias)) {
        ops.push({ kind: 'mappingDisabledTake', phase: 'after-backend', queueKey: targetQueueKey(target), targetKey, alias: channel.alias });
      }
    });
  });
  void currentDisabled;

  addExplicitIdentityOps(state, baselineAlias, finalAlias, baselineTargets, selectedTargets, `identity:${toAliasKey(finalAlias)}`, ops);
  return { ops, forked: 0, excluded: 0 };
}

export function planAliasDelete(input: { state: ModelManagementState; aliasKey: string }): ModelOp[] {
  const channel = input.state.mapping.byAliasKey.get(toAliasKey(input.aliasKey));
  if (!channel) return [];
  return planAliasSave({
    state: input.state,
    draft: {
      alias: channel.alias,
      previousAliasKey: channel.aliasKey,
      baselineAlias: channel.alias,
      isEditing: true,
      selectedTargets: [],
      disabledTargets: [],
    },
  }).ops.concat({
    kind: 'mappingDisabledClearAlias',
    phase: 'after-backend',
    queueKey: `mapping-alias:${channel.aliasKey}`,
    aliasKey: channel.aliasKey,
  });
}

export type ProviderFormDelta = { ref: MappingTargetRef; nextEnabled: boolean };

export function planProviderFormDeltas(input: {
  state: ModelManagementState;
  resource: ProviderResource;
  deltas: ProviderFormDelta[];
}): ModelOp[] {
  const ops: ModelOp[] = [];
  if (supportsExcludedModels(input.resource)) return ops;
  for (const delta of input.deltas) {
    if (delta.ref.source !== 'apiKey' || delta.ref.resourceId !== input.resource.id) continue;
    const targetKey = accessEnabledKey(delta.ref);
    if (!delta.nextEnabled) {
      const entries = modelEntriesForTarget(readApiKeyModels(input.resource), delta.ref.modelId);
      if (entries.length) {
        ops.push({ kind: 'modelDisabledPut', phase: 'before-backend', queueKey: input.resource.id, targetKey, snapshot: { target: stripTarget(delta.ref), entries } });
      }
    } else {
      ops.push({ kind: 'modelDisabledTake', phase: 'after-backend', queueKey: input.resource.id, target: stripTarget(delta.ref) });
    }
  }
  return ops;
}

export { lower };
