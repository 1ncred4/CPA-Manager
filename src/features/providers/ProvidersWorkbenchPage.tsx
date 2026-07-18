import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { Skeleton } from '@/components/ui/Skeleton';
import { Sheet } from '@/components/ui/Sheet';
import { useAuthStore, useNotificationStore } from '@/stores';
import { useProviderRecentRequests } from '@/components/providers/hooks/useProviderRecentRequests';
import {
  getOpenAIProviderRecentWindowStats,
  getProviderRecentWindowStats,
  type ProviderRecentUsageMap,
} from '@/components/providers/utils';
import type { OpenAIProviderConfig } from '@/types';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { pluginsApi } from '@/services/api';
import { getTypeLabel } from '@/features/authFiles/constants';
import { ProviderHeaderCard } from './components/ProviderHeaderCard';
import { ProviderCategoryList } from './components/ProviderCategoryList';
import type { OAuthCategoryItem } from './components/ProviderCategoryList';
import { ProviderResourcePanel } from './components/ProviderResourcePanel';
import type { ProviderPanelControls } from './components/ProviderResourcePanel';
import { ProviderSheet, type ProviderSheetHandle } from './sheets/ProviderSheet';
import { OAuthAuthFilesPanel } from './oauth/OAuthAuthFilesPanel';
import { OAuthLoginPanel } from './oauth/OAuthLoginPanel';
import {
  buildOAuthChannelList,
  getOAuthChannelDescriptor,
  resolveAuthFileChannel,
} from './oauthChannels';
import { useProviderWorkbench } from './useProviderWorkbench';
import {
  getActiveCategory,
  getCategoryFilterState,
  readProvidersWorkbenchUiState,
  writeProvidersWorkbenchUiState,
  type ProviderFilterState,
  type ProvidersWorkbenchUiState,
} from './uiState';
import {
  toCategoryKey,
  type ProviderBrand,
  type ProviderCategoryId,
  type ProviderResource,
  type ProviderSortBy,
  type SortDir,
} from './types';
import styles from './ProvidersWorkbenchPage.module.scss';

type SheetMode = 'detail' | 'create' | 'edit';

interface ApiKeySheetState {
  open: boolean;
  brand: ProviderBrand;
  mode: SheetMode;
  resource: ProviderResource | null;
}

const formatDateTime = (iso: string, locale?: string) => {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return iso;
  }
};

const matchesFilter = (r: ProviderResource, normalized: string): boolean => {
  if (!normalized) return true;
  const haystack = [
    r.identifier,
    r.name,
    r.authIndex,
    r.apiKeyPreview,
    r.apiKey,
    r.baseUrl,
    r.proxyUrl,
    r.prefix,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  return haystack.some((v) => v.includes(normalized));
};

const getResourceSortName = (resource: ProviderResource): string =>
  (resource.name ?? resource.identifier ?? resource.apiKeyPreview ?? '').toLowerCase();

const getResourceRecentSuccess = (
  resource: ProviderResource,
  usageByProvider: ProviderRecentUsageMap
): number => {
  if (resource.brand === 'openaiCompatibility') {
    return getOpenAIProviderRecentWindowStats(resource.raw as OpenAIProviderConfig, usageByProvider)
      .success;
  }
  return getProviderRecentWindowStats(
    usageByProvider,
    resource.brand,
    resource.apiKey ?? undefined,
    resource.baseUrl ?? undefined
  ).success;
};

export function ProvidersWorkbenchPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const { showNotification, showConfirmation } = useNotificationStore();

  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const workbench = useProviderWorkbench();
  const authFiles = useAuthFilesData();
  const [uiState, setUiState] = useState<ProvidersWorkbenchUiState>(readProvidersWorkbenchUiState);
  const [sheetState, setSheetState] = useState<ApiKeySheetState>({
    open: false,
    brand: 'gemini',
    mode: 'detail',
    resource: null,
  });
  const [oauthAddOpen, setOauthAddOpen] = useState(false);
  const [pluginOAuthChannels, setPluginOAuthChannels] = useState<string[]>([]);
  const sheetRef = useRef<ProviderSheetHandle>(null);

  const connected = connectionStatus === 'connected';
  const { usageByProvider, refreshRecentRequests } = useProviderRecentRequests({
    enabled: connected,
  });

  const activeCategory = getActiveCategory(uiState);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await pluginsApi.list();
        if (cancelled) return;
        const channels = response.plugins
          .filter((plugin) => plugin.supportsOAuth && plugin.effectiveEnabled && plugin.oauthProvider)
          .map((plugin) => String(plugin.oauthProvider));
        setPluginOAuthChannels(channels);
      } catch {
        if (!cancelled) setPluginOAuthChannels([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadAuthFiles = authFiles.loadFiles;
  const refetchProviders = workbench.refetch;
  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([
      refetchProviders(),
      loadAuthFiles(),
      refreshRecentRequests().catch(() => undefined),
    ]);
  }, [loadAuthFiles, refreshRecentRequests, refetchProviders]);

  useHeaderRefresh(handleRefresh, isCurrentLayer);

  const disableMutations =
    connectionStatus !== 'connected' ||
    workbench.mutating ||
    workbench.isFetching ||
    workbench.isError;

  const persistUiState = useCallback(
    (updater: (prev: ProvidersWorkbenchUiState) => ProvidersWorkbenchUiState) => {
      setUiState((prev) => {
        const next = updater(prev);
        writeProvidersWorkbenchUiState(next);
        return next;
      });
    },
    []
  );

  const setActiveCategory = useCallback(
    (category: ProviderCategoryId) => {
      persistUiState((prev) => {
        const key = toCategoryKey(category);
        if (prev.activeCategoryKey === key) return prev;
        return {
          ...prev,
          activeCategoryKey: key,
          activeBrand: category.method === 'apiKey' ? category.brand : prev.activeBrand,
        };
      });
      setOauthAddOpen(false);
    },
    [persistUiState]
  );

  const groups = useMemo(() => workbench.snapshot?.groups ?? [], [workbench.snapshot]);

  const oauthChannelList = useMemo(() => {
    const extras = new Set<string>(pluginOAuthChannels);
    authFiles.files.forEach((file) => {
      const channel = resolveAuthFileChannel(file);
      if (channel) extras.add(channel);
    });
    return buildOAuthChannelList(extras);
  }, [authFiles.files, pluginOAuthChannels]);

  const oauthCategoryItems = useMemo<OAuthCategoryItem[]>(() => {
    return oauthChannelList.map((channel) => {
      const channelFiles = authFiles.files.filter(
        (file) => resolveAuthFileChannel(file) === channel
      );
      const active = channelFiles.filter((file) => file.disabled !== true).length;
      return { channel, total: channelFiles.length, active };
    });
  }, [authFiles.files, oauthChannelList]);

  // Ensure active OAuth channel is still present; otherwise fall back.
  useEffect(() => {
    if (activeCategory.method !== 'oauth') return;
    if (oauthChannelList.includes(activeCategory.channel)) return;
    const fallback: ProviderCategoryId =
      groups[0] != null
        ? { method: 'apiKey', brand: groups[0].id }
        : { method: 'apiKey', brand: 'gemini' };
    setActiveCategory(fallback);
  }, [activeCategory, groups, oauthChannelList, setActiveCategory]);

  const activeFilterState = getCategoryFilterState(uiState, activeCategory);
  const filter = activeFilterState.filter;
  const providerSortBy = activeFilterState.sortBy;
  const providerSortDir = activeFilterState.sortDir;
  const activeGroup =
    activeCategory.method === 'apiKey'
      ? (groups.find((g) => g.id === activeCategory.brand) ?? groups[0] ?? null)
      : null;

  const updateActiveFilterState = useCallback(
    (patch: Partial<ProviderFilterState>) => {
      persistUiState((prev) => {
        const key = toCategoryKey(activeCategory);
        const current = getCategoryFilterState(prev, activeCategory);
        const nextFilter = { ...current, ...patch };
        const next: ProvidersWorkbenchUiState = {
          ...prev,
          filtersByCategory: {
            ...prev.filtersByCategory,
            [key]: nextFilter,
          },
        };
        if (activeCategory.method === 'apiKey') {
          next.filtersByBrand = {
            ...prev.filtersByBrand,
            [activeCategory.brand]: nextFilter,
          };
        }
        return next;
      });
    },
    [activeCategory, persistUiState]
  );

  const filteredResources = useMemo(() => {
    if (!activeGroup) return [];
    const normalized = filter.trim().toLowerCase();
    return activeGroup.resources.filter((r) => matchesFilter(r, normalized));
  }, [activeGroup, filter]);

  const availableModels = useMemo(() => {
    if (!activeGroup) return [];
    const seen = new Set<string>();
    activeGroup.resources.forEach((r) => {
      r.models.forEach((name) => seen.add(name));
    });
    return Array.from(seen).sort();
  }, [activeGroup]);

  const selectedModels = useMemo(() => {
    if (availableModels.length === 0) return new Set<string>();
    const availableModelSet = new Set(availableModels);
    return new Set(activeFilterState.selectedModels.filter((name) => availableModelSet.has(name)));
  }, [activeFilterState.selectedModels, availableModels]);

  const visibleResources = useMemo(() => {
    let arr = filteredResources;
    if (selectedModels.size > 0) {
      arr = arr.filter((r) => r.models.some((name) => selectedModels.has(name)));
    }

    const sorted = [...arr].sort((a, b) => {
      const sortDiff =
        providerSortBy === 'name'
          ? getResourceSortName(a).localeCompare(getResourceSortName(b))
          : providerSortBy === 'priority'
            ? a.priority - b.priority
            : getResourceRecentSuccess(a, usageByProvider) -
              getResourceRecentSuccess(b, usageByProvider);
      const diff = sortDiff || a.originalIndex - b.originalIndex;
      return providerSortDir === 'asc' ? diff : -diff;
    });

    return sorted;
  }, [filteredResources, providerSortBy, providerSortDir, selectedModels, usageByProvider]);

  const toolbarControls = useMemo<ProviderPanelControls | undefined>(() => {
    if (!activeGroup) return undefined;
    return {
      sortBy: providerSortBy,
      sortDir: providerSortDir,
      onSortBy: (value: ProviderSortBy) => updateActiveFilterState({ sortBy: value }),
      onSortDir: (value: SortDir) => updateActiveFilterState({ sortDir: value }),
      availableModels,
      selectedModels,
      onSelectedModelsChange: (next) =>
        updateActiveFilterState({
          selectedModels: Array.from(next).sort((a, b) => a.localeCompare(b)),
        }),
    };
  }, [
    activeGroup,
    availableModels,
    providerSortBy,
    providerSortDir,
    selectedModels,
    updateActiveFilterState,
  ]);

  const totalApiKeyResources = useMemo(
    () => groups.reduce((sum, g) => sum + g.resources.length, 0),
    [groups]
  );
  const totalApiKeyActive = useMemo(
    () => groups.reduce((sum, g) => sum + g.resources.filter((r) => !r.disabled).length, 0),
    [groups]
  );
  const totalOauthResources = authFiles.files.length;
  const totalOauthActive = authFiles.files.filter((f) => f.disabled !== true).length;
  const totalResources = totalApiKeyResources + totalOauthResources;
  const totalActive = totalApiKeyActive + totalOauthActive;
  const providerFamilies = useMemo(
    () =>
      groups.filter((g) => g.resources.length > 0).length +
      oauthCategoryItems.filter((c) => c.total > 0).length,
    [groups, oauthCategoryItems]
  );

  const updatedAtLabel = workbench.snapshot
    ? formatDateTime(workbench.snapshot.fetchedAt, i18n.language)
    : t('providersPage.modelCatalog.notLoaded');
  const errorBanner = workbench.errorMessage ? (
    <div className="error-box">{workbench.errorMessage}</div>
  ) : null;

  const openCreate = useCallback(() => {
    if (activeCategory.method === 'oauth') {
      setOauthAddOpen(true);
      return;
    }
    const brand = activeCategory.brand;
    setSheetState({ open: true, brand, mode: 'create', resource: null });
  }, [activeCategory]);

  const openView = useCallback((resource: ProviderResource) => {
    setSheetState({
      open: true,
      brand: resource.brand,
      mode: 'detail',
      resource,
    });
  }, []);

  const openEdit = useCallback((resource: ProviderResource) => {
    setSheetState({
      open: true,
      brand: resource.brand,
      mode: 'edit',
      resource,
    });
  }, []);

  const closeSheet = useCallback(() => {
    setSheetState((s) => ({ ...s, open: false }));
  }, []);

  const handleDelete = useCallback(
    (resource: ProviderResource) => {
      const name = resource.name ?? resource.apiKeyPreview ?? resource.identifier ?? '';
      showConfirmation({
        title: t('providersPage.delete.title'),
        message: t('providersPage.delete.confirm', { name }),
        variant: 'danger',
        confirmText: t('providersPage.actions.delete'),
        onConfirm: async () => {
          try {
            await workbench.deleteProvider(resource);
            showNotification(t('providersPage.toast.deleted'), 'success');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showNotification(`${t('notification.delete_failed')}: ${msg}`, 'error');
          }
        },
      });
    },
    [showConfirmation, showNotification, t, workbench]
  );

  const handleToggleDisabled = useCallback(
    async (resource: ProviderResource, disabled: boolean) => {
      try {
        await workbench.toggleDisabled(resource, disabled);
        showNotification(
          disabled ? t('providersPage.toast.disabled') : t('providersPage.toast.enabled'),
          'success'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showNotification(`${t('providersPage.toast.toggleFailed')}: ${msg}`, 'error');
      }
    },
    [showNotification, t, workbench]
  );

  const handleCreated = useCallback(() => {
    showNotification(t('providersPage.toast.created'), 'success');
    closeSheet();
  }, [closeSheet, showNotification, t]);

  const handleUpdated = useCallback(() => {
    showNotification(t('providersPage.toast.updated'), 'success');
    closeSheet();
  }, [closeSheet, showNotification, t]);

  const handleSelectCategory = useCallback(
    (category: ProviderCategoryId) => {
      const isSwitching =
        sheetState.open &&
        (activeCategory.method !== category.method ||
          (category.method === 'apiKey' &&
            activeCategory.method === 'apiKey' &&
            sheetState.brand !== category.brand));
      const proceed =
        isSwitching && sheetRef.current
          ? sheetRef.current.confirmDiscardIfDirty()
          : Promise.resolve(true);
      void proceed.then((ok) => {
        if (!ok) return;
        setActiveCategory(category);
        if (isSwitching) closeSheet();
      });
    },
    [activeCategory, closeSheet, setActiveCategory, sheetState.brand, sheetState.open]
  );

  const oauthAddTitle =
    activeCategory.method === 'oauth' ? getTypeLabel(t, activeCategory.channel) : '';
  const oauthLoginMode =
    activeCategory.method === 'oauth'
      ? getOAuthChannelDescriptor(activeCategory.channel).loginMode
      : 'oauth';

  // 加载状态
  if (!workbench.snapshot && workbench.isPending) {
    return (
      <div className={styles.page}>
        <Skeleton height={120} />
        <div className={styles.layout}>
          <Skeleton height={110} />
          <Skeleton height={420} />
        </div>
      </div>
    );
  }

  const newLabel =
    activeCategory.method === 'oauth'
      ? t('providersPage.oauth.addCredential', { defaultValue: 'Add credential' })
      : t('providersPage.actions.new');

  return (
    <div className={styles.page}>
      <ProviderHeaderCard
        totalActive={totalActive}
        totalResources={totalResources}
        providerFamilies={providerFamilies}
        updatedAtLabel={updatedAtLabel}
        isFetching={workbench.isFetching || authFiles.loading}
        isNewDisabled={disableMutations && activeCategory.method === 'apiKey'}
        newLabel={newLabel}
        onRefresh={() => void handleRefresh()}
        onNew={openCreate}
      />

      {errorBanner}

      <div className={styles.layout}>
        <ProviderCategoryList
          apiKeyGroups={groups}
          oauthChannels={oauthCategoryItems}
          activeCategory={activeCategory}
          onSelect={handleSelectCategory}
        />

        {activeCategory.method === 'apiKey' && activeGroup ? (
          <ProviderResourcePanel
            group={activeGroup}
            filter={filter}
            onFilterChange={(value) => updateActiveFilterState({ filter: value })}
            filteredResources={visibleResources}
            selectedId={sheetState.open ? (sheetState.resource?.id ?? null) : null}
            disableMutations={disableMutations}
            usageByProvider={usageByProvider}
            toolbarControls={toolbarControls}
            onView={openView}
            onEdit={openEdit}
            onDelete={handleDelete}
            onToggleDisabled={handleToggleDisabled}
            onCreate={openCreate}
          />
        ) : activeCategory.method === 'oauth' ? (
          <OAuthAuthFilesPanel
            channel={activeCategory.channel}
            disableControls={connectionStatus !== 'connected'}
            authFiles={authFiles}
          />
        ) : null}
      </div>

      <ProviderSheet
        ref={sheetRef}
        state={sheetState}
        onClose={closeSheet}
        onSwitchToEdit={() => {
          setSheetState((s) => (s.resource ? { ...s, mode: 'edit' } : s));
        }}
        workbench={workbench}
        onCreated={handleCreated}
        onUpdated={handleUpdated}
        mutationDisabled={disableMutations}
        usageByProvider={usageByProvider}
      />

      <Sheet
        open={oauthAddOpen && activeCategory.method === 'oauth'}
        onClose={() => setOauthAddOpen(false)}
        size="md"
        eyebrow={t('providersPage.authGroups.oauth')}
        title={oauthAddTitle}
        description={
          oauthLoginMode === 'upload-only'
            ? t('providersPage.oauth.uploadOnlyHint', {
                defaultValue: 'This channel only supports uploading credential JSON files.',
              })
            : oauthLoginMode === 'vertex-import'
              ? t('vertex_import.description')
              : t('providersPage.oauth.loginDescription', {
                  defaultValue: 'Start OAuth login or paste the callback URL after authorization.',
                })
        }
      >
        {activeCategory.method === 'oauth' ? (
          <>
            <OAuthLoginPanel
              channel={activeCategory.channel}
              onSuccess={() => {
                void authFiles.loadFiles();
              }}
            />
            {oauthLoginMode === 'upload-only' || oauthLoginMode === 'oauth' ? (
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className={styles.emptyActionButton ?? undefined}
                  onClick={() => {
                    setOauthAddOpen(false);
                    authFiles.handleUploadClick();
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {t('auth_files.upload_button', { defaultValue: 'Upload credential file' })}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </Sheet>
    </div>
  );
}
