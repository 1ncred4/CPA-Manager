/**
 * 联邦模型映射编辑：自定义名 → 多目标（OAuth + API Key）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconInfo, IconX } from '@/components/ui/icons';
import { SecondaryScreenShell } from '@/components/common/SecondaryScreenShell';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import { authFilesApi } from '@/services/api';
import {
  getAuthFileIcon,
  getTypeLabel,
  type AuthFileModelItem,
} from '@/features/authFiles/constants';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import type { ProviderResource } from '@/features/providers/types';
import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import { getErrorMessage } from '@/utils/helpers';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  collectOAuthChannels,
  type ModelAccessRow,
} from './modelAccessRows';
import {
  claimManualMapping,
  listManualMappingClaims,
  unclaimManualMapping,
} from './mappingClaims';
import {
  applyApiKeyModelAliasChanges,
  applyOauthAliasTargetChanges,
  assembleManualAndAutoMappingRows,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  buildOauthDisplayNameMap,
  collectChannelsForAlias,
  collectConfiguredApiKeyResourceIdsForAlias,
  collectConfiguredOauthChannelsForAlias,
  filterPersistableMappingTargets,
  getMappingDraftSignature,
  mappingTargetKey,
  planAliasTargetAssignments,
  toAliasKey,
  validateMappingSelection,
  type MappingPickerOption,
  type MappingTargetRef,
  type MappingValidationError,
} from './modelMapping';
import { updateApiKeyModels } from './updateApiKeyModels';
import styles from './ModelAliasEdit.module.scss';

type LocationState = { fromModels?: boolean } | null;

export function ModelAliasEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const apiBase = useAuthStore((s) => s.apiBase);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const workbench = useProviderWorkbench();
  const disableControls = connectionStatus !== 'connected';

  const aliasFromParams = (searchParams.get('alias') ?? '').trim();
  const preselectFromParams = (searchParams.get('preselect') ?? '').trim();
  const isEditing = Boolean(aliasFromParams);

  const [initialLoading, setInitialLoading] = useState(true);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [oauthUnsupported, setOauthUnsupported] = useState(false);
  const [modelAlias, setModelAlias] = useState<Record<string, OAuthModelAliasEntry[]>>({});
  const [resources, setResources] = useState<ProviderResource[]>([]);
  const [enabledOptions, setEnabledOptions] = useState<MappingPickerOption[]>([]);
  const [existingAliasKeys, setExistingAliasKeys] = useState<string[]>([]);
  const [baselineAlias, setBaselineAlias] = useState(aliasFromParams);
  const [baselineTargets, setBaselineTargets] = useState<MappingTargetRef[]>([]);

  const [alias, setAlias] = useState(aliasFromParams);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [pickerSearch, setPickerSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const loadRequestRef = useRef(0);
  const workbenchRef = useRef(workbench);
  useEffect(() => {
    workbenchRef.current = workbench;
  }, [workbench]);

  const optionByKey = useMemo(() => {
    const map = new Map<string, MappingPickerOption>();
    enabledOptions.forEach((opt) => map.set(mappingTargetKey(opt), opt));
    return map;
  }, [enabledOptions]);

  const selectedTargets: MappingTargetRef[] = useMemo(() => {
    const result: MappingTargetRef[] = [];
    selectedKeys.forEach((key) => {
      const opt = optionByKey.get(key);
      if (opt) {
        result.push(
          opt.source === 'oauth'
            ? { source: 'oauth', channel: opt.channel, modelId: opt.modelId }
            : {
                source: 'apiKey',
                resourceId: opt.resourceId,
                brand: opt.brand,
                modelId: opt.modelId,
              }
        );
        return;
      }
      // Keep baseline targets that are no longer in enabled options (disabled but still mapped)
      const baseline = baselineTargets.find((t) => mappingTargetKey(t) === key);
      if (baseline) result.push(baseline);
    });
    return result;
  }, [baselineTargets, optionByKey, selectedKeys]);

  const baselineSignature = useMemo(
    () => getMappingDraftSignature(baselineAlias, baselineTargets),
    [baselineAlias, baselineTargets]
  );
  const currentSignature = useMemo(
    () => getMappingDraftSignature(alias, selectedTargets),
    [alias, selectedTargets]
  );
  const isDirty = baselineSignature !== currentSignature;

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
    navigate('/models?tab=mapping', { replace: true });
  }, [location.state, navigate]);

  const swipeRef = useEdgeSwipeBack({ onBack: handleBack });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBack]);

  const loadInitialData = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setInitialLoading(true);
    setInitialLoadError(null);
    setOauthUnsupported(false);

    try {
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

      let nextAlias: Record<string, OAuthModelAliasEntry[]> = {};
      if (aliasResult.status === 'fulfilled') {
        nextAlias = aliasResult.value ?? {};
      } else {
        const status =
          typeof aliasResult.reason === 'object' &&
          aliasResult.reason !== null &&
          'status' in aliasResult.reason
            ? (aliasResult.reason as { status?: unknown }).status
            : undefined;
        if (status === 404) {
          setOauthUnsupported(true);
        } else {
          throw aliasResult.reason;
        }
      }
      setModelAlias(nextAlias);

      let nextExcluded: Record<string, string[]> = {};
      if (excludedResult.status === 'fulfilled') {
        nextExcluded = excludedResult.value ?? {};
      }

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

      const oauthModels: Record<string, AuthFileModelItem[]> = {};
      definitionResults.forEach(({ channel, models }) => {
        if (models.length > 0) oauthModels[channel] = models;
      });

      const nextResources =
        workbenchRef.current.snapshot?.groups.flatMap((g) => g.resources) ?? [];
      setResources(nextResources);

      const accessRows: ModelAccessRow[] = [];
      Object.entries(oauthModels).forEach(([channel, models]) => {
        accessRows.push(
          ...buildOAuthAccessRows({
            channel,
            models,
            excluded: nextExcluded,
            providerLabel: getTypeLabel(t, channel),
            iconSrc: getAuthFileIcon(channel, resolvedTheme),
          })
        );
      });
      nextResources.forEach((resource) => {
        const logo = PROVIDER_LOGOS[resource.brand];
        const iconSrc =
          resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
        const brandLabel = t(`providersPage.providerNames.${resource.brand}`, {
          defaultValue: resource.brand,
        });
        const entryLabel = resource.name ?? resource.identifier;
        const providerLabel = entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel;
        accessRows.push(...buildApiKeyAccessRows({ resource, providerLabel, iconSrc }));
      });

      const options = buildEnabledMappingOptions(accessRows);
      setEnabledOptions(options);

      const enabledKeySet = new Set(accessRows.filter((r) => r.enabled).map((r) => r.key));
      const configured = buildFederatedMappingRows({
        modelAlias: nextAlias,
        resources: nextResources,
        oauthDisplayNames: buildOauthDisplayNameMap(oauthModels),
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
      });
      const { manualRows, autoRows } = assembleManualAndAutoMappingRows(
        configured,
        accessRows,
        listManualMappingClaims(apiBase)
      );
      // 编辑页可加载手动 + 自动行（自动「转为手动」时预填）
      const federated = [...manualRows, ...autoRows];

      // 重名校验只针对已有手动渠道
      setExistingAliasKeys(manualRows.map((row) => row.aliasKey));

      if (aliasFromParams) {
        const match = federated.find((row) => row.aliasKey === toAliasKey(aliasFromParams));
        const resolvedAlias = match?.alias ?? aliasFromParams;
        const targets: MappingTargetRef[] = (match?.targets ?? []).map((target) =>
          target.source === 'oauth'
            ? { source: 'oauth', channel: target.channel, modelId: target.modelId }
            : {
                source: 'apiKey',
                resourceId: target.resourceId,
                brand: target.brand,
                modelId: target.modelId,
              }
        );
        setAlias(resolvedAlias);
        setBaselineAlias(resolvedAlias);
        setBaselineTargets(targets);
        setSelectedKeys(new Set(targets.map(mappingTargetKey)));
      } else {
        setAlias('');
        setBaselineAlias('');
        setBaselineTargets([]);
        const preselected = new Set<string>();
        if (preselectFromParams) {
          const optionKeys = new Set(options.map((opt) => mappingTargetKey(opt)));
          if (optionKeys.has(preselectFromParams)) {
            preselected.add(preselectFromParams);
          }
        }
        setSelectedKeys(preselected);
      }
    } catch (err: unknown) {
      if (requestId === loadRequestRef.current) {
        setInitialLoadError(getErrorMessage(err));
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setInitialLoading(false);
      }
    }
  }, [aliasFromParams, apiBase, preselectFromParams, resolvedTheme, t]);

  useEffect(() => {
    void loadInitialData();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadInitialData]);

  const validationError = useMemo(
    () =>
      validateMappingSelection({
        alias,
        targets: selectedTargets,
        existingAliasKeys,
        editingAliasKey: isEditing ? toAliasKey(baselineAlias) : null,
      }),
    [alias, baselineAlias, existingAliasKeys, isEditing, selectedTargets]
  );

  const validationMessage = useCallback(
    (code: MappingValidationError | null): string | null => {
      if (!code) return null;
      switch (code) {
        case 'alias_required':
          return t('modelsPage.mapping.aliasRequired', { defaultValue: '请填写自定义模型名。' });
        case 'no_targets':
          return t('modelsPage.mapping.noTargets', {
            defaultValue: '请至少选择一个映射目标模型。',
          });
        case 'duplicate_alias':
          return t('modelsPage.mapping.duplicateAlias', {
            defaultValue: '该自定义模型名已存在。',
          });
        case 'channel_conflict':
          return t('modelsPage.mapping.channelConflict', {
            defaultValue: '同一 OAuth 渠道下只能映射一个模型到此名称。',
          });
        case 'identity_only':
          // Same-name multi-provider federation is auto-grouped in the list;
          // editing page treats pure identity selection as a no-op confirm.
          return t('modelsPage.mapping.identityOnly', {
            defaultValue:
              '所选目标与自定义名相同，无需改写别名。同名多来源模型会自动出现在「已映射」列表中。',
          });
        default:
          return null;
      }
    },
    [t]
  );

  const toggleTarget = (key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const removeSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const filteredOptions = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return enabledOptions;
    return enabledOptions.filter((opt) => {
      const hay = `${opt.displayName} ${opt.modelId} ${opt.providerLabel}`.toLowerCase();
      return hay.includes(q);
    });
  }, [enabledOptions, pickerSearch]);

  const groupedOptions = useMemo(() => {
    const groups = new Map<string, { label: string; items: MappingPickerOption[] }>();
    filteredOptions.forEach((opt) => {
      const existing = groups.get(opt.groupKey);
      if (existing) {
        existing.items.push(opt);
      } else {
        groups.set(opt.groupKey, { label: opt.providerLabel, items: [opt] });
      }
    });
    return Array.from(groups.entries()).map(([key, value]) => ({ key, ...value }));
  }, [filteredOptions]);

  const selectedChips = useMemo(() => {
    return Array.from(selectedKeys).map((key) => {
      const opt = optionByKey.get(key);
      if (opt) {
        return {
          key,
          label: opt.displayName || opt.modelId,
          providerLabel: opt.providerLabel,
          iconSrc: opt.iconSrc,
          disabled: false,
        };
      }
      const baseline = baselineTargets.find((t) => mappingTargetKey(t) === key);
      return {
        key,
        label: baseline?.modelId ?? key,
        providerLabel:
          baseline?.source === 'oauth'
            ? getTypeLabel(t, baseline.channel)
            : t('modelsPage.mapping.disabledTarget', { defaultValue: '已禁用目标' }),
        iconSrc: null as string | null,
        disabled: true,
      };
    });
  }, [baselineTargets, optionByKey, selectedKeys, t]);

  const handleSave = useCallback(async () => {
    const aliasLiteral = alias.trim();
    const prevAliasKey = toAliasKey(baselineAlias || aliasLiteral);
    // Identity targets (alias===modelId) cannot be persisted; only write real redirects.
    const persistableSelected = filterPersistableMappingTargets(aliasLiteral, selectedTargets);
    const persistableBaseline = filterPersistableMappingTargets(
      baselineAlias || aliasLiteral,
      baselineTargets
    );

    // 编辑时：若原本有可持久化目标，现在全部取消 → 必须写回清空，不能走 identity_only 假成功
    const clearingConfigured =
      isEditing && persistableBaseline.length > 0 && persistableSelected.length === 0;

    // 只剩同名目标（无可持久化）：认领为手动渠道，不写 alias===name
    const pureIdentity =
      !clearingConfigured &&
      selectedTargets.length > 0 &&
      persistableSelected.length === 0;

    if (pureIdentity) {
      claimManualMapping(apiBase, aliasLiteral || baselineAlias);
      showNotification(
        t('modelsPage.mapping.saveSuccessPromoted', {
          defaultValue: '已转为手动映射渠道（同名目标无需改写别名）',
        }),
        'success'
      );
      allowNextNavigation();
      handleBack();
      return;
    }

    // 编辑时清空全部勾选：取消认领 + 清理后端配置
    if (selectedTargets.length === 0) {
      if (!isEditing) {
        showNotification(
          validationMessage('no_targets') ??
            t('modelsPage.mapping.noTargets', { defaultValue: '请至少选择一个映射目标模型。' }),
          'error'
        );
        return;
      }
      // fall through to write path with empty next plan
    }

    const error = validateMappingSelection({
      alias: aliasLiteral || baselineAlias,
      targets: selectedTargets.length ? selectedTargets : persistableBaseline,
      existingAliasKeys,
      editingAliasKey: isEditing ? toAliasKey(baselineAlias) : null,
    });

    // clearingConfigured 时 selected 可能为空，validate 会报 no_targets — 允许通过
    if (error && !(clearingConfigured && (error === 'no_targets' || error === 'identity_only'))) {
      showNotification(validationMessage(error) ?? error, 'error');
      return;
    }

    if (
      oauthUnsupported &&
      [...persistableSelected, ...persistableBaseline].some((t) => t.source === 'oauth')
    ) {
      showNotification(
        t('modelsPage.mapping.oauthUnsupported', {
          defaultValue:
            '当前 CPA 版本不支持 OAuth 模型映射。下方仍会展示 API Key 侧的模型别名映射。',
        }),
        'error'
      );
      return;
    }

    setSaving(true);
    try {
      const nextPlan = planAliasTargetAssignments(persistableSelected, aliasLiteral || baselineAlias);
      const baselinePlan = planAliasTargetAssignments(
        persistableBaseline,
        baselineAlias || aliasLiteral
      );

      // 只清理后端真正有该 alias 的 channel，外加 next plan；避免 identity 展示目标触发 channel not found
      const oauthChannels = new Set<string>([
        ...nextPlan.oauthByChannel.keys(),
        ...baselinePlan.oauthByChannel.keys(),
        ...collectConfiguredOauthChannelsForAlias(modelAlias, prevAliasKey),
        ...collectChannelsForAlias(modelAlias, prevAliasKey),
      ]);

      for (const channel of oauthChannels) {
        const entries = modelAlias[channel] ?? [];
        if (!entries.length && !(nextPlan.oauthByChannel.get(channel) ?? []).length) {
          continue;
        }
        let working = entries;
        if (isEditing && toAliasKey(baselineAlias) !== toAliasKey(aliasLiteral || baselineAlias)) {
          working = applyOauthAliasTargetChanges({
            entries: working,
            alias: baselineAlias,
            nextModelIds: [],
          });
        }
        const nextModelIds = nextPlan.oauthByChannel.get(channel) ?? [];
        const nextEntries = applyOauthAliasTargetChanges({
          entries: working,
          alias: aliasLiteral || baselineAlias,
          nextModelIds,
        });
        if (nextEntries.length) {
          await authFilesApi.saveOauthModelAlias(channel, nextEntries);
        } else if (entries.length) {
          // 该 channel 上原本有条目才 delete；空 channel 不要调 delete
          await authFilesApi.deleteOauthModelAlias(channel);
        }
      }

      const resourceIds = new Set<string>([
        ...nextPlan.apiKeyByResource.keys(),
        ...baselinePlan.apiKeyByResource.keys(),
        ...collectConfiguredApiKeyResourceIdsForAlias(resources, prevAliasKey),
      ]);

      for (const resourceId of resourceIds) {
        const resource = resources.find((r) => r.id === resourceId);
        if (!resource) {
          // 清理路径：资源已不存在可跳过；新增路径才报错
          if ((nextPlan.apiKeyByResource.get(resourceId)?.modelIds ?? []).length) {
            throw new Error(
              t('modelsPage.mapping.resourceMissing', {
                defaultValue: '未找到提供商条目（{{id}}），请刷新后重试。',
                id: resourceId,
              })
            );
          }
          continue;
        }
        const rawModels = ((resource.raw as { models?: ModelAlias[] })?.models ??
          []) as ModelAlias[];
        const previousModelIds = baselinePlan.apiKeyByResource.get(resourceId)?.modelIds ?? [];
        let working = rawModels;
        if (isEditing && toAliasKey(baselineAlias) !== toAliasKey(aliasLiteral || baselineAlias)) {
          working = applyApiKeyModelAliasChanges({
            models: working,
            alias: baselineAlias,
            nextModelIds: [],
            previousModelIds,
            previousAliasKey: prevAliasKey,
          });
        }
        const nextModelIds = nextPlan.apiKeyByResource.get(resourceId)?.modelIds ?? [];
        const nextModels = applyApiKeyModelAliasChanges({
          models: working,
          alias: aliasLiteral || baselineAlias,
          nextModelIds,
          previousModelIds,
          previousAliasKey: prevAliasKey,
        });
        await updateApiKeyModels(resource, nextModels);
      }

      if (selectedTargets.length === 0) {
        // 清空全部目标 = 删除手动渠道 → 取消认领，模型回自动映射
        unclaimManualMapping(apiBase, aliasLiteral || baselineAlias);
      } else {
        // 任意成功保存都认领为手动（含跨名 + 同名混合）
        claimManualMapping(apiBase, aliasLiteral || baselineAlias);
      }

      const skippedIdentity =
        selectedTargets.length - persistableSelected.length > 0 &&
        persistableSelected.length > 0;
      showNotification(
        clearingConfigured || selectedTargets.length === 0
          ? t('modelsPage.mapping.deleteSuccess', {
              defaultValue: '手动映射已删除，同名模型已回到自动映射',
            })
          : skippedIdentity
            ? t('modelsPage.mapping.saveSuccessIdentitySkipped', {
                defaultValue:
                  '映射已保存（与自定义名相同的目标无需单独配置，客户端会直接匹配原生模型）',
              })
            : t('modelsPage.mapping.saveSuccess', { defaultValue: '映射已保存' }),
        'success'
      );
      allowNextNavigation();
      handleBack();
    } catch (err: unknown) {
      showNotification(
        `${t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' })}: ${getErrorMessage(err)}`,
        'error'
      );
    } finally {
      setSaving(false);
    }
  }, [
    alias,
    allowNextNavigation,
    apiBase,
    baselineAlias,
    baselineTargets,
    existingAliasKeys,
    handleBack,
    isEditing,
    modelAlias,
    oauthUnsupported,
    resources,
    selectedTargets,
    showNotification,
    t,
    validationMessage,
  ]);

  const title = isEditing
    ? t('modelsPage.mapping.editTitle', { defaultValue: '编辑模型映射' })
    : t('modelsPage.mapping.createTitle', { defaultValue: '添加模型映射' });

  const canSave = !disableControls && !saving && !initialLoading && initialLoadError === null;

  return (
    <SecondaryScreenShell
      ref={swipeRef}
      title={title}
      onBack={handleBack}
      backLabel={t('common.back')}
      backAriaLabel={t('common.back')}
      contentClassName={styles.pageContent}
      rightAction={
        <Button size="sm" onClick={() => void handleSave()} loading={saving} disabled={!canSave}>
          {t('modelsPage.mapping.save', { defaultValue: '保存' })}
        </Button>
      }
      isLoading={initialLoading}
      loadingLabel={t('common.loading')}
    >
      {initialLoadError !== null ? (
        <Card>
          <EmptyState
            title={t('notification.refresh_failed')}
            description={initialLoadError || t('notification.refresh_failed')}
            action={
              <Button variant="secondary" size="sm" onClick={() => void loadInitialData()}>
                {t('common.refresh')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card className={styles.settingsCard}>
            <div className={styles.settingsHeader}>
              <div className={styles.settingsHeaderTitle}>
                <IconInfo size={16} />
                <span>
                  {t('modelsPage.mapping.aliasLabel', { defaultValue: '自定义模型名' })}
                </span>
              </div>
              <div className={styles.settingsHeaderHint}>
                {t('modelsPage.mapping.aliasHint', {
                  defaultValue: '客户端将使用此名称请求；可映射到多个提供商模型。',
                })}
              </div>
            </div>
            <div className={styles.settingsSection}>
              <input
                className={`input ${styles.aliasInput}`}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={t('modelsPage.mapping.aliasPlaceholder', {
                  defaultValue: '例如 custom.chat.plus',
                })}
                disabled={disableControls || saving}
                autoComplete="off"
                spellCheck={false}
              />
              {validationError && alias.trim() ? (
                <div className={styles.validationHint}>{validationMessage(validationError)}</div>
              ) : null}
              {oauthUnsupported ? (
                <div className={styles.validationHint}>
                  {t('modelsPage.mapping.oauthUnsupported', {
                    defaultValue:
                      '当前 CPA 版本不支持 OAuth 模型映射。下方仍会展示 API Key 侧的模型别名映射。',
                  })}
                </div>
              ) : null}
            </div>
          </Card>

          <Card className={styles.settingsCard}>
            <div className={styles.settingsHeader}>
              <div className={styles.settingsHeaderTitle}>
                <span>
                  {t('modelsPage.mapping.targetsLabel', { defaultValue: '映射目标' })}
                </span>
              </div>
              <div className={styles.settingsHeaderHint}>
                {t('modelsPage.mapping.targetsHint', {
                  defaultValue: '从当前已启用的提供商模型中多选。',
                })}
              </div>
            </div>

            {selectedChips.length > 0 ? (
              <div className={styles.selectedSection}>
                <div className={styles.tagList}>
                  {selectedChips.map((chip) => (
                    <span
                      key={chip.key}
                      className={`${styles.selectedTag} ${chip.disabled ? styles.selectedTagDisabled : ''}`}
                      title={
                        chip.disabled
                          ? t('modelsPage.mapping.targetDisabledHint', {
                              defaultValue: '{{label}}（当前已禁用）',
                              label: `${chip.providerLabel} · ${chip.label}`,
                            })
                          : `${chip.providerLabel} · ${chip.label}`
                      }
                    >
                      {chip.iconSrc ? (
                        <img src={chip.iconSrc} alt="" className={styles.tagIcon} />
                      ) : null}
                      <span className={styles.tagText}>{chip.label}</span>
                      <span className={styles.tagProvider}>{chip.providerLabel}</span>
                      <button
                        type="button"
                        className={styles.tagRemove}
                        onClick={() => removeSelected(chip.key)}
                        disabled={disableControls || saving}
                        aria-label={t('common.delete')}
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={styles.pickerSection}>
              <input
                className={styles.pickerSearch}
                type="search"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder={t('modelsPage.mapping.searchPlaceholder', {
                  defaultValue: '搜索自定义名称或目标模型',
                })}
                disabled={disableControls || saving}
              />

              {enabledOptions.length === 0 ? (
                <EmptyState
                  title={t('modelsPage.mapping.targetsEmpty', {
                    defaultValue: '暂无已启用的模型可选',
                  })}
                  description={t('modelsPage.mapping.targetsEmptyDesc', {
                    defaultValue: '请先在「模型禁用」中启用模型，或在 AI 提供商中配置模型列表。',
                  })}
                />
              ) : filteredOptions.length === 0 ? (
                <EmptyState
                  title={t('modelsPage.mapping.noSearchResults', {
                    defaultValue: '没有匹配的映射',
                  })}
                />
              ) : (
                <div className={styles.pickerGroups}>
                  {groupedOptions.map((group) => (
                    <div key={group.key} className={styles.pickerGroup}>
                      <div className={styles.pickerGroupTitle}>{group.label}</div>
                      <div className={styles.pickerItems}>
                        {group.items.map((opt) => {
                          const key = mappingTargetKey(opt);
                          const checked = selectedKeys.has(key);
                          return (
                            <div key={key} className={styles.pickerItem}>
                              <SelectionCheckbox
                                checked={checked}
                                onChange={(value) => toggleTarget(key, value)}
                                disabled={disableControls || saving}
                                label={
                                  <span className={styles.pickerLabel}>
                                    {opt.iconSrc ? (
                                      <img src={opt.iconSrc} alt="" className={styles.tagIcon} />
                                    ) : null}
                                    <span className={styles.pickerName}>
                                      {opt.displayName || opt.modelId}
                                    </span>
                                    {opt.displayName && opt.displayName !== opt.modelId ? (
                                      <span className={styles.pickerId}>{opt.modelId}</span>
                                    ) : null}
                                  </span>
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </SecondaryScreenShell>
  );
}
