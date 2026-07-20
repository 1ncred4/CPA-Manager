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
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
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
  clearSuspendedForAlias,
  listSuspendedForAlias,
  mergeSuspendedForTarget,
  type SuspendedMapping,
} from './mappingSuspend';
import {
  accessEnabledKey,
  accessRowToTargetRef,
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
  isIdentityMappingTarget,
  mappingTargetKey,
  planAliasTargetAssignments,
  toAliasKey,
  validateMappingSelection,
  type MappingPickerOption,
  type MappingTargetRef,
  type MappingValidationError,
} from './modelMapping';
import { updateApiKeyModels } from './updateApiKeyModels';
import { applyManagedIdentityExcludeDisplayMask } from './managedIdentityExclude';
import { syncIdentityAccessOnMappingSave } from './syncIdentityAccessOnMapping';
import styles from './ModelAliasEdit.module.scss';

type LocationState = { fromModels?: boolean } | null;

/** 编辑页 tag 展示元数据：覆盖启用 / 禁用（仍映射）目标 */
type TargetChipMeta = {
  key: string;
  ref: MappingTargetRef;
  displayName: string;
  providerLabel: string;
  iconSrc: string | null;
  currentlyEnabled: boolean;
};

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
  /** 目标展示信息（含已禁用但仍映射的模型），供 tag 列表用 */
  const [targetChipMeta, setTargetChipMeta] = useState<Map<string, TargetChipMeta>>(() => new Map());

  const [alias, setAlias] = useState(aliasFromParams);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  /** 编辑页本地挂起目标（模型禁用时剪枝），可在 tag 列表中删除 */
  const [suspendedTargets, setSuspendedTargets] = useState<SuspendedMapping[]>([]);
  const [baselineSuspendedKeys, setBaselineSuspendedKeys] = useState<string[]>([]);
  /**
   * 打开编辑页时该 alias 曾持有的全部目标（活跃 + 渠道内挂起）。
   * 用于计算彻底移除项，保存时清掉渠道禁用写过的受管 exclude。
   */
  const [baselineHeldTargets, setBaselineHeldTargets] = useState<MappingTargetRef[]>([]);
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

  const resolveTargetRef = useCallback(
    (key: string): MappingTargetRef | null => {
      const opt = optionByKey.get(key);
      if (opt) {
        return opt.source === 'oauth'
          ? { source: 'oauth', channel: opt.channel, modelId: opt.modelId }
          : {
              source: 'apiKey',
              resourceId: opt.resourceId,
              brand: opt.brand,
              modelId: opt.modelId,
            };
      }
      // 已禁用但仍选中 / 渠道内禁用：用 chip meta / suspended / baseline 补齐
      const meta = targetChipMeta.get(key);
      if (meta) return meta.ref;
      const suspended = suspendedTargets.find((entry) => mappingTargetKey(entry.target) === key);
      if (suspended) return suspended.target;
      const baseline = baselineTargets.find((t) => mappingTargetKey(t) === key);
      return baseline ?? null;
    },
    [baselineTargets, optionByKey, suspendedTargets, targetChipMeta]
  );

  const selectedTargets: MappingTargetRef[] = useMemo(() => {
    const result: MappingTargetRef[] = [];
    selectedKeys.forEach((key) => {
      const ref = resolveTargetRef(key);
      if (ref) result.push(ref);
    });
    return result;
  }, [resolveTargetRef, selectedKeys]);

  const suspendedSignature = useMemo(
    () =>
      suspendedTargets
        .map((entry) => `${toAliasKey(entry.alias)}|${mappingTargetKey(entry.target)}`)
        .sort()
        .join('\n'),
    [suspendedTargets]
  );
  const baselineSuspendedSignature = useMemo(
    () => [...baselineSuspendedKeys].sort().join('\n'),
    [baselineSuspendedKeys]
  );
  const baselineSignature = useMemo(
    () => getMappingDraftSignature(baselineAlias, baselineTargets),
    [baselineAlias, baselineTargets]
  );
  const currentSignature = useMemo(
    () => getMappingDraftSignature(alias, selectedTargets),
    [alias, selectedTargets]
  );
  const isDirty =
    baselineSignature !== currentSignature || suspendedSignature !== baselineSuspendedSignature;

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

      const accessRowsRaw: ModelAccessRow[] = [];
      Object.entries(oauthModels).forEach(([channel, models]) => {
        accessRowsRaw.push(
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
        accessRowsRaw.push(...buildApiKeyAccessRows({ resource, providerLabel, iconSrc }));
      });
      // 受管 identity 排除：UI 仍显示启用，其它渠道可选
      const accessRows = applyManagedIdentityExcludeDisplayMask(accessRowsRaw, apiBase);

      const options = buildEnabledMappingOptions(accessRows);
      setEnabledOptions(options);

      // access 全量元数据（含已禁用），供 tag 展示禁用但仍映射的目标
      const chipMeta = new Map<string, TargetChipMeta>();
      accessRows.forEach((row) => {
        const ref = accessRowToTargetRef(row);
        if (!ref) return;
        const key = mappingTargetKey(ref);
        chipMeta.set(key, {
          key,
          ref,
          displayName: row.displayName || ref.modelId,
          providerLabel: row.providerLabel,
          iconSrc: row.iconSrc ?? null,
          currentlyEnabled: row.enabled,
        });
      });

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
        icons: {
          oauth: (channel) => getAuthFileIcon(channel, resolvedTheme),
          apiKey: (resource) => {
            const logo = PROVIDER_LOGOS[resource.brand];
            return resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null);
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
        // 渠道内已禁用（localStorage 挂起）的目标不得再进 selectedKeys。
        // attachNativeIdentityTargets 会把同名原生模型自动挂回行上；若不排除挂起项，
        // 用户移除/禁用的 identity 目标保存后再打开会被重新勾选。
        const suspended = listSuspendedForAlias(apiBase, resolvedAlias);
        const suspendedKeySet = new Set(
          suspended.map((entry) => mappingTargetKey(entry.target))
        );
        // 活跃目标不含挂起项（挂起仅存 localStorage，后端已剪枝）
        // 但包含 currentlyEnabled=false 的「已禁用但仍映射」目标，须出现在 tag 列表
        const liveTargets = (match?.targets ?? []).filter(
          (target) => !target.suspended && !suspendedKeySet.has(mappingTargetKey(target))
        );
        const targets: MappingTargetRef[] = liveTargets.map((target) =>
          target.source === 'oauth'
            ? { source: 'oauth', channel: target.channel, modelId: target.modelId }
            : {
                source: 'apiKey',
                resourceId: target.resourceId,
                brand: target.brand,
                modelId: target.modelId,
              }
        );
        // 用联邦行补齐禁用目标的展示信息（accessRows 若已无该模型则仍可显示）
        // 含挂起 identity：仍要能显示灰标 chip
        const metaSourceTargets = (match?.targets ?? []).filter((target) => !target.suspended);
        metaSourceTargets.forEach((target) => {
          const key = mappingTargetKey(target);
          if (chipMeta.has(key)) {
            // access 有该行时以 access 为准（enabled 更准），仅补全缺失
            const existing = chipMeta.get(key)!;
            chipMeta.set(key, {
              ...existing,
              displayName: existing.displayName || target.displayName || target.modelId,
              providerLabel: existing.providerLabel || target.providerLabel,
              iconSrc: existing.iconSrc ?? target.iconSrc ?? null,
              currentlyEnabled: target.currentlyEnabled,
            });
            return;
          }
          chipMeta.set(key, {
            key,
            ref:
              target.source === 'oauth'
                ? { source: 'oauth', channel: target.channel, modelId: target.modelId }
                : {
                    source: 'apiKey',
                    resourceId: target.resourceId,
                    brand: target.brand,
                    modelId: target.modelId,
                  },
            displayName: target.displayName || target.modelId,
            providerLabel: target.providerLabel,
            iconSrc: target.iconSrc ?? null,
            currentlyEnabled: target.currentlyEnabled,
          });
        });

        setTargetChipMeta(chipMeta);
        setAlias(resolvedAlias);
        setBaselineAlias(resolvedAlias);
        setBaselineTargets(targets);
        setSelectedKeys(new Set(targets.map(mappingTargetKey)));
        setSuspendedTargets(suspended);
        setBaselineSuspendedKeys(
          suspended.map((entry) => `${toAliasKey(entry.alias)}|${mappingTargetKey(entry.target)}`)
        );
        const held: MappingTargetRef[] = [...targets];
        const heldKeys = new Set(targets.map(mappingTargetKey));
        suspended.forEach((entry) => {
          const key = mappingTargetKey(entry.target);
          if (heldKeys.has(key)) return;
          heldKeys.add(key);
          held.push(entry.target);
        });
        setBaselineHeldTargets(held);
      } else {
        setTargetChipMeta(chipMeta);
        setAlias('');
        setBaselineAlias('');
        setBaselineTargets([]);
        setSuspendedTargets([]);
        setBaselineSuspendedKeys([]);
        setBaselineHeldTargets([]);
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
    // Selecting from picker clears any channel-local disable for that target.
    if (checked) {
      setSuspendedTargets((prev) =>
        prev.filter((entry) => mappingTargetKey(entry.target) !== key)
      );
    }
  };

  const removeSelected = (key: string) => {
    const ref = resolveTargetRef(key);
    const aliasLiteral = alias.trim() || baselineAlias;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    // 同名 identity 目标会被 attachNative 在下次加载时自动挂回。
    // 永久「×」对 identity 也记为渠道内挂起，否则保存后一刷新又出现。
    if (ref && aliasLiteral && isIdentityMappingTarget(aliasLiteral, ref)) {
      setSuspendedTargets((prev) => {
        if (prev.some((entry) => mappingTargetKey(entry.target) === key)) return prev;
        return [...prev, { alias: aliasLiteral, target: ref }];
      });
      return;
    }
    // 跨名目标：永久移除，清掉渠道内挂起残留
    setSuspendedTargets((prev) =>
      prev.filter((entry) => mappingTargetKey(entry.target) !== key)
    );
  };

  /** 从 tag 列表移除挂起目标（跨名可删；同名 identity 见 UI：不显示 ×） */
  const removeSuspended = (key: string) => {
    setSuspendedTargets((prev) => prev.filter((e) => mappingTargetKey(e.target) !== key));
  };

  /**
   * 渠道级启停：先改 selectedKeys / suspendedTargets。
   * 保存时：剪枝/恢复本渠道 alias，并对挂起目标隐藏原名入口
   * （OAuth fork=false 或受管 exclude；API Key excluded/catalog），
   * 避免原名重新出现在模型列表。
   */
  const setChannelTargetEnabled = (key: string, enabled: boolean) => {
    const ref = resolveTargetRef(key);
    if (!ref) return;
    const aliasLiteral = alias.trim() || baselineAlias;
    if (!aliasLiteral) return;

    if (!enabled) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setSuspendedTargets((prev) => {
        if (prev.some((entry) => mappingTargetKey(entry.target) === key)) return prev;
        return [...prev, { alias: aliasLiteral, target: ref }];
      });
      return;
    }

    setSuspendedTargets((prev) =>
      prev.filter((entry) => mappingTargetKey(entry.target) !== key)
    );
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
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
    const active = Array.from(selectedKeys).map((key) => {
      const opt = optionByKey.get(key);
      const meta = targetChipMeta.get(key);
      if (opt) {
        return {
          key,
          label: opt.displayName || opt.modelId,
          providerLabel: opt.providerLabel,
          iconSrc: opt.iconSrc,
          disabled: false,
          suspended: false,
        };
      }
      // 已禁用但仍映射：用 access / 联邦行补齐的 meta 展示
      if (meta) {
        return {
          key,
          label: meta.displayName || meta.ref.modelId,
          providerLabel: meta.providerLabel,
          iconSrc: meta.iconSrc,
          disabled: true,
          suspended: false,
        };
      }
      const baseline = baselineTargets.find((t) => mappingTargetKey(t) === key);
      if (baseline?.source === 'oauth') {
        return {
          key,
          label: baseline.modelId,
          providerLabel: getTypeLabel(t, baseline.channel),
          iconSrc: getAuthFileIcon(baseline.channel, resolvedTheme) as string | null,
          disabled: true,
          suspended: false,
        };
      }
      if (baseline?.source === 'apiKey') {
        const brandLabel = t(`providersPage.providerNames.${baseline.brand}`, {
          defaultValue: baseline.brand,
        });
        const resource = resources.find((r) => r.id === baseline.resourceId);
        const entryLabel = resource?.name ?? resource?.identifier;
        const logo = PROVIDER_LOGOS[baseline.brand];
        return {
          key,
          label: baseline.modelId,
          providerLabel: entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel,
          iconSrc:
            resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null),
          disabled: true,
          suspended: false,
        };
      }
      return {
        key,
        label: key,
        providerLabel: t('modelsPage.mapping.disabledTarget', { defaultValue: '已禁用目标' }),
        iconSrc: null as string | null,
        disabled: true,
        suspended: false,
      };
    });

    // 活跃 selected 已占用的 key 不再重复展示挂起 tag
    const activeKeys = new Set(active.map((chip) => chip.key));
    const suspendedChips = suspendedTargets
      .filter((entry) => !activeKeys.has(mappingTargetKey(entry.target)))
      .map((entry) => {
        const key = mappingTargetKey(entry.target);
        const opt = optionByKey.get(key);
        const meta = targetChipMeta.get(key);
        if (entry.target.source === 'oauth') {
          return {
            key,
            label: opt?.displayName || meta?.displayName || entry.target.modelId,
            providerLabel:
              opt?.providerLabel || meta?.providerLabel || getTypeLabel(t, entry.target.channel),
            iconSrc:
              opt?.iconSrc ??
              meta?.iconSrc ??
              (getAuthFileIcon(entry.target.channel, resolvedTheme) as string | null),
            disabled: true,
            suspended: true,
          };
        }
        const apiTarget = entry.target;
        const brandLabel = t(`providersPage.providerNames.${apiTarget.brand}`, {
          defaultValue: apiTarget.brand,
        });
        const resource = resources.find((r) => r.id === apiTarget.resourceId);
        const entryLabel = resource?.name ?? resource?.identifier;
        const providerLabel =
          opt?.providerLabel ||
          meta?.providerLabel ||
          (entryLabel ? `${brandLabel} · ${entryLabel}` : brandLabel);
        const logo = PROVIDER_LOGOS[apiTarget.brand];
        const iconSrc =
          opt?.iconSrc ??
          meta?.iconSrc ??
          (resolvedTheme === 'dark' && logo?.darkSrc ? logo.darkSrc : (logo?.src ?? null));
        return {
          key,
          label: opt?.displayName || meta?.displayName || apiTarget.modelId,
          providerLabel,
          iconSrc,
          disabled: true,
          suspended: true,
        };
      });

    return [...active, ...suspendedChips];
  }, [
    alias,
    baselineAlias,
    baselineTargets,
    optionByKey,
    resolveTargetRef,
    resources,
    resolvedTheme,
    selectedKeys,
    suspendedTargets,
    t,
    targetChipMeta,
  ]);

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

    const syncSuspendedTags = (finalAliasName: string) => {
      if (isEditing && baselineAlias) {
        clearSuspendedForAlias(apiBase, baselineAlias);
      }
      if (finalAliasName && toAliasKey(finalAliasName) !== toAliasKey(baselineAlias || '')) {
        clearSuspendedForAlias(apiBase, finalAliasName);
      }
      // 写回仍保留的挂起 tag（alias 可能已改名）；活跃与挂起都空时 clear 后不再 merge
      if (suspendedTargets.length > 0 && finalAliasName) {
        suspendedTargets.forEach((entry) => {
          mergeSuspendedForTarget(apiBase, accessEnabledKey(entry.target), [
            { ...entry, alias: finalAliasName },
          ]);
        });
      }
    };

    const applyIdentityAccess = async (finalAliasName: string) => {
      const claimedKeys = new Set([
        ...selectedTargets.map(mappingTargetKey),
        ...suspendedTargets.map((entry) => mappingTargetKey(entry.target)),
      ]);
      const abandonedTargets = baselineHeldTargets.filter(
        (target) => !claimedKeys.has(mappingTargetKey(target))
      );
      const sync = await syncIdentityAccessOnMappingSave({
        apiBase,
        alias: finalAliasName,
        selectedTargets,
        suspendedTargets,
        abandonedTargets,
        resources,
      });
      if (sync.failed.length) {
        showNotification(
          t('modelsPage.mapping.identityAccessSyncFailed', {
            defaultValue:
              '映射已保存，但映射目标的原名启停同步失败：{{detail}}',
            detail: sync.failed.join('; '),
          }),
          'warning'
        );
      } else if (sync.forked > 0) {
        showNotification(
          t('modelsPage.mapping.identityAccessForked', {
            defaultValue:
              '已关闭 {{count}} 个映射目标的原名入口（fork=关，模型仍可通过其它别名使用）',
            count: sync.forked,
          }),
          'success'
        );
      } else if (sync.excluded > 0) {
        showNotification(
          t('modelsPage.mapping.identityAccessExcluded', {
            defaultValue:
              '已关闭 {{count}} 个映射目标的原名路由；管理端仍显示启用，其它渠道可继续映射',
            count: sync.excluded,
          }),
          'success'
        );
      }
      return sync;
    };

    if (pureIdentity) {
      const finalAlias = aliasLiteral || baselineAlias;
      setSaving(true);
      try {
        claimManualMapping(apiBase, finalAlias);
        syncSuspendedTags(finalAlias);
        await applyIdentityAccess(finalAlias);
        showNotification(
          t('modelsPage.mapping.saveSuccessPromoted', {
            defaultValue: '已转为手动映射渠道（同名目标无需改写别名）',
          }),
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
      return;
    }

    // 仅挂起目标仍算「有映射」：只同步 localStorage，不走后端清空
    if (isEditing && selectedTargets.length === 0 && suspendedTargets.length > 0) {
      const finalAlias = aliasLiteral || baselineAlias;
      if (!finalAlias.trim()) {
        showNotification(
          validationMessage('alias_required') ??
            t('modelsPage.mapping.aliasRequired', { defaultValue: '请填写自定义模型名。' }),
          'error'
        );
        return;
      }
      setSaving(true);
      try {
        // 挂起仍在 → 保持手动认领，避免灰标行掉回自动
        claimManualMapping(apiBase, finalAlias);
        // 后端侧：若原本有可持久化目标，须清空（禁用剪枝后后端本已无配置；重命名时清旧名）
        if (persistableBaseline.length > 0 || toAliasKey(baselineAlias) !== toAliasKey(finalAlias)) {
          // fall through to backend clear + suspended rewrite below with empty next plan
        } else {
          syncSuspendedTags(finalAlias);
          await applyIdentityAccess(finalAlias);
          showNotification(
            t('modelsPage.mapping.saveSuccess', { defaultValue: '映射已保存' }),
            'success'
          );
          allowNextNavigation();
          handleBack();
          return;
        }
      } catch (err: unknown) {
        showNotification(
          `${t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' })}: ${getErrorMessage(err)}`,
          'error'
        );
        setSaving(false);
        return;
      }
      // continue into write path with empty selected (clear old backend bindings)
    }

    // 编辑时清空全部勾选（含挂起也删光）：取消认领 + 清理后端配置
    if (selectedTargets.length === 0 && suspendedTargets.length === 0) {
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

    // 编辑时空活跃目标：validate 会报 no_targets — 允许通过
    const allowEmptyTargets =
      isEditing &&
      selectedTargets.length === 0 &&
      (error === 'no_targets' || error === 'identity_only');
    if (
      error &&
      !(clearingConfigured && (error === 'no_targets' || error === 'identity_only')) &&
      !allowEmptyTargets
    ) {
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

      const finalAlias = aliasLiteral || baselineAlias;

      if (selectedTargets.length === 0 && suspendedTargets.length === 0) {
        // 活跃 + 挂起全部清空 = 删除手动渠道 → 取消认领，模型回自动映射
        unclaimManualMapping(apiBase, finalAlias);
      } else {
        // 任意成功保存都认领为手动（含跨名 + 同名混合 + 仅挂起）
        claimManualMapping(apiBase, finalAlias);
      }

      syncSuspendedTags(finalAlias);
      await applyIdentityAccess(finalAlias);

      const skippedIdentity =
        selectedTargets.length - persistableSelected.length > 0 &&
        persistableSelected.length > 0;
      const fullyDeleted = selectedTargets.length === 0 && suspendedTargets.length === 0;
      showNotification(
        fullyDeleted
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
    baselineHeldTargets,
    baselineTargets,
    existingAliasKeys,
    handleBack,
    isEditing,
    modelAlias,
    oauthUnsupported,
    resources,
    selectedTargets,
    showNotification,
    suspendedTargets,
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
                  {selectedChips.map((chip) => {
                    const isDimmed = chip.suspended || chip.disabled;
                    // Globally disabled (still mapped): keep channel checked but lock toggle.
                    const globallyDisabled = chip.disabled && !chip.suspended;
                    const channelEnabled = !chip.suspended;
                    const ref = resolveTargetRef(chip.key);
                    const isIdentity =
                      Boolean(ref) &&
                      isIdentityMappingTarget(alias.trim() || baselineAlias, ref!);
                    const title = chip.suspended
                      ? isIdentity
                        ? t('modelsPage.mapping.targetIdentityChannelDisabledHint', {
                            defaultValue:
                              '{{label}}（同名目标：保存后关闭原名入口，模型仍可被其它渠道映射）',
                            label: `${chip.providerLabel} · ${chip.label}`,
                          })
                        : t('modelsPage.mapping.targetChannelDisabledHint', {
                            defaultValue: '{{label}}（渠道内已禁用，启用后恢复）',
                            label: `${chip.providerLabel} · ${chip.label}`,
                          })
                      : chip.disabled
                        ? t('modelsPage.mapping.targetDisabledHint', {
                            defaultValue: '{{label}}（当前已禁用）',
                            label: `${chip.providerLabel} · ${chip.label}`,
                          })
                        : `${chip.providerLabel} · ${chip.label}`;
                    return (
                      <span
                        key={`${chip.suspended ? 'suspended' : 'active'}:${chip.key}`}
                        className={`${styles.selectedTag} ${
                          isDimmed ? styles.selectedTagDisabled : ''
                        }`}
                        title={title}
                      >
                        {chip.iconSrc ? (
                          <img src={chip.iconSrc} alt="" className={styles.tagIcon} />
                        ) : null}
                        <span className={styles.tagText}>{chip.label}</span>
                        <span className={styles.tagProvider}>{chip.providerLabel}</span>
                        {isDimmed ? (
                          <span className={styles.tagBadge}>
                            {t('modelsPage.mapping.disabledBadge', { defaultValue: '禁用' })}
                          </span>
                        ) : null}
                        <span className={styles.selectedTagActions}>
                          <ToggleSwitch
                            checked={channelEnabled}
                            disabled={disableControls || saving || globallyDisabled}
                            ariaLabel={t('modelsPage.mapping.channelToggleAria', {
                              defaultValue: '渠道内启用 {{model}}',
                              model: chip.label,
                            })}
                            onChange={(value) => setChannelTargetEnabled(chip.key, value)}
                          />
                          {/* 同名 identity 无法从渠道蒸发：用开关禁用，不提供 × 以免误以为已删除却刷新又回 */}
                          {isIdentity ? null : (
                            <button
                              type="button"
                              className={styles.tagRemove}
                              onClick={() =>
                                chip.suspended
                                  ? removeSuspended(chip.key)
                                  : removeSelected(chip.key)
                              }
                              disabled={disableControls || saving}
                              aria-label={t('common.delete')}
                            >
                              <IconX size={12} />
                            </button>
                          )}
                        </span>
                      </span>
                    );
                  })}
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
