import { describe, expect, test } from 'bun:test';
import {
  listUserNonIdentityAliasesForModel,
  partitionIdentityAccessTargets,
  planOauthIdentityDisable,
  planOauthIdentityEnable,
} from '../src/features/models/syncIdentityAccessOnMapping';
import {
  __replaceManagedIdentityExcludeForTests,
  applyManagedIdentityExcludeDisplayMask,
  listManagedIdentityExcludeKeys,
  managedOauthExcludeKey,
  markManagedOauthIdentityExclude,
  unmarkManagedOauthIdentityExclude,
} from '../src/features/models/managedIdentityExclude';
import type { MappingTargetRef } from '../src/features/models/modelMapping';
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
  globalThis.window = { localStorage: storage, dispatchEvent: () => true };
  // @ts-expect-error test shim
  globalThis.localStorage = storage;
};

const oauth = (channel: string, modelId: string): MappingTargetRef => ({
  source: 'oauth',
  channel,
  modelId,
});

describe('partitionIdentityAccessTargets', () => {
  test('splits same-name identity targets by channel enable state', () => {
    const alias = 'gpt-5.6-luna';
    const identity = oauth('codex', 'gpt-5.6-luna');
    const other = oauth('codex', 'gpt-5');
    const result = partitionIdentityAccessTargets({
      alias,
      selectedTargets: [other],
      suspendedTargets: [{ target: identity }],
    });
    expect(result.toDisable).toEqual([identity]);
    expect(result.toEnable).toEqual([]);
  });
});

describe('oauth identity fork vs exclude plan', () => {
  test('prefers fork=false when user aliases exist', () => {
    const entries: OAuthModelAliasEntry[] = [
      { name: 'gpt-5.6-luna', alias: 'my-luna', fork: true },
    ];
    const plan = planOauthIdentityDisable(entries, 'gpt-5.6-luna');
    expect(plan.usedFork).toBe(true);
    expect(plan.needsExclude).toBe(false);
    expect(plan.next[0].fork).toBeUndefined();
  });

  test('needs exclude when no user aliases (no fake cpa.off alias)', () => {
    const plan = planOauthIdentityDisable([{ name: 'other', alias: 'chat' }], 'gpt-5.6-luna');
    expect(plan.usedFork).toBe(false);
    expect(plan.needsExclude).toBe(true);
    expect(plan.next.some((e) => String(e.alias).startsWith('cpa.off.'))).toBe(false);
  });

  test('drops historical cpa.off anchors on disable plan', () => {
    const plan = planOauthIdentityDisable(
      [
        { name: 'gpt-5.6-luna', alias: 'cpa.off.gpt-5.6-luna' },
        { name: 'gpt-5.6-luna', alias: 'my-luna', fork: true },
      ],
      'gpt-5.6-luna'
    );
    expect(plan.usedFork).toBe(true);
    expect(plan.next.find((e) => String(e.alias).startsWith('cpa.off.'))).toBeUndefined();
    expect(plan.next.find((e) => e.alias === 'my-luna')?.fork).toBeUndefined();
  });

  test('enable restores fork and drops anchors', () => {
    const plan = planOauthIdentityEnable(
      [
        { name: 'gpt-5.6-luna', alias: 'my-luna' },
        { name: 'gpt-5.6-luna', alias: 'cpa.off.gpt-5.6-luna' },
      ],
      'gpt-5.6-luna'
    );
    expect(plan.next).toEqual([{ name: 'gpt-5.6-luna', alias: 'my-luna', fork: true }]);
  });

  test('listUserNonIdentityAliasesForModel ignores cpa.off', () => {
    const related = listUserNonIdentityAliasesForModel(
      [
        { name: 'gpt-5.6-luna', alias: 'cpa.off.gpt-5.6-luna' },
        { name: 'gpt-5.6-luna', alias: 'my-luna' },
      ],
      'gpt-5.6-luna'
    );
    expect(related).toEqual([{ name: 'gpt-5.6-luna', alias: 'my-luna' }]);
  });
});

describe('managed identity exclude display mask', () => {
  test('marks and unmasks oauth rows as enabled in UI', () => {
    installLocalStorage();
    memory.clear();
    __replaceManagedIdentityExcludeForTests(API, []);

    markManagedOauthIdentityExclude(API, 'codex', 'gpt-5.6-luna');
    const key = managedOauthExcludeKey('codex', 'gpt-5.6-luna');
    expect(listManagedIdentityExcludeKeys(API).has(key)).toBe(true);

    const masked = applyManagedIdentityExcludeDisplayMask(
      [
        { key, source: 'oauth', enabled: false, modelId: 'gpt-5.6-luna' },
        {
          key: 'oauth:codex:other',
          source: 'oauth',
          enabled: false,
          modelId: 'other',
        },
      ],
      API
    );
    expect(masked[0].enabled).toBe(true);
    expect(masked[1].enabled).toBe(false);

    unmarkManagedOauthIdentityExclude(API, 'codex', 'gpt-5.6-luna');
    expect(listManagedIdentityExcludeKeys(API).has(key)).toBe(false);
  });
});
