/**
 * 模型管理：统一 OAuth 渠道 + API Key 条目的禁用与映射
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { useAuthStore } from '@/stores';
import type { ProviderResource } from '@/features/providers/types';
import { ModelAccessList } from './ModelAccessList';
import { useModelAccessList } from './useModelAccessList';
import styles from './ModelsPage.module.scss';

type ModelsTab = 'disabled' | 'mapping';

const isModelsTab = (value: string | null): value is ModelsTab =>
  value === 'disabled' || value === 'mapping';

export function ModelsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const tabParam = searchParams.get('tab');
  const [tab, setTabState] = useState<ModelsTab>(() =>
    isModelsTab(tabParam) ? tabParam : 'disabled'
  );
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');

  // Keep local tab in sync when the URL is updated externally (redirects / deep links).
  useEffect(() => {
    if (isModelsTab(tabParam) && tabParam !== tab) {
      setTabState(tabParam);
    }
  }, [tab, tabParam]);

  const authFiles = useAuthFilesData();
  const oauth = useAuthFilesOauth({ viewMode, files: authFiles.files });
  const workbench = useProviderWorkbench();
  const modelAccess = useModelAccessList();

  const disableControls = connectionStatus !== 'connected';

  const loadAuthFiles = authFiles.loadFiles;
  const loadExcluded = oauth.loadExcluded;
  const loadModelAlias = oauth.loadModelAlias;
  const refetchProviders = workbench.refetch;
  const refreshModelAccess = modelAccess.refresh;

  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([
      loadAuthFiles(),
      loadExcluded(),
      loadModelAlias(),
      refetchProviders(),
      refreshModelAccess(),
    ]);
  }, [loadAuthFiles, loadExcluded, loadModelAlias, refetchProviders, refreshModelAccess]);

  useHeaderRefresh(handleRefresh, isCurrentLayer);

  useEffect(() => {
    void loadModelAlias();
  }, [loadModelAlias]);

  const setTab = (next: ModelsTab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const openAliasEditor = useCallback(
    (provider?: string) => {
      const params = new URLSearchParams();
      if (provider) params.set('provider', provider);
      const qs = params.toString();
      navigate(`/models/mapping${qs ? `?${qs}` : ''}`, { state: { fromModels: true } });
    },
    [navigate]
  );

  const allApiKeyResources = useMemo(() => {
    const groups = workbench.snapshot?.groups ?? [];
    return groups.flatMap((group) => group.resources);
  }, [workbench.snapshot]);

  const openApiKeyModelsEditor = useCallback(
    (resource: ProviderResource) => {
      navigate(
        `/models/api-key?brand=${encodeURIComponent(resource.brand)}&id=${encodeURIComponent(resource.id)}&focus=models`,
        { state: { fromModels: true } }
      );
    },
    [navigate]
  );

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('modelsPage.title', { defaultValue: '模型管理' })}</h1>
          <p className={styles.subtitle}>
            {t('modelsPage.subtitle', {
              defaultValue: '统一管理所有提供商的模型启用状态与模型映射。',
            })}
          </p>
        </div>
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'disabled'}
            className={`${styles.tab} ${tab === 'disabled' ? styles.tabActive : ''}`}
            onClick={() => setTab('disabled')}
          >
            {t('modelsPage.tabs.disabled', { defaultValue: '模型禁用' })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mapping'}
            className={`${styles.tab} ${tab === 'mapping' ? styles.tabActive : ''}`}
            onClick={() => setTab('mapping')}
          >
            {t('modelsPage.tabs.mapping', { defaultValue: '模型映射' })}
          </button>
        </div>
      </div>

      {tab === 'disabled' ? (
        <div className={styles.stack}>
          <ModelAccessList list={modelAccess} />
        </div>
      ) : (
        <div className={styles.stack}>
          <OAuthModelAliasCard
            disableControls={disableControls}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onRetry={oauth.loadModelAlias}
            onAdd={() => openAliasEditor()}
            onEditProvider={openAliasEditor}
            onDeleteProvider={oauth.deleteModelAlias}
            modelAliasError={oauth.modelAliasError}
            modelAlias={oauth.modelAlias}
            allProviderModels={oauth.allProviderModels}
            onUpdate={oauth.handleMappingUpdate}
            onDeleteLink={oauth.handleDeleteLink}
            onToggleFork={oauth.handleToggleFork}
            onRenameAlias={oauth.handleRenameAlias}
            onDeleteAlias={oauth.handleDeleteAlias}
          />

          <Card
            title={t('modelsPage.apiKeyMappingTitle', {
              defaultValue: 'API Key 提供商 · 模型映射',
            })}
          >
            {allApiKeyResources.length === 0 ? (
              <EmptyState
                title={t('modelsPage.noApiKeyResources', {
                  defaultValue: '暂无 API Key 提供商条目',
                })}
              />
            ) : (
              <div className={styles.resourceList}>
                {allApiKeyResources.map((resource) => {
                  const logo = PROVIDER_LOGOS[resource.brand];
                  return (
                    <div key={resource.id} className={styles.resourceRow}>
                      <div className={styles.resourceInfo}>
                        {logo ? (
                          <img src={logo.src} alt="" className={styles.resourceLogo} />
                        ) : null}
                        <div>
                          <div className={styles.resourceName}>
                            {t(`providersPage.providerNames.${resource.brand}`)} ·{' '}
                            {resource.name ?? resource.identifier}
                          </div>
                          <div className={styles.resourceMeta}>
                            {t('modelsPage.mappingCount', {
                              defaultValue: '{{count}} 个模型',
                              count: resource.modelCount,
                            })}
                          </div>
                        </div>
                      </div>
                      <div className={styles.resourceActions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={disableControls}
                          onClick={() => openApiKeyModelsEditor(resource)}
                        >
                          {t('common.edit')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
