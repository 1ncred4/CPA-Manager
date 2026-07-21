import { describe, expect, test } from 'bun:test';
import { buildApiKeyModelsUpdate } from '../src/features/models/updateApiKeyModels';
import type { ProviderResource } from '../src/features/providers/types';

const resource = (brand: ProviderResource['brand'], raw: Record<string, unknown>): ProviderResource =>
  ({ brand, raw } as unknown as ProviderResource);

describe('API key model mapping writes', () => {
  test('empty Claude mappings use an all-model exclusion instead of models: []', () => {
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

  test('other API key brands keep their existing empty-model behavior', () => {
    const next = buildApiKeyModelsUpdate(resource('gemini', {}), []);

    expect(next.models).toBeUndefined();
    expect(next.excludedModels).toBeUndefined();
  });
});
