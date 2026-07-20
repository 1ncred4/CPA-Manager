/**
 * 受管 identity 排除：网关侧写了 oauth-excluded-models，
 * 但管理端用 localStorage 记一笔，显示时仍当「启用」——
 * 模型禁用列表 / 其它渠道 picker 可见可选，其它渠道映射不受 UI 屏蔽。
 *
 * 注意：底层仍是 excluded；若后端对 excluded 模型连 alias 也拒，运行时仍可能失败。
 * 有真实非同名 alias 时优先 fork，不必走这条路径。
 */

import { normalizeApiBase } from '@/utils/connection';
import { normalizeProviderKey } from '@/features/authFiles/constants';

const STORAGE_PREFIX = 'cpa-manager:managed-identity-exclude:v1:';
export const MANAGED_IDENTITY_EXCLUDE_CHANGED_EVENT =
  'cpa-manager:managed-identity-exclude-changed';

type StoreFile = {
  version: 1;
  /** access-style keys: oauth:<channel>:<modelLower> */
  keys: string[];
};

const lower = (value: string): string => value.trim().toLowerCase();

export function managedIdentityExcludeStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function managedOauthExcludeKey(channel: string, modelId: string): string {
  return `oauth:${normalizeProviderKey(channel)}:${lower(modelId)}`;
}

function readStore(apiBase: string): StoreFile {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, keys: [] };
  }
  try {
    const raw = window.localStorage.getItem(managedIdentityExcludeStorageKey(apiBase));
    if (!raw) return { version: 1, keys: [] };
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return { version: 1, keys: parsed.keys.map(String).filter(Boolean) };
  } catch {
    return { version: 1, keys: [] };
  }
}

function writeStore(apiBase: string, store: StoreFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const uniq = Array.from(new Set(store.keys.map((k) => k.trim()).filter(Boolean)));
    if (!uniq.length) {
      window.localStorage.removeItem(managedIdentityExcludeStorageKey(apiBase));
    } else {
      window.localStorage.setItem(
        managedIdentityExcludeStorageKey(apiBase),
        JSON.stringify({ version: 1, keys: uniq })
      );
    }
    try {
      window.dispatchEvent(
        new CustomEvent(MANAGED_IDENTITY_EXCLUDE_CHANGED_EVENT, { detail: { apiBase } })
      );
    } catch {
      // ignore
    }
  } catch {
    // quota / private mode
  }
}

export function listManagedIdentityExcludeKeys(apiBase: string): Set<string> {
  return new Set(readStore(apiBase).keys);
}

export function isManagedIdentityExclude(apiBase: string, key: string): boolean {
  return listManagedIdentityExcludeKeys(apiBase).has(key);
}

export function markManagedIdentityExclude(apiBase: string, key: string): void {
  const k = key.trim();
  if (!k) return;
  const store = readStore(apiBase);
  if (store.keys.includes(k)) return;
  store.keys.push(k);
  writeStore(apiBase, store);
}

export function unmarkManagedIdentityExclude(apiBase: string, key: string): void {
  const k = key.trim();
  if (!k) return;
  const store = readStore(apiBase);
  const next = store.keys.filter((item) => item !== k);
  if (next.length === store.keys.length) return;
  writeStore(apiBase, { version: 1, keys: next });
}

export function markManagedOauthIdentityExclude(
  apiBase: string,
  channel: string,
  modelId: string
): void {
  markManagedIdentityExclude(apiBase, managedOauthExcludeKey(channel, modelId));
}

export function unmarkManagedOauthIdentityExclude(
  apiBase: string,
  channel: string,
  modelId: string
): void {
  unmarkManagedIdentityExclude(apiBase, managedOauthExcludeKey(channel, modelId));
}

/** 用户在「模型禁用」页主动开关时：去掉受管标记，之后 UI 按真实 excluded 显示 */
export function clearManagedIdentityExcludeIfPresent(apiBase: string, key: string): void {
  unmarkManagedIdentityExclude(apiBase, key);
}

export function __replaceManagedIdentityExcludeForTests(
  apiBase: string,
  keys: string[]
): void {
  writeStore(apiBase, { version: 1, keys: [...keys] });
}

/**
 * 访问行 / picker：受管 excluded 在 UI 上显示为 enabled，
 * 以便其它渠道仍能选到该模型。
 */
export function applyManagedIdentityExcludeDisplayMask<
  T extends { key: string; source: string; enabled: boolean },
>(rows: T[], apiBase: string): T[] {
  if (!apiBase || !rows.length) return rows;
  const managed = listManagedIdentityExcludeKeys(apiBase);
  if (!managed.size) return rows;
  return rows.map((row) => {
    if (row.source !== 'oauth' || row.enabled) return row;
    if (!managed.has(row.key)) return row;
    return { ...row, enabled: true };
  });
}
