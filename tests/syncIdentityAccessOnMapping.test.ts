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
  managedApiKeyExcludeKey,
  managedOauthExcludeKey,
  markManagedApiKeyIdentityExclude,
  markManagedOauthIdentityExclude,
  unmarkManagedApiKeyIdentityExclude,
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
    // 跨名 other 活跃 → toClearExclude；同名 identity 挂起 → toDisable
    expect(result.toDisable).toEqual([identity]);
    expect(result.toEnable).toEqual([]);
    expect(result.toClearExclude).toEqual([other]);
  });

  test('channel-disabled cross-name targets also hide original name', () => {
    const alias = 'my-chat';
    const cross = oauth('claude', 'claude-sonnet-4-5');
    const other = oauth('claude', 'other-model');
    const result = partitionIdentityAccessTargets({
      alias,
      selectedTargets: [other],
      suspendedTargets: [{ target: cross }],
    });
    // 跨名挂起也要进 toDisable，否则剪枝 alias 后原名会回到模型列表
    expect(result.toDisable).toEqual([cross]);
    expect(result.toEnable).toEqual([]);
    expect(result.toClearExclude).toEqual([other]);
  });

  test('re-enabling identity restores fork; re-enabling cross-name only clears exclude', () => {
    const alias = 'gpt-5.6-luna';
    const identity = oauth('codex', 'gpt-5.6-luna');
    const cross = oauth('claude', 'claude-sonnet-4-5');
    const result = partitionIdentityAccessTargets({
      alias,
      selectedTargets: [identity, cross],
      suspendedTargets: [],
    });
    expect(result.toEnable).toEqual([identity]);
    expect(result.toClearExclude).toEqual([cross]);
    expect(result.toDisable).toEqual([]);
  });

  test('abandoned targets (permanent remove / delete channel) restore original name', () => {
    const alias = 'my-chat';
    const cross = oauth('claude', 'claude-sonnet-4-5');
    const identity = oauth('codex', 'my-chat');
    const kept = oauth('claude', 'other-model');
    const result = partitionIdentityAccessTargets({
      alias,
      selectedTargets: [kept],
      suspendedTargets: [],
      abandonedTargets: [cross, identity, kept],
    });
    // kept still selected → not abandoned
    expect(result.toDisable).toEqual([]);
    expect(result.toEnable).toEqual([identity]);
    expect(result.toClearExclude.map((t) => t.modelId).sort()).toEqual([
      'claude-sonnet-4-5',
      'my-chat',
      'other-model',
    ]);
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

  test('masks apiKey excluded / catalog-suspended rows as enabled for picker UI', () => {
    installLocalStorage();
    memory.clear();
    __replaceManagedIdentityExcludeForTests(API, []);

    const resourceId = 'claude:0:sk';
    markManagedApiKeyIdentityExclude(API, resourceId, 'claude-sonnet-4-5');
    const key = managedApiKeyExcludeKey(resourceId, 'claude-sonnet-4-5');
    expect(listManagedIdentityExcludeKeys(API).has(key)).toBe(true);

    const masked = applyManagedIdentityExcludeDisplayMask(
      [
        { key, source: 'apiKey', enabled: false, modelId: 'claude-sonnet-4-5' },
        {
          key: `apiKey:${resourceId}:other`,
          source: 'apiKey',
          enabled: false,
          modelId: 'other',
        },
      ],
      API
    );
    // 受管隐藏原名：禁用页 / 映射编辑列表仍显示启用
    expect(masked[0].enabled).toBe(true);
    expect(masked[1].enabled).toBe(false);

    unmarkManagedApiKeyIdentityExclude(API, resourceId, 'claude-sonnet-4-5');
    expect(listManagedIdentityExcludeKeys(API).has(key)).toBe(false);
  });
});
