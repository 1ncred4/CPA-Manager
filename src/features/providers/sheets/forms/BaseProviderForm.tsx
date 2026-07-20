import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconDownload,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconPlus,
  IconX,
} from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { hasDisableAllModelsRule } from '@/components/providers/utils';
import { useAuthStore } from '@/stores';
import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { ModelInfo } from '@/utils/models';
import {
  collectExactExcludedIds,
  loadSuspendedCatalogSafe,
  modelsToFormEntriesWithAccess,
} from '../../formModelAccess';
import { PROVIDER_DESCRIPTORS } from '../../descriptors';
import type {
  ApiKeyEntryInput,
  ModelEntryInput,
  ProviderBrand,
  ProviderEntryFormInput,
  ProviderResource,
} from '../../types';
import { useConnectivityTest, type ConnectivityErrorMessages } from './useConnectivityTest';
import { useModelDiscovery } from './useModelDiscovery';
import { ModelDiscoveryPanel } from './ModelDiscoveryPanel';
import { ConnectivityStatusIcon } from './ConnectivityStatusIcon';
import { ApiKeyEntriesEditor } from './ApiKeyEntriesEditor';
import { ModelEntriesEditor } from './ModelEntriesEditor';
import styles from './sharedForm.module.scss';

function FormSection({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.sectionBlock}>
      <header className={styles.sectionBlockHeader}>
        <h3 className={styles.sectionBlockTitle}>{title}</h3>
        {hint ? <span className={styles.sectionBlockHint}>{hint}</span> : null}
      </header>
      <div className={styles.sectionBlockBody}>{children}</div>
    </section>
  );
}

interface BaseProviderFormProps {
  brand: ProviderBrand;
  resource: ProviderResource | null;
  mode: 'create' | 'edit';
  mutating: boolean;
  formId: string;
  onSubmit: (input: ProviderEntryFormInput) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

const emptyHeader = () => ({ key: '', value: '' });
const emptyModel = (): ModelEntryInput => ({ name: '', enabled: true });
const emptyApiKeyEntry = (): ApiKeyEntryInput => ({
  apiKey: '',
  proxyUrl: '',
});
const XAI_API_BASE_URL = 'https://api.x.ai/v1';

function buildInitialForm(
  brand: ProviderBrand,
  resource: ProviderResource | null,
  mode: 'create' | 'edit',
  apiBase?: string
): ProviderEntryFormInput {
  if (mode === 'create' || !resource) {
    return {
      apiKey: '',
      name: '',
      baseUrl: brand === 'xai' ? XAI_API_BASE_URL : '',
      proxyUrl: '',
      prefix: '',
      disabled: false,
      disableCooling: false,
      priority: undefined,
      models: [emptyModel()],
      headers: [emptyHeader()],
      excludedModelsText: '',
      websockets: brand === 'codex' || brand === 'xai' ? false : undefined,
      cloak:
        brand === 'claude'
          ? { mode: '', strictMode: false, sensitiveWordsText: '', cacheUserId: false }
          : undefined,
      experimentalCchSigning: brand === 'claude' ? false : undefined,
      testModel:
        brand === 'openaiCompatibility' ||
        brand === 'codex' ||
        brand === 'xai' ||
        brand === 'claude' ||
        brand === 'gemini'
          ? ''
          : undefined,
      apiKeyEntries: brand === 'openaiCompatibility' ? [emptyApiKeyEntry()] : undefined,
    };
  }

  const raw = resource.raw;
  if (brand === 'openaiCompatibility') {
    const cfg = raw as OpenAIProviderConfig;
    const suspendedCatalog = loadSuspendedCatalogSafe(apiBase, resource.id);
    return {
      apiKey: '',
      name: cfg.name ?? '',
      baseUrl: cfg.baseUrl ?? '',
      proxyUrl: '',
      prefix: cfg.prefix ?? '',
      disabled: cfg.disabled === true,
      disableCooling: cfg.disableCooling === true,
      priority: cfg.priority,
      models: modelsToFormEntriesWithAccess({
        models: cfg.models,
        includeOpenAIFields: true,
        suspendedCatalog,
      }),
      headers: cfg.headers
        ? Object.entries(cfg.headers).map(([k, v]) => ({ key: k, value: String(v) }))
        : [emptyHeader()],
      excludedModelsText: '',
      testModel: cfg.testModel ?? '',
      apiKeyEntries: cfg.apiKeyEntries?.length
        ? cfg.apiKeyEntries.map((entry) => ({
            apiKey: '',
            existingApiKey: entry.apiKey,
            proxyUrl: entry.proxyUrl ?? '',
            authIndex: entry.authIndex,
          }))
        : [emptyApiKeyEntry()],
    };
  }

  const cfg = raw as GeminiKeyConfig & ProviderKeyConfig;
  const disabled = hasDisableAllModelsRule(cfg.excludedModels);
  const exactExcludedIds = collectExactExcludedIds(cfg.excludedModels);
  return {
    // Keep the API key blank in edit mode. Pre-filling the real key makes this
    // password field a browser-autofill target (the saved management key can
    // overwrite it) and defeats the "leave empty = keep unchanged" contract; an
    // empty field is preserved on save via buildProviderKeyConfig's existing fallback.
    apiKey: '',
    name: '',
    baseUrl: cfg.baseUrl ?? '',
    proxyUrl: cfg.proxyUrl ?? '',
    prefix: cfg.prefix ?? '',
    disabled,
    disableCooling: cfg.disableCooling === true,
    priority: cfg.priority,
    models: modelsToFormEntriesWithAccess({
      models: cfg.models,
      exactExcludedIds,
    }),
    headers: cfg.headers
      ? Object.entries(cfg.headers).map(([k, v]) => ({ key: k, value: String(v) }))
      : [emptyHeader()],
    // Exact excludes are now owned by model-row toggles; wildcards stay server-side.
    excludedModelsText: '',
    websockets:
      brand === 'codex' || brand === 'xai'
        ? (cfg as ProviderKeyConfig).websockets === true
        : undefined,
    cloak: brand === 'claude'
      ? {
          mode: (cfg as ProviderKeyConfig).cloak?.mode ?? '',
          strictMode: (cfg as ProviderKeyConfig).cloak?.strictMode === true,
          sensitiveWordsText: (cfg as ProviderKeyConfig).cloak?.sensitiveWords?.join('\n') ?? '',
          cacheUserId: (cfg as ProviderKeyConfig).cloak?.cacheUserId === true,
        }
      : undefined,
    experimentalCchSigning: brand === 'claude'
      ? (cfg as ProviderKeyConfig).experimentalCchSigning === true
      : undefined,
    testModel:
      brand === 'codex' || brand === 'xai' || brand === 'claude' || brand === 'gemini'
        ? ''
        : undefined,
  };
}

export function BaseProviderForm({
  brand,
  resource,
  mode,
  mutating,
  formId,
  onSubmit,
  onDirtyChange,
}: BaseProviderFormProps) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((s) => s.apiBase);
  const descriptor = PROVIDER_DESCRIPTORS[brand];
  const fid = useId();
  const [form, setForm] = useState<ProviderEntryFormInput>(() =>
    buildInitialForm(brand, resource, mode, apiBase)
  );
  const [initialFormSignature] = useState<string>(() =>
    JSON.stringify(buildInitialForm(brand, resource, mode, apiBase))
  );
  const [error, setError] = useState<string | null>(null);
  const [showSingleApiKey, setShowSingleApiKey] = useState(false);

  const isDirty = useMemo(
    () => JSON.stringify(form) !== initialFormSignature,
    [form, initialFormSignature]
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const fallbackApiKey = useMemo(() => {
    if (mode !== 'edit' || !resource) return '';
    if (brand === 'openaiCompatibility') return '';
    return (resource.raw as { apiKey?: string } | undefined)?.apiKey ?? '';
  }, [brand, mode, resource]);

  const fallbackAuthIndex = useMemo(() => {
    if (mode !== 'edit' || !resource) return '';
    return (resource.raw as { authIndex?: string } | undefined)?.authIndex ?? '';
  }, [mode, resource]);

  const connectivityMessages = useMemo<ConnectivityErrorMessages>(
    () => ({
      baseUrlRequired: t('providersPage.connectivity.baseUrlRequired'),
      endpointInvalid: t('providersPage.connectivity.endpointInvalid'),
      apiKeyRequired: t('providersPage.connectivity.apiKeyRequired'),
      modelRequired: t('providersPage.connectivity.modelRequired'),
      timeout: (seconds: number) => t('providersPage.connectivity.timeout', { seconds }),
      requestFailed: t('providersPage.connectivity.requestFailed'),
    }),
    [t]
  );

  const connectivity = useConnectivityTest(
    {
      brand,
      baseUrl: form.baseUrl,
      testModel: form.testModel,
      models: form.models,
      formHeaders: form.headers,
      apiKeyEntries: form.apiKeyEntries,
      apiKey: form.apiKey,
      fallbackApiKey,
      authIndex: fallbackAuthIndex,
    },
    connectivityMessages
  );

  const discovery = useModelDiscovery({
    brand,
    baseUrl: form.baseUrl,
    formHeaders: form.headers,
    apiKeyEntries: form.apiKeyEntries,
    apiKey: form.apiKey,
    fallbackApiKey,
    authIndex: fallbackAuthIndex,
  });
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  const existingModelNames = useMemo(() => {
    const set = new Set<string>();
    form.models.forEach((m) => {
      const name = (m.name ?? '').trim();
      if (name) set.add(name);
    });
    return set;
  }, [form.models]);

  const testModelOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    form.models.forEach((m) => {
      const name = (m.name ?? '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    const firstName = names[0];
    const autoLabel = firstName
      ? t('providersPage.form.testModelAutoWith', { name: firstName })
      : t('providersPage.form.testModelAutoEmpty');
    const opts: Array<{ value: string; label: string }> = [{ value: '', label: autoLabel }];
    names.forEach((n) => opts.push({ value: n, label: n }));
    const tm = (form.testModel ?? '').trim();
    if (tm && !seen.has(tm)) {
      opts.push({
        value: tm,
        label: t('providersPage.form.testModelCustom', { name: tm }),
      });
    }
    return opts;
  }, [form.models, form.testModel, t]);

  const openDiscovery = () => {
    setDiscoveryOpen(true);
    if (!discovery.loading && !discovery.hasFetched) {
      void discovery.fetch();
    }
  };

  const closeDiscovery = () => {
    setDiscoveryOpen(false);
  };

  const applyDiscoveredModels = (incoming: ModelInfo[]) => {
    if (!incoming.length) return;
    setForm((prev) => {
      const seen = new Set<string>();
      const next: ModelEntryInput[] = [];
      prev.models.forEach((entry) => {
        const trimmed = (entry.name ?? '').trim();
        if (trimmed) {
          const key = trimmed.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
        }
        // Drop residual alias from catalog UI; mappings own aliases.
        next.push({ ...entry, alias: undefined });
      });
      // If the existing list is just an empty placeholder row, drop it.
      const placeholderIdx = next.findIndex((it) => !(it.name ?? '').trim());
      if (placeholderIdx !== -1) {
        next.splice(placeholderIdx, 1);
      }
      incoming.forEach((info) => {
        const trimmed = info.name.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        next.push({ name: trimmed, enabled: true });
      });
      return { ...prev, models: next };
    });
  };

  const updateField = <K extends keyof ProviderEntryFormInput>(
    key: K,
    value: ProviderEntryFormInput[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateCloak = <K extends keyof NonNullable<ProviderEntryFormInput['cloak']>>(
    key: K,
    value: NonNullable<ProviderEntryFormInput['cloak']>[K]
  ) => {
    setForm((prev) => ({
      ...prev,
      cloak: {
        ...(prev.cloak ?? {
          mode: '',
          strictMode: false,
          sensitiveWordsText: '',
          cacheUserId: false,
        }),
        [key]: value,
      },
    }));
  };

  const validate = (): string | null => {
    if (descriptor.supportsName && !form.name.trim()) {
      return t('providersPage.form.validation.nameRequired');
    }
    if (descriptor.supportsApiKey && mode === 'create' && !form.apiKey.trim()) {
      return t('providersPage.form.validation.apiKeyRequired');
    }
    if (descriptor.baseUrlRequired && !form.baseUrl.trim()) {
      return t('providersPage.form.validation.baseUrlRequired');
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    try {
      setError(null);
      await onSubmit(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /* ------------------ entries helpers ------------------ */

  const headersList = useMemo(
    () => (form.headers.length ? form.headers : [emptyHeader()]),
    [form.headers]
  );
  const modelsList = useMemo(
    () => (form.models.length ? form.models : [emptyModel()]),
    [form.models]
  );
  const apiKeyEntries = useMemo(
    () =>
      form.apiKeyEntries && form.apiKeyEntries.length ? form.apiKeyEntries : [emptyApiKeyEntry()],
    [form.apiKeyEntries]
  );
  const actualApiKeyEntries = form.apiKeyEntries ?? [];
  const supportsDisableCooling =
    brand === 'gemini' ||
    brand === 'codex' ||
    brand === 'xai' ||
    brand === 'claude' ||
    brand === 'openaiCompatibility';
  const supportsOpenAIModelOptions = brand === 'openaiCompatibility';
  const singleConnectivity =
    brand === 'codex' || brand === 'xai'
      ? { status: connectivity.codexStatus, run: connectivity.runCodex }
      : brand === 'gemini'
        ? { status: connectivity.geminiStatus, run: connectivity.runGemini }
        : brand === 'claude'
          ? { status: connectivity.claudeStatus, run: connectivity.runClaude }
          : null;

  const updateModelEntry = (idx: number, patch: Partial<ModelEntryInput>) => {
    updateField(
      'models',
      modelsList.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    );
  };

  const removeModelEntry = (idx: number) => {
    updateField(
      'models',
      modelsList.filter((_, i) => i !== idx)
    );
  };

  return (
    <form id={formId} className={styles.form} onSubmit={handleSubmit} noValidate>
      <FormSection title={t('providersPage.form.connectionSection')}>
        <div className={styles.section}>
          {descriptor.supportsName ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-name`}>
                {t('providersPage.form.name')}
              </label>
              <input
                id={`${fid}-name`}
                className={styles.input}
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                disabled={mutating}
              />
            </div>
          ) : null}

          {descriptor.supportsApiKey ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-apiKey`}>
                {t('providersPage.form.apiKey')}
              </label>
              <div className={styles.passwordField}>
                <input
                  id={`${fid}-apiKey`}
                  className={styles.passwordInput}
                  type={showSingleApiKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => updateField('apiKey', e.target.value)}
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  placeholder={
                    mode === 'edit'
                      ? t('providersPage.form.apiKeyEditPlaceholder')
                      : t('providersPage.form.apiKeyCreatePlaceholder')
                  }
                  disabled={mutating}
                />
                <button
                  type="button"
                  className={styles.passwordToggle}
                  onClick={() => setShowSingleApiKey((v) => !v)}
                  disabled={mutating}
                  aria-label={
                    showSingleApiKey
                      ? t('providersPage.form.hideApiKey')
                      : t('providersPage.form.showApiKey')
                  }
                  title={
                    showSingleApiKey
                      ? t('providersPage.form.hideApiKey')
                      : t('providersPage.form.showApiKey')
                  }
                >
                  {showSingleApiKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </div>
            </div>
          ) : null}

          {descriptor.supportsBaseUrl ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-baseUrl`}>
                {t('providersPage.form.baseUrl')}
                {descriptor.baseUrlRequired ? (
                  <span className={styles.labelHint}>
                    {' '}
                    · {t('providersPage.form.baseUrlRequiredHint')}
                  </span>
                ) : null}
              </label>
              <input
                id={`${fid}-baseUrl`}
                className={styles.input}
                value={form.baseUrl}
                onChange={(e) => updateField('baseUrl', e.target.value)}
                placeholder="https://api.example.com"
                disabled={mutating}
              />
            </div>
          ) : null}

          {descriptor.supportsProxyUrl ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-proxy`}>
                {t('providersPage.form.proxyUrl')}
              </label>
              <input
                id={`${fid}-proxy`}
                className={styles.input}
                value={form.proxyUrl}
                onChange={(e) => updateField('proxyUrl', e.target.value)}
                placeholder="http://127.0.0.1:7890"
                disabled={mutating}
              />
            </div>
          ) : null}

          {descriptor.supportsPrefix || descriptor.supportsPriority ? (
            <div className={styles.fieldRow}>
              {descriptor.supportsPrefix ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${fid}-prefix`}>
                    {t('providersPage.form.prefix')}
                  </label>
                  <input
                    id={`${fid}-prefix`}
                    className={styles.input}
                    value={form.prefix}
                    onChange={(e) => updateField('prefix', e.target.value)}
                    disabled={mutating}
                  />
                </div>
              ) : null}
              {descriptor.supportsPriority ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${fid}-prio`}>
                    {t('providersPage.form.priority')}
                  </label>
                  <input
                    id={`${fid}-prio`}
                    type="number"
                    className={styles.input}
                    value={form.priority ?? ''}
                    onChange={(e) =>
                      updateField(
                        'priority',
                        e.target.value === '' ? undefined : Number(e.target.value)
                      )
                    }
                    disabled={mutating}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {descriptor.supportsTestModel ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-testModel`}>
                {t('providersPage.form.testModel')}
                {brand === 'codex' ||
                brand === 'xai' ||
                brand === 'claude' ||
                brand === 'gemini' ? (
                  <span className={styles.labelHint}>
                    {' '}
                    · {t('providersPage.form.testModelClaudeHint')}
                  </span>
                ) : null}
              </label>
              <Select
                id={`${fid}-testModel`}
                value={form.testModel ?? ''}
                options={testModelOptions}
                onChange={(value) => updateField('testModel', value)}
                disabled={mutating}
                ariaLabel={t('providersPage.form.testModel')}
              />
              {singleConnectivity ? (
                <div className={styles.connectivityRow}>
                  <button
                    type="button"
                    className={styles.connectivityBtn}
                    disabled={mutating || connectivity.isTestingAny}
                    onClick={() => void singleConnectivity.run()}
                  >
                    {singleConnectivity.status.state === 'loading' ? (
                      <span className={`${styles.statusIcon} ${styles.statusIconLoading}`}>
                        <IconLoader2 size={14} />
                      </span>
                    ) : null}
                    <span>{t('providersPage.connectivity.test')}</span>
                  </button>
                  <ConnectivityStatusIcon state={singleConnectivity.status.state} />
                  {singleConnectivity.status.state === 'success' ? (
                    <span className={styles.connectivityHintSuccess}>
                      {t('providersPage.connectivity.success')}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {singleConnectivity?.status.state === 'error' ? (
                <div className={styles.connectivityError}>{singleConnectivity.status.message}</div>
              ) : null}
            </div>
          ) : null}

          <div className={styles.checkboxGroup}>
            {descriptor.supportsWebsockets ? (
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.websockets ?? false}
                  disabled={mutating}
                  onChange={(e) => updateField('websockets', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.websockets')}</span>
                </span>
              </label>
            ) : null}

            {descriptor.supportsDisabled ? (
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.disabled}
                  disabled={mutating}
                  onChange={(e) => updateField('disabled', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.disabled')}</span>
                  <small>{t('providersPage.form.disabledHint')}</small>
                </span>
              </label>
            ) : null}

            {supportsDisableCooling ? (
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.disableCooling ?? false}
                  disabled={mutating}
                  onChange={(e) => updateField('disableCooling', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.disableCooling')}</span>
                  <small>{t('providersPage.form.disableCoolingHint')}</small>
                </span>
              </label>
            ) : null}
          </div>
        </div>
      </FormSection>

      {descriptor.supportsApiKeyEntries && form.apiKeyEntries ? (
        <FormSection
          title={t('providersPage.form.apiKeyEntriesSection')}
          hint={`${
            apiKeyEntries.filter((e) => e.apiKey.trim() || e.existingApiKey?.trim()).length
          }`}
        >
          <ApiKeyEntriesEditor
            entries={apiKeyEntries}
            removeDisabled={actualApiKeyEntries.length === 0}
            mutating={mutating}
            statuses={connectivity.openaiStatuses}
            isTestingAny={connectivity.isTestingAny}
            onUpdate={(idx, patch) =>
              updateField(
                'apiKeyEntries',
                apiKeyEntries.map((it, i) => (i === idx ? { ...it, ...patch } : it))
              )
            }
            onAdd={() => {
              const next = [...actualApiKeyEntries, emptyApiKeyEntry()];
              updateField('apiKeyEntries', next);
              return next.length - 1;
            }}
            onRemove={(idx) =>
              updateField(
                'apiKeyEntries',
                actualApiKeyEntries.filter((_, i) => i !== idx)
              )
            }
            onTest={(idx) => void connectivity.runOpenAIKey(idx)}
            onTestAll={() => void connectivity.runOpenAIAllKeys()}
          />
        </FormSection>
      ) : null}

      {descriptor.supportsModels ? (
        <FormSection
          title={t('providersPage.form.modelsSection')}
          hint={`${existingModelNames.size}`}
        >
          <p className={styles.sectionHintInline}>
            {t('providersPage.form.modelsSectionHint', {
              defaultValue: '只维护去重后的模型 ID；别名/手动渠道请在「模型映射」中管理。',
            })}
          </p>
          <div className={styles.entriesList}>
            {discovery.available ? (
              <div className={styles.entriesToolbar}>
                <button
                  type="button"
                  className={styles.connectivityBtn}
                  onClick={openDiscovery}
                  disabled={mutating}
                >
                  <IconDownload size={14} />
                  <span>{t('providersPage.discovery.openButton')}</span>
                </button>
              </div>
            ) : null}
            {discovery.available && discoveryOpen ? (
              <ModelDiscoveryPanel
                loading={discovery.loading}
                error={discovery.error}
                models={discovery.models}
                hasFetched={discovery.hasFetched}
                existingNames={existingModelNames}
                mutating={mutating}
                onApply={(names) => {
                  applyDiscoveredModels(names);
                }}
                onReload={() => void discovery.fetch()}
                onClose={closeDiscovery}
              />
            ) : null}
            <ModelEntriesEditor
              models={modelsList}
              extendedOptions={supportsOpenAIModelOptions}
              mutating={mutating}
              removeDisabled={modelsList.length <= 1}
              lockToggles={form.disabled}
              onUpdate={updateModelEntry}
              onAdd={() => updateField('models', [...modelsList, emptyModel()])}
              onRemove={removeModelEntry}
            />
          </div>
        </FormSection>
      ) : null}

      {descriptor.supportsHeaders ? (
        <FormSection title={t('providersPage.form.headersSection')}>
          <div className={styles.entriesList}>
            {headersList.map((entry, idx) => (
              <div key={idx} className={styles.headerRow}>
                <input
                  className={styles.input}
                  placeholder="X-Custom-Header"
                  value={entry.key}
                  onChange={(e) =>
                    updateField(
                      'headers',
                      headersList.map((it, i) => (i === idx ? { ...it, key: e.target.value } : it))
                    )
                  }
                  disabled={mutating}
                />
                <input
                  className={styles.input}
                  placeholder="value"
                  value={entry.value}
                  onChange={(e) =>
                    updateField(
                      'headers',
                      headersList.map((it, i) =>
                        i === idx ? { ...it, value: e.target.value } : it
                      )
                    )
                  }
                  disabled={mutating}
                />
                <button
                  type="button"
                  className={styles.removeBtn}
                  disabled={mutating || headersList.length <= 1}
                  onClick={() =>
                    updateField(
                      'headers',
                      headersList.filter((_, i) => i !== idx)
                    )
                  }
                >
                  <IconX size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles.addBtn}
              disabled={mutating}
              onClick={() => updateField('headers', [...headersList, emptyHeader()])}
            >
              <IconPlus size={12} />
              <span>{t('providersPage.form.addHeader')}</span>
            </button>
          </div>
        </FormSection>
      ) : null}

      {descriptor.supportsCloak && form.cloak ? (
        <FormSection title={t('providersPage.form.cloakSection')}>
          <div className={styles.section}>
            <div className={styles.field}>
              <label className={styles.label}>{t('providersPage.form.cloakMode')}</label>
              <input
                className={styles.input}
                value={form.cloak.mode}
                onChange={(e) => updateCloak('mode', e.target.value)}
                placeholder="auto / always / never"
                disabled={mutating}
              />
            </div>
            <div className={styles.checkboxGroup}>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.cloak.strictMode}
                  disabled={mutating}
                  onChange={(e) => updateCloak('strictMode', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.cloakStrict')}</span>
                </span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.cloak.cacheUserId}
                  disabled={mutating}
                  onChange={(e) => updateCloak('cacheUserId', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.cloakCacheUserId')}</span>
                  <small>{t('providersPage.form.cloakCacheUserIdHint')}</small>
                </span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxBox}
                  checked={form.experimentalCchSigning ?? false}
                  disabled={mutating}
                  onChange={(e) => updateField('experimentalCchSigning', e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  <span>{t('providersPage.form.experimentalCchSigning')}</span>
                  <small>{t('providersPage.form.experimentalCchSigningHint')}</small>
                </span>
              </label>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>{t('providersPage.form.cloakSensitiveWords')}</label>
              <textarea
                className={styles.textarea}
                rows={3}
                value={form.cloak.sensitiveWordsText}
                onChange={(e) => updateCloak('sensitiveWordsText', e.target.value)}
                disabled={mutating}
              />
            </div>
          </div>
        </FormSection>
      ) : null}

      {error ? <div className={styles.errorBox}>{error}</div> : null}
    </form>
  );
}
