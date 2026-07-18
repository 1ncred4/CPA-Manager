import { describe, expect, test } from 'bun:test';
import {
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  diffMappingTargets,
  filterFederatedMappingRows,
  getMappingDraftSignature,
  isMeaningfulAlias,
  mappingTargetKey,
  planAliasTargetAssignments,
  toAliasKey,
  validateMappingSelection,
} from '../src/features/models/modelMapping';
import type { ModelAccessRow } from '../src/features/models/modelAccessRows';
import type { ProviderResource } from '../src/features/providers/types';
import type { OAuthModelAliasEntry } from '../src/types';

const makeResource = (overrides: Partial<ProviderResource> = {}): ProviderResource =>
  ({
    id: 'claude:0:sk-test',
    brand: 'claude',
    originalIndex: 0,
    name: null,
    identifier: 'sk-…test',
    apiKeyPreview: 'sk-…test',
    apiKey: 'sk-test',
    authIndex: null,
    baseUrl: null,
    proxyUrl: null,
    prefix: null,
    modelCount: 2,
    models: ['claude-opus-4-8', 'claude-sonnet-4-5'],
    priority: 0,
    headerCount: 0,
    excludedModelCount: 0,
    apiKeyEntryCount: 0,
    disabled: false,
    flags: {},
    selector: { brand: 'claude', apiKey: 'sk-test', index: 0 },
    raw: {
      apiKey: 'sk-test',
      models: [
        { name: 'claude-opus-4-8', alias: 'chat-plus' },
        { name: 'claude-sonnet-4-5' },
      ],
    },
    ...overrides,
  }) as ProviderResource;

describe('modelMapping', () => {
  test('aggregates oauth aliases across channels into one row', () => {
    const modelAlias: Record<string, OAuthModelAliasEntry[]> = {
      claude: [{ name: 'claude-sonnet-4-5', alias: 'chat-plus', fork: true }],
      codex: [{ name: 'gpt-5.2', alias: 'Chat-Plus' }],
    };

    const rows = buildFederatedMappingRows({
      modelAlias,
      resources: [],
      providerLabels: {
        oauth: (ch) => ch,
        apiKey: () => 'api',
      },
      oauthDisplayNames: {
        claude: { 'claude-sonnet-4-5': 'Claude Sonnet' },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].aliasKey).toBe('chat-plus');
    expect(rows[0].targets).toHaveLength(2);
    expect(rows[0].targets.map((t) => t.source).sort()).toEqual(['oauth', 'oauth']);
    expect(rows[0].targets.find((t) => t.source === 'oauth' && t.channel === 'claude')?.displayName).toBe(
      'Claude Sonnet'
    );
  });

  test('aggregates api key aliases and ignores alias===name', () => {
    const resource = makeResource({
      raw: {
        apiKey: 'sk-test',
        models: [
          { name: 'claude-opus-4-8', alias: 'chat-plus' },
          { name: 'claude-sonnet-4-5', alias: 'claude-sonnet-4-5' },
          { name: 'claude-haiku' },
        ],
      },
    });

    const rows = buildFederatedMappingRows({
      modelAlias: {},
      resources: [resource],
      providerLabels: {
        oauth: (ch) => ch,
        apiKey: (r) => `API · ${r.identifier}`,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].alias).toBe('chat-plus');
    expect(rows[0].targets).toHaveLength(1);
    expect(rows[0].targets[0]).toMatchObject({
      source: 'apiKey',
      resourceId: resource.id,
      modelId: 'claude-opus-4-8',
    });
  });

  test('merges oauth + api key targets under same alias', () => {
    const rows = buildFederatedMappingRows({
      modelAlias: {
        claude: [{ name: 'claude-sonnet-4-5', alias: 'chat-plus' }],
      },
      resources: [makeResource()],
      providerLabels: {
        oauth: () => 'Claude OAuth',
        apiKey: () => 'Claude Key',
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].aliasKey).toBe('chat-plus');
    expect(rows[0].targets).toHaveLength(2);
    expect(rows[0].targets.some((t) => t.source === 'oauth')).toBe(true);
    expect(rows[0].targets.some((t) => t.source === 'apiKey')).toBe(true);
  });

  test('currentlyEnabled reflects enabledKeySet without dropping mapped targets', () => {
    const rows = buildFederatedMappingRows({
      modelAlias: {
        claude: [{ name: 'claude-sonnet-4-5', alias: 'chat-plus' }],
      },
      resources: [],
      providerLabels: { oauth: () => 'Claude', apiKey: () => 'k' },
      enabledKeySet: new Set(), // none enabled
    });
    expect(rows[0].targets[0].currentlyEnabled).toBe(false);

    const rows2 = buildFederatedMappingRows({
      modelAlias: {
        claude: [{ name: 'claude-sonnet-4-5', alias: 'chat-plus' }],
      },
      resources: [],
      providerLabels: { oauth: () => 'Claude', apiKey: () => 'k' },
      enabledKeySet: new Set(['oauth:claude:claude-sonnet-4-5']),
    });
    expect(rows2[0].targets[0].currentlyEnabled).toBe(true);
  });

  test('buildEnabledMappingOptions only includes enabled rows', () => {
    const accessRows: ModelAccessRow[] = [
      {
        key: 'oauth:claude:a',
        source: 'oauth',
        modelId: 'claude-a',
        displayName: 'A',
        providerLabel: 'Claude',
        channelOrBrand: 'claude',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
        oauthChannel: 'claude',
      },
      {
        key: 'oauth:claude:b',
        source: 'oauth',
        modelId: 'claude-b',
        displayName: 'B',
        providerLabel: 'Claude',
        channelOrBrand: 'claude',
        enabled: false,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
        oauthChannel: 'claude',
      },
      {
        key: 'apiKey:r1:x',
        source: 'apiKey',
        modelId: 'gpt-x',
        displayName: 'gpt-x',
        providerLabel: 'OpenAI',
        channelOrBrand: 'openaiCompatibility',
        enabled: true,
        supportsExclude: false,
        toggleDisabled: true,
        lockReason: 'unsupported',
        resourceId: 'openaiCompatibility:0:x',
        brand: 'openaiCompatibility',
      },
    ];

    const options = buildEnabledMappingOptions(accessRows);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.modelId).sort()).toEqual(['claude-a', 'gpt-x']);
  });

  test('diffMappingTargets computes add/remove', () => {
    const baseline = [
      { source: 'oauth' as const, channel: 'claude', modelId: 'a' },
      { source: 'oauth' as const, channel: 'codex', modelId: 'b' },
    ];
    const next = [
      { source: 'oauth' as const, channel: 'claude', modelId: 'a' },
      { source: 'apiKey' as const, resourceId: 'r1', brand: 'claude' as const, modelId: 'c' },
    ];
    const diff = diffMappingTargets(baseline, next);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toAdd[0]).toMatchObject({ source: 'apiKey', modelId: 'c' });
    expect(diff.toRemove).toHaveLength(1);
    expect(diff.toRemove[0]).toMatchObject({ channel: 'codex', modelId: 'b' });
  });

  test('validateMappingSelection catches conflicts', () => {
    expect(
      validateMappingSelection({
        alias: '',
        targets: [{ source: 'oauth', channel: 'claude', modelId: 'a' }],
        existingAliasKeys: [],
      })
    ).toBe('alias_required');

    expect(
      validateMappingSelection({
        alias: 'x',
        targets: [],
        existingAliasKeys: [],
      })
    ).toBe('no_targets');

    expect(
      validateMappingSelection({
        alias: 'Chat',
        targets: [{ source: 'oauth', channel: 'claude', modelId: 'a' }],
        existingAliasKeys: ['chat'],
      })
    ).toBe('duplicate_alias');

    expect(
      validateMappingSelection({
        alias: 'Chat',
        targets: [{ source: 'oauth', channel: 'claude', modelId: 'a' }],
        existingAliasKeys: ['chat'],
        editingAliasKey: 'chat',
      })
    ).toBeNull();

    expect(
      validateMappingSelection({
        alias: 'x',
        targets: [
          { source: 'oauth', channel: 'claude', modelId: 'a' },
          { source: 'oauth', channel: 'claude', modelId: 'b' },
        ],
        existingAliasKeys: [],
      })
    ).toBe('channel_conflict');

    expect(
      validateMappingSelection({
        alias: 'x',
        targets: [
          { source: 'apiKey', resourceId: 'r1', brand: 'claude', modelId: 'a' },
          { source: 'apiKey', resourceId: 'r1', brand: 'claude', modelId: 'b' },
        ],
        existingAliasKeys: [],
      })
    ).toBe('resource_conflict');
  });

  test('applyOauthAliasTargetChanges preserves other aliases and forceMapping', () => {
    const entries: OAuthModelAliasEntry[] = [
      { name: 'keep-me', alias: 'other', fork: true },
      { name: 'old', alias: 'chat', fork: true, forceMapping: true },
    ];

    const next = applyOauthAliasTargetChanges({
      entries,
      alias: 'chat',
      nextModelIds: ['old'],
    });
    expect(next).toHaveLength(2);
    expect(next.find((e) => e.alias === 'other')?.name).toBe('keep-me');
    expect(next.find((e) => e.alias === 'chat')).toMatchObject({
      name: 'old',
      forceMapping: true,
      fork: true,
    });

    const replaced = applyOauthAliasTargetChanges({
      entries,
      alias: 'chat',
      nextModelIds: ['new-model'],
    });
    expect(replaced.find((e) => e.alias === 'chat')?.name).toBe('new-model');
    expect(replaced.find((e) => e.name === 'old')).toBeUndefined();

    const cleared = applyOauthAliasTargetChanges({
      entries,
      alias: 'chat',
      nextModelIds: [],
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].alias).toBe('other');
  });

  test('applyApiKeyModelAliasChanges sets and clears alias without dropping models', () => {
    const models = [
      { name: 'a', alias: 'chat' },
      { name: 'b', priority: 1 },
      { name: 'c', alias: 'other' },
    ];

    const next = applyApiKeyModelAliasChanges({
      models,
      alias: 'chat',
      nextModelIds: ['b'],
      previousModelIds: ['a'],
    });

    expect(next.find((m) => m.name === 'a')?.alias).toBeUndefined();
    expect(next.find((m) => m.name === 'b')?.alias).toBe('chat');
    expect(next.find((m) => m.name === 'b')?.priority).toBe(1);
    expect(next.find((m) => m.name === 'c')?.alias).toBe('other');
  });

  test('planAliasTargetAssignments groups by channel/resource', () => {
    const plan = planAliasTargetAssignments([
      { source: 'oauth', channel: 'Claude', modelId: 'a' },
      { source: 'oauth', channel: 'codex', modelId: 'b' },
      { source: 'apiKey', resourceId: 'r1', brand: 'claude', modelId: 'c' },
    ]);
    expect(plan.oauthByChannel.get('claude')).toEqual(['a']);
    expect(plan.oauthByChannel.get('codex')).toEqual(['b']);
    expect(plan.apiKeyByResource.get('r1')?.modelIds).toEqual(['c']);
  });

  test('filter + signature helpers', () => {
    expect(isMeaningfulAlias('x', 'x')).toBe(false);
    expect(isMeaningfulAlias('X', 'x')).toBe(false);
    expect(isMeaningfulAlias('y', 'x')).toBe(true);
    expect(toAliasKey(' AbC ')).toBe('abc');
    expect(mappingTargetKey({ source: 'oauth', channel: 'Claude', modelId: 'A' })).toBe(
      'oauth:claude:a'
    );

    const rows = buildFederatedMappingRows({
      modelAlias: { claude: [{ name: 'm1', alias: 'alpha' }] },
      resources: [],
      providerLabels: { oauth: () => 'Claude', apiKey: () => 'k' },
    });
    expect(filterFederatedMappingRows(rows, 'alp')).toHaveLength(1);
    expect(filterFederatedMappingRows(rows, 'zzz')).toHaveLength(0);

    expect(
      getMappingDraftSignature('A', [{ source: 'oauth', channel: 'c', modelId: 'm' }])
    ).toBe(getMappingDraftSignature('a', [{ source: 'oauth', channel: 'C', modelId: 'M' }]));
  });
});
