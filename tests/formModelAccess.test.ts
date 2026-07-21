import { describe, expect, test } from 'bun:test';
import {
  collectDisabledModelIds,
  collectExactExcludedIds,
  filterEnabledCatalogNames,
  mergeFormExcludedModels,
  modelsToFormEntriesWithAccess,
  resolveEntriesToSuspend,
} from '../src/features/providers/formModelAccess';

describe('formModelAccess', () => {
  test('collectDisabledModelIds returns unique disabled names', () => {
    expect(
      collectDisabledModelIds([
        { name: 'gpt-a', enabled: false },
        { name: 'gpt-b', enabled: true },
        { name: 'GPT-A', enabled: false },
        { name: '  ', enabled: false },
      ])
    ).toEqual(['gpt-a']);
  });

  test('collectExactExcludedIds ignores wildcards and star', () => {
    const set = collectExactExcludedIds(['gpt-4', 'gpt-*', '*', 'claude-opus']);
    expect(set.has('gpt-4')).toBe(true);
    expect(set.has('claude-opus')).toBe(true);
    expect(set.has('gpt-*')).toBe(false);
    expect(set.has('*')).toBe(false);
  });

  test('mergeFormExcludedModels keeps wildcards and applies form disables + entry flag', () => {
    const next = mergeFormExcludedModels({
      existingExcluded: ['old-exact', 'gpt-*', '*'],
      entryDisabled: true,
      formDisabledModelIds: ['claude-opus', 'gpt-4'],
    });
    expect(next).toEqual(['gpt-*', 'claude-opus', 'gpt-4', '*']);
  });

  test('mergeFormExcludedModels drops star when entry is enabled', () => {
    const next = mergeFormExcludedModels({
      existingExcluded: ['old', '*'],
      entryDisabled: false,
      formDisabledModelIds: ['gpt-4'],
    });
    expect(next).toEqual(['gpt-4']);
  });

  test('modelsToFormEntriesWithAccess annotates excludes and appends suspended', () => {
    const rows = modelsToFormEntriesWithAccess({
      models: [
        { name: 'gpt-a' },
        { name: 'gpt-b' },
        { name: 'gpt-a', image: true },
      ],
      includeOpenAIFields: true,
      exactExcludedIds: ['gpt-b'],
      suspendedCatalog: [
        {
          resourceId: 'openaiCompatibility:0:x',
          modelId: 'gpt-c',
          entries: [{ name: 'gpt-c', alias: 'my-c' }],
        },
        {
          resourceId: 'openaiCompatibility:0:x',
          modelId: 'gpt-a',
          entries: [{ name: 'gpt-a' }],
        },
      ],
    });
    expect(rows.map((r) => ({ name: r.name, enabled: r.enabled, image: r.image }))).toEqual([
      { name: 'gpt-a', enabled: true, image: true },
      { name: 'gpt-b', enabled: false, image: false },
      { name: 'gpt-c', enabled: false, image: undefined },
    ]);
  });

  test('filterEnabledCatalogNames drops disabled rows', () => {
    expect(
      filterEnabledCatalogNames([
        { name: 'a', enabled: true },
        { name: 'b', enabled: false },
        { name: 'c' },
      ]).map((r) => r.name)
    ).toEqual(['a', 'c']);
  });

  test('resolveEntriesToSuspend prefers existing alias entries', () => {
    const entries = resolveEntriesToSuspend(
      [
        { name: 'gpt-x', alias: 'chan-a' },
        { name: 'gpt-x', alias: 'chan-b' },
        { name: 'other' },
      ],
      'gpt-x'
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].alias).toBe('chan-a');
  });

  test('appends mapping-pruned catalog hints as enabled and backend-omitted', () => {
    const rows = modelsToFormEntriesWithAccess({
      models: [],
      catalogOnlyModelIds: ['MiniMax-M3'],
    });

    expect(rows).toEqual([{ name: 'MiniMax-M3', enabled: true, backendOmitted: true }]);
  });

  test('does not treat mapping-pruned catalog hints as enabled backend catalog names', () => {
    const rows = modelsToFormEntriesWithAccess({
      models: [],
      catalogOnlyModelIds: ['MiniMax-M3'],
    });

    expect(filterEnabledCatalogNames(rows)).toEqual([]);
  });
});
