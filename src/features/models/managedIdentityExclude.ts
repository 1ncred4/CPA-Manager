/**
 * 受管「原名隐藏」：网关侧已 excluded / catalog 摘除，
 * 但管理端用 localStorage 记一笔，显示时仍当「启用」——
 * 「模型禁用」列表与映射编辑 picker 仍可见可选，其它渠道映射不受 UI 屏蔽。
 *
 * 触发场景：
 * - 手动映射渠道内禁用目标（同名 / 跨名）
 * - OAuth 优先 fork=false；无别名时 oauth-excluded + 本标记
 * - API Key 写 excludedModels / OpenAI catalog 挂起 + 本标记
 *
 * 注意：底层仍是 excluded；若后端对 excluded 模型连 alias 也拒，运行时仍可能失败。
 */

import { normalizeApiBase } from '@/utils/connection';
import { normalizeProviderKey } from '@/features/authFiles/constants';

const STORAGE_PREFIX = 'cpa-manager:managed-identity-exclude:v1:';
export const MANAGED_IDENTITY_EXCLUDE_CHANGED_EVENT =
  'cpa-manager:managed-identity-exclude-changed';

type StoreFile = {
  version: 1;
  /**
   * access-style keys:
   * - oauth:<channel>:<modelLower>
   * - apiKey:<resourceId>:<modelLower>
   */
  keys: string[];
};

const lower = (value: string): string => value.trim().toLowerCase();

export function managedIdentityExcludeStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function managedOauthExcludeKey(channel: string, modelId: string): string {
  return `oauth:${normalizeProviderKey(channel)}:${lower(modelId)}`;
}

export function managedApiKeyExcludeKey(resourceId: string, modelId: string): string {
  return `apiKey:${resourceId}:${lower(modelId)}`;
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

export function markManagedApiKeyIdentityExclude(
  apiBase: string,
  resourceId: string,
  modelId: string
): void {
  markManagedIdentityExclude(apiBase, managedApiKeyExcludeKey(resourceId, modelId));
}

export function unmarkManagedApiKeyIdentityExclude(
  apiBase: string,
  resourceId: string,
  modelId: string
): void {
  unmarkManagedIdentityExclude(apiBase, managedApiKeyExcludeKey(resourceId, modelId));
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
 * 访问行 / picker：受管 excluded / catalog 挂起在 UI 上显示为 enabled，
 * 以便「模型禁用」仍显示启用，映射编辑列表仍可选。
 */
export function applyManagedIdentityExcludeDisplayMask<
  T extends { key: string; source: string; enabled: boolean },
>(rows: T[], apiBase: string): T[] {
  if (!apiBase || !rows.length) return rows;
  const managed = listManagedIdentityExcludeKeys(apiBase);
  if (!managed.size) return rows;
  return rows.map((row) => {
    if (row.enabled) return row;
    if (!managed.has(row.key)) return row;
    return { ...row, enabled: true };
  });
}
