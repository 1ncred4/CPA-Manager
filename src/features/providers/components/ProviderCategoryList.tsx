import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '@/features/authFiles/constants';
import { PROVIDER_LOGOS, type ProviderBrandLogo } from '../brandLogos';
import { getOAuthChannelLogo } from '../oauthChannels';
import type { ProviderBrand, ProviderCategoryId, ProviderGroup } from '../types';
import { toCategoryKey } from '../types';
import styles from './ProviderCategoryList.module.scss';

export interface OAuthCategoryItem {
  channel: string;
  total: number;
  active: number;
}

interface ProviderCategoryListProps {
  apiKeyGroups: ProviderGroup[];
  oauthChannels: OAuthCategoryItem[];
  activeCategory: ProviderCategoryId;
  onSelect: (category: ProviderCategoryId) => void;
}

function CategoryLogo({ logo }: { logo?: ProviderBrandLogo }) {
  if (!logo) return null;
  const logoClassName = [
    styles.logo,
    logo.transparent ? styles.logoTransparent : '',
    logo.themeSurface ? styles.logoThemeSurface : '',
    logo.darkSrc ? styles.logoThemeLight : '',
    logo.invertOnDark ? styles.logoInvertOnDark : '',
  ]
    .filter(Boolean)
    .join(' ');
  const darkLogoClassName = [
    styles.logo,
    logo.transparent ? styles.logoTransparent : '',
    logo.themeSurface ? styles.logoThemeSurface : '',
    styles.logoThemeDark,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <img src={logo.src} alt="" aria-hidden="true" className={logoClassName} />
      {logo.darkSrc ? (
        <img src={logo.darkSrc} alt="" aria-hidden="true" className={darkLogoClassName} />
      ) : null}
    </>
  );
}

function CategoryChip({
  active,
  title,
  subtitle,
  badge,
  logo,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  badge: number;
  logo?: ProviderBrandLogo;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.chip} ${active ? styles.active : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={`${title} · ${subtitle}`}
    >
      <CategoryLogo logo={logo} />
      <span className={styles.chipText}>
        <span className={styles.chipTitle}>{title}</span>
        <span className={styles.chipMeta}>{subtitle}</span>
      </span>
      <span className={`${styles.badge} ${badge === 0 ? styles.badgeAmber : ''}`}>{badge}</span>
    </button>
  );
}

function CategorySection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={label}>
      <div className={styles.tabs}>
        <span className={`${styles.tab} ${styles.tabActive}`}>{label}</span>
      </div>
      <div className={styles.chipGrid}>{children}</div>
    </section>
  );
}

export function ProviderCategoryList({
  apiKeyGroups,
  oauthChannels,
  activeCategory,
  onSelect,
}: ProviderCategoryListProps) {
  const { t } = useTranslation();
  const activeKey = toCategoryKey(activeCategory);

  return (
    <nav className={styles.nav} aria-label={t('providersPage.categories.title')}>
      <CategorySection label={t('providersPage.authGroups.apiKey')}>
        {apiKeyGroups.map((group) => {
          const category: ProviderCategoryId = { method: 'apiKey', brand: group.id };
          const active = toCategoryKey(category) === activeKey;
          const total = group.resources.length;
          const activeCount = group.resources.filter((r) => !r.disabled).length;
          return (
            <CategoryChip
              key={toCategoryKey(category)}
              active={active}
              title={t(`providersPage.providerNames.${group.id as ProviderBrand}`)}
              subtitle={t('providersPage.categories.activeCount', {
                active: activeCount,
                total,
              })}
              badge={total}
              logo={PROVIDER_LOGOS[group.id]}
              onClick={() => onSelect(category)}
            />
          );
        })}
      </CategorySection>

      <CategorySection label={t('providersPage.authGroups.oauth')}>
        {oauthChannels.map((item) => {
          const category: ProviderCategoryId = { method: 'oauth', channel: item.channel };
          const active = toCategoryKey(category) === activeKey;
          return (
            <CategoryChip
              key={toCategoryKey(category)}
              active={active}
              title={getTypeLabel(t, item.channel)}
              subtitle={t('providersPage.categories.activeCount', {
                active: item.active,
                total: item.total,
              })}
              badge={item.total}
              logo={getOAuthChannelLogo(item.channel)}
              onClick={() => onSelect(category)}
            />
          );
        })}
      </CategorySection>
    </nav>
  );
}
