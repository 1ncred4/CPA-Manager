/**
 * 禁用模型时「剪枝映射」的挂起记录：
 * 把被摘掉的 alias→目标 存到 localStorage，启用时再写回。
 *
 * 注意：这是管理端本地状态，不是后端契约；换浏览器/清站点数据会丢挂起项。
 */

import type { OAuthModelAliasEntry } from '@/types';
import type { ModelAlias } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { normalizeApiBase } from '@/utils/connection';
import {
  accessEnabledKey,
  isMeaningfulAlias,
  mappingTargetKey,
  toAliasKey,
  type ApiKeyMappingTargetRef,
  type FederatedMappingRow,
  type MappingTarget,
  type MappingTargetRef,
  type OauthMappingTargetRef,
} from './modelMapping';

export type SuspendedMapping = {
  alias: string;
  target: MappingTargetRef;
  fork?: boolean;
  forceMapping?: boolean;
};

type SuspendStoreFile = {
  version: 1;
  /** accessEnabledKey → suspended bindings */
  byTarget: Record<string, SuspendedMapping[]>;
};

const STORAGE_PREFIX = 'cpa-manager:suspended-model-mappings:v1:';

const lower = (value: string): string => value.trim().toLowerCase();

export function suspendedStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function suspendedMappingIdentity(entry: SuspendedMapping): string {
  return `${toAliasKey(entry.alias)}|${mappingTargetKey(entry.target)}`;
}

function readStore(apiBase: string): SuspendStoreFile {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, byTarget: {} };
  }
  try {
    const raw = window.localStorage.getItem(suspendedStorageKey(apiBase));
    if (!raw) return { version: 1, byTarget: {} };
    const parsed = JSON.parse(raw) as SuspendStoreFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.byTarget !== 'object' || !parsed.byTarget) {
      return { version: 1, byTarget: {} };
    }
    return { version: 1, byTarget: parsed.byTarget };
  } catch {
    return { version: 1, byTarget: {} };
  }
}

/** 同页其它 hook 监听挂起变化（localStorage 同 tab 不触发 storage 事件） */
export const SUSPENDED_MAPPINGS_CHANGED_EVENT = 'cpa-manager:suspended-mappings-changed';

function notifySuspendedChanged(apiBase: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(SUSPENDED_MAPPINGS_CHANGED_EVENT, { detail: { apiBase } })
    );
  } catch {
    // ignore
  }
}

function writeStore(apiBase: string, store: SuspendStoreFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keys = Object.keys(store.byTarget);
    if (keys.length === 0) {
      window.localStorage.removeItem(suspendedStorageKey(apiBase));
    } else {
      window.localStorage.setItem(suspendedStorageKey(apiBase), JSON.stringify(store));
    }
    notifySuspendedChanged(apiBase);
  } catch {
    // quota / private mode — best effort
  }
}

/** 扁平列出某 apiBase 下全部挂起绑定 */
export function listAllSuspended(apiBase: string): SuspendedMapping[] {
  const store = readStore(apiBase);
  const all: SuspendedMapping[] = [];
  const seen = new Set<string>();
  Object.values(store.byTarget).forEach((entries) => {
    entries.forEach((entry) => {
      const id = suspendedMappingIdentity(entry);
      if (seen.has(id)) return;
      seen.add(id);
      all.push(entry);
    });
  });
  return all;
}

/** 删除某个自定义名时，清掉该 alias 上所有挂起，避免灰标幽灵行 */
export function clearSuspendedForAlias(apiBase: string, alias: string): void {
  const aliasKey = toAliasKey(alias);
  if (!aliasKey) return;
  const store = readStore(apiBase);
  let changed = false;
  Object.keys(store.byTarget).forEach((targetKey) => {
    const prev = store.byTarget[targetKey] ?? [];
    const next = prev.filter((entry) => toAliasKey(entry.alias) !== aliasKey);
    if (next.length === prev.length) return;
    changed = true;
    if (next.length) store.byTarget[targetKey] = next;
    else delete store.byTarget[targetKey];
  });
  if (changed) writeStore(apiBase, store);
}

export function loadSuspendedForTarget(
  apiBase: string,
  targetKey: string
): SuspendedMapping[] {
  const store = readStore(apiBase);
  return store.byTarget[targetKey] ? [...store.byTarget[targetKey]] : [];
}

export function mergeSuspendedForTarget(
  apiBase: string,
  targetKey: string,
  entries: SuspendedMapping[]
): SuspendedMapping[] {
  if (!entries.length) {
    return loadSuspendedForTarget(apiBase, targetKey);
  }
  const store = readStore(apiBase);
  const existing = store.byTarget[targetKey] ?? [];
  const map = new Map<string, SuspendedMapping>();
  existing.forEach((entry) => map.set(suspendedMappingIdentity(entry), entry));
  entries.forEach((entry) => map.set(suspendedMappingIdentity(entry), entry));
  const merged = Array.from(map.values());
  store.byTarget[targetKey] = merged;
  writeStore(apiBase, store);
  return merged;
}

/** 取出并清除某个目标上的挂起映射 */
export function takeSuspendedForTarget(
  apiBase: string,
  targetKey: string
): SuspendedMapping[] {
  const store = readStore(apiBase);
  const entries = store.byTarget[targetKey] ? [...store.byTarget[targetKey]] : [];
  if (entries.length) {
    delete store.byTarget[targetKey];
    writeStore(apiBase, store);
  }
  return entries;
}

export function clearSuspendedForTarget(apiBase: string, targetKey: string): void {
  const store = readStore(apiBase);
  if (!store.byTarget[targetKey]) return;
  delete store.byTarget[targetKey];
  writeStore(apiBase, store);
}

/** 测试用：覆盖整个 store */
export function __replaceSuspendedStoreForTests(
  apiBase: string,
  byTarget: Record<string, SuspendedMapping[]>
): void {
  writeStore(apiBase, { version: 1, byTarget: { ...byTarget } });
}

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models;
}

/**
 * 找出当前配置里「指向该模型」的全部 alias 绑定（用于禁用时剪枝）。
 */
export function collectMappingsForTarget(input: {
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  resources: ProviderResource[];
  target: MappingTargetRef;
}): SuspendedMapping[] {
  const found: SuspendedMapping[] = [];
  const seen = new Set<string>();

  if (input.target.source === 'oauth') {
    const channel = normalizeProviderKey(input.target.channel);
    const modelKey = lower(input.target.modelId);
    if (!channel || !modelKey) return [];

    const entries = input.modelAlias[channel] ?? [];
    entries.forEach((entry) => {
      const name = String(entry.name ?? '').trim();
      const alias = String(entry.alias ?? '').trim();
      if (!name || !alias) return;
      if (lower(name) !== modelKey) return;
      const target: OauthMappingTargetRef = {
        source: 'oauth',
        channel,
        modelId: name,
      };
      const item: SuspendedMapping = {
        alias,
        target,
        fork: entry.fork === true ? true : undefined,
        forceMapping: typeof entry.forceMapping === 'boolean' ? entry.forceMapping : undefined,
      };
      const id = suspendedMappingIdentity(item);
      if (seen.has(id)) return;
      seen.add(id);
      found.push(item);
    });
    return found;
  }

  const resourceId = input.target.resourceId;
  const modelKey = lower(input.target.modelId);
  const resource = input.resources.find((r) => r.id === resourceId);
  if (!resource || !modelKey) return [];

  readApiKeyModels(resource).forEach((model) => {
    const name = String(model.name ?? '').trim();
    const alias = String(model.alias ?? '').trim();
    if (!name || lower(name) !== modelKey) return;
    if (!isMeaningfulAlias(alias, name)) return;
    const target: ApiKeyMappingTargetRef = {
      source: 'apiKey',
      resourceId,
      brand: resource.brand,
      modelId: name,
    };
    const item: SuspendedMapping = { alias, target };
    const id = suspendedMappingIdentity(item);
    if (seen.has(id)) return;
    seen.add(id);
    found.push(item);
  });

  return found;
}

/**
 * 从 OAuth channel entries 中移除指向 modelId 的别名绑定。
 */
export function pruneOauthEntriesForModel(
  entries: OAuthModelAliasEntry[],
  modelId: string
): { next: OAuthModelAliasEntry[]; removed: OAuthModelAliasEntry[] } {
  const modelKey = lower(modelId);
  const next: OAuthModelAliasEntry[] = [];
  const removed: OAuthModelAliasEntry[] = [];
  entries.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    if (name && lower(name) === modelKey) {
      removed.push(entry);
      return;
    }
    next.push(entry);
  });
  return { next, removed };
}

/**
 * 清空 API Key models[] 里指向 modelId 的 alias 字段。
 */
export function pruneApiKeyModelsForModel(
  models: ModelAlias[],
  modelId: string
): { next: ModelAlias[]; removedAliases: Array<{ modelId: string; alias: string }> } {
  const modelKey = lower(modelId);
  const removedAliases: Array<{ modelId: string; alias: string }> = [];
  const next = models.map((model) => {
    const name = String(model.name ?? '').trim();
    if (!name || lower(name) !== modelKey) return model;
    const alias = String(model.alias ?? '').trim();
    if (!isMeaningfulAlias(alias, name)) return model;
    removedAliases.push({ modelId: name, alias });
    const cloned: ModelAlias = { ...model, name: model.name };
    delete (cloned as { alias?: string }).alias;
    return cloned;
  });
  return { next, removedAliases };
}

/**
 * 把挂起的 OAuth 绑定写回 channel entries。
 * 若同 alias 已占用该 channel 的另一模型，则跳过（避免 channel 级冲突）。
 */
export function restoreOauthEntries(
  entries: OAuthModelAliasEntry[],
  suspended: SuspendedMapping[],
  channel: string
): { next: OAuthModelAliasEntry[]; restored: number; skipped: number } {
  const channelKey = normalizeProviderKey(channel);
  const working = [...entries];
  let restored = 0;
  let skipped = 0;

  suspended.forEach((item) => {
    if (item.target.source !== 'oauth') return;
    if (normalizeProviderKey(item.target.channel) !== channelKey) return;

    const alias = item.alias.trim();
    const modelId = item.target.modelId.trim();
    if (!alias || !modelId) {
      skipped += 1;
      return;
    }
    const aliasKey = toAliasKey(alias);
    const modelKey = lower(modelId);

    const existingForAlias = working.find((e) => toAliasKey(String(e.alias ?? '')) === aliasKey);
    if (existingForAlias) {
      if (lower(String(existingForAlias.name ?? '')) === modelKey) {
        // already present
        restored += 1;
        return;
      }
      skipped += 1;
      return;
    }

    // also skip if same model already mapped under different alias? allow — multi-alias ok for oauth?
    // OAuth is one alias per entry; same model can appear once. If model already has another alias entry, still allow
    // only if that isn't the same alias (handled above). Backend may allow multiple aliases per model with fork.

    const entry: OAuthModelAliasEntry = {
      name: modelId,
      alias,
    };
    // 原样恢复挂起时记录的 fork / forceMapping，不擅自补默认值
    if (item.fork === true) entry.fork = true;
    if (typeof item.forceMapping === 'boolean') entry.forceMapping = item.forceMapping;

    working.push(entry);
    restored += 1;
  });

  return { next: working, restored, skipped };
}

/**
 * 把挂起的 API Key alias 写回 models[]。
 * 若该模型已有不同 alias，则跳过。
 */
export function restoreApiKeyModels(
  models: ModelAlias[],
  suspended: SuspendedMapping[],
  resourceId: string
): { next: ModelAlias[]; restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;

  const aliasByModelKey = new Map<string, string>();
  suspended.forEach((item) => {
    if (item.target.source !== 'apiKey') return;
    if (item.target.resourceId !== resourceId) return;
    const modelKey = lower(item.target.modelId);
    const alias = item.alias.trim();
    if (!modelKey || !alias) return;
    aliasByModelKey.set(modelKey, alias);
  });

  if (aliasByModelKey.size === 0) {
    return { next: models, restored: 0, skipped: 0 };
  }

  const next = models.map((model) => {
    const name = String(model.name ?? '').trim();
    if (!name) return model;
    const modelKey = lower(name);
    const wantAlias = aliasByModelKey.get(modelKey);
    if (!wantAlias) return model;

    const currentAlias = String(model.alias ?? '').trim();
    if (currentAlias) {
      if (toAliasKey(currentAlias) === toAliasKey(wantAlias)) {
        restored += 1;
        return model;
      }
      skipped += 1;
      return model;
    }

    restored += 1;
    return { ...model, alias: wantAlias };
  });

  // models not present in resource → skip counted for remaining
  aliasByModelKey.forEach((_alias, modelKey) => {
    const exists = models.some((m) => lower(String(m.name ?? '')) === modelKey);
    if (!exists) skipped += 1;
  });

  return { next, restored, skipped };
}

export function groupSuspendedByOauthChannel(
  suspended: SuspendedMapping[]
): Map<string, SuspendedMapping[]> {
  const map = new Map<string, SuspendedMapping[]>();
  suspended.forEach((item) => {
    if (item.target.source !== 'oauth') return;
    const channel = normalizeProviderKey(item.target.channel);
    if (!channel) return;
    const list = map.get(channel) ?? [];
    list.push(item);
    map.set(channel, list);
  });
  return map;
}

export function groupSuspendedByApiKeyResource(
  suspended: SuspendedMapping[]
): Map<string, { brand: ProviderBrand; items: SuspendedMapping[] }> {
  const map = new Map<string, { brand: ProviderBrand; items: SuspendedMapping[] }>();
  suspended.forEach((item) => {
    if (item.target.source !== 'apiKey') return;
    const current = map.get(item.target.resourceId) ?? {
      brand: item.target.brand,
      items: [] as SuspendedMapping[],
    };
    current.items.push(item);
    map.set(item.target.resourceId, current);
  });
  return map;
}

export function targetRefFromAccessRow(row: {
  source: 'oauth' | 'apiKey';
  modelId: string;
  oauthChannel?: string;
  channelOrBrand?: string;
  resourceId?: string;
  brand?: ProviderBrand;
}): MappingTargetRef | null {
  const modelId = row.modelId.trim();
  if (!modelId) return null;
  if (row.source === 'oauth') {
    const channel = normalizeProviderKey(row.oauthChannel ?? row.channelOrBrand ?? '');
    if (!channel) return null;
    return { source: 'oauth', channel, modelId };
  }
  if (!row.resourceId || !row.brand) return null;
  return {
    source: 'apiKey',
    resourceId: row.resourceId,
    brand: row.brand,
    modelId,
  };
}

export type SuspendedDisplayContext = {
  oauthDisplayNames?: Record<string, Record<string, string>>;
  providerLabels: {
    oauth: (channel: string) => string;
    apiKey: (resourceId: string, brand: ProviderBrand) => string;
  };
  icons?: {
    oauth?: (channel: string) => string | null | undefined;
    apiKey?: (resourceId: string, brand: ProviderBrand) => string | null | undefined;
  };
};

function suspendedToTarget(
  item: SuspendedMapping,
  ctx: SuspendedDisplayContext
): MappingTarget {
  if (item.target.source === 'oauth') {
    const channel = normalizeProviderKey(item.target.channel);
    const modelId = item.target.modelId.trim();
    const displayMap = ctx.oauthDisplayNames?.[channel] ?? {};
    const displayName = (displayMap[lower(modelId)] || modelId).trim() || modelId;
    return {
      ...item.target,
      channel,
      modelId,
      displayName,
      providerLabel: ctx.providerLabels.oauth(channel),
      iconSrc: ctx.icons?.oauth?.(channel) ?? null,
      currentlyEnabled: false,
      suspended: true,
    };
  }

  const modelId = item.target.modelId.trim();
  return {
    ...item.target,
    modelId,
    displayName: modelId,
    providerLabel: ctx.providerLabels.apiKey(item.target.resourceId, item.target.brand),
    iconSrc: ctx.icons?.apiKey?.(item.target.resourceId, item.target.brand) ?? null,
    currentlyEnabled: false,
    suspended: true,
  };
}

/**
 * 把本地挂起的目标合并进联邦映射行：灰标展示，启用后仍可见。
 * 已在真实配置中的同一 target 不会重复添加。
 */
export function mergeSuspendedIntoFederatedRows(
  rows: FederatedMappingRow[],
  suspended: SuspendedMapping[],
  ctx: SuspendedDisplayContext
): FederatedMappingRow[] {
  if (!suspended.length) {
    return rows.map((row) => ({
      ...row,
      targets: row.targets.map((t) => ({ ...t, suspended: t.suspended === true })),
    }));
  }

  const buckets = new Map<string, FederatedMappingRow>();
  rows.forEach((row) => {
    buckets.set(row.aliasKey, {
      alias: row.alias,
      aliasKey: row.aliasKey,
      targets: row.targets.map((t) => ({ ...t, suspended: false })),
    });
  });

  suspended.forEach((item) => {
    const alias = item.alias.trim();
    if (!alias) return;
    const aliasKey = toAliasKey(alias);
    const tKey = mappingTargetKey(item.target);
    let bucket = buckets.get(aliasKey);
    if (!bucket) {
      bucket = { alias, aliasKey, targets: [] };
      buckets.set(aliasKey, bucket);
    }
    if (bucket.targets.some((t) => mappingTargetKey(t) === tKey)) return;
    bucket.targets.push(suspendedToTarget(item, ctx));
  });

  const merged = Array.from(buckets.values()).map((row) => {
    const targets = [...row.targets].sort((a, b) => {
      // active first, then suspended
      if (Boolean(a.suspended) !== Boolean(b.suspended)) {
        return a.suspended ? 1 : -1;
      }
      const p = a.providerLabel.localeCompare(b.providerLabel, undefined, { sensitivity: 'base' });
      if (p !== 0) return p;
      return a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' });
    });
    return { ...row, targets };
  });

  merged.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
  return merged;
}

export { accessEnabledKey };
