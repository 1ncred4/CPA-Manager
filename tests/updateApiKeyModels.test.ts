import { describe, expect, test } from 'bun:test';
import { buildApiKeyModelsUpdate } from '../src/features/models/updateApiKeyModels';
import type { ProviderResource } from '../src/features/providers/types';

const resource = (brand: ProviderResource['brand'], raw: Record<string, unknown>): ProviderResource =>
  ({ brand, raw } as unknown as ProviderResource);

describe('API key model mapping writes', () => {
  test('empty API Key mappings use an all-model exclusion instead of models: []', () => {
    const next = buildApiKeyModelsUpdate(
      resource('claude', {
        models: [{ name: 'glm-5.2', alias: 'claude-sonnet-4-6' }],
        excludedModels: ['custom-*'],
      }),
      []
    );

    expect(next.models).toBeUndefined();
    expect(next.excludedModels).toEqual(['custom-*', '*']);
  });

  test('empty Gemini mappings also block the provider catalog', () => {
    const next = buildApiKeyModelsUpdate(resource('gemini', {}), []);

    expect(next.models).toBeUndefined();
    expect(next.excludedModels).toEqual(['*']);
  });

  test('managed Claude all-model exclusion is cleared when mappings return', () => {
    const next = buildApiKeyModelsUpdate(
      { ...resource('claude', { excludedModels: ['*'] }), disabled: false },
      [{ name: 'MiniMax-M3', alias: 'chat' }]
    );

    expect(next.models).toEqual([{ name: 'MiniMax-M3', alias: 'chat' }]);
    expect(next.excludedModels).toEqual([]);
  });

  test('manual Claude provider disable keeps the all-model exclusion', () => {
    const next = buildApiKeyModelsUpdate(
      { ...resource('claude', { excludedModels: ['*'] }), disabled: true },
      [{ name: 'MiniMax-M3', alias: 'chat' }]
    );

    expect(next.excludedModels).toEqual(['*']);
  });
});
