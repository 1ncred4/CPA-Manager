import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconPencil, IconPlus, IconTrash2 } from '@/components/ui/icons';
import { mappingTargetKey } from './modelMapping';
import type { useModelMappingList } from './useModelMappingList';
import styles from './ModelMappingList.module.scss';

export type ModelMappingListProps = {
  list: ReturnType<typeof useModelMappingList>;
};

export function ModelMappingList({ list }: ModelMappingListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    rows,
    filteredRows,
    unmappedRows,
    filteredUnmappedRows,
    search,
    setSearch,
    loading,
    oauthAliasError,
    disableControls,
    deleteAlias,
    refresh,
  } = list;

  if (loading && rows.length === 0 && unmappedRows.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.loadingWrap}>
          <LoadingSpinner size={16} />
          <span>{t('common.loading')}</span>
        </div>
      </div>
    );
  }

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
            defaultValue: '搜索自定义名称或目标模型',
          })}
          aria-label={t('modelsPage.mapping.searchPlaceholder', {
            defaultValue: '搜索自定义名称或目标模型',
          })}
        />
        <div className={styles.meta}>
          {t('modelsPage.mapping.count', {
            defaultValue: '{{shown}} / {{total}} 个映射',
            shown: filteredRows.length,
            total: rows.length,
          })}
        </div>
        <Button
          size="sm"
          disabled={disableControls}
          onClick={() => navigate('/models/mapping', { state: { fromModels: true } })}
        >
          <IconPlus size={14} />
          {t('modelsPage.mapping.add', { defaultValue: '添加映射' })}
        </Button>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            {t('modelsPage.mapping.mappedSectionTitle', { defaultValue: '已映射' })}
          </h2>
          <div className={styles.sectionMeta}>
            {t('modelsPage.mapping.count', {
              defaultValue: '{{shown}} / {{total}} 个映射',
              shown: filteredRows.length,
              total: rows.length,
            })}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.emptyTitle', { defaultValue: '暂无模型映射' })}
              description={t('modelsPage.mapping.emptyDesc', {
                defaultValue: '将自定义模型名映射到一个或多个已启用的提供商模型。',
              })}
              action={
                <Button
                  size="sm"
                  disabled={disableControls}
                  onClick={() => navigate('/models/mapping', { state: { fromModels: true } })}
                >
                  {t('modelsPage.mapping.add', { defaultValue: '添加映射' })}
                </Button>
              }
            />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.noSearchResults', {
                defaultValue: '没有匹配的映射',
              })}
            />
          </div>
        ) : (
          <div className={styles.table}>
            <div className={styles.header}>
              <div>{t('modelsPage.mapping.columns.alias', { defaultValue: '自定义模型名' })}</div>
              <div>{t('modelsPage.mapping.columns.targets', { defaultValue: '映射目标' })}</div>
              <div style={{ textAlign: 'right' }}>
                {t('modelsPage.mapping.columns.actions', { defaultValue: '操作' })}
              </div>
            </div>
            {filteredRows.map((row) => (
              <div key={row.aliasKey} className={styles.row}>
                <div className={styles.aliasCell} title={row.alias}>
                  {row.alias}
                </div>
                <div className={styles.targetsCell}>
                  {row.targets.map((target) => {
                    const key = mappingTargetKey(target);
                    const label =
                      target.displayName !== target.modelId
                        ? `${target.displayName} (${target.modelId})`
                        : target.modelId;
                    return (
                      <span
                        key={key}
                        className={`${styles.tag} ${target.currentlyEnabled ? '' : styles.tagDisabled}`}
                        title={
                          target.currentlyEnabled
                            ? `${target.providerLabel} · ${label}`
                            : t('modelsPage.mapping.targetDisabledHint', {
                                defaultValue: '{{label}}（当前已禁用）',
                                label: `${target.providerLabel} · ${label}`,
                              })
                        }
                      >
                        {target.iconSrc ? (
                          <img src={target.iconSrc} alt="" className={styles.tagIcon} />
                        ) : null}
                        <span className={styles.tagText}>
                          {target.displayName || target.modelId}
                        </span>
                        <span className={styles.tagProvider}>{target.providerLabel}</span>
                      </span>
                    );
                  })}
                </div>
                <div className={styles.actionsCell}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    disabled={disableControls}
                    title={t('common.edit')}
                    aria-label={t('common.edit')}
                    onClick={() =>
                      navigate(`/models/mapping?alias=${encodeURIComponent(row.alias)}`, {
                        state: { fromModels: true },
                      })
                    }
                  >
                    <IconPencil size={15} />
                  </button>
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
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            {t('modelsPage.mapping.unmappedSectionTitle', { defaultValue: '未映射模型' })}
          </h2>
          <div className={styles.sectionMeta}>
            {t('modelsPage.mapping.unmappedCount', {
              defaultValue: '{{shown}} / {{total}} 个模型',
              shown: filteredUnmappedRows.length,
              total: unmappedRows.length,
            })}
          </div>
        </div>

        {unmappedRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.unmappedEmptyTitle', {
                defaultValue: '没有未映射模型',
              })}
              description={t('modelsPage.mapping.unmappedEmptyDesc', {
                defaultValue: '当前目录中的模型都已分配到某个自定义名称。',
              })}
            />
          </div>
        ) : filteredUnmappedRows.length === 0 ? (
          <div className={styles.emptyWrap}>
            <EmptyState
              title={t('modelsPage.mapping.unmappedNoSearchResults', {
                defaultValue: '没有匹配的未映射模型',
              })}
            />
          </div>
        ) : (
          <div className={styles.table}>
            <div className={styles.unmappedHeader}>
              <div>{t('modelsPage.mapping.columns.model', { defaultValue: '模型' })}</div>
              <div>{t('modelsPage.mapping.columns.provider', { defaultValue: '提供商' })}</div>
              <div style={{ textAlign: 'right' }}>
                {t('modelsPage.mapping.columns.actions', { defaultValue: '操作' })}
              </div>
            </div>
            {filteredUnmappedRows.map((row) => {
              const key = mappingTargetKey(row);
              return (
                <div key={key} className={styles.unmappedRow}>
                  <div className={styles.modelCell}>
                    {row.iconSrc ? (
                      <img src={row.iconSrc} alt="" className={styles.modelIcon} />
                    ) : (
                      <span className={styles.modelIconFallback} />
                    )}
                    <div className={styles.modelText}>
                      <div className={styles.modelName} title={row.displayName || row.modelId}>
                        {row.displayName || row.modelId}
                      </div>
                      {row.displayName && row.displayName !== row.modelId ? (
                        <div className={styles.modelId} title={row.modelId}>
                          {row.modelId}
                        </div>
                      ) : null}
                      {!row.enabled ? (
                        <div className={styles.disabledBadge}>
                          {t('modelsPage.mapping.modelDisabled', { defaultValue: '已禁用' })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className={styles.providerCell} title={row.providerLabel}>
                    {row.providerLabel}
                  </div>
                  <div className={styles.actionsCell}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={disableControls || !row.enabled}
                      title={
                        row.enabled
                          ? undefined
                          : t('modelsPage.mapping.unmappedDisabledHint', {
                              defaultValue: '请先在「模型禁用」中启用该模型',
                            })
                      }
                      onClick={() =>
                        navigate(
                          `/models/mapping?preselect=${encodeURIComponent(key)}`,
                          { state: { fromModels: true } }
                        )
                      }
                    >
                      {t('modelsPage.mapping.mapAction', { defaultValue: '添加映射' })}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
