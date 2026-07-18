/**
 * Quota management page - unified grid with provider filter and refresh-all.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import { authFilesApi } from '@/services/api';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  KIMI_CONFIG,
  QuotaCard,
  XAI_CONFIG,
  useGridColumns,
  useQuotaLoader,
  useQuotaPagination,
} from '@/components/quota';
import type { QuotaRenderHelpers, QuotaStatusState } from '@/components/quota/QuotaCard';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import styles from './QuotaPage.module.scss';

type QuotaType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';
type QuotaFilter = 'all' | QuotaType;

const MAX_ITEMS_PER_PAGE = 24;
const noop = () => {};

interface LooseQuotaConfig {
  type: QuotaType;
  i18nPrefix: string;
  filterFn: (file: AuthFileItem) => boolean;
  cardClassName: string;
  gridClassName: string;
  canResetQuota?: (quota: QuotaStatusState) => boolean;
  resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  renderQuotaItems: (
    quota: QuotaStatusState,
    t: TFunction,
    helpers: QuotaRenderHelpers
  ) => ReactNode;
}

interface QuotaLoaderEntry {
  quota: Record<string, unknown>;
  loadQuota: (
    targets: AuthFileItem[],
    setLoading: (loading: boolean) => void
  ) => Promise<void>;
}

interface LooseQuotaCardProps {
  item: AuthFileItem;
  quota?: QuotaStatusState;
  resolvedTheme: ResolvedTheme;
  i18nPrefix: string;
  cardClassName: string;
  defaultType: string;
  canRefresh?: boolean;
  onRefresh?: () => void;
  resetQuotaAction?: ReactNode;
  renderQuotaItems: (
    quota: QuotaStatusState,
    t: TFunction,
    helpers: QuotaRenderHelpers
  ) => ReactNode;
}

const ALL_CONFIGS = [
  CLAUDE_CONFIG,
  ANTIGRAVITY_CONFIG,
  CODEX_CONFIG,
  XAI_CONFIG,
  KIMI_CONFIG,
] as unknown as LooseQuotaConfig[];

const FILTER_OPTIONS: { value: QuotaFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'auth_files.filter_all' },
  { value: 'claude', labelKey: 'auth_files.filter_claude' },
  { value: 'antigravity', labelKey: 'auth_files.filter_antigravity' },
  { value: 'codex', labelKey: 'auth_files.filter_codex' },
  { value: 'xai', labelKey: 'auth_files.filter_xai' },
  { value: 'kimi', labelKey: 'auth_files.filter_kimi' },
];

const LooseQuotaCard = QuotaCard as unknown as (props: LooseQuotaCardProps) => ReactElement;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<QuotaFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [resettingQuotaName, setResettingQuotaName] = useState<string | null>(null);

  const disableControls = connectionStatus !== 'connected';

  const loadFiles = useCallback(async (): Promise<AuthFileItem[]> => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      const next = data?.files || [];
      setFiles(next);
      return next;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
      return [];
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleHeaderRefresh = useCallback(() => {
    void loadFiles();
  }, [loadFiles]);

  useHeaderRefresh(handleHeaderRefresh);

  const claudeLoader = useQuotaLoader(CLAUDE_CONFIG);
  const antigravityLoader = useQuotaLoader(ANTIGRAVITY_CONFIG);
  const codexLoader = useQuotaLoader(CODEX_CONFIG);
  const xaiLoader = useQuotaLoader(XAI_CONFIG);
  const kimiLoader = useQuotaLoader(KIMI_CONFIG);

  const loaders = {
    claude: claudeLoader,
    antigravity: antigravityLoader,
    codex: codexLoader,
    xai: xaiLoader,
    kimi: kimiLoader,
  } as unknown as Record<QuotaType, QuotaLoaderEntry>;

  const loadersRef = useRef(loaders);
  useEffect(() => {
    loadersRef.current = loaders;
  });
  const didAutoRefreshRef = useRef(false);

  useEffect(() => {
    void (async () => {
      const next = await loadFiles();
      if (didAutoRefreshRef.current) return;
      didAutoRefreshRef.current = true;
      await Promise.all(
        ALL_CONFIGS.map((config) => {
          const targets = next.filter(config.filterFn);
          if (targets.length === 0) return null;
          return loadersRef.current[config.type].loadQuota(targets, noop);
        })
      );
    })();
  }, [loadFiles]);

  const visibleConfigs = useMemo(
    () => (filter === 'all' ? ALL_CONFIGS : ALL_CONFIGS.filter((c) => c.type === filter)),
    [filter]
  );

  const visibleFiles = useMemo(
    () => files.filter((f) => visibleConfigs.some((c) => c.filterFn(f))),
    [files, visibleConfigs]
  );

  const [columns, gridRef] = useGridColumns(380);

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
  } = useQuotaPagination(visibleFiles, MAX_ITEMS_PER_PAGE);

  useEffect(() => {
    setPageSize(Math.min(Math.max(1, columns * 3), MAX_ITEMS_PER_PAGE));
  }, [columns, setPageSize]);

  const handleRefreshAll = useCallback(async () => {
    if (disableControls) return;
    setRefreshing(true);
    try {
      const next = await loadFiles();
      await Promise.all(
        visibleConfigs.map((config) => {
          const targets = next.filter(config.filterFn);
          if (targets.length === 0) return null;
          return loadersRef.current[config.type].loadQuota(targets, noop);
        })
      );
    } finally {
      setRefreshing(false);
    }
  }, [disableControls, loadFiles, visibleConfigs]);

  const resetQuotaForFile = useCallback(
    (config: LooseQuotaConfig, file: AuthFileItem) => {
      const resetQuota = config.resetQuota;
      if (!resetQuota) return;
      if (disableControls || file.disabled) return;
      const entry = loadersRef.current[config.type];
      if (!entry) return;
      const itemQuota = entry.quota[file.name] as QuotaStatusState | undefined;
      if (itemQuota?.status === 'loading') return;
      if (resettingQuotaName === file.name) return;

      showConfirmation({
        title: t('codex_quota.reset_confirm_title'),
        message: t('codex_quota.reset_confirm_message', { name: file.name }),
        confirmText: t('codex_quota.reset_confirm_button'),
        variant: 'primary',
        onConfirm: async () => {
          setResettingQuotaName(file.name);
          try {
            await resetQuota(file, t);
            showNotification(t('codex_quota.reset_success', { name: file.name }), 'success');
            await entry.loadQuota([file], noop);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            showNotification(t('codex_quota.reset_failed', { name: file.name, message }), 'error');
          } finally {
            setResettingQuotaName((current) => (current === file.name ? null : current));
          }
        },
      });
    },
    [disableControls, resettingQuotaName, showConfirmation, showNotification, t]
  );

  const isRefreshing = refreshing || loading;

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderInfo}>
          <h1 className={styles.pageTitle}>{t('quota_management.title')}</h1>
          <p className={styles.description}>{t('quota_management.description')}</p>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.viewModeToggle}>
            {FILTER_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant="secondary"
                size="sm"
                className={`${styles.viewModeButton} ${
                  filter === option.value ? styles.viewModeButtonActive : ''
                }`}
                onClick={() => setFilter(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className={styles.refreshAllButton}
            onClick={() => void handleRefreshAll()}
            disabled={disableControls || isRefreshing}
            loading={isRefreshing}
            title={t('quota_management.refresh_all_credentials')}
            aria-label={t('quota_management.refresh_all_credentials')}
          >
            {!isRefreshing && <IconRefreshCw size={16} />}
            {t('quota_management.refresh_all_credentials')}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {loading && visibleFiles.length === 0 ? (
        <div className={styles.quotaMessage}>{t('common.loading')}</div>
      ) : visibleFiles.length === 0 ? (
        <EmptyState
          title={t('quota_management.empty_title')}
          description={t('quota_management.empty_desc')}
        />
      ) : (
        <>
          <div ref={gridRef} className={styles.unifiedGrid}>
            {pageItems.map((file) => {
              const config = visibleConfigs.find((c) => c.filterFn(file));
              if (!config) return null;
              const entry = loaders[config.type];
              const itemQuota = entry?.quota[file.name] as QuotaStatusState | undefined;
              const isResettingQuota = resettingQuotaName === file.name;
              const canUseQuotaAction =
                !disableControls && !file.disabled && itemQuota?.status !== 'loading';
              const showResetQuotaAction =
                itemQuota !== undefined && Boolean(config.canResetQuota?.(itemQuota));
              const resetQuotaAction =
                config.resetQuota && showResetQuotaAction ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className={styles.quotaResetCreditButton}
                    onClick={() => resetQuotaForFile(config, file)}
                    disabled={!canUseQuotaAction || isResettingQuota}
                    loading={isResettingQuota}
                    title={t('codex_quota.reset_button')}
                    aria-label={t('codex_quota.reset_button')}
                  >
                    {!isResettingQuota && <IconRefreshCw size={14} />}
                    {t('codex_quota.reset_button')}
                  </Button>
                ) : undefined;

              return (
                <LooseQuotaCard
                  key={file.name}
                  item={file}
                  quota={itemQuota}
                  resolvedTheme={resolvedTheme}
                  i18nPrefix={config.i18nPrefix}
                  cardClassName={config.cardClassName}
                  defaultType={config.type}
                  canRefresh={canUseQuotaAction && !isResettingQuota}
                  onRefresh={() => {
                    void loaders[config.type].loadQuota([file], noop);
                  }}
                  resetQuotaAction={resetQuotaAction}
                  renderQuotaItems={config.renderQuotaItems}
                />
              );
            })}
          </div>
          {visibleFiles.length > pageSize && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrev}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: visibleFiles.length,
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNext}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
