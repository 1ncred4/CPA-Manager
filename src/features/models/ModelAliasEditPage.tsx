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
import { useAuthStore, useNotificationStore } from '@/stores';
import { useModelManagementStore } from '@/stores/useModelManagementStore';
import { useModelAccessList } from './useModelAccessList';
import {
  buildEnabledMappingOptions,
  getMappingDraftSignature,
  isIdentityMappingTarget,
  mappingTargetKey,
  toAliasKey,
  validateMappingSelection,
  type MappingPickerOption,
  type MappingTargetRef,
  type MappingValidationError,
} from './modelMapping';
import type { DisabledMapping } from './modelDisabledState';
import type { ModelMappingTarget } from './modelManagementState';
import type { AliasDraft } from './modelOps';
import styles from './ModelAliasEdit.module.scss';

type LocationState = { fromModels?: boolean } | null;

function toRef(target: MappingTargetRef): MappingTargetRef {
  if (target.source === 'oauth') return { source: 'oauth', channel: target.channel, modelId: target.modelId };
  return { source: 'apiKey', resourceId: target.resourceId, brand: target.brand, modelId: target.modelId };
}

function targetRefFromModelTarget(target: ModelMappingTarget): MappingTargetRef {
  return toRef(target);
}

export function ModelAliasEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const accessList = useModelAccessList();
  const mapping = useModelManagementStore((s) => s.mappingCurrent);
  const saveAlias = useModelManagementStore((s) => s.saveAlias);
  const ctx = useModelManagementStore((s) => s.ctx);
  const oauthAliasError = useModelManagementStore((s) => s.oauthAliasError);
  const disableControls = connectionStatus !== 'connected';
  const aliasParam = (searchParams.get('alias') ?? '').trim();
  const preselect = (searchParams.get('preselect') ?? '').trim();
  const isEditing = Boolean(aliasParam);
  const row = mapping.byAliasKey.get(toAliasKey(aliasParam));
  const [alias, setAlias] = useState(row?.alias ?? aliasParam);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [disabledTargets, setDisabledTargets] = useState<DisabledMapping[]>([]);
  const [removedTargets, setRemovedTargets] = useState<MappingTargetRef[]>([]);
  const [baselineAlias, setBaselineAlias] = useState(row?.alias ?? aliasParam);
  const [baselineSignature, setBaselineSignature] = useState('');
  const [pickerSearch, setPickerSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const initializedDraftKeyRef = useRef<string | null>(null);

  const allTargets = useMemo(() => row?.targets ?? [], [row]);
  const targetsByKey = useMemo(() => new Map(allTargets.map((target) => [mappingTargetKey(target), target])), [allTargets]);
  const enabledOptions = useMemo(() => buildEnabledMappingOptions(accessList.rows), [accessList.rows]);
  const optionByKey = useMemo(() => new Map(enabledOptions.map((option) => [mappingTargetKey(option), option])), [enabledOptions]);
  const resolveRef = useCallback((key: string): MappingTargetRef | null => {
    const option = optionByKey.get(key);
    if (option) return toRef(option);
    const target = targetsByKey.get(key);
    return target ? targetRefFromModelTarget(target) : null;
  }, [optionByKey, targetsByKey]);

  const draftInitializationKey = `${isEditing ? 'edit' : 'create'}:${toAliasKey(aliasParam)}:${preselect}`;

  useEffect(() => {
    if (!ctx || accessList.loading || initializedDraftKeyRef.current === draftInitializationKey) return;
    // Wait for the mapping snapshot before initializing an edit draft. A
    // background load must not replace a draft that the user has already
    // started editing.
    if (isEditing && !row) return;
    if (row) {
      const nextDisabled = row.targets
        .filter((target) => target.suspended && target.disabledReason === 'mapping' && !isIdentityMappingTarget(row.alias, target))
        .map((target) => ({ alias: row.alias, target: targetRefFromModelTarget(target), fork: target.fork, forceMapping: target.forceMapping }));
      const nextSelected = new Set(
        row.targets
          .filter((target) => !nextDisabled.some((entry) => mappingTargetKey(entry.target) === mappingTargetKey(target)))
          .map(mappingTargetKey)
      );
      setAlias(row.alias);
      setBaselineAlias(row.alias);
      setSelectedKeys(nextSelected);
      setDisabledTargets(nextDisabled);
      setRemovedTargets([]);
      setBaselineSignature(
        getMappingDraftSignature(
          row.alias,
          row.targets
            .filter((target) => !nextDisabled.some((entry) => mappingTargetKey(entry.target) === mappingTargetKey(target)))
            .map(targetRefFromModelTarget)
        )
      );
      initializedDraftKeyRef.current = draftInitializationKey;
      return;
    }
    setAlias('');
    setBaselineAlias('');
    setDisabledTargets([]);
    setRemovedTargets([]);
    const next = new Set<string>();
    if (preselect && enabledOptions.some((option) => mappingTargetKey(option) === preselect)) next.add(preselect);
    setSelectedKeys(next);
    setBaselineSignature(getMappingDraftSignature('', []));
    initializedDraftKeyRef.current = draftInitializationKey;
  }, [accessList.loading, ctx, draftInitializationKey, enabledOptions, isEditing, preselect, row]);

  const selectedTargets = useMemo(
    () => Array.from(selectedKeys).map(resolveRef).filter((value): value is MappingTargetRef => Boolean(value)),
    [resolveRef, selectedKeys]
  );
  const selectedSignature = getMappingDraftSignature(alias, selectedTargets);
  const disabledSignature = JSON.stringify(disabledTargets.map((entry) => `${toAliasKey(entry.alias)}|${mappingTargetKey(entry.target)}`).sort());
  const isDirty = baselineSignature !== selectedSignature || removedTargets.length > 0 || (isEditing && disabledTargets.length > 0 && disabledSignature !== JSON.stringify((row?.targets ?? []).filter((target) => target.suspended && target.disabledReason === 'mapping').map((target) => `${toAliasKey(row?.alias ?? '')}|${mappingTargetKey(target)}`).sort()));
  const guard = useUnsavedChangesGuard({
    shouldBlock: isDirty,
    dialog: {
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
    },
  });

  const handleBack = useCallback(() => {
    const state = location.state as LocationState;
    if (state?.fromModels) navigate(-1);
    else navigate('/models?tab=mapping', { replace: true });
  }, [location.state, navigate]);
  const swipeRef = useEdgeSwipeBack({ onBack: handleBack });

  const filteredOptions = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return enabledOptions;
    return enabledOptions.filter((option) => `${option.displayName} ${option.modelId} ${option.providerLabel}`.toLowerCase().includes(q));
  }, [enabledOptions, pickerSearch]);
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, { label: string; items: MappingPickerOption[] }>();
    filteredOptions.forEach((option) => {
      const key = option.groupKey;
      const group = groups.get(key) ?? { label: option.providerLabel, items: [] };
      group.items.push(option);
      groups.set(key, group);
    });
    return Array.from(groups.entries()).map(([key, group]) => ({ key, ...group }));
  }, [filteredOptions]);

  const toggleTarget = (key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
    if (checked) {
      setDisabledTargets((current) => current.filter((entry) => mappingTargetKey(entry.target) !== key));
      setRemovedTargets((current) => current.filter((target) => mappingTargetKey(target) !== key));
    }
  };

  const setChannelTargetEnabled = (key: string, enabled: boolean) => {
    const ref = resolveRef(key);
    if (!ref || isIdentityMappingTarget(alias.trim() || baselineAlias, ref)) return;
    if (enabled) {
      setDisabledTargets((current) => current.filter((entry) => mappingTargetKey(entry.target) !== key));
      setSelectedKeys((current) => new Set(current).add(key));
      setRemovedTargets((current) => current.filter((target) => mappingTargetKey(target) !== key));
    } else {
      setSelectedKeys((current) => { const next = new Set(current); next.delete(key); return next; });
      setDisabledTargets((current) => current.some((entry) => mappingTargetKey(entry.target) === key) ? current : [...current, { alias: alias.trim() || baselineAlias, target: ref }]);
    }
  };

  const removeTarget = (key: string) => {
    const ref = resolveRef(key);
    if (!ref) return;
    setSelectedKeys((current) => { const next = new Set(current); next.delete(key); return next; });
    setDisabledTargets((current) => current.filter((entry) => mappingTargetKey(entry.target) !== key));
    setRemovedTargets((current) => current.some((target) => mappingTargetKey(target) === key) ? current : [...current, ref]);
  };

  const validationError = validateMappingSelection({
    alias,
    targets: selectedTargets,
    existingAliasKeys: Array.from(mapping.byAliasKey.keys()),
    editingAliasKey: isEditing ? toAliasKey(baselineAlias) : null,
  });
  const validationMessage = (error: MappingValidationError | null) => {
    if (!error) return null;
    const key = `modelsPage.mapping.${
      error === 'alias_required'
        ? 'aliasRequired'
        : error === 'no_targets'
          ? 'noTargets'
          : 'duplicateAlias'
    }`;
    return t(key, { defaultValue: error });
  };

  const handleSave = async () => {
    const finalAlias = alias.trim() || baselineAlias.trim();
    if (!finalAlias) { showNotification(validationMessage('alias_required') ?? 'Alias is required', 'error'); return; }
    if (!selectedTargets.length && !disabledTargets.length) {
      if (!isEditing) { showNotification(validationMessage('no_targets') ?? 'Select at least one target', 'error'); return; }
    }
    if (validationError && !(isEditing && !selectedTargets.length)) { showNotification(validationMessage(validationError) ?? validationError, 'error'); return; }
    if (oauthAliasError === 'unsupported' && selectedTargets.some((target) => target.source === 'oauth')) {
      showNotification(t('modelsPage.mapping.oauthUnsupported', { defaultValue: '当前 CPA 版本不支持 OAuth 模型映射。' }), 'error');
      return;
    }
    const draft: AliasDraft = {
      alias: finalAlias,
      previousAliasKey: isEditing ? toAliasKey(baselineAlias) : null,
      baselineAlias,
      isEditing,
      selectedTargets,
      disabledTargets,
      removedTargets,
    };
    setSaving(true);
    const result = await saveAlias(draft);
    setSaving(false);
    if (!result.ok) { showNotification(t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' }), 'error'); return; }
    showNotification(t('modelsPage.mapping.saveSuccess', { defaultValue: '映射已保存' }), 'success');
    guard.allowNextNavigation();
    handleBack();
  };

  const selectedChips = useMemo(() => {
    const disabledByKey = new Map(disabledTargets.map((entry) => [mappingTargetKey(entry.target), entry]));
    const keys = new Set([...selectedKeys, ...disabledByKey.keys()]);
    return Array.from(keys).map((key) => {
      const target = targetsByKey.get(key);
      const option = optionByKey.get(key);
      const ref = resolveRef(key);
      if (!ref) return null;
      return {
        key,
        ref,
        label: target?.displayName || option?.displayName || ref.modelId,
        providerLabel: target?.providerLabel || option?.providerLabel || '',
        iconSrc: target?.iconSrc ?? option?.iconSrc ?? null,
        disabled: target?.disabledReason === 'model',
        channelDisabled: disabledByKey.has(key),
      };
    }).filter((value): value is NonNullable<typeof value> => Boolean(value));
  }, [disabledTargets, optionByKey, resolveRef, selectedKeys, targetsByKey]);

  const canSave = !disableControls && !saving && !accessList.loading;
  return (
    <SecondaryScreenShell ref={swipeRef} title={isEditing ? t('modelsPage.mapping.editTitle', { defaultValue: '编辑模型映射' }) : t('modelsPage.mapping.createTitle', { defaultValue: '添加模型映射' })} onBack={handleBack} backLabel={t('common.back')} backAriaLabel={t('common.back')} contentClassName={styles.pageContent} rightAction={<Button size="sm" onClick={() => void handleSave()} loading={saving} disabled={!canSave}>{t('modelsPage.mapping.save', { defaultValue: '保存' })}</Button>} isLoading={accessList.loading && !ctx} loadingLabel={t('common.loading')}>
      <Card className={styles.settingsCard}>
        <div className={styles.settingsHeader}><div className={styles.settingsHeaderTitle}><IconInfo size={16} /><span>{t('modelsPage.mapping.aliasLabel', { defaultValue: '模型 alias' })}</span></div><div className={styles.settingsHeaderHint}>{t('modelsPage.mapping.aliasHint', { defaultValue: '相同 alias 会聚合来自不同提供商的模型。' })}</div></div>
        <div className={styles.settingsSection}><input className={`input ${styles.aliasInput}`} value={alias} onChange={(event) => setAlias(event.target.value)} placeholder={t('modelsPage.mapping.aliasPlaceholder', { defaultValue: '例如 custom.chat.plus' })} disabled={disableControls || saving} autoComplete="off" spellCheck={false} />{validationError && alias.trim() ? <div className={styles.validationHint}>{validationMessage(validationError)}</div> : null}</div>
      </Card>
      <Card className={styles.settingsCard}>
        <div className={styles.settingsHeader}><div className={styles.settingsHeaderTitle}><span>{t('modelsPage.mapping.targetsLabel', { defaultValue: '映射目标' })}</span></div><div className={styles.settingsHeaderHint}>{t('modelsPage.mapping.targetsHint', { defaultValue: '选择模型目标；同名 identity 目标不能单独禁用。' })}</div></div>
        {selectedChips.length ? <div className={styles.selectedSection}><div className={styles.tagList}>{selectedChips.map((chip) => { const identity = isIdentityMappingTarget(alias.trim() || baselineAlias, chip.ref); const dimmed = chip.disabled || chip.channelDisabled; return <span key={chip.key} className={`${styles.selectedTag} ${dimmed ? styles.selectedTagDisabled : ''}`} title={`${chip.providerLabel} · ${chip.label}`}>
          {chip.iconSrc ? <img src={chip.iconSrc} alt="" className={styles.tagIcon} /> : null}<span className={styles.tagText}>{chip.label}</span><span className={styles.tagProvider}>{chip.providerLabel}</span>{dimmed ? <span className={styles.tagBadge}>{t('modelsPage.mapping.disabledBadge', { defaultValue: '禁用' })}</span> : null}<span className={styles.selectedTagActions}>
            {chip.disabled ? <span className={styles.tagBadge}>{t('modelsPage.mapping.modelDisabledBadge', { defaultValue: '模型禁用' })}</span> : <ToggleSwitch checked={!chip.channelDisabled} disabled={disableControls || saving || identity} ariaLabel={t('modelsPage.mapping.channelToggleAria', { defaultValue: '渠道内启用 {{model}}', model: chip.label })} onChange={(value) => setChannelTargetEnabled(chip.key, value)} />}
            <button type="button" className={styles.tagRemove} onClick={() => removeTarget(chip.key)} disabled={disableControls || saving} aria-label={t('common.delete')}><IconX size={12} /></button>
          </span>
        </span>; })}</div></div> : null}
        <div className={styles.pickerSection}><input className={styles.pickerSearch} type="search" value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} placeholder={t('modelsPage.mapping.searchPlaceholder', { defaultValue: '搜索目标模型' })} disabled={disableControls || saving} />{enabledOptions.length === 0 ? <EmptyState title={t('modelsPage.mapping.targetsEmpty', { defaultValue: '暂无已启用的模型可选' })} /> : filteredOptions.length === 0 ? <EmptyState title={t('modelsPage.mapping.noSearchResults', { defaultValue: '没有匹配的映射' })} /> : <div className={styles.pickerGroups}>{groupedOptions.map((group) => <div key={group.key} className={styles.pickerGroup}><div className={styles.pickerGroupTitle}>{group.label}</div><div className={styles.pickerItems}>{group.items.map((option) => { const key = mappingTargetKey(option); return <div key={key} className={styles.pickerItem}><SelectionCheckbox checked={selectedKeys.has(key)} onChange={(value) => toggleTarget(key, value)} disabled={disableControls || saving} label={<span className={styles.pickerLabel}>{option.iconSrc ? <img src={option.iconSrc} alt="" className={styles.tagIcon} /> : null}<span className={styles.pickerName}>{option.displayName || option.modelId}</span>{option.displayName !== option.modelId ? <span className={styles.pickerId}>{option.modelId}</span> : null}</span>} /></div>; })}</div></div>)}</div>}</div>
      </Card>
    </SecondaryScreenShell>
  );
}
