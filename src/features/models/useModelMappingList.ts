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
  listManualMappingClaims,
  MANUAL_MAPPING_CLAIMS_CHANGED_EVENT,
  unclaimManualMapping,
} from './mappingClaims';
import {
  clearSuspendedForAlias,
  listAllSuspended,
  mergeSuspendedIntoFederatedRows,
  SUSPENDED_MAPPINGS_CHANGED_EVENT,
} from './mappingSuspend';
import {
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  assembleManualAndAutoMappingRows,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  buildOauthDisplayNameMap,
  buildUnmappedModels,
  collectConfiguredApiKeyResourceIdsForAlias,
  collectConfiguredOauthChannelsForAlias,
  collectMappedTargetKeys,
  filterFederatedMappingRows,
  filterUnmappedModels,
  isManualMappingRow,
  toAliasKey,
  type FederatedMappingRow,
  type MappingPickerOption,
  type MappingTargetRef,
  type UnmappedModelRow,
} from './modelMapping';
import { updateApiKeyModels } from './updateApiKeyModels';

export type UseModelMappingListResult = {
  /** 全部行（手动 + 自动），兼容旧用法 */
  rows: FederatedMappingRow[];
  filteredRows: FederatedMappingRow[];
  /** 手动映射：后端有自定义 alias 的渠道 */
  manualRows: FederatedMappingRow[];
  filteredManualRows: FederatedMappingRow[];
  /** 自动映射：未入手动的模型按 modelId 聚合 */
  autoRows: FederatedMappingRow[];
  filteredAutoRows: FederatedMappingRow[];
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
  /** 递增以重读「手动认领」 */
  const [claimsEpoch, setClaimsEpoch] = useState(0);

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
    const onClaimsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ apiBase?: string }>).detail;
      if (detail?.apiBase && detail.apiBase !== apiBase) return;
      setClaimsEpoch((n) => n + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key) return;
      if (event.key.includes('suspended-model-mappings')) setSuspendedEpoch((n) => n + 1);
      if (event.key.includes('manual-mapping-claims')) setClaimsEpoch((n) => n + 1);
    };
    window.addEventListener(SUSPENDED_MAPPINGS_CHANGED_EVENT, onSuspendedChanged);
    window.addEventListener(MANUAL_MAPPING_CLAIMS_CHANGED_EVENT, onClaimsChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SUSPENDED_MAPPINGS_CHANGED_EVENT, onSuspendedChanged);
      window.removeEventListener(MANUAL_MAPPING_CLAIMS_CHANGED_EVENT, onClaimsChanged);
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

  const { manualRows, autoRows, rows } = useMemo(() => {
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

    void claimsEpoch;
    const claims = listManualMappingClaims(apiBase);
    const split = assembleManualAndAutoMappingRows(withSuspended, accessRows, claims);
    return {
      manualRows: split.manualRows,
      autoRows: split.autoRows,
      rows: [...split.manualRows, ...split.autoRows],
    };
  }, [
    accessRows,
    allApiKeyResources,
    apiBase,
    claimsEpoch,
    enabledKeySet,
    modelAlias,
    oauthModels,
    resolvedTheme,
    suspendedEpoch,
    t,
  ]);

  const filteredManualRows = useMemo(
    () => filterFederatedMappingRows(manualRows, search),
    [manualRows, search]
  );
  const filteredAutoRows = useMemo(
    () => filterFederatedMappingRows(autoRows, search),
    [autoRows, search]
  );
  const filteredRows = useMemo(
    () => [...filteredManualRows, ...filteredAutoRows],
    [filteredAutoRows, filteredManualRows]
  );

  // 已覆盖：手动 + 自动；剩余一般为空（自动已吸收全部启用未映射模型）
  const unmappedRows = useMemo(() => {
    const mappedKeys = collectMappedTargetKeys(rows);
    return buildUnmappedModels(accessRows, mappedKeys);
  }, [accessRows, rows]);

  const filteredUnmappedRows = useMemo(
    () => filterUnmappedModels(unmappedRows, search),
    [search, unmappedRows]
  );

  const enabledOptions = useMemo(() => buildEnabledMappingOptions(accessRows), [accessRows]);

  // 重名校验只挡手动渠道；自动渠道名与手动重名时会并入手动
  const existingAliasKeys = useMemo(
    () => manualRows.map((row) => row.aliasKey),
    [manualRows]
  );

  const deleteAlias = useCallback(
    (alias: string) => {
      const aliasKey = toAliasKey(alias);
      const row = rows.find((r) => r.aliasKey === aliasKey);
      if (!row) return;

      // 自动渠道无后端配置，删除无意义；提示用户用「转为手动」编辑
      if (!isManualMappingRow(row)) {
        showNotification(
          t('modelsPage.mapping.autoDeleteHint', {
            defaultValue:
              '自动映射由启用模型自动生成，无需删除。可点击编辑转为手动映射。',
          }),
          'info'
        );
        return;
      }

      showConfirmation({
        title: t('modelsPage.mapping.deleteTitle', { defaultValue: '删除映射' }),
        message: t('modelsPage.mapping.deleteConfirm', {
          defaultValue:
            '确定删除自定义模型「{{alias}}」的手动映射？删除后同名启用模型会重新出现在自动映射中。',
          alias: row.alias,
        }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          try {
            clearSuspendedForAlias(apiBase, row.alias);
            // 清除本地手动认领，使同名模型回到自动映射
            unclaimManualMapping(apiBase, row.alias);

            const currentAlias = modelAliasRef.current;
            // 只清理后端真正存在该 alias 的 channel / resource
            const oauthChannels = collectConfiguredOauthChannelsForAlias(
              currentAlias,
              aliasKey
            );
            await Promise.all(
              oauthChannels.map(async (channel) => {
                const entries = currentAlias[channel] ?? [];
                if (!entries.length) return;
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

            const resourceIds = collectConfiguredApiKeyResourceIdsForAlias(
              resourcesRef.current,
              aliasKey
            );
            await Promise.all(
              resourceIds.map(async (resourceId) => {
                const resource = resourcesRef.current.find((r) => r.id === resourceId);
                if (!resource) return;
                const rawModels = ((resource.raw as { models?: ModelAlias[] })?.models ??
                  []) as ModelAlias[];
                const previousModelIds = rawModels
                  .filter((m) => {
                    const name = String(m.name ?? '').trim();
                    const a = String(m.alias ?? '').trim();
                    return (
                      name &&
                      a &&
                      toAliasKey(a) === aliasKey &&
                      toAliasKey(a) !== name.trim().toLowerCase()
                    );
                  })
                  .map((m) => String(m.name).trim());
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
              t('modelsPage.mapping.deleteSuccess', {
                defaultValue: '手动映射已删除，同名模型已回到自动映射',
              }),
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
    manualRows,
    filteredManualRows,
    autoRows,
    filteredAutoRows,
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
