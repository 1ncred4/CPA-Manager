import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconPencil, IconPlus, IconTrash2 } from '@/components/ui/icons';
import { mappingTargetKey, type FederatedMappingRow } from './modelMapping';
import type { useModelMappingList } from './useModelMappingList';
import styles from './ModelMappingList.module.scss';

export type ModelMappingListProps = { list: ReturnType<typeof useModelMappingList> };

function MappingTargets({ row, t }: { row: FederatedMappingRow; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className={styles.targetsCell}>
      {row.targets.map((target) => {
        const disabled = target.suspended || !target.currentlyEnabled;
        const label = target.displayName !== target.modelId ? `${target.displayName} (${target.modelId})` : target.modelId;
        return (
          <span
            key={mappingTargetKey(target)}
            className={`${styles.tag} ${disabled ? styles.tagDisabled : ''}`}
            title={`${target.providerLabel} · ${label}`}
          >
            {target.iconSrc ? <img src={target.iconSrc} alt="" className={styles.tagIcon} /> : null}
            <span className={styles.tagText}>{target.displayName || target.modelId}</span>
            <span className={styles.tagProvider}>{target.providerLabel}</span>
            {disabled ? <span className={styles.tagBadge}>{t('modelsPage.mapping.disabledBadge', { defaultValue: '禁用' })}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

export function ModelMappingList({ list }: ModelMappingListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { rows, filteredRows, search, setSearch, loading, oauthAliasError, disableControls, deleteAlias, refresh } = list;
  const openCreate = () => navigate('/models/mapping', { state: { fromModels: true } });
  const openEdit = (alias: string) => navigate(`/models/mapping?alias=${encodeURIComponent(alias)}`, { state: { fromModels: true } });

  if (loading && rows.length === 0) {
    return <div className={styles.root}><div className={styles.loadingWrap}><LoadingSpinner size={16} /><span>{t('common.loading')}</span></div></div>;
  }

  return (
    <div className={styles.root}>
      {oauthAliasError === 'unsupported' ? <div className={styles.banner}>{t('modelsPage.mapping.oauthUnsupported', { defaultValue: '当前 CPA 版本不支持 OAuth 模型映射。' })}</div> : null}
      {oauthAliasError === 'load' ? <div className={`${styles.banner} ${styles.bannerError}`}>{t('modelsPage.mapping.oauthLoadFailed', { defaultValue: '加载 OAuth 模型映射失败。' })} <Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('common.refresh')}</Button></div> : null}
      <div className={styles.toolbar}>
        <input className={styles.search} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('modelsPage.mapping.searchPlaceholder', { defaultValue: '搜索渠道名称或目标模型' })} aria-label={t('modelsPage.mapping.searchPlaceholder', { defaultValue: '搜索渠道名称或目标模型' })} />
        <div className={styles.meta}>{t('modelsPage.mapping.count', { defaultValue: '{{shown}} / {{total}} 个映射', shown: filteredRows.length, total: rows.length })}</div>
        <Button size="sm" disabled={disableControls} onClick={openCreate}><IconPlus size={14} />{t('modelsPage.mapping.add', { defaultValue: '添加模型映射' })}</Button>
      </div>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t('modelsPage.mapping.sectionTitle', { defaultValue: '模型映射' })}</h2>
          <div className={styles.sectionMeta}>{t('modelsPage.mapping.count', { defaultValue: '{{shown}} / {{total}} 个映射', shown: filteredRows.length, total: rows.length })}</div>
        </div>
        <p className={styles.sectionHint}>{t('modelsPage.mapping.sectionHint', { defaultValue: '相同 alias 的 OAuth 与 API Key 目标会合并为同一渠道。' })}</p>
        {rows.length === 0 ? (
          <div className={styles.emptyWrap}><EmptyState title={t('modelsPage.mapping.emptyTitle', { defaultValue: '暂无模型映射' })} description={t('modelsPage.mapping.emptyDesc', { defaultValue: '创建一个 alias 并选择模型目标。' })} action={<Button size="sm" disabled={disableControls} onClick={openCreate}>{t('modelsPage.mapping.add', { defaultValue: '添加模型映射' })}</Button>} /></div>
        ) : filteredRows.length === 0 ? (
          <div className={styles.emptyWrap}><EmptyState title={t('modelsPage.mapping.noSearchResults', { defaultValue: '没有匹配的映射' })} /></div>
        ) : (
          <div className={styles.table}>
            <div className={styles.header}><div>{t('modelsPage.mapping.columns.alias', { defaultValue: '渠道名称' })}</div><div>{t('modelsPage.mapping.columns.targets', { defaultValue: '映射目标' })}</div><div style={{ textAlign: 'right' }}>{t('modelsPage.mapping.columns.actions', { defaultValue: '操作' })}</div></div>
            {filteredRows.map((row) => <div key={row.aliasKey} className={styles.row}>
              <div className={styles.aliasCell} title={row.alias}><span className={styles.aliasName}>{row.alias}</span></div>
              <MappingTargets row={row} t={t} />
              <div className={styles.actionsCell}>
                <button type="button" className={styles.iconBtn} disabled={disableControls} title={t('common.edit')} aria-label={t('common.edit')} onClick={() => openEdit(row.alias)}><IconPencil size={15} /></button>
                <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} disabled={disableControls} title={t('common.delete')} aria-label={t('common.delete')} onClick={() => deleteAlias(row.alias)}><IconTrash2 size={15} /></button>
              </div>
            </div>)}
          </div>
        )}
      </section>
    </div>
  );
}
