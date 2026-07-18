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

/** 手动：后端有自定义 alias；自动：未入手动的模型按 modelId 聚合（同名合并） */
export type MappingRowKind = 'manual' | 'auto';

export type FederatedMappingRow = {
  /** 自定义模型名（alias），大小写按首次见到的原文保留 */
  alias: string;
  aliasKey: string;
  targets: MappingTarget[];
  /** 手动 / 自动；缺省时由 hasConfiguredTargets 推断 */
  kind?: MappingRowKind;
  /**
   * 行内是否存在后端可持久化的目标（alias ≠ modelId）。
   * false 表示纯同名自动联邦 / 仅挂起灰标，删除时不应调用后端。
   */
  hasConfiguredTargets?: boolean;
  /** 行是否包含前端同名自动联邦目标（多来源同 modelId） */
  hasAutoSameNameTargets?: boolean;
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
  | 'duplicate_alias'
  | 'channel_conflict'
  /** 自定义名与全部目标模型 ID 相同：后端/序列化会丢弃，映射无法落库 */
  | 'identity_only';

const lower = (value: string): string => value.trim().toLowerCase();

export function toAliasKey(alias: string): string {
  return lower(alias);
}

/** 目标模型 ID 与自定义名相同：无需（也无法）作为 alias 持久化 */
export function isIdentityMappingTarget(alias: string, target: MappingTargetRef): boolean {
  return Boolean(toAliasKey(alias)) && lower(target.modelId) === toAliasKey(alias);
}

/** 仅保留可写回后端的目标（alias ≠ modelId） */
export function filterPersistableMappingTargets(
  alias: string,
  targets: MappingTargetRef[]
): MappingTargetRef[] {
  return targets.filter((target) => !isIdentityMappingTarget(alias, target));
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
      const alias = String(entry?.alias ?? '').trim();
      if (!modelId || !alias) return;

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
      const alias = String(model?.alias ?? '').trim();
      if (!modelId || !isMeaningfulAlias(alias, modelId)) return;

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
  if (filterPersistableMappingTargets(alias, input.targets).length === 0) {
    return 'identity_only';
  }

  const aliasKey = toAliasKey(alias);
  if (aliasKey !== (input.editingAliasKey ?? null)) {
    for (const existing of input.existingAliasKeys) {
      if (existing === aliasKey) return 'duplicate_alias';
    }
  }

  // OAuth channel still enforces one source model per alias (backend uniqueness).
  // API Key entries may map multiple models to the same custom alias.
  // Identity targets (alias===modelId) are not persisted; ignore them for channel uniqueness.
  const oauthChannels = new Map<string, string>();

  for (const target of input.targets) {
    if (target.source !== 'oauth') continue;
    if (isIdentityMappingTarget(alias, target)) continue;
    const channel = normalizeProviderKey(target.channel);
    const modelKey = lower(target.modelId);
    const prev = oauthChannels.get(channel);
    if (prev && prev !== modelKey) return 'channel_conflict';
    oauthChannels.set(channel, modelKey);
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
  // Backend drops alias===name; never write identity entries.
  const nextModelIds = input.nextModelIds
    .map((id) => id.trim())
    .filter((id) => id && lower(id) !== aliasKey);

  const preserved: OAuthModelAliasEntry[] = [];
  const existingByName = new Map<string, OAuthModelAliasEntry>();

  input.entries.forEach((entry) => {
    const name = String(entry.name ?? '').trim();
    const entryAlias = String(entry.alias ?? '').trim();
    if (!name || !entryAlias) return;
    // Drop residual identity bindings for this alias or any entry.
    if (lower(name) === toAliasKey(entryAlias)) return;
    if (toAliasKey(entryAlias) === aliasKey) {
      existingByName.set(lower(name), entry);
      return;
    }
    preserved.push(entry);
  });

  const nextForAlias: OAuthModelAliasEntry[] = [];
  nextModelIds.forEach((id) => {
    const prev = existingByName.get(lower(id));
    // fork=true 表示同时保留原模型名；新建映射默认关闭，原名不再对外启用。
    // 仅当既有条目已显式开启时才保留（编辑/重绑同名目标时不丢用户设置）。
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
 * - identity（alias===name）不会写入
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

  const nextModelKeys = new Set(
    input.nextModelIds
      .map((id) => id.trim())
      .filter((id) => id && lower(id) !== aliasKey)
      .map(lower)
  );

  const isEditedAliasKey = (key: string): boolean =>
    Boolean(key) && (key === aliasKey || key === prevAliasKey);

  const result: ModelAlias[] = [];
  /** nameKey → 结果中是否已有至少一条（用于移除 alias 后保留目录） */
  const namePresent = new Set<string>();
  /** nameKey → 是否已有「当前 alias」条目 */
  const holdsThisAlias = new Set<string>();
  /** nameKey → 结果中可升级为当前 alias 的无 alias 条目下标 */
  const bareIndexByName = new Map<string, number>();

  const stripAlias = (model: ModelAlias): ModelAlias => {
    const { alias: _drop, ...rest } = model as ModelAlias & { alias?: string };
    void _drop;
    const next: ModelAlias = { ...rest, name: model.name };
    delete (next as { alias?: string }).alias;
    return next;
  };

  input.models.forEach((model) => {
    const name = String(model.name ?? '').trim();
    if (!name) return;
    const nameKey = lower(name);
    const currentAlias = String(model.alias ?? '').trim();
    const currentAliasKey = currentAlias ? toAliasKey(currentAlias) : '';

    // 丢弃 identity 残留
    if (currentAliasKey && currentAliasKey === nameKey) {
      if (!namePresent.has(nameKey)) {
        result.push(stripAlias(model));
        namePresent.add(nameKey);
        bareIndexByName.set(nameKey, result.length - 1);
      }
      return;
    }

    // 属于正在编辑的 alias：先拿掉，后面按 nextModelIds 再加回
    if (isEditedAliasKey(currentAliasKey)) {
      return;
    }

    // 其它有意义 alias：原样保留（多渠道）
    if (currentAliasKey && isMeaningfulAlias(currentAlias, name)) {
      result.push(model);
      namePresent.add(nameKey);
      bareIndexByName.delete(nameKey);
      return;
    }

    // 无 alias 条目：保留，供后续升级
    result.push(stripAlias(model));
    namePresent.add(nameKey);
    if (!bareIndexByName.has(nameKey)) {
      bareIndexByName.set(nameKey, result.length - 1);
    }
  });

  // 为 nextModelIds 确保存在「name + 当前 alias」条目
  nextModelKeys.forEach((nameKey) => {
    if (holdsThisAlias.has(nameKey)) return;

    const bareIdx = bareIndexByName.get(nameKey);
    if (bareIdx !== undefined) {
      const prev = result[bareIdx];
      result[bareIdx] = { ...prev, alias: aliasLiteral };
      bareIndexByName.delete(nameKey);
      holdsThisAlias.add(nameKey);
      namePresent.add(nameKey);
      return;
    }

    // 已有其它 alias 的同名条目，或目录中尚无此模型：追加一条，不覆盖其它渠道
    const originalName =
      input.nextModelIds.map((id) => id.trim()).find((id) => lower(id) === nameKey) || nameKey;
    result.push({ name: originalName, alias: aliasLiteral });
    holdsThisAlias.add(nameKey);
    namePresent.add(nameKey);
  });

  // 被移出当前 alias、且结果中已无任何条目的模型：补回裸 name，避免从提供商模型列表消失
  input.models.forEach((model) => {
    const name = String(model.name ?? '').trim();
    if (!name) return;
    const nameKey = lower(name);
    if (namePresent.has(nameKey)) return;
    if (nextModelKeys.has(nameKey)) return;
    result.push(stripAlias(model));
    namePresent.add(nameKey);
  });

  return result;
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

/**
 * 自动映射渠道：尚未被手动映射覆盖的已启用模型，按 modelId 聚合（同名合并）。
 * 单来源也会生成渠道；不写后端 alias。
 *
 * @param coveredTargetKeys 已出现在手动映射行中的目标 key
 * @param manualAliasKeys 已有手动渠道的 aliasKey（这些名字不再单独出现自动渠道，同名已并入手动）
 */
export function buildAutoMappingRows(
  accessRows: ModelAccessRow[],
  coveredTargetKeys: Set<string>,
  manualAliasKeys?: Iterable<string>
): FederatedMappingRow[] {
  const manualKeys = new Set(
    Array.from(manualAliasKeys ?? [])
      .map((k) => toAliasKey(k))
      .filter(Boolean)
  );
  const groups = new Map<string, { alias: string; targets: MappingTarget[]; seen: Set<string> }>();

  accessRows.forEach((row) => {
    const target = accessRowToMappingTarget(row);
    if (!target) return;
    const tKey = mappingTargetKey(target);
    if (coveredTargetKeys.has(tKey)) return;
    const aliasKey = lower(target.modelId);
    if (!aliasKey || manualKeys.has(aliasKey)) return;
    let bucket = groups.get(aliasKey);
    if (!bucket) {
      bucket = { alias: target.modelId.trim(), targets: [], seen: new Set() };
      groups.set(aliasKey, bucket);
    }
    if (bucket.seen.has(tKey)) return;
    bucket.seen.add(tKey);
    bucket.targets.push(target);
  });

  const rows: FederatedMappingRow[] = [];
  groups.forEach((bucket, aliasKey) => {
    if (!bucket.targets.length) return;
    rows.push({
      alias: bucket.alias,
      aliasKey,
      targets: sortMappingTargets(bucket.targets),
      kind: 'auto',
      hasConfiguredTargets: false,
      hasAutoSameNameTargets: true,
    });
  });

  rows.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
  return rows;
}

/** @deprecated 使用 buildAutoMappingRows */
export function buildSameNameFederatedRows(
  accessRows: ModelAccessRow[],
  dismissedAliasKeys?: Iterable<string>
): FederatedMappingRow[] {
  // 兼容旧调用：忽略 dismiss，按「全部未覆盖 + 至少 2 源」不再限制；委托新逻辑
  void dismissedAliasKeys;
  return buildAutoMappingRows(accessRows, new Set(), []);
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
      hasConfiguredTargets: boolean;
      hasAutoSameNameTargets: boolean;
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
          hasConfiguredTargets: false,
          hasAutoSameNameTargets: false,
        };
        buckets.set(row.aliasKey, bucket);
      }
      if (row.hasConfiguredTargets) bucket.hasConfiguredTargets = true;
      if (row.hasAutoSameNameTargets) bucket.hasAutoSameNameTargets = true;
      row.targets.forEach((target) => {
        const tKey = mappingTargetKey(target);
        if (bucket!.seen.has(tKey)) return;
        bucket!.seen.add(tKey);
        bucket!.targets.push(target);
      });
    });
  });

  const merged: FederatedMappingRow[] = Array.from(buckets.entries()).map(([aliasKey, bucket]) => {
    const targets = sortMappingTargets(bucket.targets);
    // 若调用方未标记，按目标是否 identity 推断「是否有可持久化目标」
    const inferredConfigured =
      bucket.hasConfiguredTargets ||
      targets.some(
        (t) => !t.suspended && !isIdentityMappingTarget(bucket.alias, t)
      );
    return {
      alias: bucket.alias,
      aliasKey,
      targets,
      hasConfiguredTargets: inferredConfigured,
      hasAutoSameNameTargets: bucket.hasAutoSameNameTargets,
    };
  });
  merged.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
  return merged;
}

/**
 * 列表用完整聚合：手动（配置别名 + 本地认领 + 同名挂载）与自动（未覆盖模型按名聚合）分列。
 * 手动渠道名与 modelId 相同时，同名提供商模型并入手动行，不再单独出现自动渠道。
 * 删除手动后，这些模型会回到自动渠道。
 *
 * @param claimedAliasKeys 用户认领为手动的渠道（含纯同名，后端无法写 alias===name）
 */
export function assembleManualAndAutoMappingRows(
  configuredRows: FederatedMappingRow[],
  accessRows: ModelAccessRow[],
  claimedAliasKeys?: Iterable<string>
): { manualRows: FederatedMappingRow[]; autoRows: FederatedMappingRow[] } {
  const claims = new Set(
    Array.from(claimedAliasKeys ?? [])
      .map((k) => toAliasKey(k))
      .filter(Boolean)
  );

  const manualBase = configuredRows.map((row) => ({
    ...row,
    kind: 'manual' as const,
    hasConfiguredTargets:
      row.hasConfiguredTargets ??
      row.targets.some((t) => !t.suspended && !isIdentityMappingTarget(row.alias, t)),
  }));

  // 认领为手动、但后端尚无配置行：用同名启用模型撑起渠道
  const existingKeys = new Set(manualBase.map((r) => r.aliasKey));
  claims.forEach((aliasKey) => {
    if (existingKeys.has(aliasKey)) return;
    const natives = accessRows
      .map((row) => accessRowToMappingTarget(row))
      .filter((t): t is MappingTarget => Boolean(t) && lower(t!.modelId) === aliasKey);
    if (!natives.length) return;
    manualBase.push({
      alias: natives[0].modelId.trim(),
      aliasKey,
      targets: sortMappingTargets(natives),
      kind: 'manual',
      hasConfiguredTargets: false,
      hasAutoSameNameTargets: natives.length > 1,
    });
    existingKeys.add(aliasKey);
  });

  // 同名原生模型挂到手动行（如手动 gpt-image-2 + Codex/OpenAI 的 gpt-image-2）
  const manualRows = attachNativeIdentityTargets(manualBase, accessRows).map((row) => ({
    ...row,
    kind: 'manual' as const,
    hasConfiguredTargets: row.hasConfiguredTargets !== false,
  }));

  const covered = collectMappedTargetKeys(manualRows);
  const manualAliasKeys = manualRows.map((r) => r.aliasKey);
  const autoRows = buildAutoMappingRows(accessRows, covered, manualAliasKeys);

  return { manualRows, autoRows };
}

/**
 * 兼容旧调用：手动 + 自动扁平为一张表（自动在后）。
 */
export function assembleFederatedMappingRows(
  configuredRows: FederatedMappingRow[],
  accessRows: ModelAccessRow[],
  _dismissedAliasKeys?: Iterable<string>
): FederatedMappingRow[] {
  void _dismissedAliasKeys;
  const { manualRows, autoRows } = assembleManualAndAutoMappingRows(configuredRows, accessRows);
  return [...manualRows, ...autoRows];
}

export function isManualMappingRow(row: FederatedMappingRow): boolean {
  if (row.kind === 'manual') return true;
  if (row.kind === 'auto') return false;
  return rowHasConfiguredTargets(row);
}

export function isAutoMappingRow(row: FederatedMappingRow): boolean {
  return !isManualMappingRow(row);
}

/** 行内是否存在后端真正写过的配置（可被删除/清理） */
export function rowHasConfiguredTargets(row: FederatedMappingRow): boolean {
  if (typeof row.hasConfiguredTargets === 'boolean') return row.hasConfiguredTargets;
  return row.targets.some((t) => !t.suspended && !isIdentityMappingTarget(row.alias, t));
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
