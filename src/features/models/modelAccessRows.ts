/**
 * 模型禁用 Tab 的扁平行：OAuth 定义 + API Key 配置 models
 */

import {
  hasDisableAllModelsRule,
  stripDisableAllModelsRule,
} from '@/components/providers/utils';
import { hasOAuthExcludedRule } from '@/features/authFiles/oauthExcludedRules';
import { isModelExcluded, normalizeProviderKey } from '@/features/authFiles/constants';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import type { GeminiKeyConfig, ProviderKeyConfig } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';

export type ModelAccessSource = 'oauth' | 'apiKey';

export type ModelAccessLockReason = 'wildcard' | 'entry-disabled' | 'unsupported' | null;

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
  const { resource, providerLabel, iconSrc } = input;
  const supportsExclude = resource.brand !== 'openaiCompatibility';
  const models = resource.models ?? [];
  if (models.length === 0) return [];

  const raw = resource.raw as GeminiKeyConfig | ProviderKeyConfig | { excludedModels?: string[] };
  const excludedModels = supportsExclude
    ? stripDisableAllModelsRule(
        Array.isArray((raw as { excludedModels?: string[] }).excludedModels)
          ? (raw as { excludedModels?: string[] }).excludedModels
          : []
      )
    : [];
  const entryDisabled = resource.disabled === true;

  return models
    .map((name) => String(name ?? '').trim())
    .filter(Boolean)
    .map((modelId) => {
      const exactExcluded = isExactExcluded(modelId, excludedModels);

      let enabled: boolean;
      let toggleDisabled: boolean;
      let lockReason: ModelAccessLockReason;

      if (!supportsExclude) {
        enabled = true;
        toggleDisabled = true;
        lockReason = 'unsupported';
      } else if (entryDisabled) {
        enabled = false;
        toggleDisabled = true;
        lockReason = 'entry-disabled';
      } else {
        enabled = !exactExcluded;
        toggleDisabled = false;
        lockReason = null;
      }

      return {
        key: `apiKey:${resource.id}:${getRuleKey(modelId)}`,
        source: 'apiKey' as const,
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
      };
    });
}

export function sortModelAccessRows(rows: ModelAccessRow[]): ModelAccessRow[] {
  return [...rows].sort((a, b) => {
    // OAuth first, then API Key
    if (a.source !== b.source) return a.source === 'oauth' ? -1 : 1;
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

export function collectOAuthChannels(sources: {
  presets?: Iterable<string>;
  authFileTypes?: Iterable<string | undefined | null>;
  excludedKeys?: Iterable<string>;
  aliasKeys?: Iterable<string>;
}): string[] {
  const set = new Set<string>();
  const add = (value: unknown) => {
    const key = normalizeProviderKey(String(value ?? ''));
    if (!key || key === 'all' || key === 'unknown' || key === 'empty') return;
    set.add(key);
  };

  (sources.presets ? Array.from(sources.presets) : []).forEach(add);
  (sources.authFileTypes ? Array.from(sources.authFileTypes) : []).forEach(add);
  (sources.excludedKeys ? Array.from(sources.excludedKeys) : []).forEach(add);
  (sources.aliasKeys ? Array.from(sources.aliasKeys) : []).forEach(add);

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
