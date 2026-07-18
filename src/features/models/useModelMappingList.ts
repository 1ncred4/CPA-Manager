/**
 * 模型映射 Tab：加载 OAuth alias + API Key models 别名，聚合成联邦列表
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import {
  getAuthFileIcon,
  getTypeLabel,
  type AuthFileModelItem,
  type OAuthConfigLoadError,
} from '@/features/authFiles/constants';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  collectOAuthChannels,
  type ModelAccessRow,
} from './modelAccessRows';
import {
  clearSuspendedForAlias,
  listAllSuspended,
  mergeSuspendedIntoFederatedRows,
  SUSPENDED_MAPPINGS_CHANGED_EVENT,
} from './mappingSuspend';
import {
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  assembleFederatedMappingRows,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  buildOauthDisplayNameMap,
  buildUnmappedModels,
  collectMappedTargetKeys,
  filterFederatedMappingRows,
  filterUnmappedModels,
  toAliasKey,
  type FederatedMappingRow,
  type MappingPickerOption,
  type MappingTargetRef,
  type UnmappedModelRow,
} from './modelMapping';
import { updateApiKeyModels } from './updateApiKeyModels';

export type UseModelMappingListResult = {
  rows: FederatedMappingRow[];
  filteredRows: FederatedMappingRow[];
  unmappedRows: UnmappedModelRow[];
  filteredUnmappedRows: UnmappedModelRow[];
  search: string;
  setSearch: (value: string) => void;
  loading: boolean;
  oauthAliasError: OAuthConfigLoadError;
  disableControls: boolean;
  refresh: () => Promise<void>;
  deleteAlias: (alias: string) => void;
  /** 供编辑页复用的已启用选项（基于最近一次 refresh 的 access 数据） */
  enabledOptions: MappingPickerOption[];
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  resources: ProviderResource[];
  existingAliasKeys: string[];
};

const getStatusCode = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  if ('status' in err) return (err as { status?: unknown }).status as number | undefined;
  return undefined;
};

export function useModelMappingList(): UseModelMappingListResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const showConfirmation = useNotificationStore((s) => s.showConfirmation);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const apiBase = useAuthStore((s) => s.apiBase);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const workbench = useProviderWorkbench();

  const disableControls = connectionStatus !== 'connected';

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [oauthAliasError, setOauthAliasError] = useState<OAuthConfigLoadError>('loading');
  const [modelAlias, setModelAlias] = useState<Record<string, OAuthModelAliasEntry[]>>({});
  const [oauthModels, setOauthModels] = useState<Record<string, AuthFileModelItem[]>>({});
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [accessRows, setAccessRows] = useState<ModelAccessRow[]>([]);
  /** 递增以在同页剪枝/恢复后重读 localStorage 挂起项 */
  const [suspendedEpoch, setSuspendedEpoch] = useState(0);

  const loadRequestRef = useRef(0);
  const workbenchRef = useRef(workbench);
  const modelAliasRef = useRef(modelAlias);
  const resourcesRef = useRef<ProviderResource[]>([]);

  useEffect(() => {
    workbenchRef.current = workbench;
  }, [workbench]);

  useEffect(() => {
    modelAliasRef.current = modelAlias;
  }, [modelAlias]);

  const allApiKeyResources = useMemo(() => {
    const groups = workbench.snapshot?.groups ?? [];
    return groups.flatMap((group) => group.resources);
  }, [workbench.snapshot]);

  useEffect(() => {
    resourcesRef.current = allApiKeyResources;
  }, [allApiKeyResources]);

  const loadAll = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setOauthAliasError('loading');

    const [filesResult, aliasResult, excludedResult] = await Promise.allSettled([
      authFilesApi.list(),
      authFilesApi.getOauthModelAlias(),
      authFilesApi.getOauthExcludedModels(),
      workbenchRef.current.refetch(),
    ]);

    if (requestId !== loadRequestRef.current) return;

    const fileTypes: string[] = [];
    if (filesResult.status === 'fulfilled') {
      (filesResult.value?.files ?? []).forEach((file) => {
        if (typeof file.type === 'string') fileTypes.push(file.type);
        if (typeof file.provider === 'string') fileTypes.push(file.provider);
      });
    }

    if (aliasResult.status === 'fulfilled') {
      setModelAlias(aliasResult.value ?? {});
      modelAliasRef.current = aliasResult.value ?? {};
      setOauthAliasError(null);
    } else {
      const status = getStatusCode(aliasResult.reason);
      setModelAlias({});
      modelAliasRef.current = {};
      setOauthAliasError(status === 404 ? 'unsupported' : 'load');
    }

    let nextExcluded: Record<string, string[]> = {};
    if (excludedResult.status === 'fulfilled') {
      nextExcluded = excludedResult.value ?? {};
    }
    setExcluded(nextExcluded);

    const channels = collectOAuthChannels({ authFileTypes: fileTypes });
    const definitionResults = await Promise.all(
      channels.map(async (channel) => {
        try {
          const models = await authFilesApi.getModelDefinitions(channel);
          return { channel, models };
        } catch {
          return { channel, models: [] as AuthFileModelItem[] };
        }
      })
    );

    if (requestId !== loadRequestRef.current) return;

    const nextModels: Record<string, AuthFileModelItem[]> = {};
    definitionResults.forEach(({ channel, models }) => {
      if (models.length > 0) nextModels[channel] = models;
    });
    setOauthModels(nextModels);

    // rebuild access rows for enabled picker + currentlyEnabled flags
    const resources = workbenchRef.current.snapshot?.groups.flatMap((g) => g.resources) ?? [];
    const built: ModelAccessRow[] = [];

    Object.entries(nextModels).forEach(([channel, models]) => {
      const iconSrc = getAuthFileIcon(channel, resolvedTheme);
      built.push(
        ...buildOAuthAccessRows({
          channel,
          models,
          excluded: nextExcluded,
          providerLabel: getTypeLabel(t, channel),
          iconSrc,
        })
      );
    });

    resources.forEach((resource) => {
      const logo = PROVIDER_LOGOS[resource.brand];
      const iconSrc =
        resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
      const brandLabel = t(`providersPage.providerNames.${resource.brand}`, {
        defaultValue: resource.brand,
      });
      const entryLabel = resource.name ?? resource.identifier;
      const providerLabel = entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
      built.push(
        ...buildApiKeyAccessRows({
          resource,
          providerLabel,
          iconSrc,
        })
      );
    });

    setAccessRows(built);
    setLoading(false);
  }, [resolvedTheme, t]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadAll]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onSuspendedChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ apiBase?: string }>).detail;
      if (detail?.apiBase && detail.apiBase !== apiBase) return;
      setSuspendedEpoch((n) => n + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || !event.key.includes('suspended-model-mappings')) return;
      setSuspendedEpoch((n) => n + 1);
    };
    window.addEventListener(SUSPENDED_MAPPINGS_CHANGED_EVENT, onSuspendedChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SUSPENDED_MAPPINGS_CHANGED_EVENT, onSuspendedChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, [apiBase]);

  // Rebuild access rows when theme/resources change without full reload
  useEffect(() => {
    if (loading) return;
    const built: ModelAccessRow[] = [];
    Object.entries(oauthModels).forEach(([channel, models]) => {
      const iconSrc = getAuthFileIcon(channel, resolvedTheme);
      built.push(
        ...buildOAuthAccessRows({
          channel,
          models,
          excluded,
          providerLabel: getTypeLabel(t, channel),
          iconSrc,
        })
      );
    });
    allApiKeyResources.forEach((resource) => {
      const logo = PROVIDER_LOGOS[resource.brand];
      const iconSrc =
        resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
      const brandLabel = t(`providersPage.providerNames.${resource.brand}`, {
        defaultValue: resource.brand,
      });
      const entryLabel = resource.name ?? resource.identifier;
      const providerLabel = entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
      built.push(...buildApiKeyAccessRows({ resource, providerLabel, iconSrc }));
    });
    setAccessRows(built);
  }, [allApiKeyResources, excluded, loading, oauthModels, resolvedTheme, t]);

  const enabledKeySet = useMemo(() => {
    const set = new Set<string>();
    accessRows.forEach((row) => {
      if (row.enabled) set.add(row.key);
    });
    return set;
  }, [accessRows]);

  const rows = useMemo(() => {
    const oauthDisplayNames = buildOauthDisplayNameMap(oauthModels);
    const baseRows = buildFederatedMappingRows({
      modelAlias,
      resources: allApiKeyResources,
      oauthDisplayNames,
      enabledKeySet,
      providerLabels: {
        oauth: (channel) => getTypeLabel(t, channel),
        apiKey: (resource) => {
          const brandLabel = t(`providersPage.providerNames.${resource.brand}`, {
            defaultValue: resource.brand,
          });
          const entryLabel = resource.name ?? resource.identifier;
          return entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
        },
      },
      icons: {
        oauth: (channel) => getAuthFileIcon(channel, resolvedTheme),
        apiKey: (resource) => {
          const logo = PROVIDER_LOGOS[resource.brand];
          return resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
        },
      },
    });

    void suspendedEpoch;
    const suspended = listAllSuspended(apiBase);
    const resourceById = new Map(allApiKeyResources.map((r) => [r.id, r]));
    const apiKeyProviderLabel = (resourceId: string, brand: ProviderBrand) => {
      const resource = resourceById.get(resourceId);
      const brandLabel = t(`providersPage.providerNames.${brand}`, {
        defaultValue: brand,
      });
      if (!resource) return brandLabel;
      const entryLabel = resource.name ?? resource.identifier;
      return entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
    };
    const apiKeyIcon = (resourceId: string, brand: ProviderBrand) => {
      const resource = resourceById.get(resourceId);
      const logo = PROVIDER_LOGOS[resource?.brand ?? brand];
      return resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
    };

    const withSuspended = mergeSuspendedIntoFederatedRows(baseRows, suspended, {
      oauthDisplayNames,
      providerLabels: {
        oauth: (channel) => getTypeLabel(t, channel),
        apiKey: apiKeyProviderLabel,
      },
      icons: {
        oauth: (channel) => getAuthFileIcon(channel, resolvedTheme),
        apiKey: apiKeyIcon,
      },
    });

    // 配置别名 + 多来源同名自动联邦 + 原生 identity 挂载。
    return assembleFederatedMappingRows(withSuspended, accessRows);
  }, [
    accessRows,
    allApiKeyResources,
    apiBase,
    enabledKeySet,
    modelAlias,
    oauthModels,
    resolvedTheme,
    suspendedEpoch,
    t,
  ]);

  const filteredRows = useMemo(
    () => filterFederatedMappingRows(rows, search),
    [rows, search]
  );

  const unmappedRows = useMemo(() => {
    const mappedKeys = collectMappedTargetKeys(rows);
    return buildUnmappedModels(accessRows, mappedKeys);
  }, [accessRows, rows]);

  const filteredUnmappedRows = useMemo(
    () => filterUnmappedModels(unmappedRows, search),
    [search, unmappedRows]
  );

  const enabledOptions = useMemo(() => buildEnabledMappingOptions(accessRows), [accessRows]);

  const existingAliasKeys = useMemo(() => rows.map((row) => row.aliasKey), [rows]);

  const deleteAlias = useCallback(
    (alias: string) => {
      const aliasKey = toAliasKey(alias);
      const row = rows.find((r) => r.aliasKey === aliasKey);
      if (!row) return;

      showConfirmation({
        title: t('modelsPage.mapping.deleteTitle', { defaultValue: '删除映射' }),
        message: t('modelsPage.mapping.deleteConfirm', {
          defaultValue: '确定删除自定义模型「{{alias}}」的全部映射目标？',
          alias: row.alias,
        }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          try {
            // 仅清理真实配置中的目标；挂起灰标一并丢弃
            const baselineTargets: MappingTargetRef[] = row.targets
              .filter((target) => !target.suspended)
              .map((target) =>
                target.source === 'oauth'
                  ? { source: 'oauth', channel: target.channel, modelId: target.modelId }
                  : {
                      source: 'apiKey',
                      resourceId: target.resourceId,
                      brand: target.brand,
                      modelId: target.modelId,
                    }
              );

            clearSuspendedForAlias(apiBase, row.alias);

            // OAuth: clear alias from every involved channel
            const oauthChannels = new Set(
              baselineTargets
                .filter((t): t is Extract<MappingTargetRef, { source: 'oauth' }> => t.source === 'oauth')
                .map((t) => t.channel)
            );
            const currentAlias = modelAliasRef.current;
            await Promise.all(
              Array.from(oauthChannels).map(async (channel) => {
                const entries = currentAlias[channel] ?? [];
                const next = applyOauthAliasTargetChanges({
                  entries,
                  alias: row.alias,
                  nextModelIds: [],
                });
                if (next.length) {
                  await authFilesApi.saveOauthModelAlias(channel, next);
                } else {
                  await authFilesApi.deleteOauthModelAlias(channel);
                }
              })
            );

            // API Key: clear alias on involved resources
            const resourceIds = new Set(
              baselineTargets
                .filter(
                  (t): t is Extract<MappingTargetRef, { source: 'apiKey' }> => t.source === 'apiKey'
                )
                .map((t) => t.resourceId)
            );
            await Promise.all(
              Array.from(resourceIds).map(async (resourceId) => {
                const resource = resourcesRef.current.find((r) => r.id === resourceId);
                if (!resource) return;
                const rawModels = ((resource.raw as { models?: ModelAlias[] })?.models ??
                  []) as ModelAlias[];
                const previousModelIds = baselineTargets
                  .filter(
                    (t): t is Extract<MappingTargetRef, { source: 'apiKey' }> =>
                      t.source === 'apiKey' && t.resourceId === resourceId
                  )
                  .map((t) => t.modelId);
                const nextModels = applyApiKeyModelAliasChanges({
                  models: rawModels,
                  alias: row.alias,
                  nextModelIds: [],
                  previousModelIds,
                });
                await updateApiKeyModels(resource, nextModels);
              })
            );

            showNotification(
              t('modelsPage.mapping.deleteSuccess', { defaultValue: '映射已删除' }),
              'success'
            );
            await loadAll();
          } catch (err: unknown) {
            showNotification(
              `${t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' })}: ${getErrorMessage(err)}`,
              'error'
            );
          }
        },
      });
    },
    [apiBase, loadAll, rows, showConfirmation, showNotification, t]
  );

  return {
    rows,
    filteredRows,
    unmappedRows,
    filteredUnmappedRows,
    search,
    setSearch,
    loading,
    oauthAliasError,
    disableControls,
    refresh: loadAll,
    deleteAlias,
    enabledOptions,
    modelAlias,
    resources: allApiKeyResources,
    existingAliasKeys,
  };
}
