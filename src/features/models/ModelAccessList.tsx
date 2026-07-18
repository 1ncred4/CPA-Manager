import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useModelAccessList } from './useModelAccessList';
import type { ModelAccessRow } from './modelAccessRows';
import styles from './ModelAccessList.module.scss';

export type ModelAccessListProps = {
  list: ReturnType<typeof useModelAccessList>;
};

function lockTitle(
  row: ModelAccessRow,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  if (row.lockReason === 'wildcard') {
    return t('modelsPage.access.lockedByWildcard', {
      defaultValue: 'Locked by wildcard rule {{rule}}',
      rule: row.lockDetail ?? '*',
    });
  }
  if (row.lockReason === 'entry-disabled') {
    return t('modelsPage.access.lockedByEntry', {
      defaultValue: 'Provider entry is disabled. Enable it on the AI Providers page.',
    });
  }
  if (row.lockReason === 'unsupported') {
    return t('modelsPage.access.unsupportedExclude', {
      defaultValue: 'This provider does not support per-model exclusion.',
    });
  }
  return undefined;
}

export function ModelAccessList({ list }: ModelAccessListProps) {
  const { t } = useTranslation();
  const {
    rows,
    filteredRows,
    search,
    setSearch,
    loading,
    oauthExcludedError,
    disableControls,
    toggleRow,
    pendingKeys,
    refresh,
  } = list;

  if (loading && rows.length === 0) {
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
      {oauthExcludedError === 'unsupported' ? (
        <div className={styles.banner}>
          {t('modelsPage.access.oauthUnsupportedBanner', {
            defaultValue:
              'This CPA version does not support OAuth model exclusion. API Key models below can still be managed.',
          })}
        </div>
      ) : null}

      {oauthExcludedError === 'load' ? (
        <div className={`${styles.banner} ${styles.bannerError}`}>
          {t('modelsPage.access.oauthLoadFailed', {
            defaultValue: 'Failed to load OAuth model exclusion rules.',
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
          placeholder={t('modelsPage.access.searchPlaceholder', {
            defaultValue: 'Search models or providers',
          })}
          aria-label={t('modelsPage.access.searchPlaceholder', {
            defaultValue: 'Search models or providers',
          })}
        />
        <div className={styles.meta}>
          {t('modelsPage.access.count', {
            defaultValue: '{{shown}} / {{total}} models',
            shown: filteredRows.length,
            total: rows.length,
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title={t('modelsPage.access.emptyTitle', {
              defaultValue: 'No models available',
            })}
            description={t('modelsPage.access.emptyDesc', {
              defaultValue:
                'OAuth model definitions and configured API Key models will appear here.',
            })}
          />
        </div>
      ) : filteredRows.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title={t('modelsPage.access.noSearchResults', {
              defaultValue: 'No matching models',
            })}
          />
        </div>
      ) : (
        <div className={styles.sections}>
          {(['apiKey', 'oauth'] as const).map((source) => {
            const sectionRows = filteredRows.filter((row) => row.source === source);
            if (sectionRows.length === 0) return null;

            const sectionTitle =
              source === 'apiKey'
                ? t('modelsPage.access.sectionApiKey', {
                    defaultValue: 'API Key providers',
                  })
                : t('modelsPage.access.sectionOauth', {
                    defaultValue: 'OAuth providers',
                  });

            return (
              <div key={source} className={styles.section}>
                <div className={styles.sectionTitle}>{sectionTitle}</div>
                <div
                  className={styles.table}
                  role="table"
                  aria-label={sectionTitle}
                >
                  <div className={styles.header} role="row">
                    <div role="columnheader">
                      {t('modelsPage.access.columnModel', { defaultValue: 'Model' })}
                    </div>
                    <div role="columnheader">
                      {t('modelsPage.access.columnProvider', { defaultValue: 'Provider' })}
                    </div>
                    <div role="columnheader" style={{ textAlign: 'right' }}>
                      {t('modelsPage.access.columnEnabled', { defaultValue: 'Enabled' })}
                    </div>
                  </div>

                  {sectionRows.map((row) => {
                    const pending = pendingKeys.has(row.key);
                    const toggleOff =
                      disableControls ||
                      row.toggleDisabled ||
                      pending ||
                      !row.supportsExclude;
                    const title = lockTitle(row, t);
                    const showSecondaryId =
                      row.displayName.trim().toLowerCase() !==
                      row.modelId.trim().toLowerCase();

                    return (
                      <div key={row.key} className={styles.row} role="row" title={title}>
                        <div className={styles.modelCell} role="cell">
                          {row.iconSrc ? (
                            <img src={row.iconSrc} alt="" className={styles.icon} />
                          ) : (
                            <span className={styles.iconFallback} aria-hidden />
                          )}
                          <div className={styles.modelText}>
                            <span className={styles.modelName}>{row.displayName}</span>
                            {showSecondaryId ? (
                              <span className={styles.modelId}>{row.modelId}</span>
                            ) : null}
                          </div>
                        </div>
                        <div className={styles.providerCell} role="cell">
                          {row.providerLabel}
                        </div>
                        <div className={styles.toggleCell} role="cell">
                          <ToggleSwitch
                            checked={row.enabled}
                            disabled={toggleOff}
                            ariaLabel={t('modelsPage.access.toggleAria', {
                              defaultValue: 'Toggle {{model}}',
                              model: row.displayName,
                            })}
                            onChange={(value) => {
                              void toggleRow(row, value);
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
