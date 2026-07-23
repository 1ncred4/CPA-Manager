import { describe, expect, test } from 'bun:test';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  collectOAuthChannels,
  filterModelAccessRows,
  findMatchingWildcardRule,
  sortModelAccessRows,
  toggleApiKeyExcludedList,
} from '../src/features/models/modelAccessRows';
import type { ProviderResource } from '../src/features/providers/types';

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
    raw: { apiKey: 'sk-test', models: [{ name: 'claude-opus-4-8' }, { name: 'claude-sonnet-4-5' }] },
    ...overrides,
  }) as ProviderResource;

describe('modelAccessRows', () => {
  test('builds oauth rows with exact exclude as disabled', () => {
    const rows = buildOAuthAccessRows({
      channel: 'Claude',
      models: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        { id: 'claude-sonnet-4-5' },
      ],
      excluded: { claude: ['claude-opus-4-8'] },
      providerLabel: 'Claude',
      iconSrc: 'claude.svg',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: 'oauth:claude:claude-opus-4-8',
      source: 'oauth',
      enabled: false,
      displayName: 'Claude Opus 4.8',
      toggleDisabled: false,
      lockReason: null,
      oauthChannel: 'claude',
    });
    expect(rows[1]).toMatchObject({
      modelId: 'claude-sonnet-4-5',
      displayName: 'claude-sonnet-4-5',
      enabled: true,
    });
  });

  test('locks oauth rows that only match wildcard rules', () => {
    const rows = buildOAuthAccessRows({
      channel: 'codex',
      models: [{ id: 'gpt-5.2' }, { id: 'o3' }],
      excluded: { codex: ['gpt-*'] },
      providerLabel: 'Codex',
    });

    expect(rows[0]).toMatchObject({
      modelId: 'gpt-5.2',
      enabled: false,
      toggleDisabled: true,
      lockReason: 'wildcard',
      lockDetail: 'gpt-*',
    });
    expect(rows[1]).toMatchObject({
      modelId: 'o3',
      enabled: true,
      toggleDisabled: false,
    });
  });

  test('findMatchingWildcardRule ignores exact and non-matching patterns', () => {
    expect(findMatchingWildcardRule('gpt-5', ['gpt-5', 'claude-*'])).toBeNull();
    expect(findMatchingWildcardRule('gpt-5', ['gpt-*'])).toBe('gpt-*');
  });

  test('builds api key rows from active models only', () => {
    const resource = makeResource({
      raw: {
        apiKey: 'sk-test',
        models: [{ name: 'claude-opus-4-8' }, { name: 'claude-sonnet-4-5' }],
        excludedModels: ['claude-opus-4-8'],
      },
      excludedModelCount: 1,
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'Claude · sk-…test',
      iconSrc: 'c.svg',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: 'apiKey:claude:0:sk-test:claude-opus-4-8',
      source: 'apiKey',
      enabled: true,
      supportsExclude: true,
      resourceId: 'claude:0:sk-test',
    });
    expect(rows[1].enabled).toBe(true);
  });

  test('shows suspended Gemini API Key models as disabled rows', () => {
    const resource = makeResource({
      id: 'gemini:0:sk-test',
      brand: 'gemini',
      models: ['other-model'],
      raw: {
        apiKey: 'sk-test',
        models: [{ name: 'other-model', alias: 'other' }],
      },
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'Gemini · sk-…test',
      suspendedCatalogModelIds: ['gemma-4-31b-it'],
    });

    expect(rows.find((row) => row.modelId === 'gemma-4-31b-it')).toMatchObject({
      enabled: false,
      disableMode: 'catalog',
      toggleDisabled: false,
    });
  });

  test('disables toggles when api key entry is fully disabled via *', () => {
    const resource = makeResource({
      disabled: true,
      raw: {
        apiKey: 'sk-test',
        excludedModels: ['*', 'claude-opus-4-8'],
        models: [{ name: 'claude-opus-4-8' }],
      },
      models: ['claude-opus-4-8'],
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'Claude · sk-…test',
    });

    expect(rows[0]).toMatchObject({
      enabled: false,
      toggleDisabled: true,
      lockReason: 'entry-disabled',
    });
  });

  test('openaiCompatibility uses catalog disable mode and stays toggleable', () => {
    const resource = makeResource({
      id: 'openaiCompatibility:0:proxy',
      brand: 'openaiCompatibility',
      name: 'proxy',
      identifier: 'proxy',
      models: ['gpt-5'],
      disabled: false,
      selector: { brand: 'openaiCompatibility', name: 'proxy', index: 0 },
      raw: { name: 'proxy', baseUrl: 'https://x', apiKeyEntries: [], models: [{ name: 'gpt-5' }] },
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'OpenAI Compatibility · proxy',
    });

    expect(rows[0]).toMatchObject({
      enabled: true,
      supportsExclude: true,
      toggleDisabled: false,
      lockReason: null,
      disableMode: 'catalog',
    });
  });

  test('openaiCompatibility shows suspended catalog models as disabled rows', () => {
    const resource = makeResource({
      id: 'openaiCompatibility:0:proxy',
      brand: 'openaiCompatibility',
      name: 'proxy',
      identifier: 'proxy',
      models: ['gpt-5'],
      disabled: false,
      selector: { brand: 'openaiCompatibility', name: 'proxy', index: 0 },
      raw: {
        name: 'proxy',
        baseUrl: 'https://x',
        apiKeyEntries: [],
        models: [{ name: 'gpt-5' }],
      },
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'OpenAI Compatibility · proxy',
      suspendedCatalogModelIds: ['gpt-4o', 'gpt-5'],
    });

    // gpt-5 still in models[] → active enabled row; gpt-4o only suspended
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.modelId === 'gpt-5')).toMatchObject({
      enabled: true,
      disableMode: 'catalog',
    });
    expect(rows.find((r) => r.modelId === 'gpt-4o')).toMatchObject({
      enabled: false,
      toggleDisabled: false,
      disableMode: 'catalog',
    });
  });

  test('openaiCompatibility entry-disabled locks active and suspended rows', () => {
    const resource = makeResource({
      id: 'openaiCompatibility:0:proxy',
      brand: 'openaiCompatibility',
      name: 'proxy',
      models: ['gpt-5'],
      disabled: true,
      selector: { brand: 'openaiCompatibility', name: 'proxy', index: 0 },
      raw: {
        name: 'proxy',
        baseUrl: 'https://x',
        apiKeyEntries: [],
        models: [{ name: 'gpt-5' }],
        disabled: true,
      },
    });

    const rows = buildApiKeyAccessRows({
      resource,
      providerLabel: 'proxy',
      suspendedCatalogModelIds: ['o1'],
    });

    expect(rows.every((r) => r.toggleDisabled && r.lockReason === 'entry-disabled')).toBe(true);
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  test('sorts api key before oauth and by provider/name', () => {
    const rows = sortModelAccessRows([
      {
        key: 'b',
        source: 'apiKey',
        modelId: 'b',
        displayName: 'B',
        providerLabel: 'Z',
        channelOrBrand: 'claude',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
      },
      {
        key: 'a',
        source: 'oauth',
        modelId: 'a',
        displayName: 'A',
        providerLabel: 'Claude',
        channelOrBrand: 'claude',
        enabled: true,
        supportsExclude: true,
        toggleDisabled: false,
        lockReason: null,
      },
    ]);
    expect(rows.map((r) => r.key)).toEqual(['b', 'a']);
  });

  test('filters by display name, model id, or provider label', () => {
    const rows = buildOAuthAccessRows({
      channel: 'claude',
      models: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4-5' },
      ],
      excluded: {},
      providerLabel: 'Claude',
    });
    expect(filterModelAccessRows(rows, 'opus')).toHaveLength(1);
    expect(filterModelAccessRows(rows, 'haiku')).toHaveLength(1);
    expect(filterModelAccessRows(rows, 'codex')).toHaveLength(0);
  });

  test('collects oauth channels only from auth files with credentials', () => {
    expect(
      collectOAuthChannels({
        authFileTypes: ['Claude', 'gemini', '', null, 'codex'],
      }).sort()
    ).toEqual(['claude', 'codex', 'gemini']);
  });

  test('toggleApiKeyExcludedList adds and removes case-insensitively', () => {
    expect(toggleApiKeyExcludedList(['Claude-Opus-4-8'], 'claude-opus-4-8', false)).toEqual([]);
    expect(toggleApiKeyExcludedList([], 'claude-opus-4-8', true)).toEqual(['claude-opus-4-8']);
    expect(toggleApiKeyExcludedList(['claude-opus-4-8'], 'claude-opus-4-8', true)).toEqual([
      'claude-opus-4-8',
    ]);
  });
});
