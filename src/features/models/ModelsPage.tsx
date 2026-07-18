/**
 * 模型管理：模型禁用 + 联邦模型映射
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { ModelAccessList } from './ModelAccessList';
import { useModelAccessList } from './useModelAccessList';
import { ModelMappingList } from './ModelMappingList';
import { useModelMappingList } from './useModelMappingList';
import styles from './ModelsPage.module.scss';

type ModelsTab = 'disabled' | 'mapping';

const isModelsTab = (value: string | null): value is ModelsTab =>
  value === 'disabled' || value === 'mapping';

export function ModelsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.isCurrentLayer : true;
  const wasCurrentLayerRef = useRef(isCurrentLayer);

  const tabParam = searchParams.get('tab');
  const [tab, setTabState] = useState<ModelsTab>(() =>
    isModelsTab(tabParam) ? tabParam : 'mapping'
  );

  useEffect(() => {
    if (isModelsTab(tabParam) && tabParam !== tab) {
      setTabState(tabParam);
    }
  }, [tab, tabParam]);

  const modelAccess = useModelAccessList();
  const modelMapping = useModelMappingList();

  const refreshModelAccess = modelAccess.refresh;
  const refreshModelMapping = modelMapping.refresh;

  const handleRefresh = useCallback(async () => {
    await Promise.allSettled([refreshModelAccess(), refreshModelMapping()]);
  }, [refreshModelAccess, refreshModelMapping]);

  useHeaderRefresh(handleRefresh, isCurrentLayer);

  // PageTransition keeps ModelsPage mounted under the edit layer. Refresh when
  // this layer becomes current again so create/edit results show without a hard reload.
  useEffect(() => {
    const wasCurrent = wasCurrentLayerRef.current;
    wasCurrentLayerRef.current = isCurrentLayer;
    if (!wasCurrent && isCurrentLayer) {
      void handleRefresh();
    }
  }, [handleRefresh, isCurrentLayer]);

  const setTab = (next: ModelsTab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <h1 className={styles.title}>{t('modelsPage.title', { defaultValue: '模型管理' })}</h1>
          <p className={styles.subtitle}>
            {t('modelsPage.subtitle', {
              defaultValue: '统一管理所有提供商的模型启用状态与模型映射。',
            })}
          </p>
        </div>
        <div className={styles.toolbar}>
          <div className={styles.tabs} role="tablist">
            <Button
              type="button"
              role="tab"
              aria-selected={tab === 'mapping'}
              variant="secondary"
              size="sm"
              className={`${styles.tab} ${tab === 'mapping' ? styles.tabActive : ''}`}
              onClick={() => setTab('mapping')}
            >
              {t('modelsPage.tabs.mapping', { defaultValue: '模型映射' })}
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={tab === 'disabled'}
              variant="secondary"
              size="sm"
              className={`${styles.tab} ${tab === 'disabled' ? styles.tabActive : ''}`}
              onClick={() => setTab('disabled')}
            >
              {t('modelsPage.tabs.disabled', { defaultValue: '模型禁用' })}
            </Button>
          </div>
        </div>
      </div>

      {tab === 'mapping' ? (
        <div className={styles.stack}>
          <ModelMappingList list={modelMapping} />
        </div>
      ) : (
        <div className={styles.stack}>
          <ModelAccessList list={modelAccess} />
        </div>
      )}
    </div>
  );
}
