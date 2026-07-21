/**
 * Model-management v2 local state.
 *
 * The backend stores model catalog entries and alias bindings together.  The
 * UI therefore keeps two small, explicit snapshots:
 * - modelDisabled: full entries removed because a provider has no exclude rule;
 * - mappingDisabled: one exact alias -> target binding removed by the mapping UI.
 *
 * This module intentionally does not read any v1 state.  The first v2 load
 * removes the old stores so stale manual/automatic identity state cannot leak
 * into the new projection.
 */

import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import { normalizeApiBase } from '@/utils/connection';
import {
  accessEnabledKey,
  mappingTargetKey,
  toAliasKey,
  type MappingTargetRef,
} from './modelMapping';

export type DisabledMapping = {
  alias: string;
  target: MappingTargetRef;
  fork?: boolean;
  forceMapping?: boolean;
};

export type DisabledModelSnapshot = {
  target: MappingTargetRef;
  entries: ModelAlias[] | OAuthModelAliasEntry[];
};

export type ModelDisabledStore = {
  version: 2;
  modelByTarget: Record<string, DisabledModelSnapshot>;
  mappingByTarget: Record<string, DisabledMapping[]>;
  explicitIdentityKeys: string[];
};

const STORAGE_PREFIX = 'cpa-manager:model-management:v2:';

export const MODEL_MANAGEMENT_CHANGED_EVENT = 'cpa-manager:model-management-v2-changed';

const lower = (value: string): string => value.trim().toLowerCase();

export function modelManagementStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function disabledMappingIdentity(entry: DisabledMapping): string {
  return `${toAliasKey(entry.alias)}|${mappingTargetKey(entry.target)}`;
}

function emptyStore(): ModelDisabledStore {
  return { version: 2, modelByTarget: {}, mappingByTarget: {}, explicitIdentityKeys: [] };
}

function readStore(apiBase: string): ModelDisabledStore {
  if (typeof window === 'undefined' || !window.localStorage) return emptyStore();
  try {
    const raw = window.localStorage.getItem(modelManagementStorageKey(apiBase));
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<ModelDisabledStore>;
    if (
      parsed.version !== 2 ||
      !parsed.modelByTarget ||
      !parsed.mappingByTarget ||
      !Array.isArray(parsed.explicitIdentityKeys)
    ) {
      return emptyStore();
    }
    return {
      version: 2,
      modelByTarget: parsed.modelByTarget,
      mappingByTarget: parsed.mappingByTarget,
      explicitIdentityKeys: parsed.explicitIdentityKeys.map(String).filter(Boolean),
    };
  } catch {
    return emptyStore();
  }
}

function notifyChanged(apiBase: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(MODEL_MANAGEMENT_CHANGED_EVENT, { detail: { apiBase } }));
  } catch {
    // ignore
  }
}

function writeStore(apiBase: string, store: ModelDisabledStore): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const hasModels = Object.keys(store.modelByTarget).length > 0;
    const hasMappings = Object.keys(store.mappingByTarget).length > 0;
    const hasIdentity = store.explicitIdentityKeys.length > 0;
    if (!hasModels && !hasMappings && !hasIdentity) {
      window.localStorage.removeItem(modelManagementStorageKey(apiBase));
    } else {
      window.localStorage.setItem(
        modelManagementStorageKey(apiBase),
        JSON.stringify({
          version: 2,
          modelByTarget: store.modelByTarget,
          mappingByTarget: store.mappingByTarget,
          explicitIdentityKeys: Array.from(new Set(store.explicitIdentityKeys)).sort(),
        } satisfies ModelDisabledStore)
      );
    }
    notifyChanged(apiBase);
  } catch {
    // quota / private mode — best effort
  }
}

export function clearLegacyModelManagementState(apiBase: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const normalized = normalizeApiBase(apiBase) || 'default';
  const legacyKeys = [
    `cpa-manager:suspended-model-mappings:v1:${normalized}`,
    `cpa-manager:suspended-model-catalog:v1:${normalized}`,
    `cpa-manager:managed-identity-exclude:v1:${normalized}`,
    `cpa-manager:manual-mapping-claims:v1:${normalized}`,
  ];
  legacyKeys.forEach((key) => window.localStorage.removeItem(key));
}

export function loadModelDisabledSnapshots(apiBase: string): Map<string, DisabledModelSnapshot> {
  return new Map(Object.entries(readStore(apiBase).modelByTarget));
}

export function mergeModelDisabledSnapshot(
  apiBase: string,
  snapshot: DisabledModelSnapshot
): DisabledModelSnapshot {
  const store = readStore(apiBase);
  const key = accessEnabledKey(snapshot.target);
  const existing = store.modelByTarget[key];
  const entries = new Map<string, ModelAlias | OAuthModelAliasEntry>();
  const identity = (entry: ModelAlias | OAuthModelAliasEntry) =>
    `${lower(String(entry.name ?? ''))}|${lower(String(entry.alias ?? ''))}`;
  (existing?.entries ?? []).forEach((entry) => entries.set(identity(entry), entry));
  snapshot.entries.forEach((entry) => entries.set(identity(entry), entry));
  const next = {
    target: snapshot.target,
    entries: Array.from(entries.values()),
  } as DisabledModelSnapshot;
  store.modelByTarget[key] = next;
  writeStore(apiBase, store);
  return next;
}

export function putModelDisabledSnapshot(
  apiBase: string,
  snapshot: DisabledModelSnapshot
): void {
  const store = readStore(apiBase);
  const key = accessEnabledKey(snapshot.target);
  store.modelByTarget[key] = {
    target: snapshot.target,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
  };
  writeStore(apiBase, store);
}

export function takeModelDisabledSnapshot(
  apiBase: string,
  target: MappingTargetRef
): DisabledModelSnapshot | null {
  const store = readStore(apiBase);
  const key = accessEnabledKey(target);
  const snapshot = store.modelByTarget[key];
  if (!snapshot) return null;
  delete store.modelByTarget[key];
  writeStore(apiBase, store);
  return snapshot;
}

export function clearModelDisabledSnapshot(apiBase: string, target: MappingTargetRef): void {
  const store = readStore(apiBase);
  const key = accessEnabledKey(target);
  if (!store.modelByTarget[key]) return;
  delete store.modelByTarget[key];
  writeStore(apiBase, store);
}

export function listModelDisabledSnapshots(apiBase: string): DisabledModelSnapshot[] {
  return Object.values(readStore(apiBase).modelByTarget);
}

export function loadMappingDisabled(apiBase: string): Map<string, DisabledMapping[]> {
  const result = new Map<string, DisabledMapping[]>();
  Object.entries(readStore(apiBase).mappingByTarget).forEach(([key, entries]) => {
    result.set(key, [...entries]);
  });
  return result;
}

export function mergeMappingDisabled(
  apiBase: string,
  targetKey: string,
  entries: DisabledMapping[]
): DisabledMapping[] {
  const store = readStore(apiBase);
  const current = store.mappingByTarget[targetKey] ?? [];
  const merged = new Map<string, DisabledMapping>();
  current.forEach((entry) => merged.set(disabledMappingIdentity(entry), entry));
  entries.forEach((entry) => merged.set(disabledMappingIdentity(entry), entry));
  store.mappingByTarget[targetKey] = Array.from(merged.values());
  writeStore(apiBase, store);
  return store.mappingByTarget[targetKey];
}

export function takeMappingDisabled(apiBase: string, targetKey: string): DisabledMapping[] {
  const store = readStore(apiBase);
  const entries = store.mappingByTarget[targetKey] ?? [];
  if (!entries.length) return [];
  delete store.mappingByTarget[targetKey];
  writeStore(apiBase, store);
  return [...entries];
}

export function putMappingDisabled(
  apiBase: string,
  targetKey: string,
  entries: DisabledMapping[]
): void {
  const store = readStore(apiBase);
  if (entries.length) store.mappingByTarget[targetKey] = entries.map((entry) => ({ ...entry }));
  else delete store.mappingByTarget[targetKey];
  writeStore(apiBase, store);
}

export function clearMappingDisabledForAlias(apiBase: string, alias: string): void {
  const aliasKey = toAliasKey(alias);
  if (!aliasKey) return;
  const store = readStore(apiBase);
  Object.keys(store.mappingByTarget).forEach((key) => {
    const next = store.mappingByTarget[key].filter(
      (entry) => toAliasKey(entry.alias) !== aliasKey
    );
    if (next.length) store.mappingByTarget[key] = next;
    else delete store.mappingByTarget[key];
  });
  writeStore(apiBase, store);
}

export function listMappingDisabledForAlias(apiBase: string, alias: string): DisabledMapping[] {
  const aliasKey = toAliasKey(alias);
  if (!aliasKey) return [];
  return Array.from(loadMappingDisabled(apiBase).values())
    .flat()
    .filter((entry) => toAliasKey(entry.alias) === aliasKey);
}

export function takeMappingDisabledForTarget(
  apiBase: string,
  alias: string,
  target: MappingTargetRef
): boolean {
  const targetKey = accessEnabledKey(target);
  const store = readStore(apiBase);
  const prev = store.mappingByTarget[targetKey] ?? [];
  const identity = `${toAliasKey(alias)}|${mappingTargetKey(target)}`;
  const next = prev.filter((entry) => disabledMappingIdentity(entry) !== identity);
  if (next.length === prev.length) return false;
  if (next.length) store.mappingByTarget[targetKey] = next;
  else delete store.mappingByTarget[targetKey];
  writeStore(apiBase, store);
  return true;
}

export function loadExplicitIdentityKeys(apiBase: string): Set<string> {
  return new Set(readStore(apiBase).explicitIdentityKeys);
}

export function markExplicitIdentity(apiBase: string, target: MappingTargetRef): void {
  const store = readStore(apiBase);
  const key = accessEnabledKey(target);
  if (store.explicitIdentityKeys.includes(key)) return;
  store.explicitIdentityKeys.push(key);
  writeStore(apiBase, store);
}

export function unmarkExplicitIdentity(apiBase: string, target: MappingTargetRef): void {
  const store = readStore(apiBase);
  const key = accessEnabledKey(target);
  const next = store.explicitIdentityKeys.filter((item) => item !== key);
  if (next.length === store.explicitIdentityKeys.length) return;
  store.explicitIdentityKeys = next;
  writeStore(apiBase, store);
}

export function __replaceModelManagementStoreForTests(
  apiBase: string,
  store: Partial<ModelDisabledStore>
): void {
  writeStore(apiBase, {
    version: 2,
    modelByTarget: store.modelByTarget ?? {},
    mappingByTarget: store.mappingByTarget ?? {},
    explicitIdentityKeys: store.explicitIdentityKeys ?? [],
  });
}
