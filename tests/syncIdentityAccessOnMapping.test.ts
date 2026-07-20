import { describe, expect, test } from 'bun:test';
import {
  listNonIdentityAliasesForModel,
  partitionIdentityAccessTargets,
  planOauthIdentityDisable,
  planOauthIdentityEnable,
} from '../src/features/models/syncIdentityAccessOnMapping';
import type { MappingTargetRef } from '../src/features/models/modelMapping';
import type { OAuthModelAliasEntry } from '../src/types';

const oauth = (channel: string, modelId: string): MappingTargetRef => ({
  source: 'oauth',
  channel,
  modelId,
});

const apiKey = (resourceId: string, modelId: string): MappingTargetRef => ({
  source: 'apiKey',
  resourceId,
  brand: 'claude',
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

  test('enables identity when selected and not suspended', () => {
    const alias = 'gpt-5.6-luna';
    const identity = oauth('codex', 'gpt-5.6-luna');
    const result = partitionIdentityAccessTargets({
      alias,
      selectedTargets: [identity],
      suspendedTargets: [],
    });
    expect(result.toEnable).toEqual([identity]);
    expect(result.toDisable).toEqual([]);
  });

  test('ignores non-identity targets', () => {
    const result = partitionIdentityAccessTargets({
      alias: 'my-channel',
      selectedTargets: [apiKey('claude:0:x', 'claude-opus-4-8')],
      suspendedTargets: [{ target: apiKey('claude:0:x', 'claude-sonnet-4-5') }],
    });
    expect(result.toEnable).toEqual([]);
    expect(result.toDisable).toEqual([]);
  });

  test('suspended wins when both selected and suspended', () => {
    const identity = oauth('codex', 'gpt-5.6-luna');
    const result = partitionIdentityAccessTargets({
      alias: 'gpt-5.6-luna',
      selectedTargets: [identity],
      suspendedTargets: [{ target: identity }],
    });
    expect(result.toDisable).toEqual([identity]);
    expect(result.toEnable).toEqual([]);
  });
});

describe('listNonIdentityAliasesForModel / fork plans', () => {
  const entries: OAuthModelAliasEntry[] = [
    { name: 'gpt-5.6-luna', alias: 'my-luna', fork: true },
    { name: 'gpt-5.6-luna', alias: 'gpt-5.6-luna' }, // identity residue
    { name: 'other', alias: 'chat' },
  ];

  test('lists only meaningful non-identity aliases for a source model', () => {
    const related = listNonIdentityAliasesForModel(entries, 'gpt-5.6-luna');
    expect(related).toEqual([{ name: 'gpt-5.6-luna', alias: 'my-luna', fork: true }]);
  });

  test('planOauthIdentityDisable prefers fork=false over exclude', () => {
    const plan = planOauthIdentityDisable(entries, 'gpt-5.6-luna');
    expect(plan.usedFork).toBe(true);
    expect(plan.needsExclude).toBe(false);
    expect(plan.changed).toBe(true);
    const luna = plan.next.find((e) => e.alias === 'my-luna');
    expect(luna?.fork).toBeUndefined();
  });

  test('planOauthIdentityDisable falls back to exclude when no alias exists', () => {
    const plan = planOauthIdentityDisable(
      [{ name: 'other', alias: 'chat' }],
      'gpt-5.6-luna'
    );
    expect(plan.usedFork).toBe(false);
    expect(plan.needsExclude).toBe(true);
    expect(plan.changed).toBe(false);
  });

  test('planOauthIdentityDisable is no-op when fork already off', () => {
    const plan = planOauthIdentityDisable(
      [{ name: 'gpt-5.6-luna', alias: 'my-luna' }],
      'gpt-5.6-luna'
    );
    expect(plan.usedFork).toBe(true);
    expect(plan.needsExclude).toBe(false);
    expect(plan.changed).toBe(false);
  });

  test('planOauthIdentityEnable sets fork=true', () => {
    const plan = planOauthIdentityEnable(
      [{ name: 'gpt-5.6-luna', alias: 'my-luna' }],
      'gpt-5.6-luna'
    );
    expect(plan.usedFork).toBe(true);
    expect(plan.clearExclude).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.next[0].fork).toBe(true);
  });
});
