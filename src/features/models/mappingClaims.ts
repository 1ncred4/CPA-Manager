/**
 * 用户将「自动映射渠道」认领为手动（含纯同名渠道，后端无法写 alias===name）。
 * 本地标记：认领后出现在「手动映射」；删除手动后清除，渠道回到自动。
 */

import { normalizeApiBase } from '@/utils/connection';
import { toAliasKey } from './modelMapping';

type ClaimStoreFile = {
  version: 1;
  aliases: string[];
};

const STORAGE_PREFIX = 'cpa-manager:manual-mapping-claims:v1:';

export const MANUAL_MAPPING_CLAIMS_CHANGED_EVENT = 'cpa-manager:manual-mapping-claims-changed';

export function manualClaimsStorageKey(apiBase: string): string {
  return `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;
}

function readStore(apiBase: string): ClaimStoreFile {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 1, aliases: [] };
  }
  try {
    const raw = window.localStorage.getItem(manualClaimsStorageKey(apiBase));
    if (!raw) return { version: 1, aliases: [] };
    const parsed = JSON.parse(raw) as ClaimStoreFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.aliases)) {
      return { version: 1, aliases: [] };
    }
    return {
      version: 1,
      aliases: parsed.aliases.map((a) => toAliasKey(String(a ?? ''))).filter(Boolean),
    };
  } catch {
    return { version: 1, aliases: [] };
  }
}

function notifyChanged(apiBase: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(MANUAL_MAPPING_CLAIMS_CHANGED_EVENT, { detail: { apiBase } })
    );
  } catch {
    // ignore
  }
}

function writeStore(apiBase: string, store: ClaimStoreFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const aliases = Array.from(new Set(store.aliases.map(toAliasKey).filter(Boolean))).sort();
    if (!aliases.length) {
      window.localStorage.removeItem(manualClaimsStorageKey(apiBase));
    } else {
      window.localStorage.setItem(
        manualClaimsStorageKey(apiBase),
        JSON.stringify({ version: 1, aliases })
      );
    }
    notifyChanged(apiBase);
  } catch {
    // quota / private mode
  }
}

export function listManualMappingClaims(apiBase: string): string[] {
  return [...readStore(apiBase).aliases];
}

export function claimManualMapping(apiBase: string, alias: string): void {
  const key = toAliasKey(alias);
  if (!key) return;
  const store = readStore(apiBase);
  if (store.aliases.includes(key)) return;
  store.aliases.push(key);
  writeStore(apiBase, store);
}

export function unclaimManualMapping(apiBase: string, alias: string): void {
  const key = toAliasKey(alias);
  if (!key) return;
  const store = readStore(apiBase);
  const next = store.aliases.filter((a) => a !== key);
  if (next.length === store.aliases.length) return;
  writeStore(apiBase, { version: 1, aliases: next });
}

export function __replaceManualClaimsForTests(apiBase: string, aliases: string[]): void {
  writeStore(apiBase, {
    version: 1,
    aliases: aliases.map(toAliasKey).filter(Boolean),
  });
}
