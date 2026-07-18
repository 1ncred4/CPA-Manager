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
    // Catalog editor shows unique model names only; aliases are owned by the Mapping page.
    const uniqueNames = (list: ModelAlias[] | undefined): string => {
      const seen = new Set<string>();
      const names: string[] = [];
      (list ?? []).forEach((m) => {
        const name = String(m?.name ?? '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        names.push(name);
      });
      return names.join('\n');
    };
    if (resource.brand === 'openaiCompatibility') {
      const cfg = resource.raw as OpenAIProviderConfig;
      const models = uniqueNames(cfg.models);
      setModelsText(models);
      setExcludedText('');
      setBaseline({ models, excluded: '' });
      return;
    }
    const cfg = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
    const models = uniqueNames(cfg.models);
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

  /** Unique model names from the textarea (ignore legacy name=alias lines). */
  const parseCatalogNames = (text: string): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        // Back-compat: if user pastes name=alias, only take the name side.
        const eq = line.indexOf('=');
        const name = (eq === -1 ? line : line.slice(0, eq)).trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        names.push(name);
      });
    return names;
  };

  /**
   * Merge catalog names with existing multi-alias mappings so this page cannot
   * clobber channels created on the Model Mapping page.
   */
  const mergeCatalogWithExistingAliases = (
    catalogNames: string[],
    existing: ModelAlias[] | undefined
  ): ModelAlias[] => {
    const lower = (v: string) => v.trim().toLowerCase();
    const existingByName = new Map<string, ModelAlias[]>();
    (existing ?? []).forEach((entry) => {
      const name = String(entry?.name ?? '').trim();
      if (!name) return;
      const key = lower(name);
      const list = existingByName.get(key) ?? [];
      list.push(entry);
      existingByName.set(key, list);
    });

    const result: ModelAlias[] = [];
    catalogNames.forEach((name) => {
      const key = lower(name);
      const prevList = existingByName.get(key) ?? [];
      const withAlias = prevList.filter((e) => {
        const alias = String(e.alias ?? '').trim();
        return alias && lower(alias) !== key;
      });
      if (withAlias.length) {
        withAlias.forEach((prev) => {
          result.push({ ...prev, name });
        });
        return;
      }
      const bare = prevList[0];
      if (bare) {
        const next: ModelAlias = { ...bare, name };
        delete (next as { alias?: string }).alias;
        result.push(next);
      } else {
        result.push({ name });
      }
    });
    return result;
  };

  const parseExcluded = (text: string): string[] =>
    text
      .split(/[\n,]+/)
      .map((v) => v.trim())
      .filter((v) => v && v !== '*');

  const handleSave = async () => {
    if (!resource) return;
    setSaving(true);
    try {
      const catalogNames = parseCatalogNames(modelsText);
      if (resource.brand === 'openaiCompatibility') {
        const cfg = resource.raw as OpenAIProviderConfig;
        const selector = resource.selector;
        if (selector.brand !== 'openaiCompatibility') throw new Error('Invalid selector');
        const name = selector.name || cfg.name || '';
        const models = mergeCatalogWithExistingAliases(catalogNames, cfg.models);
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
        const models = mergeCatalogWithExistingAliases(catalogNames, cfg.models);
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
      : t('modelsPage.editCatalogTitle', { defaultValue: '编辑模型列表' });

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
                  {t('modelsPage.catalogEditorLabel', {
                    defaultValue: '模型列表（每行一个模型 ID；别名请在「模型映射」中管理）',
                  })}
                </div>
                <div className={styles.settingsHeaderHint}>
                  {t('modelsPage.catalogEditorHint', {
                    defaultValue: '此处只维护去重后的模型目录，保存时会保留映射页写入的手动渠道别名。',
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
                spellCheck={false}
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
