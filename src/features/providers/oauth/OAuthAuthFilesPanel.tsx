/**
 * OAuth 渠道下的认证文件资源面板（列表 / 上传 / 启停 / 删除 / 字段编辑）
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPlus, IconSearch, IconFileText } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import {
  getTypeLabel,
  normalizeProviderKey,
  type QuotaProviderType,
  type ResolvedTheme,
  QUOTA_PROVIDER_TYPES,
} from '@/features/authFiles/constants';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { resolveAuthFileChannel } from '../oauthChannels';
import { getOAuthChannelLogo } from '../oauthChannels';
import { useNotificationStore, useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import styles from '../components/ProviderResourcePanel.module.scss';
import authStyles from '@/features/authFiles/AuthFiles.module.scss';

export interface OAuthAuthFilesPanelProps {
  channel: string;
  disableControls: boolean;
  authFiles: ReturnType<typeof useAuthFilesData>;
  onAdd: () => void;
  onUpload: () => void;
}

export function OAuthAuthFilesPanel({
  channel,
  disableControls,
  authFiles,
  onAdd,
  onUpload,
}: OAuthAuthFilesPanelProps) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((s) => s.showNotification);
  const resolvedTheme: ResolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const [filter, setFilter] = useState('');
  const channelKey = normalizeProviderKey(channel);

  const {
    files,
    selectedFiles,
    loading,
    error,
    uploading,
    deleting,
    statusUpdating,
    fileInputRef,
    loadFiles,
    handleFileChange,
    handleDelete,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
  } = authFiles;

  const statusBarCache = useAuthFilesStatusBarCache(files);
  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls,
    loadFiles,
  });

  const channelFiles = useMemo(
    () =>
      files.filter((file) => {
        const fileChannel = resolveAuthFileChannel(file);
        return fileChannel === channelKey;
      }),
    [channelKey, files]
  );

  const filteredFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return channelFiles;
    return channelFiles.filter((file) => {
      const haystack = [file.name, file.type, file.provider, file.status, file.statusMessage]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return haystack.some((v) => v.includes(q));
    });
  }, [channelFiles, filter]);

  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    channelKey as QuotaProviderType
  )
    ? (channelKey as QuotaProviderType)
    : null;

  const logo = getOAuthChannelLogo(channel);
  const title = getTypeLabel(t, channel);
  const logoClassName = [
    styles.logo,
    logo.themeSurface ? styles.logoThemeSurface : '',
    logo.darkSrc ? styles.logoThemeLight : '',
    logo.invertOnDark ? styles.logoInvertOnDark : '',
  ]
    .filter(Boolean)
    .join(' ');
  const darkLogoClassName = [
    styles.logo,
    logo.themeSurface ? styles.logoThemeSurface : '',
    styles.logoThemeDark,
  ]
    .filter(Boolean)
    .join(' ');

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      showNotification(
        t(ok ? 'notification.copy_success' : 'notification.copy_failed', {
          defaultValue: ok ? 'Copied' : 'Copy failed',
        }),
        ok ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <div className={styles.titleArea}>
            <div className={styles.titleRow}>
              <img src={logo.src} alt="" aria-hidden="true" className={logoClassName} />
              {logo.darkSrc ? (
                <img src={logo.darkSrc} alt="" aria-hidden="true" className={darkLogoClassName} />
              ) : null}
              <h2 className={styles.title}>{title}</h2>
            </div>
          </div>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon} aria-hidden="true">
              <IconSearch size={16} />
            </span>
            <input
              type="search"
              className={styles.searchInput}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('providersPage.oauth.filterPlaceholder', {
                defaultValue: 'Search credentials…',
              })}
            />
          </div>
        </div>
        <div className={styles.headerToolbarRow}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={onUpload}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              <IconFileText size={14} />
              <span>{t('auth_files.upload_button', { defaultValue: 'Upload' })}</span>
            </Button>
            <Button size="sm" onClick={onAdd} disabled={disableControls}>
              <IconPlus size={14} />
              <span>
                {t('providersPage.oauth.addCredential', { defaultValue: 'Add credential' })}
              </span>
            </Button>
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => void handleFileChange(e)}
      />

      {error ? <div className="error-box">{error}</div> : null}

      {loading && filteredFiles.length === 0 ? (
        <div className={styles.empty}>{t('common.loading')}</div>
      ) : filteredFiles.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            title={t('providersPage.oauth.emptyTitle', {
              defaultValue: 'No credentials yet',
            })}
            description={t('providersPage.oauth.emptyDescription', {
              defaultValue: 'Start OAuth login or upload a credential JSON file.',
            })}
          />
          <div className={styles.emptyAction}>
            <button type="button" className={styles.emptyActionButton} onClick={onAdd}>
              <IconPlus size={16} />
              <span>
                {t('providersPage.oauth.addCredential', { defaultValue: 'Add credential' })}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className={authStyles.fileGrid}>
          {filteredFiles.map((file: AuthFileItem) => (
            <AuthFileCard
              key={file.name}
              file={file}
              compact={false}
              selected={selectedFiles.has(file.name)}
              resolvedTheme={resolvedTheme}
              disableControls={disableControls}
              deleting={deleting}
              statusUpdating={statusUpdating}
              quotaFilterType={quotaFilterType}
              statusBarCache={statusBarCache}
              onShowModels={(item) => void showModels(item)}
              onDownload={(name) => void handleDownload(name)}
              onOpenPrefixProxyEditor={openPrefixProxyEditor}
              onDelete={handleDelete}
              onToggleStatus={(item, enabled) => void handleStatusToggle(item, enabled)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={{}}
        onClose={closeModelsModal}
        onCopyText={(text) => void copyTextWithNotification(text)}
      />

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={(text) => void copyTextWithNotification(text)}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />
    </section>
  );
}
