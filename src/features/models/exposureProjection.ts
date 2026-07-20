/**
 * 顶层暴露投影（纯函数）：
 * 手动活跃别名 ∪ 自动原名 = 期望出现在 /v1/models 的名字。
 *
 * 认领规则：只要模型仍是任意手动边的目标（含 channelEnabled=false / suspended），
 * 就不得进入自动映射；跨名认领默认隐藏原名。
 */

import type { ModelAccessRow } from './modelAccessRows';
import {
  accessRowToTargetRef,
  isIdentityMappingTarget,
  mappingTargetKey,
  toAliasKey,
  type FederatedMappingRow,
  type MappingTarget,
  type MappingTargetRef,
} from './modelMapping';

const lower = (value: string): string => value.trim().toLowerCase();

export type MappingEdge = {
  target: MappingTargetRef;
  /** false = 渠道内禁用：关系保留，不参与路由/暴露 */
  channelEnabled: boolean;
};

export type ManualMapping = {
  alias: string;
  edges: MappingEdge[];
};

export type ExposureAccessModel = {
  /** accessEnabledKey */
  key: string;
  modelId: string;
  enabled: boolean;
  ref: MappingTargetRef;
  displayName?: string;
  providerLabel?: string;
  iconSrc?: string | null;
};

export type ExposureProjection = {
  /** 期望出现在 /v1/models 的名字（大小写保留首次） */
  exposedNames: string[];
  /** 应隐藏的原名目标（跨名认领） */
  nativeHide: MappingTargetRef[];
  /** 应作为自动映射暴露的原名目标 */
  nativeShow: MappingTargetRef[];
  /** 有至少一条活跃边的手动渠道 */
  manualActive: Array<{ alias: string; targets: MappingTargetRef[] }>;
  /** 自动映射行（按 modelId 聚合） */
  auto: Array<{ alias: string; targets: MappingTargetRef[] }>;
  /** 全部被手动认领的 modelId（lower） */
  claimedModelIds: Set<string>;
};

function sortTargets(targets: MappingTargetRef[]): MappingTargetRef[] {
  return [...targets].sort((a, b) =>
    mappingTargetKey(a).localeCompare(mappingTargetKey(b), undefined, { sensitivity: 'base' })
  );
}

/** 从访问行提取投影用 access 模型 */
export function accessRowsToExposureModels(rows: ModelAccessRow[]): ExposureAccessModel[] {
  const out: ExposureAccessModel[] = [];
  rows.forEach((row) => {
    const ref = accessRowToTargetRef(row);
    if (!ref) return;
    out.push({
      key: row.key,
      modelId: row.modelId,
      enabled: row.enabled,
      ref,
      displayName: row.displayName,
      providerLabel: row.providerLabel,
      iconSrc: row.iconSrc ?? null,
    });
  });
  return out;
}

/** 联邦手动行 → ManualMapping（suspended / !currentlyEnabled 视为 channelEnabled=false） */
export function federatedRowsToManualMappings(rows: FederatedMappingRow[]): ManualMapping[] {
  return rows.map((row) => ({
    alias: row.alias,
    edges: row.targets.map((target) => {
      const ref: MappingTargetRef =
        target.source === 'oauth'
          ? { source: 'oauth', channel: target.channel, modelId: target.modelId }
          : {
              source: 'apiKey',
              resourceId: target.resourceId,
              brand: target.brand,
              modelId: target.modelId,
            };
      const channelEnabled = target.suspended !== true && target.currentlyEnabled !== false;
      return { target: ref, channelEnabled };
    }),
  }));
}

/**
 * 被手动渠道认领的 modelId（含渠道内禁用边）。
 * 认领即阻止进入自动映射。
 */
export function collectClaimedModelIds(manual: ManualMapping[]): Set<string> {
  const set = new Set<string>();
  manual.forEach((channel) => {
    channel.edges.forEach((edge) => {
      const id = lower(edge.target.modelId);
      if (id) set.add(id);
    });
  });
  return set;
}

/** 跨名认领 → 应隐藏原名的目标（去重） */
export function collectNativeHideTargets(manual: ManualMapping[]): MappingTargetRef[] {
  const byKey = new Map<string, MappingTargetRef>();
  manual.forEach((channel) => {
    const alias = channel.alias.trim();
    if (!alias) return;
    channel.edges.forEach((edge) => {
      if (isIdentityMappingTarget(alias, edge.target)) return;
      const key = mappingTargetKey(edge.target);
      if (!byKey.has(key)) byKey.set(key, edge.target);
    });
  });
  return sortTargets(Array.from(byKey.values()));
}

export function projectExposure(input: {
  access: ExposureAccessModel[];
  manual: ManualMapping[];
}): ExposureProjection {
  const claimedModelIds = collectClaimedModelIds(input.manual);
  const nativeHide = collectNativeHideTargets(input.manual);
  const hideKeys = new Set(nativeHide.map(mappingTargetKey));

  const enabledByKey = new Map<string, ExposureAccessModel>();
  input.access.forEach((model) => {
    if (!model.enabled) return;
    enabledByKey.set(mappingTargetKey(model.ref), model);
  });

  // 手动活跃：channelEnabled 且底层 enabled
  const manualActive: ExposureProjection['manualActive'] = [];
  const exposedAliasKeys = new Set<string>();
  const exposedNames: string[] = [];
  const seenExposed = new Set<string>();

  const pushExposed = (name: string) => {
    const key = lower(name);
    if (!key || seenExposed.has(key)) return;
    seenExposed.add(key);
    exposedNames.push(name.trim());
  };

  input.manual.forEach((channel) => {
    const alias = channel.alias.trim();
    if (!alias) return;
    const activeTargets: MappingTargetRef[] = [];
    channel.edges.forEach((edge) => {
      if (!edge.channelEnabled) return;
      if (!enabledByKey.has(mappingTargetKey(edge.target))) return;
      activeTargets.push(edge.target);
    });
    if (!activeTargets.length) return;
    manualActive.push({ alias, targets: sortTargets(activeTargets) });
    const aliasKey = toAliasKey(alias);
    if (!exposedAliasKeys.has(aliasKey)) {
      exposedAliasKeys.add(aliasKey);
      pushExposed(alias);
    }
  });

  // 自动：底层 enabled 且 modelId 未被认领
  const autoBuckets = new Map<string, { alias: string; targets: MappingTargetRef[]; seen: Set<string> }>();
  input.access.forEach((model) => {
    if (!model.enabled) return;
    const modelKey = lower(model.modelId);
    if (!modelKey || claimedModelIds.has(modelKey)) return;
    // 被 hide 列表精确覆盖的目标也不进 auto（防御）
    if (hideKeys.has(mappingTargetKey(model.ref))) return;

    let bucket = autoBuckets.get(modelKey);
    if (!bucket) {
      bucket = { alias: model.modelId.trim(), targets: [], seen: new Set() };
      autoBuckets.set(modelKey, bucket);
    }
    const tKey = mappingTargetKey(model.ref);
    if (bucket.seen.has(tKey)) return;
    bucket.seen.add(tKey);
    bucket.targets.push(model.ref);
  });

  const auto = Array.from(autoBuckets.values())
    .map((b) => ({ alias: b.alias, targets: sortTargets(b.targets) }))
    .sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));

  const nativeShow: MappingTargetRef[] = [];
  auto.forEach((row) => {
    row.targets.forEach((t) => nativeShow.push(t));
    pushExposed(row.alias);
  });

  manualActive.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));

  return {
    exposedNames,
    nativeHide,
    nativeShow,
    manualActive,
    auto,
    claimedModelIds,
  };
}

/** 供列表 UI：把投影的 auto 转成 FederatedMappingRow */
export function autoProjectionToFederatedRows(
  auto: ExposureProjection['auto'],
  access: ExposureAccessModel[]
): FederatedMappingRow[] {
  const metaByKey = new Map(access.map((a) => [mappingTargetKey(a.ref), a]));
  return auto.map((row) => {
    const targets: MappingTarget[] = row.targets.map((ref) => {
      const meta = metaByKey.get(mappingTargetKey(ref));
      return {
        ...ref,
        displayName: meta?.displayName || ref.modelId,
        providerLabel: meta?.providerLabel || '',
        iconSrc: meta?.iconSrc ?? null,
        currentlyEnabled: true,
      };
    });
    return {
      alias: row.alias,
      aliasKey: toAliasKey(row.alias),
      targets,
      kind: 'auto' as const,
      hasConfiguredTargets: false,
      hasAutoSameNameTargets: targets.length > 1,
    };
  });
}
