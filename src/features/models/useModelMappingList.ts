import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore, useNotificationStore } from '@/stores';
import { useModelManagementStore } from '@/stores/useModelManagementStore';
import type { ProviderResource } from '@/features/providers/types';
import type { OAuthModelAliasEntry } from '@/types';
import type { OAuthConfigLoadError } from '@/features/authFiles/constants';
import type { ModelMappingChannel } from './modelManagementState';
import type { ModelAccessRow } from './modelAccessRows';
import {
  buildEnabledMappingOptions,
  buildUnmappedModels,
  collectMappedTargetKeys,
  filterFederatedMappingRows,
  filterUnmappedModels,
  mappingTargetKey,
  toAliasKey,
  type FederatedMappingRow,
  type MappingPickerOption,
  type MappingTarget,
  type UnmappedModelRow,
} from './modelMapping';

export type UseModelMappingListResult = {
  rows: FederatedMappingRow[];
  filteredRows: FederatedMappingRow[];
  unmappedRows: UnmappedModelRow[];
  filteredUnmappedRows: UnmappedModelRow[];
  search: string;
  setSearch: (value: string) => void;
  loading: boolean;
  oauthAliasError: OAuthConfigLoadError;
  disableControls: boolean;
  refresh: () => Promise<void>;
  deleteAlias: (alias: string) => void;
  enabledOptions: MappingPickerOption[];
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  resources: ProviderResource[];
  existingAliasKeys: string[];
};

function asFederatedRow(
  channel: ModelMappingChannel,
  access: Map<string, ModelAccessRow>
): FederatedMappingRow {
  const targets: MappingTarget[] = channel.targets.map((target) => {
    const key = mappingTargetKey(target);
    const accessRow = access.get(key);
    return {
      ...target,
      currentlyEnabled: accessRow?.enabled ?? target.disabledReason !== 'model',
      suspended: target.suspended,
    };
  });
  return { alias: channel.alias, aliasKey: channel.aliasKey, targets };
}

export function useModelMappingList(): UseModelMappingListResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const showConfirmation = useNotificationStore((s) => s.showConfirmation);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);
  const disableControls = connectionStatus !== 'connected';
  const [search, setSearch] = useState('');

  const accessCurrent = useModelManagementStore((s) => s.accessCurrent);
  const mappingCurrent = useModelManagementStore((s) => s.mappingCurrent);
  const oauthAliasMap = useModelManagementStore((s) => s.oauthAliasMap);
  const catalogs = useModelManagementStore((s) => s.catalogs);
  const loading = useModelManagementStore((s) => s.loading);
  const oauthAliasError = useModelManagementStore((s) => s.oauthAliasError);
  const deleteAliasAction = useModelManagementStore((s) => s.deleteAlias);

  const accessRows = useMemo<ModelAccessRow[]>(() => Array.from(accessCurrent.byKey.values()), [accessCurrent]);
  const accessByKey = useMemo(() => new Map(accessRows.map((row) => [row.key, row])), [accessRows]);
  const rows = useMemo<FederatedMappingRow[]>(
    () => Array.from(mappingCurrent.byAliasKey.values()).map((channel) => asFederatedRow(channel, accessByKey)),
    [accessByKey, mappingCurrent]
  );
  const filteredRows = useMemo(() => filterFederatedMappingRows(rows, search), [rows, search]);
  const unmappedRows = useMemo(
    () => buildUnmappedModels(accessRows, collectMappedTargetKeys(rows)),
    [accessRows, rows]
  );
  const filteredUnmappedRows = useMemo(
    () => filterUnmappedModels(unmappedRows, search),
    [search, unmappedRows]
  );
  const enabledOptions = useMemo(() => buildEnabledMappingOptions(accessRows), [accessRows]);
  const deleteAlias = useCallback(
    (alias: string) => {
      const row = rows.find((item) => item.aliasKey === toAliasKey(alias));
      if (!row) return;
      showConfirmation({
        title: t('modelsPage.mapping.deleteTitle', { defaultValue: '删除映射' }),
        message: t('modelsPage.mapping.deleteConfirm', {
          defaultValue: '确定删除模型渠道「{{alias}}」的映射？',
          alias: row.alias,
        }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          const result = await deleteAliasAction(row.aliasKey);
          showNotification(
            result.ok
              ? t('modelsPage.mapping.deleteSuccess', { defaultValue: '映射已删除' })
              : t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' }),
            result.ok ? 'success' : 'error'
          );
        },
      });
    },
    [deleteAliasAction, rows, showConfirmation, showNotification, t]
  );

  return {
    rows,
    filteredRows,
    unmappedRows,
    filteredUnmappedRows,
    search,
    setSearch,
    loading,
    oauthAliasError,
    disableControls,
    refresh: async () => undefined,
    deleteAlias,
    enabledOptions,
    modelAlias: oauthAliasMap,
    resources: catalogs.resources,
    existingAliasKeys: rows.map((row) => row.aliasKey),
  };
}
