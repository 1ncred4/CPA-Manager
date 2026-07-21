/**
 * 模型映射 Tab：从 store 投影联邦映射列表（手动 + 自动）。
 *
 * Phase 3 重构后：本 hook 是纯 selector--不 fetch、不持有数据 state、不监听 localStorage。
 * 数据由 useModelAccessList 的 loadAll fetch + store.load 写入共享 store；本 hook 只读取并投影。
 * deleteAlias 委托 store.deleteAlias（planAliasDelete -> applier）；乐观更新 / 回滚由 store 处理。
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore, useNotificationStore } from '@/stores';
import { useModelManagementStore } from '@/stores/useModelManagementStore';
import type { ProviderResource } from '@/features/providers/types';
import type { OAuthModelAliasEntry } from '@/types';
import type { OAuthConfigLoadError } from '@/features/authFiles/constants';
import type { ModelAccessRow } from './modelAccessRows';
import { mergeSuspendedIntoFederatedRows, type SuspendedMapping } from './mappingSuspend';
import { applyManagedIdentityExcludeDisplayMaskWithKeys } from './managedIdentityExclude';
import {
  assembleManualAndAutoMappingRows,
  buildEnabledMappingOptions,
  buildFederatedMappingRows,
  buildUnmappedModels,
  collectMappedTargetKeys,
  filterFederatedMappingRows,
  filterUnmappedModels,
  isManualMappingRow,
  toAliasKey,
  type FederatedMappingRow,
  type MappingPickerOption,
  type UnmappedModelRow,
} from './modelMapping';

export type UseModelMappingListResult = {
  rows: FederatedMappingRow[];
  filteredRows: FederatedMappingRow[];
  manualRows: FederatedMappingRow[];
  filteredManualRows: FederatedMappingRow[];
  autoRows: FederatedMappingRow[];
  filteredAutoRows: FederatedMappingRow[];
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

export function useModelMappingList(): UseModelMappingListResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const showConfirmation = useNotificationStore((s) => s.showConfirmation);
  const connectionStatus = useAuthStore((s) => s.connectionStatus);

  const disableControls = connectionStatus !== 'connected';
  const [search, setSearch] = useState('');

  const accessCurrent = useModelManagementStore((s) => s.accessCurrent);
  const managedExcludeKeys = useModelManagementStore((s) => s.managedExcludeKeys);
  const oauthAliasMap = useModelManagementStore((s) => s.oauthAliasMap);
  const catalogs = useModelManagementStore((s) => s.catalogs);
  const ctx = useModelManagementStore((s) => s.ctx);
  const loading = useModelManagementStore((s) => s.loading);
  const oauthAliasError = useModelManagementStore((s) => s.oauthAliasError);
  const currentMirrors = useModelManagementStore((s) => s.currentMirrors);
  const deleteAliasAction = useModelManagementStore((s) => s.deleteAlias);

  const allApiKeyResources = catalogs.resources;

  const accessRows = useMemo<ModelAccessRow[]>(
    () => Array.from(accessCurrent.byKey.values()),
    [accessCurrent]
  );

  const displayAccessRows = useMemo(
    () => applyManagedIdentityExcludeDisplayMaskWithKeys(accessRows, managedExcludeKeys),
    [accessRows, managedExcludeKeys]
  );

  const enabledKeySet = useMemo(() => {
    const set = new Set<string>();
    accessRows.forEach((row) => {
      if (row.enabled) set.add(row.key);
    });
    return set;
  }, [accessRows]);

  const suspendedList = useMemo<SuspendedMapping[]>(
    () => Array.from(currentMirrors.mappingSuspend.values()).flat(),
    [currentMirrors]
  );

  const { manualRows, autoRows, rows } = useMemo(() => {
    if (!ctx) {
      return { manualRows: [], autoRows: [], rows: [] as FederatedMappingRow[] };
    }
    const oauthDisplayNames = ctx.oauthDisplayNames;
    const baseRows = buildFederatedMappingRows({
      modelAlias: oauthAliasMap,
      resources: allApiKeyResources,
      oauthDisplayNames,
      enabledKeySet,
      providerLabels: {
        oauth: (channel) => ctx.oauthProviderLabel(channel),
        apiKey: (resource) => ctx.apiKeyProviderLabel(resource.id, resource.brand),
      },
      icons: {
        oauth: (channel) => ctx.oauthIcon(channel),
        apiKey: (resource) => ctx.apiKeyIcon(resource.id, resource.brand),
      },
    });

    const withSuspended = mergeSuspendedIntoFederatedRows(baseRows, suspendedList, {
      oauthDisplayNames,
      providerLabels: {
        oauth: (channel) => ctx.oauthProviderLabel(channel),
        apiKey: (resourceId, brand) => ctx.apiKeyProviderLabel(resourceId, brand),
      },
      icons: {
        oauth: (channel) => ctx.oauthIcon(channel),
        apiKey: (resourceId, brand) => ctx.apiKeyIcon(resourceId, brand),
      },
    });

    const claims = currentMirrors.claims;
    const split = assembleManualAndAutoMappingRows(withSuspended, accessRows, claims);
    return {
      manualRows: split.manualRows,
      autoRows: split.autoRows,
      rows: [...split.manualRows, ...split.autoRows],
    };
  }, [
    ctx,
    oauthAliasMap,
    allApiKeyResources,
    enabledKeySet,
    suspendedList,
    currentMirrors.claims,
    accessRows,
  ]);

  const filteredManualRows = useMemo(
    () => filterFederatedMappingRows(manualRows, search),
    [manualRows, search]
  );
  const filteredAutoRows = useMemo(
    () => filterFederatedMappingRows(autoRows, search),
    [autoRows, search]
  );
  const filteredRows = useMemo(
    () => [...filteredManualRows, ...filteredAutoRows],
    [filteredAutoRows, filteredManualRows]
  );

  const unmappedRows = useMemo(() => {
    const mappedKeys = collectMappedTargetKeys(rows);
    return buildUnmappedModels(accessRows, mappedKeys);
  }, [accessRows, rows]);

  const filteredUnmappedRows = useMemo(
    () => filterUnmappedModels(unmappedRows, search),
    [search, unmappedRows]
  );

  const enabledOptions = useMemo(
    () => buildEnabledMappingOptions(displayAccessRows),
    [displayAccessRows]
  );

  const existingAliasKeys = useMemo(
    () => manualRows.map((row) => row.aliasKey),
    [manualRows]
  );

  const deleteAlias = useCallback(
    (alias: string) => {
      const aliasKey = toAliasKey(alias);
      const row = rows.find((r) => r.aliasKey === aliasKey);
      if (!row) return;

      if (!isManualMappingRow(row)) {
        showNotification(
          t('modelsPage.mapping.autoDeleteHint', {
            defaultValue:
              '自动映射由启用模型自动生成，无需删除。可点击编辑转为手动映射。',
          }),
          'info'
        );
        return;
      }

      showConfirmation({
        title: t('modelsPage.mapping.deleteTitle', { defaultValue: '删除映射' }),
        message: t('modelsPage.mapping.deleteConfirm', {
          defaultValue:
            '确定删除自定义模型「{{alias}}」的手动映射？删除后同名启用模型会重新出现在自动映射中。',
          alias: row.alias,
        }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          const result = await deleteAliasAction(aliasKey);
          if (result.ok) {
            showNotification(
              t('modelsPage.mapping.deleteSuccess', {
                defaultValue: '手动映射已删除，同名模型已回到自动映射',
              }),
              'success'
            );
          } else {
            showNotification(
              t('modelsPage.mapping.saveFailed', { defaultValue: '保存映射失败' }),
              'error'
            );
          }
        },
      });
    },
    [rows, showConfirmation, showNotification, t, deleteAliasAction]
  );

  return {
    rows,
    filteredRows,
    manualRows,
    filteredManualRows,
    autoRows,
    filteredAutoRows,
    unmappedRows,
    filteredUnmappedRows,
    search,
    setSearch,
    loading,
    oauthAliasError,
    disableControls,
    refresh: async () => {
      /* 数据由 useModelAccessList.loadAll 统一刷新；本 hook 为纯 selector */
    },
    deleteAlias,
    enabledOptions,
    modelAlias: oauthAliasMap,
    resources: allApiKeyResources,
    existingAliasKeys,
  };
}
