import { describe, expect, test } from 'bun:test';
import { buildStateFromSources, emptyMirrors, type ModelDisplayContext } from '../src/features/models/modelManagementState';
import { accessEnabledKey } from '../src/features/models/modelMapping';
import type { ProviderResource } from '../src/features/providers/types';

const ctx: ModelDisplayContext = {
  oauthProviderLabel: (channel) => `OAuth ${channel}`,
  apiKeyProviderLabel: (id) => `API ${id}`,
  oauthIcon: () => null,
  apiKeyIcon: () => null,
  oauthDisplayNames: {},
};

const apiResource = (id: string, models: Array<{ name: string; alias: string }>): ProviderResource => ({
  id,
  brand: 'gemini',
  originalIndex: 0,
  name: null,
  identifier: id,
  apiKeyPreview: null,
  apiKey: null,
  authIndex: null,
  baseUrl: null,
  proxyUrl: null,
  prefix: null,
  modelCount: models.length,
  models: models.map((model) => model.name),
  priority: 0,
  headerCount: 0,
  excludedModelCount: 0,
  apiKeyEntryCount: 0,
  disabled: false,
  flags: {},
  selector: { brand: 'gemini', apiKey: 'key', index: 0 },
  raw: { models, excludedModels: [] },
});

describe('model-management v2 projection', () => {
  test('groups OAuth and API Key targets by alias', () => {
    const state = buildStateFromSources(
      {
        oauthModels: { claude: [{ id: 'shared', display_name: 'Shared' }] },
        oauthAliasMap: { claude: [{ name: 'shared', alias: 'chat' }] },
        oauthExcludedMap: {},
        resources: [apiResource('gemini:0', [{ name: 'shared', alias: 'chat' }])],
      },
      emptyMirrors(),
      ctx
    );
    const row = state.mapping.byAliasKey.get('chat');
    expect(row?.targets).toHaveLength(2);
    expect(row?.targets.map((target) => target.source).sort()).toEqual(['apiKey', 'oauth']);
  });

  test('suppresses automatic identity when another alias exists, but preserves explicit identity', () => {
    const refKey = accessEnabledKey({ source: 'oauth', channel: 'claude', modelId: 'shared' });
    const sources = {
      oauthModels: { claude: [{ id: 'shared' }] },
      oauthAliasMap: { claude: [{ name: 'shared', alias: 'shared' }, { name: 'shared', alias: 'chat' }] },
      oauthExcludedMap: {},
      resources: [],
    };
    const automatic = buildStateFromSources(sources, emptyMirrors(), ctx);
    expect(automatic.mapping.byAliasKey.has('shared')).toBe(false);
    const mirrors = emptyMirrors();
    mirrors.explicitIdentityKeys.add(refKey);
    const explicit = buildStateFromSources(sources, mirrors, ctx);
    expect(explicit.mapping.byAliasKey.get('shared')?.targets).toHaveLength(1);
    expect(explicit.mapping.byAliasKey.get('shared')?.targets[0].aliasOrigin).toBe('explicit');
  });

  test('keeps disabled mapping targets grouped without affecting other aliases', () => {
    const ref = { source: 'oauth' as const, channel: 'claude', modelId: 'a' };
    const mirrors = emptyMirrors();
    mirrors.mappingDisabled.set('oauth:claude:a', [{ alias: 'chat', target: ref }]);
    const state = buildStateFromSources(
      { oauthModels: { claude: [{ id: 'a' }] }, oauthAliasMap: { claude: [{ name: 'a', alias: 'other' }] }, oauthExcludedMap: {}, resources: [] },
      mirrors,
      ctx
    );
    const chat = state.mapping.byAliasKey.get('chat');
    const other = state.mapping.byAliasKey.get('other');
    expect(chat?.targets[0].disabledReason).toBe('mapping');
    expect(other?.targets[0].disabledReason).toBeUndefined();
  });

  test('hides globally disabled models that have no explicit alias mapping', () => {
    const ref = { source: 'oauth' as const, channel: 'claude', modelId: 'native' };
    const mirrors = emptyMirrors();
    mirrors.modelDisabled.set(accessEnabledKey(ref), {
      target: ref,
      entries: [{ name: 'native', alias: 'native' }],
    });
    const hidden = buildStateFromSources(
      {
        oauthModels: { claude: [{ id: 'native' }] },
        oauthAliasMap: {},
        oauthExcludedMap: {},
        resources: [],
      },
      mirrors,
      ctx
    );
    expect(hidden.mapping.byAliasKey.has('native')).toBe(false);

    mirrors.modelDisabled.set(accessEnabledKey(ref), {
      target: ref,
      entries: [{ name: 'native', alias: 'chat' }],
    });
    const mapped = buildStateFromSources(
      {
        oauthModels: { claude: [{ id: 'native' }] },
        oauthAliasMap: {},
        oauthExcludedMap: {},
        resources: [],
      },
      mirrors,
      ctx
    );
    expect(mapped.mapping.byAliasKey.get('chat')?.targets[0].disabledReason).toBe('model');
  });

  test('hides OAuth excluded models that have no explicit alias mapping', () => {
    const sources = {
      oauthModels: { codex: [{ id: 'gpt-5.4' }] },
      oauthAliasMap: {},
      oauthExcludedMap: { codex: ['gpt-5.4'] },
      resources: [],
    };
    const hidden = buildStateFromSources(sources, emptyMirrors(), ctx);
    expect(hidden.mapping.byAliasKey.has('gpt-5.4')).toBe(false);

    const mapped = buildStateFromSources(
      { ...sources, oauthAliasMap: { codex: [{ name: 'gpt-5.4', alias: 'fast' }] } },
      emptyMirrors(),
      ctx
    );
    expect(mapped.mapping.byAliasKey.get('fast')?.targets[0].disabledReason).toBe('model');
  });

  test('keeps mapping-disabled API models visible as globally enabled access rows', () => {
    const ref = {
      source: 'apiKey' as const,
      resourceId: 'claude:0',
      brand: 'claude' as const,
      modelId: 'MiniMax-M3',
    };
    const mirrors = emptyMirrors();
    mirrors.mappingDisabled.set('apiKey:claude:0:minimax-m3', [{ alias: 'chat', target: ref }]);

    const state = buildStateFromSources(
      {
        oauthModels: {},
        oauthAliasMap: {},
        oauthExcludedMap: {},
        resources: [apiResource('claude:0', [])],
      },
      mirrors,
      ctx
    );

    expect(state.access.byKey.get('apiKey:claude:0:minimax-m3')).toMatchObject({
      modelId: 'MiniMax-M3',
      enabled: true,
    });
  });
});
