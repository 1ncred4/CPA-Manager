/**
 * 模型禁用 Tab：加载 OAuth 定义 + API Key models，支持逐模型开关
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
import {
  normalizeOAuthExcludedRules,
  updateOAuthExcludedRule,
} from '@/features/authFiles/oauthExcludedRules';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import type { ProviderResource } from '@/features/providers/types';
import type { GeminiKeyConfig, ProviderKeyConfig } from '@/types';
import { stripDisableAllModelsRule } from '@/components/providers/utils';
import { getErrorMessage } from '@/utils/helpers';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  collectOAuthChannels,
  filterModelAccessRows,
  sortModelAccessRows,
  toggleApiKeyExcludedList,
  type ModelAccessRow,
} from './modelAccessRows';
import { updateApiKeyExcludedModels } from './updateApiKeyExcludedModels';

export type UseModelAccessListResult = {
  rows: ModelAccessRow[];
  filteredRows: ModelAccessRow[];
  search: string;
  setSearch: (value: string) => void;
  loading: boolean;
  oauthExcludedError: OAuthConfigLoadError;
  disableControls: boolean;
  toggleRow: (row: ModelAccessRow, enabled: boolean) => Promise<void>;
  pendingKeys: Set<string>;
  refresh: () => Promise<void>;
};

const getStatusCode = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  if ('status' in err) return (err as { status?: unknown }).status as number | undefined;
  return undefined;
};

const enqueueSerial = <T,>(
  map: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = map.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  map.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
};

export function useModelAccessList(): UseModelAccessListResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const workbench = useProviderWorkbench();

  const disableControls = connectionStatus !== 'connected';

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [oauthExcludedError, setOauthExcludedError] = useState<OAuthConfigLoadError>('loading');
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [oauthModels, setOauthModels] = useState<Record<string, AuthFileModelItem[]>>({});
  /** resourceId -> excluded models without `*` */
  const [apiKeyExcludedOverrides, setApiKeyExcludedOverrides] = useState<
    Record<string, string[]>
  >({});
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());

  const loadRequestRef = useRef(0);
  const oauthQueuesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const apiKeyQueuesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const excludedRef = useRef(excluded);
  const overridesRef = useRef(apiKeyExcludedOverrides);
  const resourcesRef = useRef<ProviderResource[]>([]);
  const workbenchRef = useRef(workbench);

  useEffect(() => {
    excludedRef.current = excluded;
  }, [excluded]);

  useEffect(() => {
    overridesRef.current = apiKeyExcludedOverrides;
  }, [apiKeyExcludedOverrides]);

  useEffect(() => {
    workbenchRef.current = workbench;
  }, [workbench]);

  const allApiKeyResources = useMemo(() => {
    const groups = workbench.snapshot?.groups ?? [];
    return groups.flatMap((group) => group.resources);
  }, [workbench.snapshot]);

  useEffect(() => {
    resourcesRef.current = allApiKeyResources;
  }, [allApiKeyResources]);

  // Drop overrides once server state catches up after refetch
  useEffect(() => {
    setApiKeyExcludedOverrides((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      keys.forEach((resourceId) => {
        const resource = allApiKeyResources.find((r) => r.id === resourceId);
        if (!resource || resource.brand === 'openaiCompatibility') {
          delete next[resourceId];
          changed = true;
          return;
        }
        const raw = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
        const serverList = stripDisableAllModelsRule(raw.excludedModels);
        const overrideList = prev[resourceId] ?? [];
        const serverSig = [...serverList].map((v) => v.toLowerCase()).sort().join('\0');
        const overrideSig = [...overrideList].map((v) => v.toLowerCase()).sort().join('\0');
        if (serverSig === overrideSig) {
          delete next[resourceId];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [allApiKeyResources]);

  const loadAll = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setOauthExcludedError('loading');

    const [filesResult, excludedResult] = await Promise.allSettled([
      authFilesApi.list(),
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

    if (excludedResult.status === 'fulfilled') {
      const nextExcluded = excludedResult.value ?? {};
      setExcluded(nextExcluded);
      excludedRef.current = nextExcluded;
      setOauthExcludedError(null);
    } else {
      const status = getStatusCode(excludedResult.reason);
      setExcluded({});
      excludedRef.current = {};
      setOauthExcludedError(status === 404 ? 'unsupported' : 'load');
    }

    // 仅展示当前有凭证的 OAuth 渠道
    const channels = collectOAuthChannels({
      authFileTypes: fileTypes,
    });

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
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadAll]);

  const rows = useMemo(() => {
    const built: ModelAccessRow[] = [];

    const oauthEditable = oauthExcludedError === null;

    Object.entries(oauthModels).forEach(([channel, models]) => {
      const iconSrc = getAuthFileIcon(channel, resolvedTheme);
      const oauthRows = buildOAuthAccessRows({
        channel,
        models,
        excluded,
        providerLabel: getTypeLabel(t, channel),
        iconSrc,
      });
      if (!oauthEditable) {
        oauthRows.forEach((row) => {
          row.supportsExclude = false;
          row.toggleDisabled = true;
          row.lockReason = row.lockReason ?? 'unsupported';
        });
      }
      built.push(...oauthRows);
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

      let effectiveResource = resource;
      const override = apiKeyExcludedOverrides[resource.id];
      if (override && resource.brand !== 'openaiCompatibility') {
        const raw = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
        const hasStar = Array.isArray(raw.excludedModels)
          ? raw.excludedModels.some((m) => String(m ?? '').trim() === '*')
          : false;
        const nextExcluded = hasStar ? [...override, '*'] : [...override];
        effectiveResource = {
          ...resource,
          raw: { ...raw, excludedModels: nextExcluded },
          excludedModelCount: override.length,
        };
      }

      built.push(
        ...buildApiKeyAccessRows({
          resource: effectiveResource,
          providerLabel,
          iconSrc,
        })
      );
    });

    return sortModelAccessRows(built);
  }, [
    allApiKeyResources,
    apiKeyExcludedOverrides,
    excluded,
    oauthExcludedError,
    oauthModels,
    resolvedTheme,
    t,
  ]);

  const filteredRows = useMemo(() => filterModelAccessRows(rows, search), [rows, search]);

  const setRowPending = (key: string, pending: boolean) => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleRow = useCallback(
    async (row: ModelAccessRow, enabled: boolean) => {
      if (disableControls || row.toggleDisabled || !row.supportsExclude) return;

      const wantExclude = !enabled;

      if (row.source === 'oauth' && row.oauthChannel) {
        const channel = row.oauthChannel;
        const snapshotBefore = normalizeOAuthExcludedRules(excludedRef.current[channel] ?? []);
        const optimistic = updateOAuthExcludedRule(snapshotBefore, row.modelId, wantExclude);
        setExcluded((prev) => ({ ...prev, [channel]: optimistic }));
        excludedRef.current = { ...excludedRef.current, [channel]: optimistic };
        setRowPending(row.key, true);

        try {
          await enqueueSerial(oauthQueuesRef.current, channel, async () => {
            const latest = normalizeOAuthExcludedRules(excludedRef.current[channel] ?? []);
            const serialRules = updateOAuthExcludedRule(latest, row.modelId, wantExclude);
            setExcluded((prev) => ({ ...prev, [channel]: serialRules }));
            excludedRef.current = { ...excludedRef.current, [channel]: serialRules };

            if (serialRules.length) {
              await authFilesApi.saveOauthExcludedModels(channel, serialRules);
            } else {
              await authFilesApi.deleteOauthExcludedEntry(channel);
              setExcluded((prev) => {
                const next = { ...prev };
                delete next[channel];
                return next;
              });
              const rest = { ...excludedRef.current };
              delete rest[channel];
              excludedRef.current = rest;
            }
          });
        } catch (err) {
          setExcluded((prev) => ({ ...prev, [channel]: snapshotBefore }));
          excludedRef.current = { ...excludedRef.current, [channel]: snapshotBefore };
          showNotification(
            `${t('modelsPage.access.saveFailed', {
              defaultValue: 'Failed to update model access',
            })}: ${getErrorMessage(err)}`,
            'error'
          );
        } finally {
          setRowPending(row.key, false);
        }
        return;
      }

      if (row.source === 'apiKey' && row.resourceId) {
        const resourceId = row.resourceId;
        const resource = resourcesRef.current.find((r) => r.id === resourceId);
        if (!resource || resource.brand === 'openaiCompatibility') return;

        const raw = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
        const baseList =
          overridesRef.current[resourceId] ?? stripDisableAllModelsRule(raw.excludedModels);
        const previousList = [...baseList];
        const nextList = toggleApiKeyExcludedList(baseList, row.modelId, wantExclude);

        setApiKeyExcludedOverrides((prev) => ({ ...prev, [resourceId]: nextList }));
        overridesRef.current = { ...overridesRef.current, [resourceId]: nextList };
        setRowPending(row.key, true);

        try {
          await enqueueSerial(apiKeyQueuesRef.current, resourceId, async () => {
            const latestResource =
              resourcesRef.current.find((r) => r.id === resourceId) ?? resource;
            const finalList =
              overridesRef.current[resourceId] ??
              toggleApiKeyExcludedList(
                stripDisableAllModelsRule(
                  (latestResource.raw as GeminiKeyConfig | ProviderKeyConfig).excludedModels
                ),
                row.modelId,
                wantExclude
              );

            await updateApiKeyExcludedModels(latestResource, finalList);
            await workbenchRef.current.refetch();
          });
        } catch (err) {
          setApiKeyExcludedOverrides((prev) => ({ ...prev, [resourceId]: previousList }));
          overridesRef.current = { ...overridesRef.current, [resourceId]: previousList };
          showNotification(
            `${t('modelsPage.access.saveFailed', {
              defaultValue: 'Failed to update model access',
            })}: ${getErrorMessage(err)}`,
            'error'
          );
        } finally {
          setRowPending(row.key, false);
        }
      }
    },
    [disableControls, showNotification, t]
  );

  const refresh = useCallback(async () => {
    await loadAll();
  }, [loadAll]);

  return {
    rows,
    filteredRows,
    search,
    setSearch,
    loading,
    oauthExcludedError,
    disableControls,
    toggleRow,
    pendingKeys,
    refresh,
  };
}
