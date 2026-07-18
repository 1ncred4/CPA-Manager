/**
 * 写回单个 API Key 条目的 models[]（保留其它配置字段）
 */

import { providersApi } from '@/services/api';
import type { GeminiKeyConfig, ModelAlias, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { ProviderResource } from '@/features/providers/types';

export async function updateApiKeyModels(
  resource: ProviderResource,
  nextModels: ModelAlias[]
): Promise<void> {
  const models = nextModels.length ? nextModels : undefined;
  const selector = resource.selector;

  if (selector.brand === 'openaiCompatibility') {
    const cfg = resource.raw as OpenAIProviderConfig;
    const name = selector.name || cfg.name || '';
    await providersApi.updateOpenAIProvider(name, selector.index, {
      ...cfg,
      models,
    });
    return;
  }

  const current = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
  const next = { ...current, models };

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
