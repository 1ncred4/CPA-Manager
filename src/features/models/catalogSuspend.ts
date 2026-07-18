/**
 * OpenAI Compatibility 无 excludedModels 字段。
 * 按模型「禁用」= 从 models[] 摘掉该模型，并把完整 ModelAlias 条目挂到 localStorage，
 * 启用时再写回。换浏览器 / 清站点数据会丢挂起项。
 */

import type { ModelAlias } from '@/types';
import { normalizeApiBase } from '@/utils/connection';

export type SuspendedCatalogEntry = {
  resourceId: string;
  /** 模型原始 name（保留首次见到的大小写） */
  modelId: string;
  /** 该模型在 models[] 里的全部条目（含 alias / priority 等） */
  entries: ModelAlias[];
};

type CatalogSuspendStore = {
  version: 1;
  /** `${resourceId}\0${modelKey}` → entry */
  byKey: Record<string, SuspendedCatalogEntry>;
};

const STORAGE_PREFIX = 'cpa-manager:suspended-model-catalog:v1:';

const lower = (value: string): string => value.trim().toLowerCase();

export function catalogSuspendStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function catalogSuspendKey(resourceId: string, modelId: string): string {
  return `${resourceId}\0${lower(modelId)}`;
}

function readStore(apiBase: string): CatalogSuspendStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, byKey: {} };
  }
  try {
    const raw = window.localStorage.getItem(catalogSuspendStorageKey(apiBase));
    if (!raw) return { version: 1, byKey: {} };
    const parsed = JSON.parse(raw) as CatalogSuspendStore;
    if (!parsed || parsed.version !== 1 || typeof parsed.byKey !== 'object' || !parsed.byKey) {
      return { version: 1, byKey: {} };
    }
    return { version: 1, byKey: parsed.byKey };
  } catch {
    return { version: 1, byKey: {} };
  }
}

/** 同页其它 hook 监听挂起变化（localStorage 同 tab 不触发 storage 事件） */
export const SUSPENDED_CATALOG_CHANGED_EVENT = 'cpa-manager:suspended-catalog-changed';

function notifyCatalogChanged(apiBase: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(SUSPENDED_CATALOG_CHANGED_EVENT, { detail: { apiBase } })
    );
  } catch {
    // ignore
  }
}

function writeStore(apiBase: string, store: CatalogSuspendStore): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keys = Object.keys(store.byKey);
    if (keys.length === 0) {
      window.localStorage.removeItem(catalogSuspendStorageKey(apiBase));
    } else {
      window.localStorage.setItem(catalogSuspendStorageKey(apiBase), JSON.stringify(store));
    }
    notifyCatalogChanged(apiBase);
  } catch {
    // quota / private mode — best effort
  }
}

export function listSuspendedCatalog(apiBase: string): SuspendedCatalogEntry[] {
  return Object.values(readStore(apiBase).byKey);
}

export function listSuspendedCatalogForResource(
  apiBase: string,
  resourceId: string
): SuspendedCatalogEntry[] {
  return listSuspendedCatalog(apiBase).filter((entry) => entry.resourceId === resourceId);
}

export function loadSuspendedCatalog(
  apiBase: string,
  resourceId: string,
  modelId: string
): SuspendedCatalogEntry | null {
  const key = catalogSuspendKey(resourceId, modelId);
  const entry = readStore(apiBase).byKey[key];
  return entry ? { ...entry, entries: entry.entries.map((e) => ({ ...e })) } : null;
}

/**
 * 挂起某 resource 上某模型的全部 models[] 条目。
 * 若已有挂起，合并 entries（按 name+alias 去重）。
 */
export function mergeSuspendedCatalog(
  apiBase: string,
  resourceId: string,
  modelId: string,
  entries: ModelAlias[]
): SuspendedCatalogEntry {
  const store = readStore(apiBase);
  const key = catalogSuspendKey(resourceId, modelId);
  const existing = store.byKey[key];
  const entryIdentity = (m: ModelAlias) =>
    `${lower(String(m.name ?? ''))}|${lower(String(m.alias ?? ''))}`;

  const map = new Map<string, ModelAlias>();
  (existing?.entries ?? []).forEach((e) => map.set(entryIdentity(e), e));
  entries.forEach((e) => {
    const name = String(e?.name ?? '').trim();
    if (!name) return;
    map.set(entryIdentity(e), { ...e, name });
  });

  const next: SuspendedCatalogEntry = {
    resourceId,
    modelId: (existing?.modelId || modelId).trim() || modelId,
    entries: Array.from(map.values()),
  };
  store.byKey[key] = next;
  writeStore(apiBase, store);
  return next;
}

/** 取出并清除某个模型的 catalog 挂起 */
export function takeSuspendedCatalog(
  apiBase: string,
  resourceId: string,
  modelId: string
): SuspendedCatalogEntry | null {
  const store = readStore(apiBase);
  const key = catalogSuspendKey(resourceId, modelId);
  const entry = store.byKey[key];
  if (!entry) return null;
  delete store.byKey[key];
  writeStore(apiBase, store);
  return { ...entry, entries: entry.entries.map((e) => ({ ...e })) };
}

export function clearSuspendedCatalog(
  apiBase: string,
  resourceId: string,
  modelId: string
): void {
  const store = readStore(apiBase);
  const key = catalogSuspendKey(resourceId, modelId);
  if (!store.byKey[key]) return;
  delete store.byKey[key];
  writeStore(apiBase, store);
}

/** 清除某 resource 下全部 catalog 挂起（例如条目被删除） */
export function clearSuspendedCatalogForResource(apiBase: string, resourceId: string): void {
  const store = readStore(apiBase);
  let changed = false;
  Object.keys(store.byKey).forEach((key) => {
    if (store.byKey[key]?.resourceId !== resourceId) return;
    delete store.byKey[key];
    changed = true;
  });
  if (changed) writeStore(apiBase, store);
}

/**
 * 若 models[] 里又出现了挂起中的模型（用户在编辑页手动加回），清掉对应挂起，
 * 避免「目录里有、禁用列表仍显示关闭」。
 */
export function reconcileSuspendedCatalogWithModels(
  apiBase: string,
  resourceId: string,
  activeModelIds: Iterable<string>
): void {
  const active = new Set(Array.from(activeModelIds).map(lower).filter(Boolean));
  if (active.size === 0) {
    // still may need to clear nothing; only drop entries that are present
  }
  const store = readStore(apiBase);
  let changed = false;
  Object.keys(store.byKey).forEach((key) => {
    const entry = store.byKey[key];
    if (!entry || entry.resourceId !== resourceId) return;
    if (active.has(lower(entry.modelId))) {
      delete store.byKey[key];
      changed = true;
    }
  });
  if (changed) writeStore(apiBase, store);
}

/** 从 models[] 中摘掉 modelId 的全部条目，返回被摘掉的条目 */
export function removeModelFromCatalog(
  models: ModelAlias[] | undefined,
  modelId: string
): { next: ModelAlias[]; removed: ModelAlias[] } {
  const modelKey = lower(modelId);
  const next: ModelAlias[] = [];
  const removed: ModelAlias[] = [];
  (models ?? []).forEach((entry) => {
    const name = String(entry?.name ?? '').trim();
    if (name && lower(name) === modelKey) {
      removed.push(entry);
      return;
    }
    next.push(entry);
  });
  return { next, removed };
}

/**
 * 把挂起条目写回 models[]。
 * 已存在同 name+alias 的跳过；裸 name 已存在且无 alias 冲突时也跳过重复裸条目。
 */
export function restoreModelToCatalog(
  models: ModelAlias[] | undefined,
  entries: ModelAlias[]
): { next: ModelAlias[]; restored: number; skipped: number } {
  const working = [...(models ?? [])];
  let restored = 0;
  let skipped = 0;

  const identity = (m: ModelAlias) =>
    `${lower(String(m.name ?? ''))}|${lower(String(m.alias ?? ''))}`;
  const present = new Set(working.map(identity));

  entries.forEach((entry) => {
    const name = String(entry?.name ?? '').trim();
    if (!name) {
      skipped += 1;
      return;
    }
    const id = identity({ ...entry, name });
    if (present.has(id)) {
      // already there
      restored += 1;
      return;
    }
    working.push({ ...entry, name });
    present.add(id);
    restored += 1;
  });

  return { next: working, restored, skipped };
}

/** 测试用 */
export function __replaceCatalogSuspendStoreForTests(
  apiBase: string,
  entries: SuspendedCatalogEntry[]
): void {
  const byKey: Record<string, SuspendedCatalogEntry> = {};
  entries.forEach((entry) => {
    byKey[catalogSuspendKey(entry.resourceId, entry.modelId)] = entry;
  });
  writeStore(apiBase, { version: 1, byKey });
}
