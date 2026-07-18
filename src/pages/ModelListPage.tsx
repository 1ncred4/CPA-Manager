import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore, useModelsStore, useNotificationStore, useThemeStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import { classifyModels } from '@/utils/models';
import { resolveModelCategoryIcon } from '@/utils/modelCategoryIcons';
import styles from './ModelListPage.module.scss';

export function ModelListPage() {
  const { t, i18n } = useTranslation();
  const { showNotification } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const auth = useAuthStore();
  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const modelsError = useModelsStore((state) => state.error);
  const fetchModelsFromStore = useModelsStore((state) => state.fetchModels);

  const [modelStatus, setModelStatus] = useState<{
    type: 'success' | 'warning' | 'error' | 'muted';
    message: string;
  }>();

  const otherLabel = useMemo(
    () => (i18n.language?.toLowerCase().startsWith('zh') ? '其他' : 'Other'),
    [i18n.language]
  );
  const groupedModels = useMemo(() => classifyModels(models, { otherLabel }), [models, otherLabel]);
  const resolveApiKeysForModels = useApiKeysForModels();

  const fetchModels = async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
    if (auth.connectionStatus !== 'connected') {
      setModelStatus({
        type: 'warning',
        message: t('notification.connection_required'),
      });
      return;
    }

    if (!auth.apiBase) {
      showNotification(t('notification.connection_required'), 'warning');
      return;
    }

    setModelStatus({ type: 'muted', message: t('system_info.models_loading') });
    try {
      const apiKeys = await resolveApiKeysForModels({ force: forceRefresh });
      const primaryKey = apiKeys[0];
      const list = await fetchModelsFromStore(auth.apiBase, primaryKey, forceRefresh);
      const hasModels = list.length > 0;
      setModelStatus({
        type: hasModels ? 'success' : 'warning',
        message: hasModels
          ? t('system_info.models_count', { count: list.length })
          : t('system_info.models_empty'),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      const suffix = message ? `: ${message}` : '';
      setModelStatus({ type: 'error', message: `${t('system_info.models_error')}${suffix}` });
    }
  };

  useEffect(() => {
    void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.connectionStatus, auth.apiBase]);

  return (
    <div className={styles.container}>
      <h1 className={styles.pageTitle}>{t('nav.model_list')}</h1>
      <Card
        title={t('system_info.models_title')}
        extra={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchModels({ forceRefresh: true })}
            loading={modelsLoading}
          >
            {t('common.refresh')}
          </Button>
        }
      >
        <p className={styles.sectionDescription}>{t('system_info.models_desc')}</p>
        {modelStatus && <div className={`status-badge ${modelStatus.type}`}>{modelStatus.message}</div>}
        {modelsError && <div className="error-box">{modelsError}</div>}
        {modelsLoading ? (
          <div className="hint">{t('common.loading')}</div>
        ) : models.length === 0 ? (
          <div className="hint">{t('system_info.models_empty')}</div>
        ) : (
          <div className="item-list">
            {groupedModels.map((group) => {
              const iconSrc = resolveModelCategoryIcon(group.id, resolvedTheme);
              return (
                <div key={group.id} className="item-row">
                  <div className="item-meta">
                    <div className={styles.groupTitle}>
                      {iconSrc ? <img src={iconSrc} alt="" className={styles.groupIcon} /> : null}
                      <span className="item-title">{group.label}</span>
                    </div>
                    <div className="item-subtitle">
                      {t('system_info.models_count', { count: group.items.length })}
                    </div>
                  </div>
                  <div className={styles.modelTags}>
                    {group.items.map((model) => (
                      <span
                        key={`${model.name}-${model.alias ?? 'default'}`}
                        className={styles.modelTag}
                        title={model.description || ''}
                      >
                        <span className={styles.modelName}>{model.name}</span>
                        {model.alias ? <span className={styles.modelAlias}>{model.alias}</span> : null}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
