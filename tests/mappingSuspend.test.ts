import { afterEach, describe, expect, test } from 'bun:test';
import {
  __replaceSuspendedStoreForTests,
  clearSuspendedForAlias,
  collectMappingsForTarget,
  listAllSuspended,
  listSuspendedForAlias,
  loadSuspendedForTarget,
  mergeSuspendedForTarget,
  mergeSuspendedIntoFederatedRows,
  pruneApiKeyModelsForModel,
  pruneOauthEntriesForModel,
  removeSuspendedMapping,
  restoreApiKeyModels,
  restoreOauthEntries,
  suspendedMappingIdentity,
  takeSuspendedForTarget,
} from '../src/features/models/mappingSuspend';
import type { FederatedMappingRow } from '../src/features/models/modelMapping';
import type { ProviderResource } from '../src/features/providers/types';
import type { OAuthModelAliasEntry } from '../src/types';

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
  globalThis.window = { localStorage: storage };
  // @ts-expect-error test shim
  globalThis.localStorage = storage;
};

afterEach(() => {
  memory.clear();
});

describe('mappingSuspend storage', () => {
  test('merge and take round-trip by target key', () => {
    installLocalStorage();
    const targetKey = 'oauth:claude:kimi-k3';
    mergeSuspendedForTarget(API, targetKey, [
      {
        alias: 'claude-opus-4-8',
        target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        fork: true,
      },
    ]);
    const loaded = loadSuspendedForTarget(API, targetKey);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].alias).toBe('claude-opus-4-8');

    const taken = takeSuspendedForTarget(API, targetKey);
    expect(taken).toHaveLength(1);
    expect(loadSuspendedForTarget(API, targetKey)).toHaveLength(0);
  });

  test('merge dedupes identical bindings', () => {
    installLocalStorage();
    const targetKey = 'oauth:claude:kimi-k3';
    const entry = {
      alias: 'claude-opus-4-8',
      target: { source: 'oauth' as const, channel: 'claude', modelId: 'kimi-k3' },
    };
    mergeSuspendedForTarget(API, targetKey, [entry]);
    mergeSuspendedForTarget(API, targetKey, [entry, { ...entry, fork: true }]);
    const loaded = loadSuspendedForTarget(API, targetKey);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].fork).toBe(true);
  });
});

describe('collect / prune / restore', () => {
  test('collectMappingsForTarget finds oauth aliases for model', () => {
    const found = collectMappingsForTarget({
      modelAlias: {
        claude: [
          { name: 'kimi-k3', alias: 'claude-opus-4-8', fork: true },
          { name: 'other', alias: 'x' },
        ],
      },
      resources: [],
      target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
    });
    expect(found).toHaveLength(1);
    expect(found[0].alias).toBe('claude-opus-4-8');
    expect(found[0].fork).toBe(true);
  });

  test('pruneOauthEntriesForModel removes only matching model', () => {
    const entries: OAuthModelAliasEntry[] = [
      { name: 'kimi-k3', alias: 'claude-opus-4-8' },
      { name: 'keep-me', alias: 'stay' },
    ];
    const { next, removed } = pruneOauthEntriesForModel(entries, 'kimi-k3');
    expect(removed).toHaveLength(1);
    expect(next).toEqual([{ name: 'keep-me', alias: 'stay' }]);
  });

  test('restoreOauthEntries re-adds and skips channel alias conflict', () => {
    const entries: OAuthModelAliasEntry[] = [
      { name: 'already', alias: 'claude-opus-4-8' },
    ];
    const conflict = restoreOauthEntries(
      entries,
      [
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
      ],
      'claude'
    );
    expect(conflict.skipped).toBe(1);
    expect(conflict.restored).toBe(0);

    const ok = restoreOauthEntries(
      [],
      [
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
          forceMapping: true,
        },
      ],
      'claude'
    );
    expect(ok.restored).toBe(1);
    expect(ok.next[0]).toEqual({
      name: 'kimi-k3',
      alias: 'claude-opus-4-8',
      forceMapping: true,
    });
  });

  test('api key prune and restore', () => {
    const models = [
      { name: 'kimi-k3', alias: 'claude-opus-4-8' },
      { name: 'keep', alias: 'stay' },
    ];
    const pruned = pruneApiKeyModelsForModel(models, 'kimi-k3');
    expect(pruned.removedAliases).toEqual([{ modelId: 'kimi-k3', alias: 'claude-opus-4-8' }]);
    expect(pruned.next[0].alias).toBeUndefined();

    const restored = restoreApiKeyModels(
      pruned.next,
      [
        {
          alias: 'claude-opus-4-8',
          target: {
            source: 'apiKey',
            resourceId: 'claude:0:sk',
            brand: 'claude',
            modelId: 'kimi-k3',
          },
        },
      ],
      'claude:0:sk'
    );
    expect(restored.restored).toBe(1);
    expect(restored.next[0].alias).toBe('claude-opus-4-8');
  });

  test('collectMappingsForTarget on api key resource', () => {
    const resource = {
      id: 'claude:0:sk',
      brand: 'claude',
      raw: {
        models: [
          { name: 'kimi-k3', alias: 'claude-opus-4-8' },
          { name: 'plain' },
        ],
      },
    } as unknown as ProviderResource;

    const found = collectMappingsForTarget({
      modelAlias: {},
      resources: [resource],
      target: {
        source: 'apiKey',
        resourceId: 'claude:0:sk',
        brand: 'claude',
        modelId: 'kimi-k3',
      },
    });
    expect(found.map(suspendedMappingIdentity)).toEqual([
      'claude-opus-4-8|apiKey:claude:0:sk:kimi-k3',
    ]);
  });

  test('__replaceSuspendedStoreForTests clears previous', () => {
    installLocalStorage();
    __replaceSuspendedStoreForTests(API, {
      'oauth:claude:a': [
        {
          alias: 'x',
          target: { source: 'oauth', channel: 'claude', modelId: 'a' },
        },
      ],
    });
    expect(loadSuspendedForTarget(API, 'oauth:claude:a')).toHaveLength(1);
    __replaceSuspendedStoreForTests(API, {});
    expect(loadSuspendedForTarget(API, 'oauth:claude:a')).toHaveLength(0);
  });

  test('mergeSuspendedIntoFederatedRows greys out suspended targets and keeps alias rows', () => {
    const live: FederatedMappingRow[] = [
      {
        alias: 'claude-opus-4-8',
        aliasKey: 'claude-opus-4-8',
        targets: [
          {
            source: 'apiKey',
            resourceId: 'xai:0:k',
            brand: 'xai',
            modelId: 'grok-4.5',
            displayName: 'grok-4.5',
            providerLabel: 'xAI · key',
            currentlyEnabled: true,
          },
        ],
      },
    ];

    const merged = mergeSuspendedIntoFederatedRows(
      live,
      [
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
        {
          alias: 'only-suspended',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
      ],
      {
        oauthDisplayNames: { claude: { 'kimi-k3': 'kimi-k3' } },
        providerLabels: {
          oauth: () => 'Claude',
          apiKey: () => 'xAI',
        },
      }
    );

    const multi = merged.find((r) => r.aliasKey === 'claude-opus-4-8');
    expect(multi?.targets).toHaveLength(2);
    expect(multi?.targets.some((t) => t.suspended && t.modelId === 'kimi-k3')).toBe(true);
    expect(multi?.targets.some((t) => !t.suspended && t.modelId === 'grok-4.5')).toBe(true);

    const solo = merged.find((r) => r.aliasKey === 'only-suspended');
    expect(solo?.targets).toHaveLength(1);
    expect(solo?.targets[0].suspended).toBe(true);
    expect(solo?.targets[0].currentlyEnabled).toBe(false);
  });

  test('clearSuspendedForAlias drops hangover grey targets', () => {
    installLocalStorage();
    __replaceSuspendedStoreForTests(API, {
      'oauth:claude:kimi-k3': [
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
        {
          alias: 'other',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
      ],
    });
    clearSuspendedForAlias(API, 'claude-opus-4-8');
    const left = listAllSuspended(API);
    expect(left).toHaveLength(1);
    expect(left[0].alias).toBe('other');
  });

  test('listSuspendedForAlias filters by alias key', () => {
    installLocalStorage();
    __replaceSuspendedStoreForTests(API, {
      'oauth:claude:kimi-k3': [
        {
          alias: 'Claude-Opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
        {
          alias: 'other',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
      ],
      'apiKey:xai:0:k:grok': [
        {
          alias: 'claude-opus-4-8',
          target: {
            source: 'apiKey',
            resourceId: 'xai:0:k',
            brand: 'xai',
            modelId: 'grok',
          },
        },
      ],
    });
    const listed = listSuspendedForAlias(API, 'claude-opus-4-8');
    expect(listed).toHaveLength(2);
    expect(listed.every((e) => e.alias.toLowerCase() === 'claude-opus-4-8')).toBe(true);
  });

  test('removeSuspendedMapping drops one alias→target binding', () => {
    installLocalStorage();
    __replaceSuspendedStoreForTests(API, {
      'oauth:claude:kimi-k3': [
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
        {
          alias: 'other',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
        },
      ],
    });
    const removed = removeSuspendedMapping(API, 'claude-opus-4-8', {
      source: 'oauth',
      channel: 'claude',
      modelId: 'kimi-k3',
    });
    expect(removed).toBe(true);
    expect(listSuspendedForAlias(API, 'claude-opus-4-8')).toHaveLength(0);
    expect(listSuspendedForAlias(API, 'other')).toHaveLength(1);
  });
});
