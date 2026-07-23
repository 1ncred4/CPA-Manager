import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providersApi } from '@/services/api';
import { getErrorMessage } from '@/utils/helpers';
import { useAuthStore, useConfigStore } from '@/stores';
import {
  withDisableAllModelsRule,
  withoutDisableAllModelsRule,
} from '@/components/providers/utils';
import {
  accessEnabledKey,
} from '@/features/models/modelMapping';
import {
  loadModelDisabledSnapshots,
  loadMappingDisabled,
  putModelDisabledSnapshot,
  takeModelDisabledSnapshot,
} from '@/features/models/modelDisabledState';
import {
  clearProviderManualDisabled,
  listManuallyDisabledProviders,
  markProviderManuallyDisabled,
} from '@/features/models/managedProviderDisable';
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
  filterEnabledCatalogNames,
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

function isMappingManagedProviderDisable(
  apiBase: string,
  resource: ProviderResource
): boolean {
  if (!apiBase || resource.brand !== 'claude' || !resource.disabled || resource.models.length) {
    return false;
  }
  if (listManuallyDisabledProviders(apiBase).has(resource.id)) return false;
  const raw = resource.raw as { excludedModels?: string[] };
  if (!Array.isArray(raw.excludedModels) || !raw.excludedModels.includes('*')) return false;
  return Array.from(loadMappingDisabled(apiBase).values())
    .flat()
    .some(
      (entry) => entry.target.source === 'apiKey' && entry.target.resourceId === resource.id
    );
}

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
    if (m.backendOmitted === true) return;
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

    // No mapping aliases: emit the identity alias as the catalog baseline.
    const entry: ModelAlias = { name: cat.name, alias: cat.name };
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
  existing?: ProviderKeyConfig | GeminiKeyConfig | null,
  options?: {
    preserveBackendOmittedAllModelsRule?: boolean;
    preserveEmptyModelsAllModelsRule?: boolean;
    modelsOverride?: ModelAlias[];
  }
): ProviderKeyConfig | GeminiKeyConfig => {
  const headers = headersFromEntries(input.headers);
  const models = options?.modelsOverride ?? buildModelAliases(input.models, false, existing?.models);
  const hasBackendOmittedModels = input.models.some((model) => model.backendOmitted === true);
  const preserveBackendOmittedAllModelsRule =
    options?.preserveBackendOmittedAllModelsRule === true && hasBackendOmittedModels;
  const preserveEmptyModelsAllModelsRule =
    options?.preserveEmptyModelsAllModelsRule === true && models.length === 0;
  const existingExcluded = (existing?.excludedModels ?? []).filter((rule) =>
    String(rule ?? '').includes('*')
  );
  const excluded = input.disabled || preserveBackendOmittedAllModelsRule || preserveEmptyModelsAllModelsRule
    ? [...existingExcluded.filter((rule) => rule !== '*'), '*']
    : existingExcluded.filter((rule) => rule !== '*');
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
    modelsOverride ?? buildModelAliases(filterEnabledCatalogNames(input.models), true, existing?.models);
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

type ApiKeyModelSavePlan = {
  models: ModelAlias[];
  snapshotsToPut: Array<{
    target: {
      source: 'apiKey';
      resourceId: string;
      brand: Exclude<ProviderBrand, 'openaiCompatibility'>;
      modelId: string;
    };
    entries: ModelAlias[];
  }>;
  snapshotsToTake: Array<{
    source: 'apiKey';
    resourceId: string;
    brand: Exclude<ProviderBrand, 'openaiCompatibility'>;
    modelId: string;
  }>;
};

/** Build API Key models[] while preserving disabled model aliases in snapshots. */
function buildApiKeyModelsForSave(input: {
  apiBase: string;
  resourceId: string;
  brand: Exclude<ProviderBrand, 'openaiCompatibility'>;
  form: ProviderEntryFormInput;
  existingModels?: ModelAlias[] | null;
}): ApiKeyModelSavePlan {
  const existing = input.existingModels ?? [];
  const snapshots = loadModelDisabledSnapshots(input.apiBase);
  const byName = new Map<string, ModelAlias[]>();
  existing.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    if (!name) return;
    const normalized = {
      ...entry,
      name,
      alias: String(entry.alias ?? name).trim() || name,
    };
    const list = byName.get(lowerModel(name)) ?? [];
    list.push(normalized);
    byName.set(lowerModel(name), list);
  });

  const result: ModelAlias[] = [];
  const snapshotsToPut: ApiKeyModelSavePlan['snapshotsToPut'] = [];
  const snapshotsToTake: ApiKeyModelSavePlan['snapshotsToTake'] = [];
  const seen = new Set<string>();

  (input.form.models ?? []).forEach((formEntry) => {
    const name = String(formEntry.name ?? '').trim();
    if (!name || formEntry.backendOmitted === true) return;
    const key = lowerModel(name);
    const target = {
      source: 'apiKey' as const,
      resourceId: input.resourceId,
      brand: input.brand,
      modelId: name,
    };
    const targetKey = accessEnabledKey(target);
    const snapshot = snapshots.get(targetKey);
    const entries = snapshot?.entries?.length
      ? (snapshot.entries as ModelAlias[])
      : byName.get(key)?.length
        ? byName.get(key)!
        : [{ name, alias: name }];

    if (formEntry.enabled === false) {
      if (!snapshot || JSON.stringify(snapshot.entries) !== JSON.stringify(entries)) {
        snapshotsToPut.push({ target, entries: entries.map((entry) => ({ ...entry })) });
      }
      return;
    }

    entries.forEach((entry) => {
      const normalized = {
        ...entry,
        name,
        alias: String(entry.alias ?? name).trim() || name,
      };
      const entryKey = `${lowerModel(normalized.name)}|${lowerModel(normalized.alias)}`;
      if (seen.has(entryKey)) return;
      seen.add(entryKey);
      result.push(normalized);
    });
    if (snapshot) snapshotsToTake.push(target);
  });

  return { models: result, snapshotsToPut, snapshotsToTake };
}

type OpenAIModelSavePlan = {
  models: ModelAlias[];
  snapshotsToPut: Array<{ target: { source: 'apiKey'; resourceId: string; brand: 'openaiCompatibility'; modelId: string }; entries: ModelAlias[] }>;
  snapshotsToTake: Array<{ source: 'apiKey'; resourceId: string; brand: 'openaiCompatibility'; modelId: string }>;
};

/** Build the OpenAI models payload while preserving v2 disabled snapshots. */
function buildOpenAIModelsForSave(input: {
  apiBase: string;
  resourceId: string;
  form: ProviderEntryFormInput;
  existingModels?: ModelAlias[] | null;
}): OpenAIModelSavePlan {
  const existing = input.existingModels ?? [];
  const snapshots = loadModelDisabledSnapshots(input.apiBase);
  const byName = new Map<string, ModelAlias[]>();
  existing.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    if (!name) return;
    const list = byName.get(lowerModel(name)) ?? [];
    list.push({ ...entry, name, alias: String(entry.alias ?? name).trim() || name });
    byName.set(lowerModel(name), list);
  });
  const result: ModelAlias[] = [];
  const snapshotsToPut: OpenAIModelSavePlan['snapshotsToPut'] = [];
  const snapshotsToTake: OpenAIModelSavePlan['snapshotsToTake'] = [];
  const seen = new Set<string>();
  (input.form.models ?? []).forEach((formEntry) => {
    const name = formEntry.name.trim();
    if (!name) return;
    if (formEntry.backendOmitted === true) return;
    const key = lowerModel(name);
    const targetKey = accessEnabledKey({ source: 'apiKey', resourceId: input.resourceId, brand: 'openaiCompatibility', modelId: name });
    const snapshot = snapshots.get(targetKey);
    if (formEntry.enabled === false) {
      const entries = snapshot?.entries?.length ? snapshot.entries : byName.get(key) ?? [{ name, alias: name }];
      if (!snapshot || JSON.stringify(snapshot.entries) !== JSON.stringify(entries)) {
        snapshotsToPut.push({ target: { source: 'apiKey', resourceId: input.resourceId, brand: 'openaiCompatibility', modelId: name }, entries });
      }
      return;
    }
    const entries = snapshot?.entries?.length ? snapshot.entries : byName.get(key) ?? [{ name, alias: name }];
    entries.forEach((entry) => {
      const normalized = { ...entry, name, alias: String(entry.alias ?? name).trim() || name };
      const entryKey = `${lowerModel(normalized.name)}|${lowerModel(normalized.alias)}`;
      if (!seen.has(entryKey)) { seen.add(entryKey); result.push(normalized); }
    });
    if (snapshot) snapshotsToTake.push({ source: 'apiKey', resourceId: input.resourceId, brand: 'openaiCompatibility', modelId: name });
  });
  return { models: result, snapshotsToPut, snapshotsToTake };
}

/* -------------------------------------------------------------------------- */
/* hook                                                                       */
/* -------------------------------------------------------------------------- */

export function useProviderWorkbench(): UseProviderWorkbenchResult {
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const apiBase = useAuthStore((s) => s.apiBase);
  const config = useConfigStore((s) => s.config);
  const fetchConfig = useConfigStore((s) => s.fetchConfig);
  const updateConfigValue = useConfigStore((s) => s.updateConfigValue);
  const isCacheValid = useConfigStore((s) => s.isCacheValid);

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
        resources: resources.map((resource) =>
          isMappingManagedProviderDisable(apiBase, resource)
            ? { ...resource, disabled: false }
            : resource
        ),
      };
    });
    return {
      fetchedAt,
      groups,
    };
  }, [apiBase, config, fetchedAt]);

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
        let apiKeyModelPlan: ApiKeyModelSavePlan | null = null;
        let openaiModelPlan: OpenAIModelSavePlan | null = null;
        if (brand === 'gemini' && selector.brand === 'gemini') {
          const existing = resource.raw as GeminiKeyConfig;
          apiKeyModelPlan = apiBase
            ? buildApiKeyModelsForSave({
                apiBase,
                resourceId: resource.id,
                brand: 'gemini',
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateGeminiKey(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('gemini', input, existing, {
              preserveBackendOmittedAllModelsRule: !resource.disabled,
              preserveEmptyModelsAllModelsRule: apiKeyModelPlan !== null && apiKeyModelPlan.models.length === 0,
              modelsOverride: apiKeyModelPlan?.models,
            }) as GeminiKeyConfig
          );
        } else if (brand === 'codex' && selector.brand === 'codex') {
          const existing = resource.raw as ProviderKeyConfig;
          apiKeyModelPlan = apiBase
            ? buildApiKeyModelsForSave({
                apiBase,
                resourceId: resource.id,
                brand: 'codex',
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateCodexConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('codex', input, existing, {
              preserveBackendOmittedAllModelsRule: !resource.disabled,
              preserveEmptyModelsAllModelsRule: apiKeyModelPlan !== null && apiKeyModelPlan.models.length === 0,
              modelsOverride: apiKeyModelPlan?.models,
            }) as ProviderKeyConfig
          );
        } else if (brand === 'xai' && selector.brand === 'xai') {
          const existing = resource.raw as ProviderKeyConfig;
          apiKeyModelPlan = apiBase
            ? buildApiKeyModelsForSave({
                apiBase,
                resourceId: resource.id,
                brand: 'xai',
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateXAIConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('xai', input, existing, {
              preserveBackendOmittedAllModelsRule: !resource.disabled,
              preserveEmptyModelsAllModelsRule: apiKeyModelPlan !== null && apiKeyModelPlan.models.length === 0,
              modelsOverride: apiKeyModelPlan?.models,
            }) as ProviderKeyConfig
          );
        } else if (brand === 'claude' && selector.brand === 'claude') {
          const existing = resource.raw as ProviderKeyConfig;
          apiKeyModelPlan = apiBase
            ? buildApiKeyModelsForSave({
                apiBase,
                resourceId: resource.id,
                brand: 'claude',
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateClaudeConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('claude', input, existing, {
              preserveBackendOmittedAllModelsRule: !resource.disabled,
              preserveEmptyModelsAllModelsRule: apiKeyModelPlan !== null && apiKeyModelPlan.models.length === 0,
              modelsOverride: apiKeyModelPlan?.models,
            }) as ProviderKeyConfig
          );
        } else if (brand === 'vertex' && selector.brand === 'vertex') {
          const existing = resource.raw as ProviderKeyConfig;
          apiKeyModelPlan = apiBase
            ? buildApiKeyModelsForSave({
                apiBase,
                resourceId: resource.id,
                brand: 'vertex',
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateVertexConfig(
            selector.apiKey,
            selector.baseUrl,
            buildProviderKeyConfig('vertex', input, existing, {
              preserveBackendOmittedAllModelsRule: !resource.disabled,
              preserveEmptyModelsAllModelsRule: apiKeyModelPlan !== null && apiKeyModelPlan.models.length === 0,
              modelsOverride: apiKeyModelPlan?.models,
            }) as ProviderKeyConfig
          );
        } else if (brand === 'openaiCompatibility' && selector.brand === 'openaiCompatibility') {
          const existing = resource.raw as OpenAIProviderConfig;
          openaiModelPlan = apiBase
            ? buildOpenAIModelsForSave({
                apiBase,
                resourceId: resource.id,
                form: input,
                existingModels: existing.models,
              })
            : null;
          await providersApi.updateOpenAIProvider(
            selector.name,
            selector.index,
            buildOpenAIConfig(input, existing, openaiModelPlan?.models)
          );
        }

        if (input.disabled) {
          markProviderManuallyDisabled(apiBase, resource.id);
        } else if (resource.disabled) {
          clearProviderManualDisabled(apiBase, resource.id);
        }

        if (apiKeyModelPlan && apiBase) {
          apiKeyModelPlan.snapshotsToPut.forEach((snapshot) => putModelDisabledSnapshot(apiBase, snapshot));
          apiKeyModelPlan.snapshotsToTake.forEach((target) => takeModelDisabledSnapshot(apiBase, target));
        }
        if (openaiModelPlan && apiBase) {
          openaiModelPlan.snapshotsToPut.forEach((snapshot) => putModelDisabledSnapshot(apiBase, snapshot));
          openaiModelPlan.snapshotsToTake.forEach((target) => takeModelDisabledSnapshot(apiBase, target));
        }

        await refetch();

      } finally {
        setMutating(false);
      }
    },
    [refetch]
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
        clearProviderManualDisabled(apiBase, resource.id);
        await refetch();
      } finally {
        setMutating(false);
      }
    },
    [apiBase, config, refetch, updateConfigValue]
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
        if (disabled) {
          markProviderManuallyDisabled(apiBase, resource.id);
        } else {
          clearProviderManualDisabled(apiBase, resource.id);
        }
        await refetch();
      } finally {
        setMutating(false);
      }
    },
    [apiBase, refetch]
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
