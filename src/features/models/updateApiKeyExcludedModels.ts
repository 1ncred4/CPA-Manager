/**
 * 写回单个 API Key 条目的 excludedModels（保留 `*` 整条目禁用语义）
 */

import {
  hasDisableAllModelsRule,
  withDisableAllModelsRule,
} from '@/components/providers/utils';
import { providersApi } from '@/services/api';
import type { GeminiKeyConfig, ProviderKeyConfig } from '@/types';
import type { ProviderResource } from '@/features/providers/types';

export async function updateApiKeyExcludedModels(
  resource: ProviderResource,
  nextExcludedWithoutStar: string[]
): Promise<void> {
  const brand = resource.brand;
  if (brand === 'openaiCompatibility') {
    // OpenAI compatibility has no excluded-models field
    return;
  }

  const current = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
  const disabled = hasDisableAllModelsRule(current.excludedModels);
  const cleaned = nextExcludedWithoutStar
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '*');

  const nextExcluded = disabled
    ? withDisableAllModelsRule(cleaned)
    : cleaned.length
      ? cleaned
      : undefined;

  const next = { ...current, excludedModels: nextExcluded };
  const selector = resource.selector;

  if (selector.brand === 'gemini') {
    await providersApi.updateGeminiKey(selector.apiKey, selector.baseUrl, next as GeminiKeyConfig);
    return;
  }
  if (selector.brand === 'codex') {
    await providersApi.updateCodexConfig(
      selector.apiKey,
      selector.baseUrl,
      next as ProviderKeyConfig
    );
    return;
  }
  if (selector.brand === 'xai') {
    await providersApi.updateXAIConfig(selector.apiKey, selector.baseUrl, next as ProviderKeyConfig);
    return;
  }
  if (selector.brand === 'claude') {
    await providersApi.updateClaudeConfig(
      selector.apiKey,
      selector.baseUrl,
      next as ProviderKeyConfig
    );
    return;
  }
  if (selector.brand === 'vertex') {
    await providersApi.updateVertexConfig(
      selector.apiKey,
      selector.baseUrl,
      next as ProviderKeyConfig
    );
  }
}
