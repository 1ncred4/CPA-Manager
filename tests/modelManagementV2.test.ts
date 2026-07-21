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
});
