import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providersApi } from '@/services/api';
import { getErrorMessage } from '@/utils/helpers';
import { useAuthStore, useConfigStore } from '@/stores';
import {
  withDisableAllModelsRule,
  withoutDisableAllModelsRule,
} from '@/components/providers/utils';
import {
  clearSuspendedCatalog,
  listSuspendedCatalogForResource,
  mergeSuspendedCatalog,
  removeModelFromCatalog,
  restoreModelToCatalog,
  takeSuspendedCatalog,
} from '@/features/models/catalogSuspend';
import { useModelManagementStore } from '@/stores/useModelManagementStore';
import type { ProviderFormDelta } from '@/features/models/modelOps';
import type { GeminiKeyConfig, ModelAlias, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import {
  claudeToResource,
  codexToResource,
  geminiToResource,
  openaiToResource,
  vertexToResource,
  xaiToResource,
} from './adapters';
import { PROVIDER_BRAND_ORDER } from './descriptors';
import {
  collectDisabledModelIds,
  collectExactExcludedIds,
  filterEnabledCatalogNames,
  mergeFormExcludedModels,
  resolveEntriesToSuspend,
} from './formModelAccess';
import type {
  ProviderBrand,
  ProviderEntryFormInput,
  ProviderGroup,
  ProviderResource,
  ProviderSnapshot,
} from './types';

export interface UseProviderWorkbenchResult {
  connected: boolean;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  errorMessage: string | null;
  snapshot: ProviderSnapshot | null;
  refetch: () => Promise<void>;

  createProvider: (brand: ProviderBrand, input: ProviderEntryFormInput) => Promise<void>;
  updateProvider: (resource: ProviderResource, input: ProviderEntryFormInput) => Promise<void>;
  deleteProvider: (resource: ProviderResource) => Promise<void>;
  toggleDisabled: (resource: ProviderResource, disabled: boolean) => Promise<void>;
  mutating: boolean;
  refreshSnapshot: () => void;
}

/* -------------------------------------------------------------------------- */
/* form -> backend config 转换                                                 */
/* -------------------------------------------------------------------------- */

const parseTextList = (text: string): string[] =>
  text
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const headersFromEntries = (
  entries: Array<{ key: string; value: string }>
): Record<string, string> => {
  const out: Record<string, string> = {};
  entries.forEach((entry) => {
    const key = entry.key.trim();
    if (!key) return;
    out[key] = entry.value;
  });
  return out;
};

const parseThinkingJson = (value: string | undefined): Record<string, unknown> | undefined => {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Thinking config must be a JSON object');
  }
  return parsed as Record<string, unknown>;
};

/**
 * Build models[] for provider save.
 * Catalog form only edits unique model names (+ OpenAI image/thinking).
 * Mapping-page aliases (including multi-alias duplicates of the same name) are
 * preserved from `existing.models` so provider edits cannot clobber manual mappings.
 *
 * For openaiCompatibility, pass only enabled models so disabled ones stay out of models[].
 */
const buildModelAliases = (
  models: ProviderEntryFormInput['models'] | undefined,
  includeOpenAIFields = false,
  existingModels?: ModelAlias[] | null
): ModelAlias[] => {
  const lower = (v: string) => v.trim().toLowerCase();

  // Desired catalog order (unique by name, first wins for OpenAI flags).
  const catalog: Array<{
    name: string;
    priority?: number;
    testModel?: string;
    image?: boolean;
    thinking?: Record<string, unknown>;
  }> = [];
  const catalogIndex = new Map<string, number>();
  (models ?? []).forEach((m) => {
    const name = m.name.trim();
    if (!name) return;
    const key = lower(name);
    if (catalogIndex.has(key)) return;
    catalogIndex.set(key, catalog.length);
    catalog.push({
      name,
      priority: m.priority,
      testModel: m.testModel,
      image: includeOpenAIFields ? m.image === true : undefined,
      thinking: includeOpenAIFields ? parseThinkingJson(m.thinkingJson) : undefined,
    });
  });

  // Group existing alias bindings by model name (multi-channel support).
  const existingByName = new Map<string, ModelAlias[]>();
  (existingModels ?? []).forEach((entry) => {
    const name = String(entry?.name ?? '').trim();
    if (!name) return;
    const key = lower(name);
    const list = existingByName.get(key) ?? [];
    list.push(entry);
    existingByName.set(key, list);
  });

  const result: ModelAlias[] = [];
  catalog.forEach((cat) => {
    const key = lower(cat.name);
    const prevList = existingByName.get(key) ?? [];
    const meaningful = prevList.filter((e) => {
      const alias = String(e.alias ?? '').trim();
      return alias && lower(alias) !== key;
    });

    if (meaningful.length) {
      meaningful.forEach((prev) => {
        const next: ModelAlias = {
          ...prev,
          name: cat.name,
        };
        if (cat.priority !== undefined) next.priority = cat.priority;
        if (cat.testModel !== undefined) next.testModel = cat.testModel;
        if (includeOpenAIFields) {
          next.image = cat.image === true;
          if (cat.thinking) next.thinking = cat.thinking;
          else delete next.thinking;
        }
        result.push(next);
      });
      return;
    }

    // No mapping aliases: emit a single catalog entry.
    const entry: ModelAlias = { name: cat.name };
    if (cat.priority !== undefined) entry.priority = cat.priority;
    if (cat.testModel) entry.testModel = cat.testModel;
    if (includeOpenAIFields) {
      if (cat.image) entry.image = true;
      if (cat.thinking) entry.thinking = cat.thinking;
    }
    // Prefer preserving other non-alias fields from the first existing row.
    const bare = prevList[0];
    if (bare) {
      if (entry.priority === undefined && bare.priority !== undefined) {
        entry.priority = bare.priority;
      }
      if (!entry.testModel && bare.testModel) entry.testModel = bare.testModel;
    }
    result.push(entry);
  });

  return result;
};

const buildProviderKeyConfig = (
  brand: 'gemini' | 'codex' | 'xai' | 'claude' | 'vertex',
  input: ProviderEntryFormInput,
  existing?: ProviderKeyConfig | GeminiKeyConfig | null
): ProviderKeyConfig | GeminiKeyConfig => {
  const headers = headersFromEntries(input.headers);
  // Exclude brands keep disabled models in models[]; exact excludes go to excludedModels.
  const models = buildModelAliases(input.models, false, existing?.models);
  const excluded = mergeFormExcludedModels({
    existingExcluded: existing?.excludedModels,
    entryDisabled: input.disabled,
    formDisabledModelIds: collectDisabledModelIds(input.models),
  });
  const apiKeyChanged = input.apiKey.trim().length > 0;
  const next: ProviderKeyConfig = {
    apiKey: apiKeyChanged ? input.apiKey.trim() : (existing?.apiKey ?? ''),
    priority: input.priority,
    prefix: input.prefix.trim() || undefined,
    baseUrl: input.baseUrl.trim() || undefined,
    proxyUrl: input.proxyUrl.trim() || undefined,
    models: models.length ? models : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    excludedModels: excluded,
    disableCooling: input.disableCooling === true,
    authIndex: existing?.authIndex,
  };
  if ((brand === 'codex' || brand === 'xai') && input.websockets !== undefined) {
    next.websockets = input.websockets;
  }
  if (brand === 'claude' && input.cloak) {
    next.cloak = {
      mode: input.cloak.mode.trim() || undefined,
      strictMode: input.cloak.strictMode,
      sensitiveWords: parseTextList(input.cloak.sensitiveWordsText),
      cacheUserId: input.cloak.cacheUserId === true,
    };
  }
  if (brand === 'claude') {
    next.experimentalCchSigning = input.experimentalCchSigning === true;
  }
  return next;
};

const buildOpenAIConfig = (
  input: ProviderEntryFormInput,
  existing?: OpenAIProviderConfig | null,
  /** Pre-merged models[] (enabled + restored suspend entries). When omitted, enabled-only. */
  modelsOverride?: ModelAlias[]
): OpenAIProviderConfig => {
  const headers = headersFromEntries(input.headers);
  const models =
    modelsOverride ??
    buildModelAliases(filterEnabledCatalogNames(input.models), true, existing?.models);
  const apiKeyEntries =
    input.apiKeyEntries
      ?.map((entry, index) => {
        const fallbackApiKey =
          entry.existingApiKey?.trim() || existing?.apiKeyEntries?.[index]?.apiKey?.trim() || '';
        return {
          apiKey: entry.apiKey.trim() || fallbackApiKey,
          proxyUrl: entry.proxyUrl.trim() || undefined,
          authIndex: entry.authIndex?.trim() || undefined,
        };
      })
      .filter((entry) => entry.apiKey) ?? [];

  return {
    ...(existing ?? {}),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    prefix: input.prefix.trim() || undefined,
    apiKeyEntries,
    disabled: input.disabled,
    disableCooling: input.disableCooling === true,
    headers: Object.keys(headers).length ? headers : undefined,
    models: models.length ? models : undefined,
    priority: input.priority,
    testModel: input.testModel?.trim() || undefined,
  };
};

const lowerModel = (value: string): string => value.trim().toLowerCase();

/** Diff previous exact excludes / catalog presence vs form toggles for mapping sync. */
function collectModelAccessDeltas(input: {
  brand: ProviderBrand;
  form: ProviderEntryFormInput;
  existingExcluded?: string[];
  existingModels?: ModelAlias[];
  previouslySuspendedIds?: string[];
}): { disabled: string[]; enabled: string[] } {
  const formByKey = new Map<string, string>();
  const formDisabled = new Set<string>();
  (input.form.models ?? []).forEach((m) => {
    const name = m.name.trim();
    if (!name) return;
    const key = lowerModel(name);
    if (!formByKey.has(key)) formByKey.set(key, name);
    if (m.enabled === false) formDisabled.add(key);
  });

  const disabled: string[] = [];
  const enabled: string[] = [];

  if (input.brand === 'openaiCompatibility') {
    const prevActive = new Set(
      (input.existingModels ?? [])
        .map((m) => lowerModel(String(m.name ?? '')))
        .filter(Boolean)
    );
    const prevSuspended = new Set((input.previouslySuspendedIds ?? []).map(lowerModel));
    formByKey.forEach((name, key) => {
      const nowDisabled = formDisabled.has(key);
      if (nowDisabled && prevActive.has(key)) disabled.push(name);
      if (!nowDisabled && prevSuspended.has(key)) enabled.push(name);
    });
    return { disabled, enabled };
  }

  const prevExcluded = collectExactExcludedIds(input.existingExcluded);
  formByKey.forEach((name, key) => {
    const nowDisabled = formDisabled.has(key);
    const wasDisabled = prevExcluded.has(key);
    if (nowDisabled && !wasDisabled) disabled.push(name);
    if (!nowDisabled && wasDisabled) enabled.push(name);
  });
  return { disabled, enabled };
}

/**
 * Apply openaiCompatibility catalog suspend/restore around a form save.
 * Returns models[] that should be written (enabled + restored suspend entries).
 */
function applyOpenAICatalogSuspendOnSave(input: {
  apiBase: string;
  resourceId: string;
  form: ProviderEntryFormInput;
  existingModels?: ModelAlias[] | null;
}): ModelAlias[] {
  const formByKey = new Map(
    (input.form.models ?? [])
      .map((m) => [lowerModel(m.name), m] as const)
      .filter(([key]) => Boolean(key))
  );
  const existing = input.existingModels ?? [];
  const existingKeys = new Set(
    existing.map((m) => lowerModel(String(m.name ?? ''))).filter(Boolean)
  );
  const previouslySuspended = listSuspendedCatalogForResource(input.apiBase, input.resourceId);
  const prevSuspendedKeys = new Set(previouslySuspended.map((e) => lowerModel(e.modelId)));

  // Models removed from the form entirely → clear catalog suspend ghosts.
  previouslySuspended.forEach((entry) => {
    const key = lowerModel(entry.modelId);
    if (!formByKey.has(key)) {
      clearSuspendedCatalog(input.apiBase, input.resourceId, entry.modelId);
    }
  });

  const prevSuspendedByKey = new Map(
    previouslySuspended.map((entry) => [lowerModel(entry.modelId), entry] as const)
  );

  // Disable: stash full entries then omit from catalog write.
  let working = [...existing];
  formByKey.forEach((entry, key) => {
    if (entry.enabled !== false) return;
    const name = entry.name.trim();
    if (!name) return;
    if (existingKeys.has(key) || prevSuspendedKeys.has(key)) {
      const prev = prevSuspendedByKey.get(key);
      // Prefer existing suspended entries if model was already out of catalog.
      const toSuspend =
        !existingKeys.has(key) && prev?.entries?.length
          ? prev.entries
          : resolveEntriesToSuspend(existing, name, entry);
      mergeSuspendedCatalog(input.apiBase, input.resourceId, name, toSuspend);
    }
    const removed = removeModelFromCatalog(working, name);
    working = removed.next;
  });

  const enabledForm = filterEnabledCatalogNames(input.form.models);
  // Restore previously suspended models that are now enabled.
  enabledForm.forEach((entry) => {
    const name = entry.name.trim();
    if (!name) return;
    const key = lowerModel(name);
    if (!prevSuspendedKeys.has(key)) return;
    const taken = takeSuspendedCatalog(input.apiBase, input.resourceId, name);
    const entries = taken?.entries?.length
      ? taken.entries
      : resolveEntriesToSuspend(existing, name, entry);
    const restored = restoreModelToCatalog(working, entries);
    working = restored.next;
  });

  // Rebuild via buildModelAliases so catalog order/flags follow form, aliases preserved.
  return buildModelAliases(enabledForm, true, working);
}

/* -------------------------------------------------------------------------- */
/* hook                                                                       */
/* -------------------------------------------------------------------------- */

export function useProviderWorkbench(): UseProviderWorkbenchResult {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const config = useConfigStore((s) => s.config);
  const fetchConfig = useConfigStore((s) => s.fetchConfig);
  const updateConfigValue = useConfigStore((s) => s.updateConfigValue);
  const isCacheValid = useConfigStore((s) => s.isCacheValid);
  const storeApplyProviderFormDeltas = useModelManagementStore((s) => s.applyProviderFormDeltas);

  const [isPending, setIsPending] = useState<boolean>(() => !isCacheValid());
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mutating, setMutating] = useState<boolean>(false);
  const [fetchedAt, setFetchedAt] = useState<string>(() => new Date().toISOString());

  const hasFetchedRef = useRef(false);

  const connected = connectionStatus === 'connected';

  const refetch = useCallback(async () => {
    setIsFetching(true);
    setErrorMessage(null);
    try {
      const [configResult, vertexResult, openaiResult] = await Promise.allSettled([
        fetchConfig(true),
        providersApi.getVertexConfigs(),
        providersApi.getOpenAIProviders(),
      ]);
      if (configResult.status !== 'fulfilled') {
        throw configResult.reason;
      }
      if (vertexResult.status === 'fulfilled') {
        updateConfigValue('vertex-api-key', vertexResult.value || []);
      }
      if (openaiResult.status === 'fulfilled') {
        updateConfigValue('openai-compatibility', openaiResult.value || []);
      }
      setFetchedAt(new Date().toISOString());
    } catch (err) {
      setErrorMessage(getErrorMessage(err) || 'Failed to load providers');
    } finally {
      setIsPending(false);
      setIsFetching(false);
    }
  }, [fetchConfig, updateConfigValue]);

  const refreshSnapshot = useCallback(() => {
    setFetchedAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    if (hasFetchedRef.current) return;
    if (!connected) return;
    hasFetchedRef.current = true;
    refetch().catch(() => {});
  }, [connected, refetch]);

  /* ------------------- snapshot 计算 ------------------- */

  const snapshot = useMemo<ProviderSnapshot | null>(() => {
    if (!config) return null;
    const groups: ProviderGroup[] = PROVIDER_BRAND_ORDER.map((brand) => {
      let resources: ProviderResource[] = [];
      switch (brand) {
        case 'gemini':
          resources = (config.geminiApiKeys ?? []).map((item, index) =>
            geminiToResource(item, index)
          );
          break;
        case 'codex':
          resources = (config.codexApiKeys ?? []).map((item, index) => codexToResource(item, index));
          break;
        case 'xai':
          resources = (config.xaiApiKeys ?? []).map((item, index) => xaiToResource(item, index));
          break;
        case 'claude':
          resources = (config.claudeApiKeys ?? []).map((item, index) =>
            claudeToResource(item, index)
          );
          break;
        case 'vertex':
          resources = (config.vertexApiKeys ?? []).map((c, i) => vertexToResource(c, i));
          break;
        case 'openaiCompatibility':
          resources = (config.openaiCompatibility ?? []).map((item, index) =>
            openaiToResource(item, index)
          );
          break;
      }
      return {
        id: brand,
        resources,
      };
    });
    return {
      fetchedAt,
      groups,
    };
  }, [config, fetchedAt]);

  /* ------------------- mutations ------------------- */

  const createProvider = useCallback(
    async (brand: ProviderBrand, input: ProviderEntryFormInput) => {
      setMutating(true);
      try {
        if (brand === 'gemini') {
          await providersApi.createGeminiKey(
            buildProviderKeyConfig('gemini', input) as GeminiKeyConfig
          );
        } else if (brand === 'codex') {
          await providersApi.createCodexConfig(
            buildProviderKeyConfig('codex', input) as ProviderKeyConfig
          );
        } else if (brand === 'xai') {
          await providersApi.createXAIConfig(
            buildProviderKeyConfig('xai', input) as ProviderKeyConfig
          );
        } else if (brand === 'claude') {
          await providersApi.createClaudeConfig(
            buildProviderKeyConfig('claude', input) as ProviderKeyConfig
          );
        } else if (brand === 'vertex') {
          await providersApi.createVertexConfig(
            buildProviderKeyConfig('vertex', input) as ProviderKeyConfig
          );
        } else if (brand === 'openaiCompatibility') {
          await providersApi.createOpenAIProvider(buildOpenAIConfig(input));
        }
        await refetch();
      } finally {
        setMutating(false);
      }
    },
    [refetch]
  );

  const updateProvider = useCallback(
    async (resource: ProviderResource, input: ProviderEntryFormInput) => {
      setMutating(true);
      try {
        const brand = resource.brand;
        const selector = resource.selector;
        const apiBase = useAuthStore.getState().apiBase;
        const existingRaw = resource.raw as
          | GeminiKeyConfig
          | ProviderKeyConfig
          | OpenAIProviderConfig;
        const existingModels =
          ((existingRaw as { models?: ModelAlias[] }).models ?? []) as ModelAlias[];
        const existingExcluded =
          brand === 'openaiCompatibility'
            ? undefined
            : (existingRaw as GeminiKeyConfig | ProviderKeyConfig).excludedModels;
        const previouslySuspendedIds =
          brand === 'openaiCompatibility' && apiBase
            ? listSuspendedCatalogForResource(apiBase, resource.id).map((e) => e.modelId)
            : [];

        const deltas = collectModelAccessDeltas({
          brand,
          form: input,
          existingExcluded,
          existingModels,
          previouslySuspendedIds,
        });

        // OpenAI: prune mappings while models[] still contains disabled names.
        // Exclude brands can prune after save (models[] keep disabled names).
        if (brand === 'openaiCompatibility' && apiBase && deltas.disabled.length) {
          await storeApplyProviderFormDeltas(
            deltas.disabled.map((modelId) => ({
              ref: { source: 'apiKey', resourceId: resource.id, brand, modelId },
              nextEnabled: false,
            })),
            resource
          );
        }

        if (brand === 'gemini' && selector.brand === 'gemini') {
          const existing = resource.raw as GeminiKeyConfig;
          await providersApi.updateGeminiKey(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('gemini', input, existing) as GeminiKeyConfig
          );
        } else if (brand === 'codex' && selector.brand === 'codex') {
          const existing = resource.raw as ProviderKeyConfig;
          await providersApi.updateCodexConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('codex', input, existing) as ProviderKeyConfig
          );
        } else if (brand === 'xai' && selector.brand === 'xai') {
          const existing = resource.raw as ProviderKeyConfig;
          await providersApi.updateXAIConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('xai', input, existing) as ProviderKeyConfig
          );
        } else if (brand === 'claude' && selector.brand === 'claude') {
          const existing = resource.raw as ProviderKeyConfig;
          await providersApi.updateClaudeConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('claude', input, existing) as ProviderKeyConfig
          );
        } else if (brand === 'vertex' && selector.brand === 'vertex') {
          const existing = resource.raw as ProviderKeyConfig;
          await providersApi.updateVertexConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('vertex', input, existing) as ProviderKeyConfig
          );
        } else if (brand === 'openaiCompatibility' && selector.brand === 'openaiCompatibility') {
          const existing = resource.raw as OpenAIProviderConfig;
          const modelsOverride = apiBase
            ? applyOpenAICatalogSuspendOnSave({
                apiBase,
                resourceId: resource.id,
                form: input,
                existingModels: existing.models,
              })
            : undefined;
          await providersApi.updateOpenAIProvider(
            selector.name,
            selector.index,
            buildOpenAIConfig(input, existing, modelsOverride)
          );
        }

        await refetch();

        // Sync mapping prune/restore after config is written.
        // OpenAI disables already pruned above; only restore those. Exclude brands do both here.
        if (apiBase && (deltas.disabled.length || deltas.enabled.length)) {
          const postDeltas: ProviderFormDelta[] = [];
          if (brand !== 'openaiCompatibility') {
            deltas.disabled.forEach((modelId) =>
              postDeltas.push({
                ref: { source: 'apiKey', resourceId: resource.id, brand, modelId },
                nextEnabled: false,
              })
            );
          }
          deltas.enabled.forEach((modelId) =>
            postDeltas.push({
              ref: { source: 'apiKey', resourceId: resource.id, brand, modelId },
              nextEnabled: true,
            })
          );
          if (postDeltas.length) {
            await storeApplyProviderFormDeltas(postDeltas, resource);
          }
        }
      } finally {
        setMutating(false);
      }
    },
    [refetch, storeApplyProviderFormDeltas]
  );

  const deleteProvider = useCallback(
    async (resource: ProviderResource) => {
      setMutating(true);
      try {
        const sel = resource.selector;
        if (sel.brand === 'gemini') {
          await providersApi.deleteGeminiKey(sel.apiKey, sel.baseUrl);
          const next = (config?.geminiApiKeys ?? []).filter((_, i) => i !== sel.index);
          updateConfigValue('gemini-api-key', next);
        } else if (sel.brand === 'codex') {
          await providersApi.deleteCodexConfig(sel.apiKey, sel.baseUrl);
          const next = (config?.codexApiKeys ?? []).filter((_, i) => i !== sel.index);
          updateConfigValue('codex-api-key', next);
        } else if (sel.brand === 'xai') {
          await providersApi.deleteXAIConfig(sel.apiKey, sel.baseUrl);
          const next = (config?.xaiApiKeys ?? []).filter((_, i) => i !== sel.index);
          updateConfigValue('xai-api-key', next);
        } else if (sel.brand === 'claude') {
          await providersApi.deleteClaudeConfig(sel.apiKey, sel.baseUrl);
          const next = (config?.claudeApiKeys ?? []).filter((_, i) => i !== sel.index);
          updateConfigValue('claude-api-key', next);
        } else if (sel.brand === 'vertex') {
          await providersApi.deleteVertexConfig(sel.apiKey, sel.baseUrl);
          const next = (config?.vertexApiKeys ?? []).filter((_, i) => i !== sel.index);
          updateConfigValue('vertex-api-key', next);
        } else if (sel.brand === 'openaiCompatibility') {
          await providersApi.deleteOpenAIProvider(sel.index);
          const next = (config?.openaiCompatibility ?? []).filter(
            (item, index) => (item.sourceIndex ?? index) !== sel.index
          );
          updateConfigValue('openai-compatibility', next);
        }
        await refetch();
      } finally {
        setMutating(false);
      }
    },
    [config, refetch, updateConfigValue]
  );

  const toggleDisabled = useCallback(
    async (resource: ProviderResource, disabled: boolean) => {
      setMutating(true);
      try {
        const brand = resource.brand;
        const selector = resource.selector;
        if (brand === 'gemini' && selector.brand === 'gemini') {
          const current = resource.raw as GeminiKeyConfig;
          const excluded = disabled
            ? withDisableAllModelsRule(current.excludedModels)
            : withoutDisableAllModelsRule(current.excludedModels);
          await providersApi.updateGeminiKey(selector.apiKey, selector.baseUrl, {
            ...current,
            excludedModels: excluded,
          });
        } else if (
          (brand === 'codex' && selector.brand === 'codex') ||
          (brand === 'xai' && selector.brand === 'xai') ||
          (brand === 'claude' && selector.brand === 'claude') ||
          (brand === 'vertex' && selector.brand === 'vertex')
        ) {
          const current = resource.raw as ProviderKeyConfig;
          const excluded = disabled
            ? withDisableAllModelsRule(current.excludedModels)
            : withoutDisableAllModelsRule(current.excludedModels);
          const next = { ...current, excludedModels: excluded };
          if (selector.brand === 'codex') {
            await providersApi.updateCodexConfig(selector.apiKey, selector.baseUrl, next);
          } else if (selector.brand === 'xai') {
            await providersApi.updateXAIConfig(selector.apiKey, selector.baseUrl, next);
          } else if (selector.brand === 'claude') {
            await providersApi.updateClaudeConfig(selector.apiKey, selector.baseUrl, next);
          } else if (selector.brand === 'vertex') {
            await providersApi.updateVertexConfig(selector.apiKey, selector.baseUrl, next);
          }
        } else if (brand === 'openaiCompatibility' && selector.brand === 'openaiCompatibility') {
          await providersApi.updateOpenAIProviderDisabled(selector.index, disabled);
        }
        await refetch();
      } finally {
        setMutating(false);
      }
    },
    [refetch]
  );

  return {
    connected,
    isPending,
    isFetching,
    isError: Boolean(errorMessage),
    errorMessage,
    snapshot,
    refetch,
    createProvider,
    updateProvider,
    deleteProvider,
    toggleDisabled,
    mutating,
    refreshSnapshot,
  };
}
