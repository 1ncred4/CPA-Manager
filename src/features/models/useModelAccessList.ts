/**
 * 模型禁用 Tab：加载 OAuth 定义 + API Key models，逐模型开关。
 *
 * Phase 2 重构后：本 hook 只负责 fetch（loadAll）+ 构建显示上下文 ctx + 调 store.load，
 * 以及从 store.accessCurrent 投影 ModelAccessRow[]；toggle 委托 store.toggleAccess。
 * 乐观状态 / 串行队列 / localStorage 挂起全部由 store + applier 管理。
 *
 * OpenAI Compatibility 无 excludedModels：禁用 = 从 models[] 摘除并 catalog 挂起（由 planner 编码）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import { useModelManagementStore } from '@/stores/useModelManagementStore';
import {
  getAuthFileIcon,
  getTypeLabel,
  normalizeProviderKey,
  type AuthFileModelItem,
  type OAuthConfigLoadError,
} from '@/features/authFiles/constants';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import type { OAuthModelAliasEntry } from '@/types';
import {
  collectOAuthChannels,
  filterModelAccessRows,
  type ModelAccessRow,
} from './modelAccessRows';
import { reconcileSuspendedCatalogWithModels } from './catalogSuspend';
import { targetRefFromAccessRow } from './mappingSuspend';
import { applyManagedIdentityExcludeDisplayMaskWithKeys } from './managedIdentityExclude';
import type { ModelAccessEntry, ModelDisplayContext } from './modelManagementState';

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

export function useModelAccessList(): UseModelAccessListResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const apiBase = useAuthStore((s) => s.apiBase);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const workbench = useProviderWorkbench();

  const disableControls = connectionStatus !== 'connected';

  const [search, setSearch] = useState('');
  const [oauthExcludedError, setOauthExcludedError] = useState<OAuthConfigLoadError>('loading');
  const [oauthAliasError, setOauthAliasError] = useState<OAuthConfigLoadError>('loading');
  const [oauthModels, setOauthModels] = useState<Record<string, AuthFileModelItem[]>>({});
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [oauthAliasMap, setOauthAliasMap] = useState<Record<string, OAuthModelAliasEntry[]>>({});

  const loadRequestRef = useRef(0);
  const workbenchRef = useRef(workbench);
  useEffect(() => {
    workbenchRef.current = workbench;
  }, [workbench]);

  const allApiKeyResources = useMemo(() => {
    const groups = workbench.snapshot?.groups ?? [];
    return groups.flatMap((group) => group.resources);
  }, [workbench.snapshot]);

  const accessCurrent = useModelManagementStore((s) => s.accessCurrent);
  const managedExcludeKeys = useModelManagementStore((s) => s.managedExcludeKeys);
  const pendingKeys = useModelManagementStore((s) => s.pendingKeys);
  const loading = useModelManagementStore((s) => s.loading);
  const storeLoad = useModelManagementStore((s) => s.load);
  const setLoading = useModelManagementStore((s) => s.setLoading);
  const toggleAccess = useModelManagementStore((s) => s.toggleAccess);

  const loadAll = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setOauthExcludedError('loading');
    setOauthAliasError('loading');

    const [filesResult, excludedResult, aliasResult] = await Promise.allSettled([
      authFilesApi.list(),
      authFilesApi.getOauthExcludedModels(),
      authFilesApi.getOauthModelAlias(),
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
      setExcluded(excludedResult.value ?? {});
      setOauthExcludedError(null);
    } else {
      const status = getStatusCode(excludedResult.reason);
      setExcluded({});
      setOauthExcludedError(status === 404 ? 'unsupported' : 'load');
    }

    if (aliasResult.status === 'fulfilled') {
      setOauthAliasMap(aliasResult.value ?? {});
      setOauthAliasError(null);
    } else {
      const status = getStatusCode(aliasResult.reason);
      setOauthAliasMap({});
      setOauthAliasError(status === 404 ? 'unsupported' : 'load');
    }

    // 仅展示当前有凭证的 OAuth 渠道
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
    setLoading(false);
  }, [setLoading]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadAll]);

  // 数据 / 主题变化时：reconcile catalog 挂起 + 构建 ctx + store.load
  useEffect(() => {
    if (!apiBase) return;
    allApiKeyResources.forEach((resource) => {
      if (resource.brand !== 'openaiCompatibility') return;
      reconcileSuspendedCatalogWithModels(apiBase, resource.id, resource.models ?? []);
    });

    const resourceById = new Map(allApiKeyResources.map((r) => [r.id, r]));
    const oauthDisplayNames: Record<string, Record<string, string>> = {};
    Object.entries(oauthModels).forEach(([channelRaw, models]) => {
      const channel = normalizeProviderKey(channelRaw) ?? channelRaw;
      const map: Record<string, string> = {};
      models.forEach((m) => {
        const id = String(m.id ?? '').trim().toLowerCase();
        const dn = String(m.display_name ?? '').trim();
        if (id && dn) map[id] = dn;
      });
      oauthDisplayNames[channel] = map;
    });

    const ctx: ModelDisplayContext = {
      oauthProviderLabel: (channel) => getTypeLabel(t, channel),
      apiKeyProviderLabel: (resourceId, brand) => {
        const r = resourceById.get(resourceId);
        const brandLabel = t(`providersPage.providerNames.${brand}`, {
          defaultValue: brand,
        });
        const entryLabel = r?.name ?? r?.identifier ?? '';
        return entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
      },
      oauthIcon: (channel) => getAuthFileIcon(channel, resolvedTheme),
      apiKeyIcon: (_resourceId, brand) => {
        const logo = PROVIDER_LOGOS[brand];
        return resolvedTheme === 'dark' && logo?.darkSrc
          ? logo.darkSrc
          : (logo?.src ?? null);
      },
      oauthDisplayNames,
    };

    storeLoad({
      oauthModels,
      resources: allApiKeyResources,
      oauthAliasMap,
      oauthExcludedMap: excluded,
      oauthAliasError,
      apiBase,
      ctx,
    });
  }, [
    apiBase,
    allApiKeyResources,
    oauthModels,
    excluded,
    oauthAliasMap,
    oauthAliasError,
    resolvedTheme,
    t,
    storeLoad,
  ]);

  const rows = useMemo<ModelAccessRow[]>(() => {
    const entries: ModelAccessEntry[] = Array.from(accessCurrent.byKey.values());
    const oauthEditable = oauthExcludedError === null;
    const projected: ModelAccessRow[] = oauthEditable
      ? entries
      : entries.map((e) => {
          if (e.source !== 'oauth') return e;
          return {
            ...e,
            supportsExclude: false,
            toggleDisabled: true,
            lockReason: e.lockReason ?? 'unsupported',
          };
        });
    return applyManagedIdentityExcludeDisplayMaskWithKeys(projected, managedExcludeKeys);
  }, [accessCurrent, oauthExcludedError, managedExcludeKeys]);

  const filteredRows = useMemo(() => filterModelAccessRows(rows, search), [rows, search]);

  const toggleRow = useCallback(
    async (row: ModelAccessRow, enabled: boolean) => {
      if (disableControls || row.toggleDisabled || !row.supportsExclude) return;
      const ref = targetRefFromAccessRow(row);
      if (!ref) return;

      const result = await toggleAccess(ref, enabled);
      if (!result.ok) {
        showNotification(
          t('modelsPage.access.saveFailed', {
            defaultValue: 'Failed to update model access',
          }),
          'error'
        );
        await loadAll();
        return;
      }
      if (result.pruned > 0) {
        showNotification(
          t('modelsPage.access.mappingPruned', {
            defaultValue: 'Detached {{count}} mapping target(s); will restore when re-enabled',
            count: result.pruned,
          }),
          'success'
        );
      }
      if (result.restored > 0) {
        showNotification(
          t('modelsPage.access.mappingRestored', {
            defaultValue: 'Restored {{count}} mapping target(s)',
            count: result.restored,
          }),
          'success'
        );
      }
    },
    [disableControls, toggleAccess, showNotification, t, loadAll]
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
