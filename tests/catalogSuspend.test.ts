import { afterEach, describe, expect, test } from 'bun:test';
import {
  __replaceCatalogSuspendStoreForTests,
  clearSuspendedCatalog,
  listSuspendedCatalog,
  listSuspendedCatalogForResource,
  loadSuspendedCatalog,
  mergeSuspendedCatalog,
  reconcileSuspendedCatalogWithModels,
  removeModelFromCatalog,
  restoreModelToCatalog,
  takeSuspendedCatalog,
} from '../src/features/models/catalogSuspend';
import type { ModelAlias } from '../src/types';

const API = 'http://localhost:8317';

const memory = new Map<string, string>();

const installLocalStorage = () => {
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    get length() {
      return memory.size;
    },
  };
  // @ts-expect-error test shim
  globalThis.window = { localStorage: storage, dispatchEvent: () => true };
  // @ts-expect-error test shim
  globalThis.localStorage = storage;
};

afterEach(() => {
  memory.clear();
});

describe('catalogSuspend storage', () => {
  test('merge and take round-trip', () => {
    installLocalStorage();
    mergeSuspendedCatalog(API, 'openaiCompatibility:0:proxy', 'gpt-5', [
      { name: 'gpt-5', alias: 'my-gpt' },
    ]);
    const loaded = loadSuspendedCatalog(API, 'openaiCompatibility:0:proxy', 'gpt-5');
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0].alias).toBe('my-gpt');

    const taken = takeSuspendedCatalog(API, 'openaiCompatibility:0:proxy', 'gpt-5');
    expect(taken?.entries[0].name).toBe('gpt-5');
    expect(loadSuspendedCatalog(API, 'openaiCompatibility:0:proxy', 'gpt-5')).toBeNull();
  });

  test('merge dedupes same name+alias', () => {
    installLocalStorage();
    const rid = 'openaiCompatibility:0:proxy';
    mergeSuspendedCatalog(API, rid, 'gpt-5', [{ name: 'gpt-5' }]);
    mergeSuspendedCatalog(API, rid, 'gpt-5', [
      { name: 'gpt-5' },
      { name: 'gpt-5', alias: 'a' },
    ]);
    const loaded = loadSuspendedCatalog(API, rid, 'gpt-5');
    expect(loaded?.entries).toHaveLength(2);
  });

  test('reconcile clears suspend when model is active again', () => {
    installLocalStorage();
    const rid = 'openaiCompatibility:0:proxy';
    mergeSuspendedCatalog(API, rid, 'gpt-5', [{ name: 'gpt-5' }]);
    mergeSuspendedCatalog(API, rid, 'o1', [{ name: 'o1' }]);
    reconcileSuspendedCatalogWithModels(API, rid, ['gpt-5']);
    expect(listSuspendedCatalogForResource(API, rid).map((e) => e.modelId).sort()).toEqual([
      'o1',
    ]);
  });

  test('clearSuspendedCatalog removes one model', () => {
    installLocalStorage();
    __replaceCatalogSuspendStoreForTests(API, [
      {
        resourceId: 'r1',
        modelId: 'a',
        entries: [{ name: 'a' }],
      },
      {
        resourceId: 'r1',
        modelId: 'b',
        entries: [{ name: 'b' }],
      },
    ]);
    clearSuspendedCatalog(API, 'r1', 'a');
    expect(listSuspendedCatalog(API)).toHaveLength(1);
    expect(listSuspendedCatalog(API)[0].modelId).toBe('b');
  });
});

describe('catalogSuspend model helpers', () => {
  test('removeModelFromCatalog strips all entries for model id', () => {
    const models: ModelAlias[] = [
      { name: 'gpt-5', alias: 'a' },
      { name: 'gpt-5' },
      { name: 'o1' },
    ];
    const { next, removed } = removeModelFromCatalog(models, 'GPT-5');
    expect(removed).toHaveLength(2);
    expect(next).toEqual([{ name: 'o1' }]);
  });

  test('restoreModelToCatalog skips already-present identities', () => {
    const models: ModelAlias[] = [{ name: 'gpt-5', alias: 'a' }];
    const { next, restored, skipped } = restoreModelToCatalog(models, [
      { name: 'gpt-5', alias: 'a' },
      { name: 'gpt-5' },
      { name: 'o1' },
    ]);
    expect(restored).toBe(3); // first counts as already present restored
    expect(skipped).toBe(0);
    expect(next).toHaveLength(3);
  });
});
