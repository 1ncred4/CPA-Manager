/**
 * 顶层暴露：跨名手动认领后需隐藏原名，但底层「模型禁用」仍视为启用。
 * 网关侧用 exclude 实现隐藏；本 store 标记哪些 exclude 是 exposure 补偿，
 * 以便 UI 显示 desired=enabled，并在认领解除时安全撤销。
 */

import { normalizeApiBase } from '@/utils/connection';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { mappingTargetKey, type MappingTargetRef } from './modelMapping';

const STORAGE_PREFIX = 'cpa-manager:exposure-native-hide:v1:';
export const EXPOSURE_NATIVE_HIDE_CHANGED_EVENT = 'cpa-manager:exposure-native-hide-changed';

type StoreFile = {
  version: 1;
  /** mappingTargetKey / accessEnabledKey */
  keys: string[];
};

const lower = (value: string): string => value.trim().toLowerCase();

export function exposureNativeHideStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

export function exposureNativeHideKey(ref: MappingTargetRef): string {
  return mappingTargetKey(ref);
}

function readStore(apiBase: string): StoreFile {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, keys: [] };
  }
  try {
    const raw = window.localStorage.getItem(exposureNativeHideStorageKey(apiBase));
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

function notify(apiBase: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(EXPOSURE_NATIVE_HIDE_CHANGED_EVENT, { detail: { apiBase } })
    );
  } catch {
    // ignore
  }
}

function writeStore(apiBase: string, store: StoreFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const uniq = Array.from(new Set(store.keys.map((k) => k.trim()).filter(Boolean)));
    if (!uniq.length) {
      window.localStorage.removeItem(exposureNativeHideStorageKey(apiBase));
    } else {
      window.localStorage.setItem(
        exposureNativeHideStorageKey(apiBase),
        JSON.stringify({ version: 1, keys: uniq })
      );
    }
    notify(apiBase);
  } catch {
    // quota
  }
}

export function listExposureNativeHideKeys(apiBase: string): Set<string> {
  return new Set(readStore(apiBase).keys);
}

export function markExposureNativeHide(apiBase: string, ref: MappingTargetRef): void {
  const key = exposureNativeHideKey(ref);
  if (!key) return;
  const store = readStore(apiBase);
  if (store.keys.includes(key)) return;
  store.keys.push(key);
  writeStore(apiBase, store);
}

export function unmarkExposureNativeHide(apiBase: string, ref: MappingTargetRef): void {
  const key = exposureNativeHideKey(ref);
  if (!key) return;
  const store = readStore(apiBase);
  const next = store.keys.filter((k) => k !== key);
  if (next.length === store.keys.length) return;
  writeStore(apiBase, { version: 1, keys: next });
}

export function replaceExposureNativeHideKeys(apiBase: string, keys: string[]): void {
  writeStore(apiBase, { version: 1, keys: [...keys] });
}

export function __replaceExposureNativeHideForTests(apiBase: string, keys: string[]): void {
  replaceExposureNativeHideKeys(apiBase, keys);
}

/**
 * 访问行：因 exposure-hide 写了 exclude 的模型，UI 仍显示启用。
 * 用户在「模型禁用」主动关掉时，应先 unmark 再按真实 excluded 显示。
 */
export function applyExposureNativeHideDisplayMask<
  T extends { key: string; enabled: boolean },
>(rows: T[], apiBase: string): T[] {
  if (!apiBase || !rows.length) return rows;
  const managed = listExposureNativeHideKeys(apiBase);
  if (!managed.size) return rows;
  return rows.map((row) => {
    if (row.enabled) return row;
    if (!managed.has(row.key)) return row;
    return { ...row, enabled: true };
  });
}

export function isExposureNativeHideKey(apiBase: string, key: string): boolean {
  return listExposureNativeHideKeys(apiBase).has(key);
}

/** oauth key helper for tests */
export function oauthExposureKey(channel: string, modelId: string): string {
  return `oauth:${normalizeProviderKey(channel)}:${lower(modelId)}`;
}
