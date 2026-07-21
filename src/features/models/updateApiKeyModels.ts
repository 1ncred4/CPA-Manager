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
 * CLIProxyAPI treats an omitted/empty Claude `models` list as "use the full
 * static Claude catalog".  When the last Claude mapping is disabled, that
 * fallback would resurrect every default Claude model.  Persist the backend's
 * explicit all-model exclusion instead, while still omitting `models` itself.
 */
export function buildApiKeyModelsUpdate(
  resource: ProviderResource,
  nextModels: ModelAlias[]
): GeminiKeyConfig | ProviderKeyConfig {
  const current = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
  const models = nextModels.length ? nextModels : undefined;

  if (resource.brand === 'claude' && !nextModels.length) {
    return {
      ...current,
      models,
      excludedModels: withDisableAllModelsRule(current.excludedModels),
    };
  }

  if (
    resource.brand === 'claude' &&
    !resource.disabled &&
    hasDisableAllModelsRule(current.excludedModels)
  ) {
    return {
      ...current,
      models,
      excludedModels: withoutDisableAllModelsRule(current.excludedModels),
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
