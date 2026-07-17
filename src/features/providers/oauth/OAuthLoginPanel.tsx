/**
 * 单渠道 OAuth 登录 / Vertex 导入面板（嵌入 AI 提供商 workbench 的添加 Sheet）
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { oauthApi } from '@/services/api';
import { vertexApi, type VertexImportResponse } from '@/services/api/vertex';
import { useNotificationStore, useThemeStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage, isRecord } from '@/utils/helpers';
import { getTypeLabel } from '@/features/authFiles/constants';
import {
  channelToLoginProvider,
  getOAuthChannelDescriptor,
  getOAuthChannelLogo,
} from '../oauthChannels';
import styles from './OAuthLogin.module.scss';

interface ProviderState {
  url?: string;
  state?: string;
  status?: 'idle' | 'waiting' | 'success' | 'error';
  error?: string;
  polling?: boolean;
  callbackUrl?: string;
  callbackSubmitting?: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
}

interface VertexImportResult {
  projectId?: string;
  email?: string;
  location?: string;
  authFile?: string;
}

const CALLBACK_SUPPORTED = new Set(['codex', 'anthropic', 'antigravity', 'xai']);
const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';
const SUCCESS_RESET_DELAY_MS = 5000;

const getProviderI18nPrefix = (provider: string) => provider.replace('-', '_');
const getAuthKey = (provider: string, suffix: string) =>
  `auth_login.${getProviderI18nPrefix(provider)}_${suffix}`;

function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

const isAbsoluteUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const readQueryLikeCallbackInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams =
    queryStart >= 0
      ? trimmed.slice(queryStart + 1)
      : hashStart >= 0
        ? trimmed.slice(hashStart + 1)
        : trimmed;

  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
};

const extractDisplayedXaiCode = (value: string): string => {
  const trimmed = value.trim();
  const codeMatch = trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i);
  return (codeMatch?.[1] ?? trimmed).trim();
};

const buildXaiCallbackUrl = (input: string, state?: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAbsoluteUrl(trimmed)) return trimmed;

  const params = readQueryLikeCallbackInput(trimmed);
  if (params) {
    const code = params.get('code')?.trim();
    const error = params.get('error')?.trim();
    const errorDescription = params.get('error_description')?.trim();
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;

    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    if (code) callbackUrl.searchParams.set('code', code);
    if (error) callbackUrl.searchParams.set('error', error);
    if (errorDescription) callbackUrl.searchParams.set('error_description', errorDescription);
    return callbackUrl.toString();
  }

  const code = extractDisplayedXaiCode(trimmed);
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;

  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
};

const resolveCallbackUrl = (provider: string, input: string, state?: string): string | null => {
  if (provider !== 'xai') return input.trim();
  return buildXaiCallbackUrl(input, state);
};

export interface OAuthLoginPanelProps {
  channel: string;
  onSuccess?: () => void;
}

export function OAuthLoginPanel({ channel, onSuccess }: OAuthLoginPanelProps) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const desc = getOAuthChannelDescriptor(channel);
  const logo = getOAuthChannelLogo(channel);
  const loginProvider = channelToLoginProvider(channel);

  const [state, setState] = useState<ProviderState>({});
  const [vertexFile, setVertexFile] = useState<File | undefined>();
  const [vertexFileName, setVertexFileName] = useState('');
  const [vertexLocation, setVertexLocation] = useState('');
  const [vertexLoading, setVertexLoading] = useState(false);
  const [vertexError, setVertexError] = useState<string | undefined>();
  const [vertexResult, setVertexResult] = useState<VertexImportResult | undefined>();

  const pollingTimer = useRef<number | undefined>(undefined);
  const successResetTimer = useRef<number | undefined>(undefined);
  const vertexFileInputRef = useRef<HTMLInputElement | null>(null);

  const clearTimers = useCallback(() => {
    if (pollingTimer.current !== undefined) window.clearInterval(pollingTimer.current);
    if (successResetTimer.current !== undefined) window.clearTimeout(successResetTimer.current);
    pollingTimer.current = undefined;
    successResetTimer.current = undefined;
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const title = getTypeLabel(t, channel);
  const logoSrc =
    resolvedTheme === 'dark' && logo.darkSrc ? logo.darkSrc : logo.src;

  const getText = useCallback(
    (suffix: string) => {
      if (!loginProvider) return '';
      const key = getAuthKey(loginProvider, suffix);
      const translated = t(key);
      if (translated !== key) return translated;
      // plugin / unknown fallback
      return t(`auth_login.plugin_${suffix}`, { name: title, defaultValue: suffix });
    },
    [loginProvider, t, title]
  );

  const completeAuth = useCallback(() => {
    if (pollingTimer.current !== undefined) {
      window.clearInterval(pollingTimer.current);
      pollingTimer.current = undefined;
    }
    if (successResetTimer.current !== undefined) {
      window.clearTimeout(successResetTimer.current);
    }
    setState((prev) => ({
      ...prev,
      url: undefined,
      state: undefined,
      status: 'success',
      error: undefined,
      polling: false,
      callbackUrl: '',
      callbackSubmitting: false,
      callbackStatus: undefined,
      callbackError: undefined,
    }));
    onSuccess?.();
    successResetTimer.current = window.setTimeout(() => {
      setState({});
    }, SUCCESS_RESET_DELAY_MS);
  }, [onSuccess]);

  const startPolling = useCallback(
    (authState: string) => {
      if (pollingTimer.current !== undefined) window.clearInterval(pollingTimer.current);
      pollingTimer.current = window.setInterval(async () => {
        try {
          const res = await oauthApi.getAuthStatus(authState);
          if (res.status === 'ok') {
            completeAuth();
            showNotification(getText('oauth_status_success'), 'success');
          } else if (res.status === 'error') {
            setState((prev) => ({
              ...prev,
              status: 'error',
              error: res.error,
              polling: false,
            }));
            showNotification(
              `${getText('oauth_status_error')} ${res.error || ''}`,
              'error'
            );
            if (pollingTimer.current !== undefined) {
              window.clearInterval(pollingTimer.current);
              pollingTimer.current = undefined;
            }
          }
        } catch (err: unknown) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: getErrorMessage(err),
            polling: false,
          }));
          if (pollingTimer.current !== undefined) {
            window.clearInterval(pollingTimer.current);
            pollingTimer.current = undefined;
          }
        }
      }, 3000);
    },
    [completeAuth, getText, showNotification]
  );

  const startAuth = async () => {
    if (!loginProvider) return;
    clearTimers();
    setState({
      status: 'waiting',
      polling: true,
      callbackUrl: '',
    });
    try {
      const res = await oauthApi.startAuth(loginProvider);
      if (!res.state) {
        const message = t('auth_login.missing_state');
        setState({ url: res.url, status: 'error', error: message, polling: false });
        showNotification(message, 'error');
        return;
      }
      setState({
        url: res.url,
        state: res.state,
        status: 'waiting',
        polling: true,
        callbackUrl: '',
      });
      startPolling(res.state);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setState({ status: 'error', error: message, polling: false });
      showNotification(
        `${getText('oauth_start_error')}${message ? ` ${message}` : ''}`,
        'error'
      );
    }
  };

  const copyLink = async (url?: string) => {
    if (!url) return;
    const copied = await copyToClipboard(url);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const submitCallback = async () => {
    if (!loginProvider) return;
    const callbackInput = (state.callbackUrl || '').trim();
    if (!callbackInput) {
      showNotification(
        t(
          loginProvider === 'xai'
            ? 'auth_login.xai_callback_required'
            : 'auth_login.oauth_callback_required'
        ),
        'warning'
      );
      return;
    }
    const redirectUrl = resolveCallbackUrl(loginProvider, callbackInput, state.state);
    if (!redirectUrl) {
      showNotification(
        t(
          loginProvider === 'xai'
            ? 'auth_login.xai_callback_state_missing'
            : 'auth_login.missing_state'
        ),
        'warning'
      );
      return;
    }
    setState((prev) => ({
      ...prev,
      callbackSubmitting: true,
      callbackStatus: undefined,
      callbackError: undefined,
    }));
    try {
      await oauthApi.submitCallback(loginProvider, redirectUrl);
      setState((prev) => ({
        ...prev,
        callbackSubmitting: false,
        callbackStatus: 'success',
      }));
      showNotification(t('auth_login.oauth_callback_success'), 'success');
    } catch (err: unknown) {
      const status = getErrorStatus(err);
      const message = getErrorMessage(err);
      const errorMessage =
        status === 404
          ? t('auth_login.oauth_callback_upgrade_hint', {
              defaultValue: 'Please update CLI Proxy API or check the connection.',
            })
          : message || undefined;
      setState((prev) => ({
        ...prev,
        callbackSubmitting: false,
        callbackStatus: 'error',
        callbackError: errorMessage,
      }));
      const notificationMessage = errorMessage
        ? `${t('auth_login.oauth_callback_error')} ${errorMessage}`
        : t('auth_login.oauth_callback_error');
      showNotification(notificationMessage, 'error');
    }
  };

  const handleVertexImport = async () => {
    if (!vertexFile) {
      const message = t('vertex_import.file_required');
      setVertexError(message);
      showNotification(message, 'warning');
      return;
    }
    setVertexLoading(true);
    setVertexError(undefined);
    setVertexResult(undefined);
    try {
      const res: VertexImportResponse = await vertexApi.importCredential(
        vertexFile,
        vertexLocation.trim() || undefined
      );
      setVertexResult({
        projectId: res.project_id,
        email: res.email,
        location: res.location,
        authFile: res['auth-file'] ?? res.auth_file,
      });
      setVertexLoading(false);
      showNotification(t('vertex_import.success'), 'success');
      onSuccess?.();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setVertexLoading(false);
      setVertexError(message || t('notification.upload_failed'));
      showNotification(
        message ? `${t('notification.upload_failed')}: ${message}` : t('notification.upload_failed'),
        'error'
      );
    }
  };

  if (desc.loginMode === 'vertex-import') {
    return (
      <div className={styles.cardContent}>
        <div className={styles.cardHint}>{t('vertex_import.description')}</div>
        <Input
          label={t('vertex_import.location_label')}
          hint={t('vertex_import.location_hint')}
          value={vertexLocation}
          onChange={(e) => setVertexLocation(e.target.value)}
          placeholder={t('vertex_import.location_placeholder')}
        />
        <div className={styles.formItem}>
          <label className={styles.formItemLabel}>{t('vertex_import.file_label')}</label>
          <div className={styles.filePicker}>
            <Button variant="secondary" size="sm" onClick={() => vertexFileInputRef.current?.click()}>
              {t('vertex_import.choose_file')}
            </Button>
            <span
              className={`${styles.fileName} ${vertexFileName ? '' : styles.fileNamePlaceholder}`}
            >
              {vertexFileName || t('vertex_import.file_placeholder')}
            </span>
          </div>
          <div className={styles.cardHintSecondary}>{t('vertex_import.file_hint')}</div>
          <input
            ref={vertexFileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (!file.name.endsWith('.json')) {
                showNotification(t('vertex_import.file_required'), 'warning');
                event.target.value = '';
                return;
              }
              setVertexFile(file);
              setVertexFileName(file.name);
              setVertexError(undefined);
              setVertexResult(undefined);
              event.target.value = '';
            }}
          />
        </div>
        <div className={styles.callbackActions}>
          <Button onClick={() => void handleVertexImport()} loading={vertexLoading}>
            {t('vertex_import.import_button')}
          </Button>
        </div>
        {vertexError && <div className="status-badge error">{vertexError}</div>}
        {vertexResult && (
          <div className={styles.connectionBox}>
            <div className={styles.connectionLabel}>{t('vertex_import.result_title')}</div>
            <div className={styles.keyValueList}>
              {vertexResult.projectId && (
                <div className={styles.keyValueItem}>
                  <span className={styles.keyValueKey}>{t('vertex_import.result_project')}</span>
                  <span className={styles.keyValueValue}>{vertexResult.projectId}</span>
                </div>
              )}
              {vertexResult.email && (
                <div className={styles.keyValueItem}>
                  <span className={styles.keyValueKey}>{t('vertex_import.result_email')}</span>
                  <span className={styles.keyValueValue}>{vertexResult.email}</span>
                </div>
              )}
              {vertexResult.authFile && (
                <div className={styles.keyValueItem}>
                  <span className={styles.keyValueKey}>{t('vertex_import.result_file')}</span>
                  <span className={styles.keyValueValue}>{vertexResult.authFile}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (desc.loginMode === 'upload-only') {
    return (
      <div className={styles.cardContent}>
        <div className={styles.cardHint}>
          {t('providersPage.oauth.uploadOnlyHint', {
            defaultValue: 'This channel only supports uploading credential JSON files.',
          })}
        </div>
      </div>
    );
  }

  // OAuth flow
  const canSubmitCallback =
    Boolean(state.url) &&
    (CALLBACK_SUPPORTED.has(loginProvider || '') || !CALLBACK_SUPPORTED.has(loginProvider || ''));
  // built-in known: only CALLBACK_SUPPORTED; plugin channels also allow callback when url present
  const showCallback =
    Boolean(state.url) &&
    (CALLBACK_SUPPORTED.has(loginProvider || '') ||
      !['kimi'].includes(loginProvider || ''));

  const loginButtonLabel =
    state.status === 'success'
      ? t('auth_login.login_another_account')
      : getText('oauth_button') || t('providersPage.oauth.startLogin', { defaultValue: 'Start login' });

  const statusBadgeClassName = [
    'status-badge',
    state.status === 'success' ? 'success' : '',
    state.status === 'error' ? 'error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.cardContent}>
      <div className={styles.cardTitle} style={{ marginBottom: 8 }}>
        <img src={logoSrc} alt="" className={styles.cardTitleIcon} />
        <span>{title}</span>
      </div>
      <div className={styles.cardHint}>{getText('oauth_hint')}</div>
      <div className={styles.callbackActions}>
        <Button onClick={() => void startAuth()} loading={state.polling}>
          {loginButtonLabel}
        </Button>
      </div>
      {state.url && (
        <div className={styles.authUrlBox}>
          <div className={styles.authUrlLabel}>{getText('oauth_url_label')}</div>
          <div className={styles.authUrlValue}>{state.url}</div>
          <div className={styles.authUrlActions}>
            <Button variant="secondary" size="sm" onClick={() => void copyLink(state.url)}>
              {getText('copy_link')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(state.url, '_blank', 'noopener,noreferrer')}
            >
              {getText('open_link')}
            </Button>
          </div>
        </div>
      )}
      {showCallback && canSubmitCallback && (
        <div className={styles.callbackSection}>
          <Input
            label={t(
              loginProvider === 'xai'
                ? 'auth_login.xai_callback_label'
                : 'auth_login.oauth_callback_label'
            )}
            hint={t(
              loginProvider === 'xai'
                ? 'auth_login.xai_callback_hint'
                : 'auth_login.oauth_callback_hint'
            )}
            value={state.callbackUrl || ''}
            onChange={(e) =>
              setState((prev) => ({
                ...prev,
                callbackUrl: e.target.value,
                callbackStatus: undefined,
                callbackError: undefined,
              }))
            }
            placeholder={t(
              loginProvider === 'xai'
                ? 'auth_login.xai_callback_placeholder'
                : 'auth_login.oauth_callback_placeholder'
            )}
          />
          <div className={styles.callbackActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submitCallback()}
              loading={state.callbackSubmitting}
            >
              {t('auth_login.oauth_callback_button')}
            </Button>
          </div>
          {state.callbackStatus === 'success' && state.status === 'waiting' && (
            <div className="status-badge success">{t('auth_login.oauth_callback_status_success')}</div>
          )}
          {state.callbackStatus === 'error' && (
            <div className="status-badge error">
              {t('auth_login.oauth_callback_status_error')} {state.callbackError || ''}
            </div>
          )}
        </div>
      )}
      {state.status && state.status !== 'idle' && (
        <div className={statusBadgeClassName}>
          {state.status === 'success'
            ? getText('oauth_status_success')
            : state.status === 'error'
              ? `${getText('oauth_status_error')} ${state.error || ''}`
              : getText('oauth_status_waiting')}
        </div>
      )}
    </div>
  );
}
