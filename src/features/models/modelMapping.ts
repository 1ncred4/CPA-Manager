/**
 * 联邦模型映射：把 OAuth alias + API Key models[].alias
 * 聚合成「自定义名 → 多目标」视图模型，并提供 diff/校验纯函数。
 */

import type { OAuthModelAliasEntry, ModelAlias } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import type { ModelAccessRow } from './modelAccessRows';

export type MappingTargetSource = 'oauth' | 'apiKey';

export type OauthMappingTargetRef = {
  source: 'oauth';
  channel: string;
  modelId: string;
};

export type ApiKeyMappingTargetRef = {
  source: 'apiKey';
  resourceId: string;
  brand: ProviderBrand;
  modelId: string;
};

export type MappingTargetRef = OauthMappingTargetRef | ApiKeyMappingTargetRef;

export type MappingTarget = MappingTargetRef & {
  displayName: string;
  providerLabel: string;
  iconSrc?: string | null;
  /** 目标当前是否仍在「已启用」集合中（映射可能残留在已禁用模型上） */
  currentlyEnabled: boolean;
  /**
   * 因模型禁用而被管理端剪枝、本地挂起的目标。
   * 仍展示在映射列表中（灰标），启用模型后会写回真实配置。
   */
  suspended?: boolean;
};

export type FederatedMappingRow = {
  /** 自定义模型名（alias），大小写按首次见到的原文保留 */
  alias: string;
  aliasKey: string;
  targets: MappingTarget[];
};

export type MappingPickerOption = MappingTargetRef & {
  displayName: string;
  providerLabel: string;
  iconSrc?: string | null;
  groupKey: string;
};

export type MappingTargetDiff = {
  toAdd: MappingTargetRef[];
  toRemove: MappingTargetRef[];
};

export type MappingValidationError =
  | 'alias_required'
  | 'no_targets'
  | 'duplicate_alias';

const lower = (value: string): string => value.trim().toLowerCase();

export function toAliasKey(alias: string): string {
  return lower(alias);
}

/** 目标模型 ID 与自定义名相同，属于 identity 来源。 */
export function isIdentityMappingTarget(alias: string, target: MappingTargetRef): boolean {
  return Boolean(toAliasKey(alias)) && lower(target.modelId) === toAliasKey(alias);
}

/** 保留所有目标；v2 会同时持久化 identity alias。 */
export function filterPersistableMappingTargets(
  _alias: string,
  targets: MappingTargetRef[]
): MappingTargetRef[] {
  // v2 writes identity aliases as well.  Keep this helper for callers that use
  // it as a normalization boundary, but no target is discarded anymore.
  return targets;
}

export function mappingTargetKey(ref: MappingTargetRef): string {
  if (ref.source === 'oauth') {
    return `oauth:${normalizeProviderKey(ref.channel)}:${lower(ref.modelId)}`;
  }
  return `apiKey:${ref.resourceId}:${lower(ref.modelId)}`;
}

export function sameMappingTarget(a: MappingTargetRef, b: MappingTargetRef): boolean {
  return mappingTargetKey(a) === mappingTargetKey(b);
}

/** access / 启用态集合用的 key，与 modelAccessRows 对齐 */
export function accessEnabledKey(ref: MappingTargetRef): string {
  if (ref.source === 'oauth') {
    return `oauth:${normalizeProviderKey(ref.channel)}:${lower(ref.modelId)}`;
  }
  return `apiKey:${ref.resourceId}:${lower(ref.modelId)}`;
}

export function isMeaningfulAlias(alias: string | undefined | null, modelName: string): boolean {
  const a = String(alias ?? '').trim();
  if (!a) return false;
  return lower(a) !== lower(modelName);
}

export type BuildFederatedMappingRowsInput = {
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  resources: ProviderResource[];
  /** modelId lower → display_name */
  oauthDisplayNames?: Record<string, Record<string, string>>;
  /** provider labels: channel or `apiKey:${resourceId}` */
  providerLabels: {
    oauth: (channel: string) => string;
    apiKey: (resource: ProviderResource) => string;
  };
  icons?: {
    oauth?: (channel: string) => string | null | undefined;
    apiKey?: (resource: ProviderResource) => string | null | undefined;
  };
  /** Set of accessEnabledKey values that are currently enabled */
  enabledKeySet?: Set<string>;
};

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models;
}

export function buildFederatedMappingRows(
  input: BuildFederatedMappingRowsInput
): FederatedMappingRow[] {
  const buckets = new Map<
    string,
    { alias: string; targets: MappingTarget[]; seen: Set<string> }
  >();

  const ensure = (alias: string) => {
    const key = toAliasKey(alias);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { alias: alias.trim(), targets: [], seen: new Set() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const enabledKeySet = input.enabledKeySet;

  Object.entries(input.modelAlias ?? {}).forEach(([channelRaw, entries]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(entries)) return;
    const providerLabel = input.providerLabels.oauth(channel);
    const iconSrc = input.icons?.oauth?.(channel) ?? null;
    const displayMap = input.oauthDisplayNames?.[channel] ?? {};

    entries.forEach((entry) => {
      const modelId = String(entry?.name ?? '').trim();
      const alias = String(entry?.alias ?? modelId).trim() || modelId;
      if (!modelId) return;

      const ref: OauthMappingTargetRef = { source: 'oauth', channel, modelId };
      const tKey = mappingTargetKey(ref);
      const bucket = ensure(alias);
      if (bucket.seen.has(tKey)) return;
      bucket.seen.add(tKey);

      const displayName = (displayMap[lower(modelId)] || modelId).trim() || modelId;
      const enabledKey = accessEnabledKey(ref);
      bucket.targets.push({
        ...ref,
        displayName,
        providerLabel,
        iconSrc,
        currentlyEnabled: enabledKeySet ? enabledKeySet.has(enabledKey) : true,
      });
    });
  });

  input.resources.forEach((resource) => {
    const models = readApiKeyModels(resource);
    if (models.length === 0) return;
    const providerLabel = input.providerLabels.apiKey(resource);
    const iconSrc = input.icons?.apiKey?.(resource) ?? null;

    models.forEach((model) => {
      const modelId = String(model?.name ?? '').trim();
      const alias = String(model?.alias ?? modelId).trim() || modelId;
      if (!modelId) return;

      const ref: ApiKeyMappingTargetRef = {
        source: 'apiKey',
        resourceId: resource.id,
        brand: resource.brand,
        modelId,
      };
      const tKey = mappingTargetKey(ref);
      const bucket = ensure(alias);
      if (bucket.seen.has(tKey)) return;
      bucket.seen.add(tKey);

      const enabledKey = accessEnabledKey(ref);
      bucket.targets.push({
        ...ref,
        displayName: modelId,
        providerLabel,
        iconSrc,
        currentlyEnabled: enabledKeySet ? enabledKeySet.has(enabledKey) : true,
      });
    });
  });

  const rows: FederatedMappingRow[] = Array.from(buckets.entries()).map(([aliasKey, bucket]) => {
    const targets = [...bucket.targets].sort((a, b) => {
      const p = a.providerLabel.localeCompare(b.providerLabel, undefined, { sensitivity: 'base' });
      if (p !== 0) return p;
      return a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' });
    });
    return { alias: bucket.alias, aliasKey, targets };
  });

  rows.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
  return rows;
}

export function filterFederatedMappingRows(
  rows: FederatedMappingRow[],
  query: string
): FederatedMappingRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    if (row.alias.toLowerCase().includes(q) || row.aliasKey.includes(q)) return true;
    return row.targets.some((target) => {
      const hay = `${target.displayName} ${target.modelId} ${target.providerLabel}`.toLowerCase();
      return hay.includes(q);
    });
  });
}

export type UnmappedModelRow = MappingPickerOption & {
  enabled: boolean;
};

/** Convert an access row into a stable mapping target ref, or null if incomplete. */
export function accessRowToTargetRef(row: ModelAccessRow): MappingTargetRef | null {
  const modelId = row.modelId.trim();
  if (!modelId) return null;
  if (row.source === 'oauth') {
    const channel = normalizeProviderKey(row.oauthChannel ?? row.channelOrBrand);
    if (!channel) return null;
    return { source: 'oauth', channel, modelId };
  }
  const resourceId = row.resourceId;
  const brand = row.brand;
  if (!resourceId || !brand) return null;
  return { source: 'apiKey', resourceId, brand, modelId };
}

export function collectMappedTargetKeys(rows: FederatedMappingRow[]): Set<string> {
  const keys = new Set<string>();
  rows.forEach((row) => {
    row.targets.forEach((target) => {
      keys.add(mappingTargetKey(target));
    });
  });
  return keys;
}

/**
 * Enabled models that exist in the access catalog but are not targets of any custom alias.
 * Disabled models are excluded (they cannot be mapped until re-enabled).
 */
export function buildUnmappedModels(
  accessRows: ModelAccessRow[],
  mappedTargetKeys: Set<string>
): UnmappedModelRow[] {
  const options: UnmappedModelRow[] = [];
  const seen = new Set<string>();

  accessRows.forEach((row) => {
    if (!row.enabled) return;
    const ref = accessRowToTargetRef(row);
    if (!ref) return;
    const key = mappingTargetKey(ref);
    if (mappedTargetKeys.has(key) || seen.has(key)) return;
    seen.add(key);

    const groupKey =
      ref.source === 'oauth' ? `oauth:${ref.channel}` : `apiKey:${ref.resourceId}`;

    options.push({
      ...ref,
      displayName: row.displayName || ref.modelId,
      providerLabel: row.providerLabel,
      iconSrc: row.iconSrc ?? null,
      groupKey,
      enabled: row.enabled,
    });
  });

  options.sort((a, b) => {
    const p = a.providerLabel.localeCompare(b.providerLabel, undefined, { sensitivity: 'base' });
    if (p !== 0) return p;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });

  return options;
}

export function filterUnmappedModels(
  rows: UnmappedModelRow[],
  query: string
): UnmappedModelRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const hay = `${row.displayName} ${row.modelId} ${row.providerLabel}`.toLowerCase();
    return hay.includes(q);
  });
}

export function buildEnabledMappingOptions(accessRows: ModelAccessRow[]): MappingPickerOption[] {
  const options: MappingPickerOption[] = [];
  const seen = new Set<string>();

  accessRows.forEach((row) => {
    if (!row.enabled) return;
    const ref = accessRowToTargetRef(row);
    if (!ref) return;

    const key = mappingTargetKey(ref);
    if (seen.has(key)) return;
    seen.add(key);

    const groupKey =
      ref.source === 'oauth' ? `oauth:${ref.channel}` : `apiKey:${ref.resourceId}`;

    options.push({
      ...ref,
      displayName: row.displayName || ref.modelId,
      providerLabel: row.providerLabel,
      iconSrc: row.iconSrc ?? null,
      groupKey,
    });
  });

  options.sort((a, b) => {
    const p = a.providerLabel.localeCompare(b.providerLabel, undefined, { sensitivity: 'base' });
    if (p !== 0) return p;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });

  return options;
}

export function diffMappingTargets(
  baseline: MappingTargetRef[],
  next: MappingTargetRef[]
): MappingTargetDiff {
  const baselineKeys = new Set(baseline.map(mappingTargetKey));
  const nextKeys = new Set(next.map(mappingTargetKey));

  const toAdd = next.filter((ref) => !baselineKeys.has(mappingTargetKey(ref)));
  const toRemove = baseline.filter((ref) => !nextKeys.has(mappingTargetKey(ref)));
  return { toAdd, toRemove };
}

export function validateMappingSelection(input: {
  alias: string;
  targets: MappingTargetRef[];
  /** 其它已存在 mapping 的 aliasKey；编辑时排除自身 */
  existingAliasKeys: Iterable<string>;
  /** 编辑中的原 aliasKey（允许保留） */
  editingAliasKey?: string | null;
}): MappingValidationError | null {
  const alias = input.alias.trim();
  if (!alias) return 'alias_required';
  if (!input.targets.length) return 'no_targets';

  // CPA 序列化/OAuth 存储都会丢弃 alias===name；若全部目标都是同名，保存必然不生效。
  const aliasKey = toAliasKey(alias);
  if (aliasKey !== (input.editingAliasKey ?? null)) {
    for (const existing of input.existingAliasKeys) {
      if (existing === aliasKey) return 'duplicate_alias';
    }
  }

  return null;
}

export function getMappingDraftSignature(alias: string, targets: MappingTargetRef[]): string {
  const keys = targets.map(mappingTargetKey).sort();
  return `${toAliasKey(alias)}\n${keys.join('\n')}`;
}

/**
 * 对单个 OAuth channel 应用「某 alias 的目标增删」。
 * 返回新 entries；若为空数组表示 channel 可删除。
 */
export function applyOauthAliasTargetChanges(input: {
  entries: OAuthModelAliasEntry[];
  alias: string;
  /** 该 channel 上最终应保留的 modelId 列表（0 或 1 个，因 channel 级唯一） */
  nextModelIds: string[];
}): OAuthModelAliasEntry[] {
  const aliasKey = toAliasKey(input.alias);
  const aliasLiteral = input.alias.trim();
  const nextModelIds = input.nextModelIds.map((id) => id.trim()).filter(Boolean);

  const preserved: OAuthModelAliasEntry[] = [];
  const existingByName = new Map<string, OAuthModelAliasEntry>();

  input.entries.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    const entryAlias = String(entry.alias ?? '').trim();
    if (!name) return;
    const normalizedEntry = { ...entry, name, alias: entryAlias || name };
    if (toAliasKey(entryAlias) === aliasKey) {
      existingByName.set(lower(name), normalizedEntry);
      return;
    }
    preserved.push(normalizedEntry);
  });

  const nextForAlias: OAuthModelAliasEntry[] = [];
  nextModelIds.forEach((id) => {
    const prev = existingByName.get(lower(id));
    const entry: OAuthModelAliasEntry = {
      name: id,
      alias: aliasLiteral,
    };
    if (prev?.fork === true) {
      entry.fork = true;
    }
    if (typeof prev?.forceMapping === 'boolean') {
      entry.forceMapping = prev.forceMapping;
    }
    nextForAlias.push(entry);
  });

  return [...preserved, ...nextForAlias];
}

/**
 * 对 API Key models[] 应用「某一自定义渠道 alias」的增删。
 *
 * 同一模型可挂到多个手动渠道：用多条同名 models 条目表达
 *   [{ name: "gpt-x", alias: "a" }, { name: "gpt-x", alias: "b" }]
 * 编辑渠道 a 时不得覆盖/删除渠道 b 的条目。
 *
 * - 若 nextModelIds 含目录中不存在的模型，则追加条目
 * - identity（alias===name）也会写入，作为 v2 的自动/显式 identity 来源。
 */
export function applyApiKeyModelAliasChanges(input: {
  models: ModelAlias[];
  alias: string;
  /** 该 resource 上最终应持有此 alias 的 modelId 列表（可多个） */
  nextModelIds: string[];
  /** 编辑前该 resource 上属于旧 alias（rename 时）的 modelId，需一并清空 */
  previousModelIds?: string[];
  previousAliasKey?: string | null;
}): ModelAlias[] {
  const aliasLiteral = input.alias.trim();
  const aliasKey = toAliasKey(aliasLiteral);
  const prevAliasKey = input.previousAliasKey ? toAliasKey(input.previousAliasKey) : aliasKey;
  void input.previousModelIds;

  const nextModelKeys = new Set(input.nextModelIds.map((id) => id.trim()).filter(Boolean).map(lower));

  const isEditedAliasKey = (key: string): boolean =>
    Boolean(key) && (key === aliasKey || key === prevAliasKey);

  const result: ModelAlias[] = [];
  /** nameKey → 结果中是否已有至少一条（用于移除 alias 后保留目录） */
  const namePresent = new Set<string>();
  /** nameKey → 是否已有「当前 alias」条目 */
  const holdsThisAlias = new Set<string>();
  const normalizeEntry = (model: ModelAlias): ModelAlias => ({
    ...model,
    name: String(model.name ?? '').trim(),
    alias: String(model.alias ?? model.name ?? '').trim() || String(model.name ?? '').trim(),
  });

  input.models.forEach((model) => {
    const name = String(model.name ?? '').trim();
    if (!name) return;
    const nameKey = lower(name);
    const normalized = normalizeEntry(model);
    const currentAlias = normalized.alias;
    const currentAliasKey = toAliasKey(currentAlias);

    // 属于正在编辑的 alias：先拿掉，后面按 nextModelIds 再加回
    if (isEditedAliasKey(currentAliasKey)) {
      return;
    }

    // 其它有意义 alias：原样保留（多渠道）
    if (currentAliasKey) {
      result.push(normalized);
      namePresent.add(nameKey);
      return;
    }
    result.push({ ...normalized, alias: name });
    namePresent.add(nameKey);
  });

  // 为 nextModelIds 确保存在「name + 当前 alias」条目
  nextModelKeys.forEach((nameKey) => {
    if (holdsThisAlias.has(nameKey)) return;

    const identityIndex = result.findIndex(
      (entry) => lower(entry.name) === nameKey && lower(entry.alias) === nameKey
    );
    if (identityIndex >= 0) {
      result[identityIndex] = { ...result[identityIndex], alias: aliasLiteral };
      holdsThisAlias.add(nameKey);
      namePresent.add(nameKey);
      return;
    }

    // 已有其它 alias 的同名条目，或目录中尚无此模型：追加一条，不覆盖其它渠道。
    const originalName =
      input.nextModelIds.map((id) => id.trim()).find((id) => lower(id) === nameKey) || nameKey;
    result.push({ name: originalName, alias: aliasLiteral });
    holdsThisAlias.add(nameKey);
    namePresent.add(nameKey);
  });

  // 被移出当前 alias 且结果中已无条目的模型，补回 identity alias，保证每个模型仍有 alias。
  input.models.forEach((model) => {
    const name = String(model.name ?? '').trim();
    if (!name) return;
    const nameKey = lower(name);
    if (namePresent.has(nameKey)) return;
    if (nextModelKeys.has(nameKey)) return;
    result.push({ ...normalizeEntry(model), alias: name });
    namePresent.add(nameKey);
  });

  const aliasesByName = new Map<string, string[]>();
  result.forEach((entry) => {
    const key = lower(entry.name);
    const list = aliasesByName.get(key) ?? [];
    list.push(entry.alias);
    aliasesByName.set(key, list);
  });
  return result.filter((entry) => {
    const aliases = aliasesByName.get(lower(entry.name)) ?? [];
    const hasNonIdentity = aliases.some((alias) => lower(alias) !== lower(entry.name));
    return lower(entry.name) !== lower(entry.alias) || !hasNonIdentity;
  });
}

/** 从 oauth definitions 构建 channel → modelIdLower → displayName */
export function buildOauthDisplayNameMap(
  oauthModels: Record<string, AuthFileModelItem[]>
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  Object.entries(oauthModels).forEach(([channelRaw, models]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel) return;
    const map: Record<string, string> = {};
    models.forEach((model) => {
      const id = String(model.id ?? '').trim();
      if (!id) return;
      const display = (model.display_name || id).trim() || id;
      map[lower(id)] = display;
    });
    result[channel] = map;
  });
  return result;
}

/** 收集某 alias 在全量 modelAlias map 中涉及的 channel 集合 */
export function collectChannelsForAlias(
  modelAlias: Record<string, OAuthModelAliasEntry[]>,
  aliasKey: string
): string[] {
  const channels: string[] = [];
  Object.entries(modelAlias).forEach(([channelRaw, entries]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(entries)) return;
    if (entries.some((e) => toAliasKey(String(e.alias ?? '')) === aliasKey)) {
      channels.push(channel);
    }
  });
  return channels;
}

/**
 * 为保存计算：每个 OAuth channel 最终应持有的 modelId 列表（针对给定 alias）
 * 以及每个 API Key resource 最终应持有的 modelId 列表。
 *
 * @param alias 若提供，会剔除 identity 目标（alias===modelId），避免写入会被后端丢弃的条目
 */
export function planAliasTargetAssignments(
  targets: MappingTargetRef[],
  alias?: string
): {
  oauthByChannel: Map<string, string[]>;
  apiKeyByResource: Map<string, { brand: ProviderBrand; modelIds: string[] }>;
} {
  const oauthByChannel = new Map<string, string[]>();
  const apiKeyByResource = new Map<string, { brand: ProviderBrand; modelIds: string[] }>();
  const persistable = alias ? filterPersistableMappingTargets(alias, targets) : targets;

  persistable.forEach((target) => {
    if (target.source === 'oauth') {
      const channel = normalizeProviderKey(target.channel);
      if (!channel) return;
      const list = oauthByChannel.get(channel) ?? [];
      if (!list.some((id) => lower(id) === lower(target.modelId))) {
        list.push(target.modelId.trim());
      }
      oauthByChannel.set(channel, list);
    } else {
      const current = apiKeyByResource.get(target.resourceId) ?? {
        brand: target.brand,
        modelIds: [] as string[],
      };
      if (!current.modelIds.some((id) => lower(id) === lower(target.modelId))) {
        current.modelIds.push(target.modelId.trim());
      }
      apiKeyByResource.set(target.resourceId, current);
    }
  });

  return { oauthByChannel, apiKeyByResource };
}

function sortMappingTargets(targets: MappingTarget[]): MappingTarget[] {
  return [...targets].sort((a, b) => {
    // active first, then suspended
    if (Boolean(a.suspended) !== Boolean(b.suspended)) {
      return a.suspended ? 1 : -1;
    }
    const p = a.providerLabel.localeCompare(b.providerLabel, undefined, { sensitivity: 'base' });
    if (p !== 0) return p;
    return a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' });
  });
}

function accessRowToMappingTarget(row: ModelAccessRow): MappingTarget | null {
  if (!row.enabled) return null;
  const ref = accessRowToTargetRef(row);
  if (!ref) return null;
  return {
    ...ref,
    displayName: row.displayName || ref.modelId,
    providerLabel: row.providerLabel,
    iconSrc: row.iconSrc ?? null,
    currentlyEnabled: true,
  };
}

/**
 * 把目录中「模型 ID 恰好等于某自定义名」的原生模型挂到对应映射行上。
 * 这些目标不会单独落库（identity），但客户端按该名称请求时它们天然参与路由，应在 UI 中展示。
 */
export function attachNativeIdentityTargets(
  rows: FederatedMappingRow[],
  accessRows: ModelAccessRow[]
): FederatedMappingRow[] {
  if (!rows.length || !accessRows.length) return rows;

  const identityByAlias = new Map<string, MappingTarget[]>();
  accessRows.forEach((row) => {
    const target = accessRowToMappingTarget(row);
    if (!target) return;
    const aliasKey = lower(target.modelId);
    if (!aliasKey) return;
    const list = identityByAlias.get(aliasKey) ?? [];
    if (list.some((t) => mappingTargetKey(t) === mappingTargetKey(target))) return;
    list.push(target);
    identityByAlias.set(aliasKey, list);
  });

  if (!identityByAlias.size) return rows;

  return rows.map((row) => {
    const natives = identityByAlias.get(row.aliasKey);
    if (!natives?.length) return row;
    const seen = new Set(row.targets.map(mappingTargetKey));
    const extras = natives.filter((t) => !seen.has(mappingTargetKey(t)));
    if (!extras.length) return row;
    return { ...row, targets: sortMappingTargets([...row.targets, ...extras]) };
  });
}

/** 按 aliasKey 合并多组联邦行，目标去重 */
export function mergeFederatedMappingRows(
  ...groups: FederatedMappingRow[][]
): FederatedMappingRow[] {
  const buckets = new Map<
    string,
    {
      alias: string;
      targets: MappingTarget[];
      seen: Set<string>;
    }
  >();

  groups.forEach((rows) => {
    rows.forEach((row) => {
      let bucket = buckets.get(row.aliasKey);
      if (!bucket) {
        bucket = {
          alias: row.alias,
          targets: [],
          seen: new Set(),
        };
        buckets.set(row.aliasKey, bucket);
      }
      row.targets.forEach((target) => {
        const tKey = mappingTargetKey(target);
        if (bucket!.seen.has(tKey)) return;
        bucket!.seen.add(tKey);
        bucket!.targets.push(target);
      });
    });
  });

  const merged: FederatedMappingRow[] = Array.from(buckets.entries()).map(([aliasKey, bucket]) => {
    return {
      alias: bucket.alias,
      aliasKey,
      targets: sortMappingTargets(bucket.targets),
    };
  });
  merged.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
  return merged;
}

/**
 * 仅返回「后端实际存有该 alias」的 OAuth channel。
 * 不要用展示层的 identity 目标推断 channel，否则会 delete 不存在的 channel。
 */
export function collectConfiguredOauthChannelsForAlias(
  modelAlias: Record<string, OAuthModelAliasEntry[]>,
  aliasKey: string
): string[] {
  return collectChannelsForAlias(modelAlias, aliasKey);
}

/**
 * 仅返回「后端 models[].alias 真正等于该 alias」的 API Key resourceId。
 */
export function collectConfiguredApiKeyResourceIdsForAlias(
  resources: ProviderResource[],
  aliasKey: string
): string[] {
  const key = toAliasKey(aliasKey);
  if (!key) return [];
  const ids: string[] = [];
  resources.forEach((resource) => {
    const models = readApiKeyModels(resource);
    if (
      models.some((model) => {
        const name = String(model.name ?? '').trim();
        const alias = String(model.alias ?? '').trim();
        return name && isMeaningfulAlias(alias, name) && toAliasKey(alias) === key;
      })
    ) {
      ids.push(resource.id);
    }
  });
  return ids;
}
