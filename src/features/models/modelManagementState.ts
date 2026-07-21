/**
 * 模型管理缓存态：两个独立数据结构（access / mapping）+ 原始数据快照。
 *
 * 架构（Phase 2 重构）：
 * - store 内部持有 sources（原始数据）+ mirrors（4 个 localStorage 适配器的内存镜像）+ ctx（显示上下文）。
 * - `ModelManagementState`（access + mapping + 原始 map + managedExcludeKeys）是**派生**视图，
 *   由 `buildStateFromSources(sources, mirrors, ctx)` 纯函数构建（不读 localStorage）。
 * - 计算模块（modelOps）消费 `ModelManagementState`；应用器（modelOpApplier）写后端 + localStorage；
 *   reducer（modelOpReducer）纯函数地把 ops 应用到 sources+mirrors，产出乐观 current。
 * - 视图层（ModelAccessRow / FederatedMappingRow）类型不变，从 access/mapping 投影。
 *
 * `enabled` 为真实网关状态（pre-mask）；managedExclude 显示掩码在视图投影时叠加。
 */

import type { ModelAlias, OAuthModelAliasEntry } from '@/types';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import {
  accessEnabledKey,
  isMeaningfulAlias,
  mappingTargetKey,
  toAliasKey,
  type MappingTargetRef,
} from './modelMapping';
import type { ModelAccessRow } from './modelAccessRows';
import {
  buildApiKeyAccessRows,
  buildOAuthAccessRows,
  sortModelAccessRows,
} from './modelAccessRows';
import { listAllSuspended, type SuspendedMapping } from './mappingSuspend';
import { listSuspendedCatalog } from './catalogSuspend';
import { listManualMappingClaims } from './mappingClaims';
import { listManagedIdentityExcludeKeys } from './managedIdentityExclude';
import { isManagedNativeOffAlias } from './managedNativeOffAlias';

const lower = (value: string): string => value.trim().toLowerCase();

function readApiKeyModels(resource: ProviderResource): ModelAlias[] {
  const raw = resource.raw as { models?: ModelAlias[] } | null | undefined;
  if (!raw || !Array.isArray(raw.models)) return [];
  return raw.models;
}

/** 显示上下文：provider 标签 / 图标 / OAuth display name（由 store 注入，复用现有 hook 实现）。 */
export type ModelDisplayContext = {
  oauthProviderLabel: (channel: string) => string;
  apiKeyProviderLabel: (resourceId: string, brand: ProviderBrand) => string;
  oauthIcon: (channel: string) => string | null;
  apiKeyIcon: (resourceId: string, brand: ProviderBrand) => string | null;
  /** channel(lower) -> modelId(lower) -> display_name */
  oauthDisplayNames: Record<string, Record<string, string>>;
};

// ---------------------------------------------------------------------------
// 原始数据 + 内存镜像（store 内部持有；reducer 修改它们）
// ---------------------------------------------------------------------------

export type ModelManagementSources = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
};

export type ModelManagementMirrors = {
  /** targetKey (accessEnabledKey) -> 挂起绑定 */
  mappingSuspend: Map<string, SuspendedMapping[]>;
  /** accessKey (apiKey:resourceId:modelLower) -> 挂起 catalog 条目 */
  catalogSuspend: Map<string, ModelAlias[]>;
  managedExcludeKeys: Set<string>;
  /** aliasKey */
  claims: Set<string>;
};

export function emptyMirrors(): ModelManagementMirrors {
  return {
    mappingSuspend: new Map(),
    catalogSuspend: new Map(),
    managedExcludeKeys: new Set(),
    claims: new Set(),
  };
}

/** 从 4 个 localStorage 适配器读取镜像（refresh / resync 时调用）。 */
export function loadMirrorsFromAdapters(apiBase: string): ModelManagementMirrors {
  const mappingSuspend = new Map<string, SuspendedMapping[]>();
  listAllSuspended(apiBase).forEach((item) => {
    const targetKey = accessEnabledKey(item.target);
    const list = mappingSuspend.get(targetKey) ?? [];
    list.push(item);
    mappingSuspend.set(targetKey, list);
  });
  const catalogSuspend = new Map<string, ModelAlias[]>();
  listSuspendedCatalog(apiBase).forEach((entry) => {
    const key = `apiKey:${entry.resourceId}:${lower(entry.modelId)}`;
    catalogSuspend.set(key, entry.entries);
  });
  return {
    mappingSuspend,
    catalogSuspend,
    managedExcludeKeys: listManagedIdentityExcludeKeys(apiBase),
    claims: new Set(listManualMappingClaims(apiBase)),
  };
}

// ---------------------------------------------------------------------------
// Structure A：模型禁用（所有模型 + 真实启停状态）
// ---------------------------------------------------------------------------

export type ModelAccessEntry = ModelAccessRow & {
  ref: MappingTargetRef;
  /** OpenAI catalog 挂起的完整条目（启用时恢复用）；其它品牌为 undefined */
  suspendedCatalogEntries?: ModelAlias[];
};

export type ModelAccessState = {
  /** key = accessEnabledKey(ref) */
  byKey: Map<string, ModelAccessEntry>;
};

// ---------------------------------------------------------------------------
// Structure B：模型映射（渠道 -> 目标 + 渠道内启停）
// ---------------------------------------------------------------------------

export type ModelMappingTarget = MappingTargetRef & {
  displayName: string;
  providerLabel: string;
  iconSrc: string | null;
  suspended: boolean;
  fork?: boolean;
  forceMapping?: boolean;
};

export type ModelMappingChannel = {
  alias: string;
  aliasKey: string;
  targets: ModelMappingTarget[];
  claimedManual: boolean;
};

export type ModelMappingState = {
  /** key = toAliasKey(alias) */
  byAliasKey: Map<string, ModelMappingChannel>;
};

// ---------------------------------------------------------------------------
// 合并态：计算模块的输入（派生视图）
// ---------------------------------------------------------------------------

export type ModelCatalogs = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
};

export type ModelManagementState = {
  access: ModelAccessState;
  mapping: ModelMappingState;
  managedExcludeKeys: Set<string>;
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  catalogs: ModelCatalogs;
};

// ---------------------------------------------------------------------------
// Builders：从 sources + mirrors 派生 ModelManagementState（纯函数，不读 localStorage）
// ---------------------------------------------------------------------------

export function buildStateFromSources(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelManagementState {
  return {
    access: buildAccessState(sources, mirrors, ctx),
    mapping: buildMappingState(sources, mirrors, ctx),
    managedExcludeKeys: new Set(mirrors.managedExcludeKeys),
    oauthAliasMap: sources.oauthAliasMap,
    oauthExcludedMap: sources.oauthExcludedMap,
    catalogs: { oauthModels: sources.oauthModels, resources: sources.resources },
  };
}

function buildAccessState(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelAccessState {
  const rows: ModelAccessRow[] = [];

  Object.entries(sources.oauthModels ?? {}).forEach(([channelRaw, models]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(models)) return;
    rows.push(
      ...buildOAuthAccessRows({
        channel,
        models,
        excluded: sources.oauthExcludedMap,
        providerLabel: ctx.oauthProviderLabel(channel),
        iconSrc: ctx.oauthIcon(channel),
      })
    );
  });

  const suspendedByResource = new Map<string, string[]>();
  mirrors.catalogSuspend.forEach((entries, key) => {
    const parts = key.split(':');
    const resourceId = parts[1];
    if (!resourceId) return;
    const list = suspendedByResource.get(resourceId) ?? [];
    entries.forEach((e) => {
      const name = String(e?.name ?? '').trim();
      if (name) list.push(name);
    });
    suspendedByResource.set(resourceId, list);
  });

  sources.resources.forEach((resource) => {
    rows.push(
      ...buildApiKeyAccessRows({
        resource,
        providerLabel: ctx.apiKeyProviderLabel(resource.id, resource.brand),
        iconSrc: ctx.apiKeyIcon(resource.id, resource.brand),
        suspendedCatalogModelIds: suspendedByResource.get(resource.id) ?? [],
      })
    );
  });

  const sorted = sortModelAccessRows(rows);
  const byKey = new Map<string, ModelAccessEntry>();
  sorted.forEach((row) => {
    const ref = accessRowToRef(row);
    if (!ref) return;
    byKey.set(row.key, {
      ...row,
      ref,
      suspendedCatalogEntries: mirrors.catalogSuspend.get(row.key),
    });
  });
  return { byKey };
}

function accessRowToRef(row: ModelAccessRow): MappingTargetRef | null {
  const modelId = row.modelId.trim();
  if (!modelId) return null;
  if (row.source === 'oauth') {
    const channel = normalizeProviderKey(row.oauthChannel ?? row.channelOrBrand);
    if (!channel) return null;
    return { source: 'oauth', channel, modelId };
  }
  if (!row.resourceId || !row.brand) return null;
  return { source: 'apiKey', resourceId: row.resourceId, brand: row.brand, modelId };
}

function buildMappingState(
  sources: ModelManagementSources,
  mirrors: ModelManagementMirrors,
  ctx: ModelDisplayContext
): ModelMappingState {
  const byAliasKey = new Map<string, ModelMappingChannel>();
  const ensure = (alias: string): ModelMappingChannel => {
    const aliasKey = toAliasKey(alias);
    let ch = byAliasKey.get(aliasKey);
    if (!ch) {
      ch = { alias: alias.trim(), aliasKey, targets: [], claimedManual: false };
      byAliasKey.set(aliasKey, ch);
    }
    return ch;
  };
  const addTarget = (ch: ModelMappingChannel, target: ModelMappingTarget) => {
    const key = mappingTargetKey(target);
    if (ch.targets.some((t) => mappingTargetKey(t) === key)) return;
    ch.targets.push(target);
  };

  // 活跃 OAuth 目标
  Object.entries(sources.oauthAliasMap ?? {}).forEach(([channelRaw, entries]) => {
    const channel = normalizeProviderKey(channelRaw);
    if (!channel || !Array.isArray(entries)) return;
    const providerLabel = ctx.oauthProviderLabel(channel);
    const iconSrc = ctx.oauthIcon(channel);
    const displayMap = ctx.oauthDisplayNames[channel] ?? {};
    entries.forEach((entry) => {
      const modelId = String(entry.name ?? '').trim();
      const alias = String(entry.alias ?? '').trim();
      if (!modelId || !alias) return;
      if (isManagedNativeOffAlias(alias)) return;
      const ch = ensure(alias);
      addTarget(ch, {
        source: 'oauth',
        channel,
        modelId,
        displayName: (displayMap[lower(modelId)] || modelId).trim() || modelId,
        providerLabel,
        iconSrc,
        suspended: false,
        fork: entry.fork === true ? true : undefined,
        forceMapping: typeof entry.forceMapping === 'boolean' ? entry.forceMapping : undefined,
      });
    });
  });

  // 活跃 API Key 目标
  sources.resources.forEach((resource) => {
    const models = readApiKeyModels(resource);
    if (!models.length) return;
    const providerLabel = ctx.apiKeyProviderLabel(resource.id, resource.brand);
    const iconSrc = ctx.apiKeyIcon(resource.id, resource.brand);
    models.forEach((model) => {
      const modelId = String(model.name ?? '').trim();
      const alias = String(model.alias ?? '').trim();
      if (!modelId || !isMeaningfulAlias(alias, modelId)) return;
      const ch = ensure(alias);
      addTarget(ch, {
        source: 'apiKey',
        resourceId: resource.id,
        brand: resource.brand,
        modelId,
        displayName: modelId,
        providerLabel,
        iconSrc,
        suspended: false,
      });
    });
  });

  // 挂起目标（来自 mirrors.mappingSuspend）
  mirrors.mappingSuspend.forEach((items) => {
    items.forEach((item) => {
      const alias = item.alias.trim();
      if (!alias) return;
      const ch = ensure(alias);
      const t = item.target;
      const displayName =
        t.source === 'oauth'
          ? (ctx.oauthDisplayNames[t.channel]?.[lower(t.modelId)] || t.modelId).trim() || t.modelId
          : t.modelId;
      const providerLabel =
        t.source === 'oauth'
          ? ctx.oauthProviderLabel(t.channel)
          : ctx.apiKeyProviderLabel(t.resourceId, t.brand);
      const iconSrc =
        t.source === 'oauth'
          ? ctx.oauthIcon(t.channel)
          : ctx.apiKeyIcon(t.resourceId, t.brand);
      addTarget(ch, {
        ...t,
        displayName,
        providerLabel,
        iconSrc,
        suspended: true,
        fork: item.fork === true ? true : undefined,
        forceMapping: typeof item.forceMapping === 'boolean' ? item.forceMapping : undefined,
      });
    });
  });

  // 手动认领
  mirrors.claims.forEach((aliasKey) => {
    const ch = byAliasKey.get(aliasKey);
    if (ch) ch.claimedManual = true;
    else byAliasKey.set(aliasKey, { alias: aliasKey, aliasKey, targets: [], claimedManual: true });
  });

  return { byAliasKey };
}

// ---------------------------------------------------------------------------
// 旧入口：从 fetch 输入 + 适配器构造（store.load 调用）
// ---------------------------------------------------------------------------

export type BuildModelManagementStateInput = {
  oauthModels: Record<string, AuthFileModelItem[]>;
  resources: ProviderResource[];
  oauthAliasMap: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap: Record<string, string[]>;
  apiBase: string;
  ctx: ModelDisplayContext;
};

export function buildModelManagementState(input: BuildModelManagementStateInput): ModelManagementState {
  const sources: ModelManagementSources = {
    oauthModels: input.oauthModels ?? {},
    resources: input.resources ?? [],
    oauthAliasMap: input.oauthAliasMap ?? {},
    oauthExcludedMap: input.oauthExcludedMap ?? {},
  };
  const mirrors = loadMirrorsFromAdapters(input.apiBase);
  return buildStateFromSources(sources, mirrors, input.ctx);
}

// ---------------------------------------------------------------------------
// 视图投影（Phase 2-3 接线时由 selector hook 调用）
// ---------------------------------------------------------------------------

/** 当前真实启用的目标 key 集合（供映射视图填充 currentlyEnabled）。 */
export function collectEnabledAccessKeys(access: ModelAccessState): Set<string> {
  const keys = new Set<string>();
  access.byKey.forEach((entry) => {
    if (entry.enabled) keys.add(entry.key);
  });
  return keys;
}

/** 收集某 targetKey 上的全部挂起绑定（跨 alias），用于启用时恢复。 */
export function collectSuspendedBindingsForTarget(
  mapping: ModelMappingState,
  targetKey: string
): SuspendedMapping[] {
  const out: SuspendedMapping[] = [];
  mapping.byAliasKey.forEach((ch) => {
    ch.targets.forEach((t) => {
      if (!t.suspended) return;
      if (mappingTargetKey(t) !== targetKey) return;
      out.push({
        alias: ch.alias,
        target: stripTarget(t),
        fork: t.fork === true ? true : undefined,
        forceMapping: typeof t.forceMapping === 'boolean' ? t.forceMapping : undefined,
      });
    });
  });
  return out;
}

function stripTarget(t: ModelMappingTarget): MappingTargetRef {
  if (t.source === 'oauth') return { source: 'oauth', channel: t.channel, modelId: t.modelId };
  return { source: 'apiKey', resourceId: t.resourceId, brand: t.brand, modelId: t.modelId };
}

export { accessEnabledKey };
