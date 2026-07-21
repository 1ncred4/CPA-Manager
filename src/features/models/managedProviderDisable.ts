import { normalizeApiBase } from '@/utils/connection';

const STORAGE_PREFIX = 'cpa-manager:managed-provider-disable:v1:';

type StoreFile = {
  version: 1;
  manuallyDisabled: string[];
};

const storageKey = (apiBase: string): string =>
  `${STORAGE_PREFIX}${normalizeApiBase(apiBase) || 'default'}`;

const emptyStore = (): StoreFile => ({ version: 1, manuallyDisabled: [] });

function readStore(apiBase: string): StoreFile {
  if (typeof window === 'undefined' || !window.localStorage) return emptyStore();
  try {
    const raw = window.localStorage.getItem(storageKey(apiBase));
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.manuallyDisabled)) return emptyStore();
    return {
      version: 1,
      manuallyDisabled: parsed.manuallyDisabled.map(String).filter(Boolean),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(apiBase: string, store: StoreFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const manuallyDisabled = Array.from(
      new Set(store.manuallyDisabled.map(String).filter(Boolean))
    );
    if (!manuallyDisabled.length) {
      window.localStorage.removeItem(storageKey(apiBase));
    } else {
      window.localStorage.setItem(
        storageKey(apiBase),
        JSON.stringify({ version: 1, manuallyDisabled })
      );
    }
  } catch {
    // quota / private mode
  }
}

export function listManuallyDisabledProviders(apiBase: string): Set<string> {
  return new Set(readStore(apiBase).manuallyDisabled);
}

export function markProviderManuallyDisabled(apiBase: string, resourceId: string): void {
  const id = resourceId.trim();
  if (!id) return;
  const store = readStore(apiBase);
  if (store.manuallyDisabled.includes(id)) return;
  writeStore(apiBase, { version: 1, manuallyDisabled: [...store.manuallyDisabled, id] });
}

export function clearProviderManualDisabled(apiBase: string, resourceId: string): void {
  const id = resourceId.trim();
  if (!id) return;
  const store = readStore(apiBase);
  const next = store.manuallyDisabled.filter((item) => item !== id);
  if (next.length === store.manuallyDisabled.length) return;
  writeStore(apiBase, { version: 1, manuallyDisabled: next });
}
