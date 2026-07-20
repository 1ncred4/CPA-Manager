/**
 * 按顶层投影的 nativeHide / 已认领跨名，把原名从网关暴露中藏起或释放。
 *
 * OAuth：exclude 精确规则 + exposureNativeHide 标记（UI 仍 enabled）
 * API Key（非 catalog）：excludedModels 精确规则 + 同上标记
 * openaiCompatibility：暂不强制藏原名（无 exclude；catalog 摘除会破坏映射条目）——记入 skipped
 */

import {
  normalizeOAuthExcludedRules,
  updateOAuthExcludedRule,
} from '@/features/authFiles/oauthExcludedRules';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { stripDisableAllModelsRule } from '@/components/providers/utils';
import { authFilesApi } from '@/services/api';
import type { ProviderResource } from '@/features/providers/types';
import type { GeminiKeyConfig, ProviderKeyConfig } from '@/types';
import {
  listExposureNativeHideKeys,
  markExposureNativeHide,
  unmarkExposureNativeHide,
} from './exposureNativeHide';
import { mappingTargetKey, type MappingTargetRef } from './modelMapping';
import { toggleApiKeyExcludedList } from './modelAccessRows';
import { updateApiKeyExcludedModels } from './updateApiKeyExcludedModels';

export type ReconcileExposureResult = {
  hidden: number;
  revealed: number;
  skipped: string[];
  failed: string[];
};

const lower = (value: string): string => value.trim().toLowerCase();

function sameRef(a: MappingTargetRef, b: MappingTargetRef): boolean {
  return mappingTargetKey(a) === mappingTargetKey(b);
}

export async function reconcileExposureNatives(input: {
  apiBase: string;
  /** 投影算出的应隐藏原名 */
  nativeHide: MappingTargetRef[];
  resources: ProviderResource[];
}): Promise<ReconcileExposureResult> {
  const result: ReconcileExposureResult = {
    hidden: 0,
    revealed: 0,
    skipped: [],
    failed: [],
  };

  const wantHide = input.nativeHide;
  const wantKeys = new Set(wantHide.map(mappingTargetKey));
  const prevKeys = listExposureNativeHideKeys(input.apiBase);

  // --- reveal: 曾标记 exposure-hide，现已不在 nativeHide ---
  const toReveal: MappingTargetRef[] = [];
  // 只能从 prev keys 反解 oauth / apiKey
  prevKeys.forEach((key) => {
    if (wantKeys.has(key)) return;
    const oauthMatch = key.match(/^oauth:([^:]+):(.+)$/);
    if (oauthMatch) {
      toReveal.push({ source: 'oauth', channel: oauthMatch[1], modelId: oauthMatch[2] });
      return;
    }
    const apiMatch = key.match(/^apiKey:([^:]+):(.+)$/);
    if (apiMatch) {
      const resourceId = apiMatch[1];
      const modelId = apiMatch[2];
      const resource = input.resources.find((r) => r.id === resourceId);
      if (!resource) {
        unmarkExposureNativeHide(input.apiBase, {
          source: 'apiKey',
          resourceId,
          brand: 'claude',
          modelId,
        });
        return;
      }
      toReveal.push({
        source: 'apiKey',
        resourceId,
        brand: resource.brand,
        modelId,
      });
    }
  });

  // OAuth reveal / hide grouped by channel
  const oauthHideByChannel = new Map<string, string[]>();
  const oauthRevealByChannel = new Map<string, string[]>();

  wantHide.forEach((ref) => {
    if (ref.source !== 'oauth') return;
    const channel = normalizeProviderKey(ref.channel);
    if (!channel) return;
    const list = oauthHideByChannel.get(channel) ?? [];
    if (!list.some((id) => lower(id) === lower(ref.modelId))) list.push(ref.modelId);
    oauthHideByChannel.set(channel, list);
  });
  toReveal.forEach((ref) => {
    if (ref.source !== 'oauth') return;
    const channel = normalizeProviderKey(ref.channel);
    if (!channel) return;
    const list = oauthRevealByChannel.get(channel) ?? [];
    if (!list.some((id) => lower(id) === lower(ref.modelId))) list.push(ref.modelId);
    oauthRevealByChannel.set(channel, list);
  });

  if (oauthHideByChannel.size || oauthRevealByChannel.size) {
    try {
      let excludedMap: Record<string, string[]> = {};
      try {
        excludedMap = (await authFilesApi.getOauthExcludedModels()) ?? {};
      } catch (err) {
        const status =
          err && typeof err === 'object' && 'status' in err
            ? (err as { status?: unknown }).status
            : undefined;
        if (status === 404) {
          result.skipped.push('oauth-excluded-unsupported');
        } else {
          throw err;
        }
      }

      if (!result.skipped.includes('oauth-excluded-unsupported')) {
        const channels = new Set([
          ...oauthHideByChannel.keys(),
          ...oauthRevealByChannel.keys(),
        ]);
        for (const channel of channels) {
          let rules = normalizeOAuthExcludedRules(excludedMap[channel] ?? []);
          let dirty = false;

          for (const modelId of oauthRevealByChannel.get(channel) ?? []) {
            const before = rules.length;
            rules = updateOAuthExcludedRule(rules, modelId, false);
            if (rules.length !== before) {
              dirty = true;
              result.revealed += 1;
            }
            unmarkExposureNativeHide(input.apiBase, {
              source: 'oauth',
              channel,
              modelId,
            });
          }

          for (const modelId of oauthHideByChannel.get(channel) ?? []) {
            const next = updateOAuthExcludedRule(rules, modelId, true);
            if (next.length !== rules.length || !next.includes(modelId)) {
              // updateOAuthExcludedRule 可能已存在
              const had = rules.some((r) => lower(r) === lower(modelId));
              rules = next;
              if (!had) {
                dirty = true;
                result.hidden += 1;
              }
            }
            markExposureNativeHide(input.apiBase, {
              source: 'oauth',
              channel,
              modelId,
            });
          }

          if (dirty) {
            if (rules.length) {
              await authFilesApi.saveOauthExcludedModels(channel, rules);
            } else {
              await authFilesApi.deleteOauthExcludedEntry(channel);
            }
          }
        }
      }
    } catch (err) {
      result.failed.push(err instanceof Error ? err.message : String(err));
    }
  }

  // API Key
  const apiHideByResource = new Map<string, string[]>();
  const apiRevealByResource = new Map<string, string[]>();

  wantHide.forEach((ref) => {
    if (ref.source !== 'apiKey') return;
    const list = apiHideByResource.get(ref.resourceId) ?? [];
    if (!list.some((id) => lower(id) === lower(ref.modelId))) list.push(ref.modelId);
    apiHideByResource.set(ref.resourceId, list);
  });
  toReveal.forEach((ref) => {
    if (ref.source !== 'apiKey') return;
    const list = apiRevealByResource.get(ref.resourceId) ?? [];
    if (!list.some((id) => lower(id) === lower(ref.modelId))) list.push(ref.modelId);
    apiRevealByResource.set(ref.resourceId, list);
  });

  const resourceIds = new Set([...apiHideByResource.keys(), ...apiRevealByResource.keys()]);
  for (const resourceId of resourceIds) {
    const resource = input.resources.find((r) => r.id === resourceId);
    if (!resource) {
      result.skipped.push(`resource-missing:${resourceId}`);
      continue;
    }
    if (resource.brand === 'openaiCompatibility') {
      (apiHideByResource.get(resourceId) ?? []).forEach((modelId) => {
        result.skipped.push(`openai-catalog-no-native-hide:${resourceId}:${modelId}`);
        // 仍标记，避免反复尝试；不写 catalog 摘除以免破坏 alias 条目
        markExposureNativeHide(input.apiBase, {
          source: 'apiKey',
          resourceId,
          brand: resource.brand,
          modelId,
        });
      });
      (apiRevealByResource.get(resourceId) ?? []).forEach((modelId) => {
        unmarkExposureNativeHide(input.apiBase, {
          source: 'apiKey',
          resourceId,
          brand: resource.brand,
          modelId,
        });
      });
      continue;
    }

    try {
      const raw = resource.raw as GeminiKeyConfig | ProviderKeyConfig;
      let list = stripDisableAllModelsRule(raw.excludedModels);
      let dirty = false;

      for (const modelId of apiRevealByResource.get(resourceId) ?? []) {
        const next = toggleApiKeyExcludedList(list, modelId, false);
        if (next.length !== list.length) {
          list = next;
          dirty = true;
          result.revealed += 1;
        }
        unmarkExposureNativeHide(input.apiBase, {
          source: 'apiKey',
          resourceId,
          brand: resource.brand,
          modelId,
        });
      }

      for (const modelId of apiHideByResource.get(resourceId) ?? []) {
        const next = toggleApiKeyExcludedList(list, modelId, true);
        if (next.length !== list.length) {
          list = next;
          dirty = true;
          result.hidden += 1;
        }
        markExposureNativeHide(input.apiBase, {
          source: 'apiKey',
          resourceId,
          brand: resource.brand,
          modelId,
        });
      }

      if (dirty) {
        await updateApiKeyExcludedModels(resource, list);
      }
    } catch (err) {
      result.failed.push(err instanceof Error ? err.message : String(err));
    }
  }

  void sameRef;
  return result;
}
