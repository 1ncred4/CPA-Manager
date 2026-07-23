/**
 * Provider form helpers for per-model enable/disable.
 * API Key providers use catalog suspension: disabled model entries are omitted
 * from models[] and retained in a local snapshot for restoration.
 */

import { stripDisableAllModelsRule } from '@/components/providers/utils';
import {
  loadMappingDisabled,
  loadModelDisabledSnapshots,
} from '@/features/models/modelDisabledState';
import type { ModelAlias } from '@/types';
import type { ModelEntryInput } from './types';

const lower = (value: string): string => value.trim().toLowerCase();

/** Model ids the form marks as disabled (enabled === false). */
export function collectDisabledModelIds(models: ModelEntryInput[] | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  (models ?? []).forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    if (!name || entry.enabled !== false) return;
    const key = lower(name);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(name);
  });
  return ids;
}

/** Exact-id disabled set for load-time annotation (ignores wildcards). */
export function collectExactExcludedIds(excludedModels: string[] | undefined): Set<string> {
  const set = new Set<string>();
  stripDisableAllModelsRule(excludedModels).forEach((rule) => {
    const id = String(rule ?? '').trim();
    if (!id || id.includes('*')) return;
    set.add(lower(id));
  });
  return set;
}

/**
 * Merge form per-model disables into excludedModels while preserving
 * wildcards. Entry-level `*` is driven solely by form.disabled.
 */
export function mergeFormExcludedModels(input: {
  existingExcluded?: string[];
  entryDisabled: boolean;
  formDisabledModelIds: string[];
}): string[] | undefined {
  const existing = Array.isArray(input.existingExcluded) ? input.existingExcluded : [];
  // Keep wildcards from existing; form owns exact ids.
  const preserved = stripDisableAllModelsRule(existing).filter((rule) => {
    const id = String(rule ?? '').trim();
    return Boolean(id) && id.includes('*');
  });

  const exact: string[] = [];
  const seen = new Set(preserved.map((r) => lower(r)));
  input.formDisabledModelIds.forEach((id) => {
    const name = id.trim();
    if (!name) return;
    const key = lower(name);
    if (seen.has(key)) return;
    seen.add(key);
    exact.push(name);
  });

  const withoutStar = [...preserved, ...exact];
  if (input.entryDisabled) {
    return [...withoutStar, '*'];
  }
  return withoutStar.length ? withoutStar : undefined;
}

export type FormModelsLoadOptions = {
  models?: Array<{
    name?: string;
    alias?: string;
    priority?: number;
    testModel?: string;
    image?: boolean;
    thinking?: Record<string, unknown>;
  }>;
  includeOpenAIFields?: boolean;
  /** Retained for callers that still pass server-side exclusion metadata. */
  exactExcludedIds?: Iterable<string>;
  /** Catalog-suspended models to append as enabled=false. */
  suspendedCatalog?: Array<{ modelId: string; entries: ModelAlias[] }>;
  /** Models omitted from backend models[] by manual mapping pruning. */
  catalogOnlyModelIds?: Iterable<string>;
};

/**
 * Dedupe models[] by name for the provider form and annotate enabled state.
 * Suspended catalog entries that are not in models[] are appended as disabled rows.
 */
export function modelsToFormEntriesWithAccess(options: FormModelsLoadOptions): ModelEntryInput[] {
  const includeOpenAIFields = options.includeOpenAIFields === true;
  const excluded = new Set(
    Array.from(options.exactExcludedIds ?? [])
      .map((id) => lower(String(id ?? '')))
      .filter(Boolean)
  );
  const seen = new Map<string, number>();
  const catalogOnly = new Map<string, string>();
  Array.from(options.catalogOnlyModelIds ?? []).forEach((id) => {
    const modelId = String(id ?? '').trim();
    const key = lower(modelId);
    if (key && !catalogOnly.has(key)) catalogOnly.set(key, modelId);
  });
  const out: ModelEntryInput[] = [];

  (options.models ?? []).forEach((m) => {
    const name = String(m?.name ?? '').trim();
    if (!name) return;
    const key = lower(name);
    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      if (includeOpenAIFields) {
        const prev = out[existingIdx];
        if (prev && m.image === true) prev.image = true;
        if (prev && !prev.thinkingJson?.trim() && m.thinking) {
          try {
            prev.thinkingJson = JSON.stringify(m.thinking, null, 2);
          } catch {
            // ignore
          }
        }
      }
      return;
    }
    seen.set(key, out.length);
    const entry: ModelEntryInput = {
      name,
      priority: m.priority,
      testModel: m.testModel,
      enabled: !excluded.has(key),
    };
    if (includeOpenAIFields) {
      entry.image = m.image === true;
      if (m.thinking && typeof m.thinking === 'object') {
        try {
          entry.thinkingJson = JSON.stringify(m.thinking, null, 2);
        } catch {
          entry.thinkingJson = '';
        }
      }
    }
    out.push(entry);
  });

  (options.suspendedCatalog ?? []).forEach((suspended) => {
    const name = String(suspended.modelId ?? '').trim();
    if (!name) return;
    const key = lower(name);
    if (seen.has(key)) return;
    seen.set(key, out.length);
    const first = suspended.entries[0];
    const entry: ModelEntryInput = {
      name: first?.name?.trim() || name,
      enabled: false,
    };
    if (includeOpenAIFields && first) {
      if (first.image === true) entry.image = true;
      if (first.thinking && typeof first.thinking === 'object') {
        try {
          entry.thinkingJson = JSON.stringify(first.thinking, null, 2);
        } catch {
          entry.thinkingJson = '';
        }
      }
    }
    if (first?.priority !== undefined) entry.priority = first.priority;
    if (first?.testModel !== undefined) entry.testModel = first.testModel;
    out.push(entry);
  });

  catalogOnly.forEach((modelId, key) => {
    if (seen.has(key)) return;
    seen.set(key, out.length);
    out.push({
      name: modelId,
      enabled: !excluded.has(key),
      backendOmitted: true,
    });
  });

  return out.length ? out : [{ name: '', enabled: true }];
}

/** Catalog names that should remain in models[] for openai (enabled only). */
export function filterEnabledCatalogNames(
  models: ModelEntryInput[] | undefined
): ModelEntryInput[] {
  return (models ?? []).filter((entry) => {
    const name = String(entry.name ?? '').trim();
    return Boolean(name) && entry.enabled !== false && entry.backendOmitted !== true;
  });
}

/** Resolve ModelAlias entries to suspend for a disabled openai catalog model. */
export function resolveEntriesToSuspend(
  existingModels: ModelAlias[] | undefined,
  modelId: string,
  formEntry?: ModelEntryInput
): ModelAlias[] {
  const key = lower(modelId);
  const fromExisting = (existingModels ?? []).filter(
    (entry) => lower(String(entry?.name ?? '')) === key
  );
  if (fromExisting.length) return fromExisting.map((e) => ({ ...e }));
  if (formEntry) {
    const entry: ModelAlias = {
      name: formEntry.name.trim() || modelId,
      alias: formEntry.alias?.trim() || formEntry.name.trim() || modelId,
    };
    if (formEntry.priority !== undefined) entry.priority = formEntry.priority;
    if (formEntry.testModel) entry.testModel = formEntry.testModel;
    if (formEntry.image === true) entry.image = true;
    if (formEntry.thinkingJson?.trim()) {
      try {
        const parsed = JSON.parse(formEntry.thinkingJson) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entry.thinking = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore invalid thinking draft
      }
    }
    return [entry];
  }
  return [{ name: modelId, alias: modelId }];
}

/** Load suspended catalog for a resource when apiBase is known. */
export function loadSuspendedCatalogSafe(
  apiBase: string | undefined,
  resourceId: string | undefined
): Array<{ modelId: string; entries: ModelAlias[] }> {
  if (!apiBase || !resourceId) return [];
  return Array.from(loadModelDisabledSnapshots(apiBase).values())
    .filter(
      (snapshot) => snapshot.target.source === 'apiKey' && snapshot.target.resourceId === resourceId
    )
    .map((snapshot) => ({
      modelId: snapshot.target.modelId,
      entries: snapshot.entries as ModelAlias[],
    }));
}

/**
 * Model ids kept visible locally after manual mapping pruning removes their
 * final backend catalog entry.
 */
export function loadMappingDisabledCatalogModelIdsSafe(
  apiBase: string | undefined,
  resourceId: string | undefined
): string[] {
  if (!apiBase || !resourceId) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  loadMappingDisabled(apiBase).forEach((entries) => {
    entries.forEach((entry) => {
      if (entry.target.source !== 'apiKey' || entry.target.resourceId !== resourceId) return;
      const modelId = String(entry.target.modelId ?? '').trim();
      const key = lower(modelId);
      if (!key || seen.has(key)) return;
      seen.add(key);
      ids.push(modelId);
    });
  });
  return ids;
}
