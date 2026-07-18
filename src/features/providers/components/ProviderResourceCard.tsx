import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconEye, IconPencil, IconTrash2 } from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import {
  getOpenAIProviderRecentStatusData,
  getOpenAIProviderTotalStats,
  getProviderRecentStatusData,
  getProviderTotalStats,
  type ProviderRecentUsageMap,
} from '@/components/providers/utils';
import type { OpenAIProviderConfig } from '@/types';
import type { StatusBarData } from '@/utils/recentRequests';
import { useThemeStore } from '@/stores';
import { getTypeColor, type ResolvedTheme, type ThemeColors } from '@/features/authFiles/constants';
import { PROVIDER_LOGOS } from '../brandLogos';
import type { ProviderBrand, ProviderResource } from '../types';
import styles from './ProviderResourceCard.module.scss';

export interface ProviderResourceCardProps {
  resource: ProviderResource;
  selected?: boolean;
  disableMutations?: boolean;
  usageByProvider?: ProviderRecentUsageMap;
  onView: (resource: ProviderResource) => void;
  onEdit: (resource: ProviderResource) => void;
  onDelete: (resource: ProviderResource) => void;
  onToggleDisabled?: (resource: ProviderResource, disabled: boolean) => void;
}

const OPENAI_COMPAT_COLORS: Record<ResolvedTheme, ThemeColors> = {
  light: { bg: '#f0f2f5', text: '#2f343c' },
  dark: { bg: '#373c42', text: '#cfd3db' },
};

const BRAND_COLOR_KEY: Record<ProviderBrand, string> = {
  gemini: 'gemini',
  claude: 'claude',
  codex: 'codex',
  xai: 'xai',
  vertex: 'vertex',
  openaiCompatibility: 'openaiCompatibility',
};

const getUsageProvider = (resource: ProviderResource): string => resource.brand;

const resolveBrandColor = (brand: ProviderBrand, resolvedTheme: ResolvedTheme): ThemeColors => {
  if (brand === 'openaiCompatibility') {
    return OPENAI_COMPAT_COLORS[resolvedTheme];
  }
  return getTypeColor(BRAND_COLOR_KEY[brand], resolvedTheme);
};

const resolveStatusBarData = (
  resource: ProviderResource,
  usageByProvider: ProviderRecentUsageMap
): StatusBarData => {
  if (resource.brand === 'openaiCompatibility') {
    return getOpenAIProviderRecentStatusData(resource.raw as OpenAIProviderConfig, usageByProvider);
  }
  return getProviderRecentStatusData(
    usageByProvider,
    getUsageProvider(resource),
    resource.apiKey ?? undefined,
    resource.baseUrl ?? undefined
  );
};

const resolveTotalStats = (
  resource: ProviderResource,
  usageByProvider: ProviderRecentUsageMap
): { success: number; failure: number } => {
  if (resource.brand === 'openaiCompatibility') {
    return getOpenAIProviderTotalStats(resource.raw as OpenAIProviderConfig, usageByProvider);
  }
  return getProviderTotalStats(
    usageByProvider,
    getUsageProvider(resource),
    resource.apiKey ?? undefined,
    resource.baseUrl ?? undefined
  );
};

export function ProviderResourceCard({
  resource,
  selected,
  disableMutations,
  usageByProvider,
  onView,
  onEdit,
  onDelete,
  onToggleDisabled,
}: ProviderResourceCardProps) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const logo = PROVIDER_LOGOS[resource.brand];
  const brandTitle = t(`providersPage.providerNames.${resource.brand}`);
  const typeColor = resolveBrandColor(resource.brand, resolvedTheme);

  const primaryTitle =
    resource.brand === 'openaiCompatibility'
      ? (resource.name ?? resource.identifier)
      : (resource.apiKeyPreview ?? resource.identifier);

  const primarySub =
    resource.brand === 'openaiCompatibility'
      ? resource.apiKeyPreview
        ? resource.apiKeyEntryCount > 1
          ? `${resource.apiKeyPreview} · +${resource.apiKeyEntryCount - 1}`
          : resource.apiKeyPreview
        : resource.authIndex
          ? `auth: ${resource.authIndex}`
          : null
      : resource.authIndex
        ? `auth: ${resource.authIndex}`
        : null;

  const baseUrlDisplay =
    resource.brand === 'claude' && !resource.baseUrl
      ? `https://api.anthropic.com ${t('providersPage.status.defaultSuffix')}`
      : (resource.baseUrl ?? t('providersPage.status.notSet'));

  const stats = usageByProvider
    ? resolveTotalStats(resource, usageByProvider)
    : { success: 0, failure: 0 };
  const statusData = usageByProvider ? resolveStatusBarData(resource, usageByProvider) : null;

  const stateLabel = resource.disabled
    ? t('providersPage.status.disabled')
    : t('providersPage.status.active');
  const stateBadgeClass = resource.disabled ? styles.stateBadgeDisabled : styles.stateBadgeActive;

  const metrics: ReactNode[] = [];
  metrics.push(
    <span key="models" className={styles.metric}>
      <span className={styles.metricLabel}>{t('providersPage.table.metrics.models')}</span>
      <span className={styles.metricValue}>{resource.modelCount}</span>
    </span>
  );
  if (resource.brand === 'openaiCompatibility') {
    metrics.push(
      <span key="keys" className={styles.metric}>
        <span className={styles.metricLabel}>{t('providersPage.table.metrics.keys')}</span>
        <span className={styles.metricValue}>{resource.apiKeyEntryCount}</span>
      </span>
    );
  }
  metrics.push(
    <span key="headers" className={styles.metric}>
      <span className={styles.metricLabel}>{t('providersPage.table.metrics.headers')}</span>
      <span className={styles.metricValue}>{resource.headerCount}</span>
    </span>
  );
  if ((resource.brand === 'codex' || resource.brand === 'xai') && resource.flags.websockets) {
    metrics.push(
      <span key="ws" className={styles.flagTag}>
        {t('providersPage.table.websocketsTag')}
      </span>
    );
  }
  if (resource.brand === 'claude' && resource.flags.cloakEnabled) {
    metrics.push(
      <span key="cloak" className={styles.flagTag}>
        {t('providersPage.table.cloakTag')}
      </span>
    );
  }

  const logoSrc =
    logo && resolvedTheme === 'dark' && logo.darkSrc ? logo.darkSrc : logo?.src;

  return (
    <div
      className={[
        styles.card,
        selected ? styles.cardSelected : '',
        resource.disabled ? styles.cardDisabled : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.cardMain}>
        <div className={styles.cardHeader}>
          <div
            className={styles.providerAvatar}
            style={{
              backgroundColor: typeColor.bg,
              color: typeColor.text,
              ...(typeColor.border ? { border: typeColor.border } : {}),
            }}
          >
            {logoSrc ? (
              <img src={logoSrc} alt="" aria-hidden="true" className={styles.providerAvatarImage} />
            ) : (
              <span className={styles.providerAvatarFallback}>
                {brandTitle.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className={styles.cardHeaderContent}>
            <div className={styles.cardBadgeRow}>
              <span
                className={styles.typeBadge}
                style={{
                  backgroundColor: typeColor.bg,
                  color: typeColor.text,
                  ...(typeColor.border ? { border: typeColor.border } : {}),
                }}
              >
                {brandTitle}
              </span>
              <span className={`${styles.stateBadge} ${stateBadgeClass}`}>{stateLabel}</span>
            </div>
            <span className={styles.primaryName} title={primaryTitle}>
              {primaryTitle}
            </span>
            {primarySub ? (
              <span className={styles.primarySub} title={primarySub}>
                {primarySub}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.cardMeta}>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('providersPage.table.baseUrl')}</span>
            <span className={`${styles.metaValue} ${styles.metaMono}`} title={baseUrlDisplay}>
              {baseUrlDisplay}
            </span>
          </div>
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>{t('providersPage.table.prefix')}</span>
            <span className={styles.metaValue}>
              {resource.prefix || t('providersPage.status.none')}
            </span>
          </div>
          {resource.priority ? (
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('auth_files.priority_display')}</span>
              <span className={`${styles.metaValue} ${styles.priorityValue}`}>
                {resource.priority}
              </span>
            </div>
          ) : null}
        </div>

        <div className={styles.cardInsights}>
          {metrics.length > 0 ? <div className={styles.metricsRow}>{metrics}</div> : null}

          {usageByProvider ? (
            <>
              <div className={styles.cardStats}>
                <div className={`${styles.statPill} ${styles.statSuccess}`}>
                  <span className={styles.statLabel}>{t('stats.success')}</span>
                  <span className={styles.statValue}>{stats.success}</span>
                </div>
                <div className={`${styles.statPill} ${styles.statFailure}`}>
                  <span className={styles.statLabel}>{t('stats.failure')}</span>
                  <span className={styles.statValue}>{stats.failure}</span>
                </div>
              </div>
              {statusData ? (
                <div className={styles.statusPanel}>
                  <div className={styles.statusPanelLabel}>
                    <span>{t('auth_files.health_status_label')}</span>
                  </div>
                  <ProviderStatusBar statusData={statusData} styles={styles} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className={styles.cardActions}>
          <div className={styles.cardActionsMain}>
            <div className={styles.cardUtilityActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onView(resource)}
                className={styles.iconButton}
                title={t('providersPage.actions.view')}
                aria-label={t('providersPage.actions.view')}
              >
                <IconEye className={styles.actionIcon} size={16} />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onEdit(resource)}
                className={styles.iconButton}
                title={t('providersPage.actions.edit')}
                aria-label={t('providersPage.actions.edit')}
                disabled={disableMutations}
              >
                <IconPencil className={styles.actionIcon} size={16} />
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDelete(resource)}
                className={styles.iconButton}
                title={t('providersPage.actions.delete')}
                aria-label={t('providersPage.actions.delete')}
                disabled={disableMutations}
              >
                <IconTrash2 className={styles.actionIcon} size={16} />
              </Button>
            </div>
          </div>
          {onToggleDisabled ? (
            <div className={styles.statusToggle}>
              <span className={styles.statusToggleLabel}>
                {t('auth_files.status_toggle_label')}
              </span>
              <ToggleSwitch
                checked={!resource.disabled}
                disabled={disableMutations}
                onChange={(value) => onToggleDisabled(resource, !value)}
                ariaLabel={
                  resource.disabled
                    ? t('providersPage.actions.enable')
                    : t('providersPage.actions.disable')
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
