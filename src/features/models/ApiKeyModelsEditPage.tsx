/**
 * 编辑单个 API Key 条目的 models / excluded-models
 * 保存时保留 `*` 整条目禁用语义
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SecondaryScreenShell } from '@/components/common/SecondaryScreenShell';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useAuthStore, useNotificationStore } from '@/stores';
import { providersApi } from '@/services/api';
import {
  hasDisableAllModelsRule,
  stripDisableAllModelsRule,
  withDisableAllModelsRule,
} from '@/components/providers/utils';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import type { GeminiKeyConfig, ModelAlias, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { ProviderResource } from '@/features/providers/types';
import { getErrorMessage } from '@/utils/helpers';
import styles from './ModelExcludedEdit.module.scss';

type LocationState = { fromModels?: boolean } | null;

export function ApiKeyModelsEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const disableControls = connectionStatus !== 'connected';
  const workbench = useProviderWorkbench();

  const brand = searchParams.get('brand') ?? '';
  const resourceId = searchParams.get('id') ?? '';
  const focus = searchParams.get('focus') ?? 'models';

  const resource = useMemo<ProviderResource | null>(() => {
    const groups = workbench.snapshot?.groups ?? [];
    for (const group of groups) {
      const found = group.resources.find((r) => r.id === resourceId);
      if (found) return found;
    }
    return null;
  }, [resourceId, workbench.snapshot]);

  const [modelsText, setModelsText] = useState('');
  const [excludedText, setExcludedText] = useState('');
  const [baseline, setBaseline] = useState({ models: '', excluded: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!resource) return;
    if (resource.brand === 'openaiCompatibility') {
      const cfg = resource.raw as OpenAIProviderConfig;
      const models = (cfg.models ?? [])
        .map((m) => (m.alias ? `${m.name}=${m.alias}` : m.name))
        .join('\n');
      setModelsText(models);
      setExcludedText('');
      setBaseline({ models, excluded: '' });
      return;
    }
    const cfg = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
    const models = (cfg.models ?? [])
      .map((m) => (m.alias ? `${m.name}=${m.alias}` : m.name))
      .join('\n');
    const excluded = stripDisableAllModelsRule(cfg.excludedModels).join('\n');
    setModelsText(models);
    setExcludedText(excluded);
    setBaseline({ models, excluded });
  }, [resource]);

  const isDirty = modelsText !== baseline.models || excludedText !== baseline.excluded;
  const unsavedChangesDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
    }),
    [t]
  );
  const { allowNextNavigation } = useUnsavedChangesGuard({
    shouldBlock: isDirty,
    dialog: unsavedChangesDialog,
  });

  const handleBack = useCallback(() => {
    const state = location.state as LocationState;
    if (state?.fromModels) {
      navigate(-1);
      return;
    }
    navigate(focus === 'excluded' ? '/models?tab=disabled' : '/models?tab=mapping', {
      replace: true,
    });
  }, [focus, location.state, navigate]);

  const swipeRef = useEdgeSwipeBack({ onBack: handleBack });

  const parseModels = (text: string): ModelAlias[] =>
    text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        if (eq === -1) return { name: line };
        const name = line.slice(0, eq).trim();
        const alias = line.slice(eq + 1).trim();
        return alias ? { name, alias } : { name };
      })
      .filter((m) => m.name);

  const parseExcluded = (text: string): string[] =>
    text
      .split(/[\n,]+/)
      .map((v) => v.trim())
      .filter((v) => v && v !== '*');

  const handleSave = async () => {
    if (!resource) return;
    setSaving(true);
    try {
      const models = parseModels(modelsText);
      if (resource.brand === 'openaiCompatibility') {
        const cfg = resource.raw as OpenAIProviderConfig;
        const selector = resource.selector;
        if (selector.brand !== 'openaiCompatibility') throw new Error('Invalid selector');
        const name = selector.name || cfg.name || '';
        await providersApi.updateOpenAIProvider(name, selector.index, {
          ...cfg,
          models,
        });
      } else {
        const cfg = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
        const disabled = hasDisableAllModelsRule(cfg.excludedModels);
        const excludedList = parseExcluded(excludedText);
        const excludedModels = disabled
          ? withDisableAllModelsRule(excludedList)
          : excludedList.length
            ? excludedList
            : undefined;
        const next = { ...cfg, models, excludedModels };
        const selector = resource.selector;
        if (selector.brand === 'gemini') {
          await providersApi.updateGeminiKey(
            selector.apiKey,
            selector.baseUrl,
            next as GeminiKeyConfig
          );
        } else if (selector.brand === 'codex') {
          await providersApi.updateCodexConfig(
            selector.apiKey,
            selector.baseUrl,
            next as ProviderKeyConfig
          );
        } else if (selector.brand === 'xai') {
          await providersApi.updateXAIConfig(
            selector.apiKey,
            selector.baseUrl,
            next as ProviderKeyConfig
          );
        } else if (selector.brand === 'claude') {
          await providersApi.updateClaudeConfig(
            selector.apiKey,
            selector.baseUrl,
            next as ProviderKeyConfig
          );
        } else if (selector.brand === 'vertex') {
          await providersApi.updateVertexConfig(
            selector.apiKey,
            selector.baseUrl,
            next as ProviderKeyConfig
          );
        }
      }
      showNotification(t('modelsPage.saved', { defaultValue: 'Saved' }), 'success');
      allowNextNavigation();
      await workbench.refetch();
      handleBack();
    } catch (err) {
      showNotification(
        `${t('notification.save_failed', { defaultValue: 'Save failed' })}: ${getErrorMessage(err)}`,
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const title =
    focus === 'excluded'
      ? t('modelsPage.editExcludedTitle', { defaultValue: '编辑排除模型' })
      : t('modelsPage.editMappingTitle', { defaultValue: '编辑模型映射' });

  return (
    <SecondaryScreenShell
      ref={swipeRef}
      title={title}
      onBack={handleBack}
      backLabel={t('common.back')}
      backAriaLabel={t('common.back')}
      contentClassName={styles.pageContent}
      rightAction={
        <Button size="sm" onClick={() => void handleSave()} loading={saving} disabled={disableControls || !resource}>
          {t('common.save')}
        </Button>
      }
      isLoading={!workbench.snapshot && workbench.isPending}
      loadingLabel={t('common.loading')}
    >
      {!resource ? (
        <Card>
          <EmptyState
            title={t('modelsPage.resourceNotFound', { defaultValue: '未找到该提供商条目' })}
            description={`${brand} / ${resourceId}`}
          />
        </Card>
      ) : (
        <>
          <Card className={styles.settingsCard}>
            <div className={styles.settingsHeader}>
              <div className={styles.settingsHeaderTitle}>
                {resource.name ?? resource.identifier}
              </div>
              <div className={styles.settingsHeaderHint}>
                {t(`providersPage.providerNames.${resource.brand}`)}
              </div>
            </div>
          </Card>

          {(focus === 'models' || focus === 'both') && (
            <Card className={styles.settingsCard}>
              <div className={styles.settingsHeader}>
                <div className={styles.settingsHeaderTitle}>
                  {t('modelsPage.mappingEditorLabel', {
                    defaultValue: '模型映射（每行一个：name 或 name=alias）',
                  })}
                </div>
              </div>
              <textarea
                className="input"
                rows={10}
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                disabled={disableControls || saving}
                style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Card>
          )}

          {focus === 'excluded' && resource.brand !== 'openaiCompatibility' && (
            <Card className={styles.settingsCard}>
              <div className={styles.settingsHeader}>
                <div className={styles.settingsHeaderTitle}>
                  {t('modelsPage.excludedEditorLabel', {
                    defaultValue: '排除模型（每行一条，支持 * 通配；整条目禁用由提供商启停控制）',
                  })}
                </div>
              </div>
              <textarea
                className="input"
                rows={8}
                value={excludedText}
                onChange={(e) => setExcludedText(e.target.value)}
                disabled={disableControls || saving}
                style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Card>
          )}
        </>
      )}
    </SecondaryScreenShell>
  );
}
