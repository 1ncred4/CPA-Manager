import { useTranslation } from 'react-i18next';
import styles from './ProviderHeaderCard.module.scss';

interface ProviderHeaderCardProps {
  title?: string;
  totalActive: number;
  totalResources: number;
  providerFamilies: number;
  updatedAtLabel: string;
  showSummary?: boolean;
}

export function ProviderHeaderCard({
  title,
  totalActive,
  totalResources,
  providerFamilies,
  updatedAtLabel,
  showSummary = true,
}: ProviderHeaderCardProps) {
  const { t } = useTranslation();

  return (
    <section className={styles.card}>
      <div className={styles.row}>
        <div className={styles.titleArea}>
          <h1 className={styles.title}>{title ?? t('providersPage.header.title')}</h1>
        </div>
      </div>

      {showSummary ? (
        <div className={styles.chips}>
          <span className={`${styles.chip} ${styles.chipPrimary}`}>
            {t('providersPage.header.activeResources', {
              active: totalActive,
              total: totalResources,
            })}
          </span>
          <span className={styles.chip}>
            {t('providersPage.header.providerFamilies', { count: providerFamilies })}
          </span>
          <span className={styles.chip}>
            {t('providersPage.header.updatedAt', { time: updatedAtLabel })}
          </span>
        </div>
      ) : null}
    </section>
  );
}
