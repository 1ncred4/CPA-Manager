import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconPencil, IconPlus, IconTrash2 } from '@/components/ui/icons';
import { mappingTargetKey, type FederatedMappingRow } from './modelMapping';
import type { useModelMappingList } from './useModelMappingList';
import styles from './ModelMappingList.module.scss';

export type ModelMappingListProps = {
  list: ReturnType<typeof useModelMappingList>;
};

function MappingTargets({
  row,
  t,
}: {
  row: FederatedMappingRow;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className={styles.targetsCell}>
      {row.targets.map((target) => {
        const key = mappingTargetKey(target);
        const label =
          target.displayName !== target.modelId
            ? `${target.displayName} (${target.modelId})`
            : target.modelId;
        const isDimmed = target.suspended || !target.currentlyEnabled;
        const title = target.suspended
          ? t('modelsPage.mapping.targetSuspendedHint', {
              defaultValue: '{{label}}（已挂起：模型禁用时摘除，启用后恢复）',
              label: `${target.providerLabel} · ${label}`,
            })
          : target.currentlyEnabled
            ? `${target.providerLabel} · ${label}`
            : t('modelsPage.mapping.targetDisabledHint', {
                defaultValue: '{{label}}（当前已禁用）',
                label: `${target.providerLabel} · ${label}`,
              });
        return (
          <span
            key={key}
            className={`${styles.tag} ${isDimmed ? styles.tagDisabled : ''} ${
              target.suspended ? styles.tagSuspended : ''
            }`}
            title={title}
          >
            {target.iconSrc ? (
              <img src={target.iconSrc} alt="" className={styles.tagIcon} />
            ) : null}
            <span className={styles.tagText}>{target.displayName || target.modelId}</span>
            <span className={styles.tagProvider}>{target.providerLabel}</span>
            {target.suspended ? (
              <span className={styles.tagBadge}>
                {t('modelsPage.mapping.suspendedBadge', { defaultValue: '挂起' })}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function ModelMappingList({ list }: ModelMappingListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    manualRows,
    filteredManualRows,
    autoRows,
    filteredAutoRows,
    search,
    setSearch,
    loading,
    oauthAliasError,
    disableControls,
    deleteAlias,
    refresh,
  } = list;

  if (loading && manualRows.length === 0 && autoRows.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.loadingWrap}>
          <LoadingSpinner size={16} />
          <span>{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  const openCreate = () => navigate('/models/mapping', { state: { fromModels: true } });
  const openEdit = (alias: string) =>
    navigate(`/models/mapping?alias=${encodeURIComponent(alias)}`, {
      state: { fromModels: true },
    });
  /** 将自动渠道转为手动：进入编辑页，预填同名 alias + 已有目标 */
  const promoteAuto = (alias: string) => openEdit(alias);

  const renderTable = (
    rows: FederatedMappingRow[],
    mode: 'manual' | 'auto'
  ) => (
    <div className={styles.table}>
      <div className={styles.header}>
        <div>{t('modelsPage.mapping.columns.alias', { defaultValue: '渠道名称' })}</div>
        <div>{t('modelsPage.mapping.columns.targets', { defaultValue: '映射目标' })}</div>
        <div style={{ textAlign: 'right' }}>
          {t('modelsPage.mapping.columns.actions', { defaultValue: '操作' })}
        </div>
      </div>
      {rows.map((row) => (
        <div key={`${mode}:${row.aliasKey}`} className={styles.row}>
          <div className={styles.aliasCell} title={row.alias}>
            <span className={styles.aliasName}>{row.alias}</span>
            <span
              className={`${styles.kindBadge} ${
                mode === 'manual' ? styles.kindBadgeManual : styles.kindBadgeAuto
              }`}
            >
              {mode === 'manual'
                ? t('modelsPage.mapping.kindManualBadge', { defaultValue: '手动' })
                : t('modelsPage.mapping.kindAutoBadge', { defaultValue: '自动' })}
            </span>
          </div>
          <MappingTargets row={row} t={t} />
          <div className={styles.actionsCell}>
            <button
              type="button"
              className={styles.iconBtn}
              disabled={disableControls}
              title={
                mode === 'auto'
                  ? t('modelsPage.mapping.promoteAction', { defaultValue: '转为手动映射' })
                  : t('common.edit')
              }
              aria-label={
                mode === 'auto'
                  ? t('modelsPage.mapping.promoteAction', { defaultValue: '转为手动映射' })
                  : t('common.edit')
              }
              onClick={() => (mode === 'auto' ? promoteAuto(row.alias) : openEdit(row.alias))}
            >
              <IconPencil size={15} />
            </button>
            {mode === 'manual' ? (
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                disabled={disableControls}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                onClick={() => deleteAlias(row.alias)}
              >
                <IconTrash2 size={15} />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className={styles.root}>
      {oauthAliasError === 'unsupported' ? (
        <div className={styles.banner}>
          {t('modelsPage.mapping.oauthUnsupported', {
            defaultValue:
              '当前 CPA 版本不支持 OAuth 模型映射。下方仍会展示 API Key 侧的模型别名映射。',
          })}
        </div>
      ) : null}

      {oauthAliasError === 'load' ? (
        <div className={`${styles.banner} ${styles.bannerError}`}>
          {t('modelsPage.mapping.oauthLoadFailed', {
            defaultValue: '加载 OAuth 模型映射失败。',
          })}{' '}
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            {t('common.refresh')}
          </Button>
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('modelsPage.mapping.searchPlaceholder', {
            defaultValue: '搜索渠道名称或目标模型',
          })}
          aria-label={t('modelsPage.mapping.searchPlaceholder', {
            defaultValue: '搜索渠道名称或目标模型',
          })}
        />
        <div className={styles.meta}>
          {t('modelsPage.mapping.splitCount', {
            defaultValue: '手动 {{manual}} · 自动 {{auto}}',
            manual: filteredManualRows.length,
            auto: filteredAutoRows.length,
          })}
        </div>
        <Button size="sm" disabled={disableControls} onClick={openCreate}>
          <IconPlus size={14} />
          {t('modelsPage.mapping.add', { defaultValue: '添加手动映射' })}
        </Button>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            {t('modelsPage.mapping.manualSectionTitle', { defaultValue: '手动映射' })}
          </h2>
          <div className={styles.sectionMeta}>
            {t('modelsPage.mapping.count', {
              defaultValue: '{{shown}} / {{total}} 个映射',
              shown: filteredManualRows.length,
              total: manualRows.length,
            })}
          </div>
        </div>
        <p className={styles.sectionHint}>
          {t('modelsPage.mapping.manualSectionHint', {
            defaultValue:
              '自定义渠道名 → 一个或多个提供商模型。删除后，同名启用模型会重新出现在自动映射中。',
          })}
        </p>

        {manualRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.manualEmptyTitle', {
                defaultValue: '暂无手动映射',
              })}
              description={t('modelsPage.mapping.manualEmptyDesc', {
                defaultValue: '创建自定义渠道名，或从下方自动映射中点「转为手动」。',
              })}
              action={
                <Button size="sm" disabled={disableControls} onClick={openCreate}>
                  {t('modelsPage.mapping.add', { defaultValue: '添加手动映射' })}
                </Button>
              }
            />
          </div>
        ) : filteredManualRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.noSearchResults', {
                defaultValue: '没有匹配的映射',
              })}
            />
          </div>
        ) : (
          renderTable(filteredManualRows, 'manual')
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            {t('modelsPage.mapping.autoSectionTitle', { defaultValue: '自动映射' })}
          </h2>
          <div className={styles.sectionMeta}>
            {t('modelsPage.mapping.count', {
              defaultValue: '{{shown}} / {{total}} 个映射',
              shown: filteredAutoRows.length,
              total: autoRows.length,
            })}
          </div>
        </div>
        <p className={styles.sectionHint}>
          {t('modelsPage.mapping.autoSectionHint', {
            defaultValue:
              '未入手动映射的启用模型，按模型名自动生成渠道；多来源同名会合并为一行。',
          })}
        </p>

        {autoRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.autoEmptyTitle', {
                defaultValue: '没有自动映射',
              })}
              description={t('modelsPage.mapping.autoEmptyDesc', {
                defaultValue: '所有启用模型都已出现在手动映射中，或尚未配置模型。',
              })}
            />
          </div>
        ) : filteredAutoRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.noSearchResults', {
                defaultValue: '没有匹配的映射',
              })}
            />
          </div>
        ) : (
          renderTable(filteredAutoRows, 'auto')
        )}
      </section>
    </div>
  );
}
