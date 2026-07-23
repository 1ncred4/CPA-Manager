/**
 * 模型禁用 Tab 的扁平行：OAuth 定义 + API Key 配置 models
 *
 * API Key 模型统一用 models[] 摘除 + catalog 挂起模拟按模型禁用。
 */

import { hasDisableAllModelsRule } from '@/components/providers/utils';
import { hasOAuthExcludedRule } from '@/features/authFiles/oauthExcludedRules';
import { isModelExcluded, normalizeProviderKey } from '@/features/authFiles/constants';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';

export type ModelAccessSource = 'oauth' | 'apiKey';

export type ModelAccessLockReason = 'wildcard' | 'entry-disabled' | 'unsupported' | null;

/**
 * 禁用写回策略：
 * - catalog：从 models[] 移除并挂起（所有 API Key 品牌）
 */
export type ModelAccessDisableMode = 'exclude' | 'catalog';

export type ModelAccessRow = {
  key: string;
  source: ModelAccessSource;
  modelId: string;
  displayName: string;
  providerLabel: string;
  channelOrBrand: string;
  enabled: boolean;
  iconSrc?: string | null;
  supportsExclude: boolean;
  toggleDisabled: boolean;
  lockReason: ModelAccessLockReason;
  lockDetail?: string;
  oauthChannel?: string;
  resourceId?: string;
  brand?: ProviderBrand;
  disableMode?: ModelAccessDisableMode;
};

export type BuildOAuthRowsInput = {
  channel: string;
  models: AuthFileModelItem[];
  excluded: Record<string, string[]>;
  providerLabel: string;
  iconSrc?: string | null;
};

export type BuildApiKeyRowsInput = {
  resource: ProviderResource;
  providerLabel: string;
  iconSrc?: string | null;
  /**
   * 已被 catalog 挂起（从 models[] 摘掉）的模型 id 列表。
   * 会作为 enabled=false 的行展示，以便再次启用。
   */
  suspendedCatalogModelIds?: string[];
};

const getRuleKey = (value: string): string => value.trim().toLowerCase();

/** 找到命中 modelId 的首个通配规则（不含精确匹配） */
export function findMatchingWildcardRule(
  modelId: string,
  rules: Iterable<string>
): string | null {
  const id = modelId.trim();
  if (!id) return null;

  for (const raw of rules) {
    const pattern = String(raw ?? '').trim();
    if (!pattern || !pattern.includes('*')) continue;
    if (getRuleKey(pattern) === getRuleKey(id)) continue;

    const regexSafePattern = pattern
      .split('*')
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const regex = new RegExp(`^${regexSafePattern}$`, 'i');
    if (regex.test(id)) return pattern;
  }
  return null;
}

export function isExactExcluded(modelId: string, rules: Iterable<string>): boolean {
  return hasOAuthExcludedRule(rules, modelId);
}

export function buildOAuthAccessRows(input: BuildOAuthRowsInput): ModelAccessRow[] {
  const channel = normalizeProviderKey(input.channel);
  if (!channel) return [];

  const channelRules = input.excluded[channel] ?? input.excluded[input.channel] ?? [];
  const rows: ModelAccessRow[] = [];

  input.models.forEach((model) => {
    const modelId = String(model.id ?? '').trim();
    if (!modelId) return;

    const exact = isExactExcluded(modelId, channelRules);
    const wildcard = findMatchingWildcardRule(modelId, channelRules);
    const excluded = isModelExcluded(modelId, channel, input.excluded);
    const lockedByWildcard = excluded && !exact && Boolean(wildcard);

    rows.push({
      key: `oauth:${channel}:${getRuleKey(modelId)}`,
      source: 'oauth',
      modelId,
      displayName: (model.display_name || modelId).trim() || modelId,
      providerLabel: input.providerLabel,
      channelOrBrand: channel,
      enabled: !excluded,
      iconSrc: input.iconSrc ?? null,
      supportsExclude: true,
      toggleDisabled: lockedByWildcard,
      lockReason: lockedByWildcard ? 'wildcard' : null,
      lockDetail: lockedByWildcard ? (wildcard ?? undefined) : undefined,
      oauthChannel: channel,
    });
  });

  return rows;
}

export function buildApiKeyAccessRows(input: BuildApiKeyRowsInput): ModelAccessRow[] {
  const { resource, providerLabel, iconSrc, suspendedCatalogModelIds = [] } = input;
  const supportsExclude = true;
  const disableMode: ModelAccessDisableMode = 'catalog';
  const models = resource.models ?? [];
  const entryDisabled = resource.disabled === true;

  const activeIds = models.map((name) => String(name ?? '').trim()).filter(Boolean);
  const activeKeySet = new Set(activeIds.map(getRuleKey));

  // Catalog-suspended models that are no longer in models[] still need a row to re-enable.
  const suspendedIds = suspendedCatalogModelIds
    .map((id) => String(id ?? '').trim())
    .filter((id) => id && !activeKeySet.has(getRuleKey(id)));

  if (activeIds.length === 0 && suspendedIds.length === 0) return [];

  const rows: ModelAccessRow[] = [];

  activeIds.forEach((modelId) => {
    let enabled: boolean;
    let toggleDisabled: boolean;
    let lockReason: ModelAccessLockReason;

    if (entryDisabled) {
      enabled = false;
      toggleDisabled = true;
      lockReason = 'entry-disabled';
    } else {
      enabled = true;
      toggleDisabled = false;
      lockReason = null;
    }

    rows.push({
      key: `apiKey:${resource.id}:${getRuleKey(modelId)}`,
      source: 'apiKey',
      modelId,
      displayName: modelId,
      providerLabel,
      channelOrBrand: resource.brand,
      enabled,
      iconSrc: iconSrc ?? null,
      supportsExclude,
      toggleDisabled,
      lockReason,
      resourceId: resource.id,
      brand: resource.brand,
      disableMode,
    });
  });

  suspendedIds.forEach((modelId) => {
    rows.push({
      key: `apiKey:${resource.id}:${getRuleKey(modelId)}`,
      source: 'apiKey',
      modelId,
      displayName: modelId,
      providerLabel,
      channelOrBrand: resource.brand,
      enabled: false,
      iconSrc: iconSrc ?? null,
      supportsExclude,
      toggleDisabled: entryDisabled,
      lockReason: entryDisabled ? 'entry-disabled' : null,
      resourceId: resource.id,
      brand: resource.brand,
      disableMode,
    });
  });

  return rows;
}

export function sortModelAccessRows(rows: ModelAccessRow[]): ModelAccessRow[] {
  return [...rows].sort((a, b) => {
    // API Key first, then OAuth
    if (a.source !== b.source) return a.source === 'apiKey' ? -1 : 1;
    const providerCmp = a.providerLabel.localeCompare(b.providerLabel, undefined, {
      sensitivity: 'base',
    });
    if (providerCmp !== 0) return providerCmp;
    const nameCmp = a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: 'base',
    });
    if (nameCmp !== 0) return nameCmp;
    return a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' });
  });
}

export function filterModelAccessRows(rows: ModelAccessRow[], query: string): ModelAccessRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const haystack = `${row.displayName} ${row.modelId} ${row.providerLabel} ${row.channelOrBrand}`
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * 仅从当前已有凭证（auth files）的 type/provider 收集 OAuth 渠道。
 * 不含 presets / 排除规则 keys — 无凭证的渠道不展示模型。
 */
export function collectOAuthChannels(sources: {
  authFileTypes?: Iterable<string | undefined | null>;
}): string[] {
  const set = new Set<string>();
  const add = (value: unknown) => {
    const key = normalizeProviderKey(String(value ?? ''));
    if (!key || key === 'all' || key === 'unknown' || key === 'empty') return;
    set.add(key);
  };

  (sources.authFileTypes ? Array.from(sources.authFileTypes) : []).forEach(add);

  return Array.from(set);
}

/** 在 API Key 排除列表上切换单模型（精确 id，大小写不敏感） */
export function toggleApiKeyExcludedList(
  currentWithoutStar: string[],
  modelId: string,
  exclude: boolean
): string[] {
  return exclude
    ? // add
      (() => {
        if (isExactExcluded(modelId, currentWithoutStar)) {
          return [...currentWithoutStar];
        }
        return [...currentWithoutStar, modelId.trim()];
      })()
    : // remove
      currentWithoutStar.filter((rule) => getRuleKey(rule) !== getRuleKey(modelId));
}

export function entryHasDisableAll(resource: ProviderResource): boolean {
  if (resource.brand === 'openaiCompatibility') return resource.disabled === true;
  const raw = resource.raw as { excludedModels?: string[] };
  return hasDisableAllModelsRule(raw?.excludedModels);
}
