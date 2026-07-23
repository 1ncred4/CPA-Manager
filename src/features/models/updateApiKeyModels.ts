/**
 * 写回单个 API Key 条目的 models[]（保留其它配置字段）
 */

import { providersApi } from '@/services/api';
import {
  hasDisableAllModelsRule,
  withoutDisableAllModelsRule,
  withDisableAllModelsRule,
} from '@/components/providers/utils';
import type { GeminiKeyConfig, ModelAlias, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { ProviderResource } from '@/features/providers/types';

/**
 * Build the provider payload used when a model mapping removes entries.
 *
 * CLIProxyAPI treats an omitted/empty API Key `models` list as a provider
 * fallback. When the last configured model is disabled, that fallback could
 * resurrect the provider catalog. Persist an explicit all-model exclusion
 * instead, while still omitting `models` itself.
 */
export function buildApiKeyModelsUpdate(
  resource: ProviderResource,
  nextModels: ModelAlias[]
): GeminiKeyConfig | ProviderKeyConfig {
  const current = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
  const models = nextModels.length ? nextModels : undefined;
  const existingExcluded = Array.isArray(current.excludedModels)
    ? current.excludedModels.filter((rule) => String(rule ?? '').includes('*'))
    : undefined;

  if (!nextModels.length) {
    return {
      ...current,
      models,
      excludedModels: withDisableAllModelsRule(existingExcluded),
    };
  }

  if (
    !resource.disabled &&
    hasDisableAllModelsRule(existingExcluded)
  ) {
    return {
      ...current,
      models,
      excludedModels: withoutDisableAllModelsRule(existingExcluded),
    };
  }

  return { ...current, models };
}

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

  const next = buildApiKeyModelsUpdate(resource, nextModels);

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
