import { describe, expect, test } from 'bun:test';
import {
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  assembleFederatedMappingRows,
  attachNativeIdentityTargets,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  buildSameNameFederatedRows,
  buildUnmappedModels,
  collectMappedTargetKeys,
  diffMappingTargets,
  filterFederatedMappingRows,
  filterPersistableMappingTargets,
  filterUnmappedModels,
  getMappingDraftSignature,
  isIdentityMappingTarget,
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

    // Same API Key entry may map multiple models to one custom alias.
    expect(
      validateMappingSelection({
        alias: 'x',
        targets: [
          { source: 'apiKey', resourceId: 'r1', brand: 'claude', modelId: 'a' },
          { source: 'apiKey', resourceId: 'r1', brand: 'claude', modelId: 'b' },
        ],
        existingAliasKeys: [],
      })
    ).toBeNull();

    // Custom alias equal to every selected model id cannot be persisted.
    expect(
      validateMappingSelection({
        alias: 'gpt-image-2',
        targets: [
          { source: 'oauth', channel: 'codex', modelId: 'gpt-image-2' },
          {
            source: 'apiKey',
            resourceId: 'openaiCompatibility:0:tool',
            brand: 'openaiCompatibility',
            modelId: 'gpt-image-2',
          },
        ],
        existingAliasKeys: [],
      })
    ).toBe('identity_only');

    // Identity targets are ignored for channel uniqueness and for "has persistable target".
    expect(
      validateMappingSelection({
        alias: 'gpt-image-2',
        targets: [
          { source: 'oauth', channel: 'codex', modelId: 'gpt-image-2' },
          {
            source: 'apiKey',
            resourceId: 'openaiCompatibility:0:tool',
            brand: 'openaiCompatibility',
            modelId: 'doubao-seedream-5.0-lite',
          },
        ],
        existingAliasKeys: [],
      })
    ).toBeNull();
  });

  test('filterPersistableMappingTargets drops identity-only bindings', () => {
    const targets = [
      { source: 'oauth' as const, channel: 'codex', modelId: 'gpt-image-2' },
      {
        source: 'apiKey' as const,
        resourceId: 'r1',
        brand: 'openaiCompatibility' as const,
        modelId: 'doubao-seedream-5.0-lite',
      },
    ];
    expect(isIdentityMappingTarget('gpt-image-2', targets[0])).toBe(true);
    expect(isIdentityMappingTarget('gpt-image-2', targets[1])).toBe(false);
    const persistable = filterPersistableMappingTargets('gpt-image-2', targets);
    expect(persistable).toHaveLength(1);
    expect(persistable[0]).toMatchObject({ modelId: 'doubao-seedream-5.0-lite' });
  });

  test('planAliasTargetAssignments drops identity targets when alias is provided', () => {
    const plan = planAliasTargetAssignments(
      [
        { source: 'oauth', channel: 'codex', modelId: 'gpt-image-2' },
        {
          source: 'apiKey',
          resourceId: 'r1',
          brand: 'openaiCompatibility',
          modelId: 'doubao-seedream-5.0-lite',
        },
      ],
      'gpt-image-2'
    );
    expect(plan.oauthByChannel.size).toBe(0);
    expect(plan.apiKeyByResource.get('r1')?.modelIds).toEqual(['doubao-seedream-5.0-lite']);
  });

  test('attachNativeIdentityTargets surfaces native models matching alias', () => {
    const rows = buildFederatedMappingRows({
      modelAlias: {
        codex: [{ name: 'gpt-5.6-luna', alias: 'claude-sonnet-5' }],
      },
      resources: [
        makeResource({
          id: 'openaiCompatibility:0:tool',
          brand: 'openaiCompatibility',
          raw: {
            name: 'Tool_Aisonet',
            models: [{ name: 'doubao-seedream-5.0-lite', alias: 'gpt-image-2' }],
          },
        }),
      ],
      providerLabels: {
        oauth: (ch) => ch,
        apiKey: () => 'Tool_Aisonet',
      },
    });

    // Also create a row named gpt-image-2 via the api key alias above.
    expect(rows.some((r) => r.aliasKey === 'gpt-image-2')).toBe(true);

    const accessRows: ModelAccessRow[] = [
      {
        key: 'oauth:codex:gpt-image-2',
        source: 'oauth',
        modelId: 'gpt-image-2',
        displayName: 'gpt-image-2',
        providerLabel: 'Codex',
        channelOrBrand: 'codex',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
        oauthChannel: 'codex',
      },
      {
        key: 'apiKey:openaiCompatibility:0:tool:gpt-image-2',
        source: 'apiKey',
        modelId: 'gpt-image-2',
        displayName: 'gpt-image-2',
        providerLabel: 'OpenAI · Tool_Aisonet',
        channelOrBrand: 'openaiCompatibility',
        enabled: true,
        supportsExclude: false,
        toggleDisabled: true,
        lockReason: 'unsupported',
        resourceId: 'openaiCompatibility:0:tool',
        brand: 'openaiCompatibility',
      },
    ];

    const attached = attachNativeIdentityTargets(rows, accessRows);
    const imageRow = attached.find((r) => r.aliasKey === 'gpt-image-2');
    expect(imageRow).toBeTruthy();
    // Persistable target + native identity targets both appear.
    expect(imageRow?.targets.some((t) => t.modelId === 'doubao-seedream-5.0-lite')).toBe(true);
    expect(
      imageRow?.targets.some((t) => t.source === 'oauth' && t.modelId === 'gpt-image-2')
    ).toBe(true);
    expect(
      imageRow?.targets.some((t) => t.source === 'apiKey' && t.modelId === 'gpt-image-2')
    ).toBe(true);
  });

  test('buildSameNameFederatedRows groups multi-provider same model ids', () => {
    const accessRows: ModelAccessRow[] = [
      {
        key: 'oauth:codex:gpt-image-2',
        source: 'oauth',
        modelId: 'gpt-image-2',
        displayName: 'gpt-image-2',
        providerLabel: 'Codex',
        channelOrBrand: 'codex',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
        oauthChannel: 'codex',
      },
      {
        key: 'apiKey:openaiCompatibility:0:tool:gpt-image-2',
        source: 'apiKey',
        modelId: 'gpt-image-2',
        displayName: 'gpt-image-2',
        providerLabel: 'OpenAI · Tool_Aisonet',
        channelOrBrand: 'openaiCompatibility',
        enabled: true,
        supportsExclude: false,
        toggleDisabled: true,
        lockReason: 'unsupported',
        resourceId: 'openaiCompatibility:0:tool',
        brand: 'openaiCompatibility',
      },
      {
        key: 'oauth:claude:claude-sonnet-4-5',
        source: 'oauth',
        modelId: 'claude-sonnet-4-5',
        displayName: 'Sonnet',
        providerLabel: 'Claude',
        channelOrBrand: 'claude',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
        oauthChannel: 'claude',
      },
    ];

    const sameName = buildSameNameFederatedRows(accessRows);
    expect(sameName).toHaveLength(1);
    expect(sameName[0].aliasKey).toBe('gpt-image-2');
    expect(sameName[0].targets).toHaveLength(2);

    const assembled = assembleFederatedMappingRows([], accessRows);
    expect(assembled).toHaveLength(1);
    expect(assembled[0].alias).toBe('gpt-image-2');

    // Same-name federation leaves those targets out of "unmapped".
    const mappedKeys = collectMappedTargetKeys(assembled);
    const unmapped = buildUnmappedModels(accessRows, mappedKeys);
    expect(unmapped.map((r) => r.modelId)).toEqual(['claude-sonnet-4-5']);
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

  test('applyApiKeyModelAliasChanges allows multiple models on one resource to share an alias', () => {
    const models = [
      { name: 'a', alias: 'chat' },
      { name: 'b' },
      { name: 'c', alias: 'other' },
    ];

    const next = applyApiKeyModelAliasChanges({
      models,
      alias: 'chat',
      nextModelIds: ['a', 'b'],
      previousModelIds: ['a'],
    });

    expect(next.find((m) => m.name === 'a')?.alias).toBe('chat');
    expect(next.find((m) => m.name === 'b')?.alias).toBe('chat');
    expect(next.find((m) => m.name === 'c')?.alias).toBe('other');
  });

  test('applyApiKeyModelAliasChanges skips identity alias and can append missing models', () => {
    const models = [{ name: 'gpt-image-2', alias: 'gpt-image-2' }];

    const next = applyApiKeyModelAliasChanges({
      models,
      alias: 'gpt-image-2',
      nextModelIds: ['gpt-image-2', 'doubao-seedream-5.0-lite'],
    });

    expect(next.find((m) => m.name === 'gpt-image-2')?.alias).toBeUndefined();
    expect(next.find((m) => m.name === 'doubao-seedream-5.0-lite')).toMatchObject({
      name: 'doubao-seedream-5.0-lite',
      alias: 'gpt-image-2',
    });
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

  test('buildUnmappedModels excludes mapped targets and disabled models', () => {
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

    const mapped = collectMappedTargetKeys([
      {
        alias: 'chat',
        aliasKey: 'chat',
        targets: [
          {
            source: 'oauth',
            channel: 'claude',
            modelId: 'claude-a',
            displayName: 'A',
            providerLabel: 'Claude',
            currentlyEnabled: true,
          },
        ],
      },
    ]);

    const unmapped = buildUnmappedModels(accessRows, mapped);
    // claude-a is mapped; claude-b is disabled; only gpt-x remains.
    expect(unmapped.map((row) => row.modelId)).toEqual(['gpt-x']);
    expect(unmapped.every((row) => row.enabled)).toBe(true);
    expect(filterUnmappedModels(unmapped, 'gpt')).toHaveLength(1);
    expect(filterUnmappedModels(unmapped, 'zzz')).toHaveLength(0);
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
