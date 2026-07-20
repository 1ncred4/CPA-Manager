import { describe, expect, test } from 'bun:test';
import {
  collectClaimedModelIds,
  collectNativeHideTargets,
  federatedRowsToManualMappings,
  projectExposure,
  type ExposureAccessModel,
  type ManualMapping,
} from '../src/features/models/exposureProjection';
import type { FederatedMappingRow } from '../src/features/models/modelMapping';

const oauth = (channel: string, modelId: string) =>
  ({ source: 'oauth' as const, channel, modelId });

const apiKey = (resourceId: string, modelId: string) =>
  ({
    source: 'apiKey' as const,
    resourceId,
    brand: 'claude' as const,
    modelId,
  });

const access = (
  ref: ExposureAccessModel['ref'],
  enabled = true
): ExposureAccessModel => ({
  key:
    ref.source === 'oauth'
      ? `oauth:${ref.channel}:${ref.modelId.toLowerCase()}`
      : `apiKey:${ref.resourceId}:${ref.modelId.toLowerCase()}`,
  modelId: ref.modelId,
  enabled,
  ref,
  displayName: ref.modelId,
  providerLabel: ref.source === 'oauth' ? ref.channel : ref.resourceId,
});

describe('exposureProjection', () => {
  test('active cross-name manual alias is exposed; native is hidden and not auto', () => {
    const manual: ManualMapping[] = [
      {
        alias: 'custom.chat',
        edges: [{ target: oauth('codex', 'gpt-x'), channelEnabled: true }],
      },
    ];
    const models = [access(oauth('codex', 'gpt-x')), access(oauth('claude', 'claude-a'))];
    const proj = projectExposure({ access: models, manual });

    expect(proj.exposedNames).toContain('custom.chat');
    expect(proj.exposedNames).toContain('claude-a');
    expect(proj.exposedNames).not.toContain('gpt-x');
    expect(proj.claimedModelIds.has('gpt-x')).toBe(true);
    expect(proj.nativeHide).toEqual([oauth('codex', 'gpt-x')]);
    expect(proj.auto.map((r) => r.alias)).toEqual(['claude-a']);
    expect(proj.manualActive).toHaveLength(1);
  });

  test('channel-disabled edge still claims native: no auto, still hide, no custom expose', () => {
    const manual: ManualMapping[] = [
      {
        alias: 'custom.chat',
        edges: [{ target: oauth('codex', 'gpt-x'), channelEnabled: false }],
      },
    ];
    const models = [access(oauth('codex', 'gpt-x')), access(apiKey('r1', 'gpt-x'))];
    const proj = projectExposure({ access: models, manual });

    // 自定义名无活跃边 → 不暴露
    expect(proj.exposedNames).not.toContain('custom.chat');
    // 认领含禁用边 → 所有来源的 gpt-x 都不进自动映射
    expect(proj.claimedModelIds.has('gpt-x')).toBe(true);
    expect(proj.exposedNames).not.toContain('gpt-x');
    expect(proj.auto).toHaveLength(0);
    expect(proj.manualActive).toHaveLength(0);
    // 跨名认领仍 hide
    expect(proj.nativeHide.map((t) => t.modelId)).toEqual(['gpt-x']);
  });

  test('identity manual edge claims but is not nativeHide', () => {
    const manual: ManualMapping[] = [
      {
        alias: 'gpt-x',
        edges: [{ target: oauth('codex', 'gpt-x'), channelEnabled: true }],
      },
    ];
    const proj = projectExposure({
      access: [access(oauth('codex', 'gpt-x'))],
      manual,
    });
    expect(proj.exposedNames).toContain('gpt-x');
    expect(proj.nativeHide).toHaveLength(0);
    expect(proj.auto).toHaveLength(0);
    expect(proj.manualActive).toHaveLength(1);
  });

  test('bottom-disabled model does not activate manual alias', () => {
    const manual: ManualMapping[] = [
      {
        alias: 'custom.chat',
        edges: [{ target: oauth('codex', 'gpt-x'), channelEnabled: true }],
      },
    ];
    const proj = projectExposure({
      access: [access(oauth('codex', 'gpt-x'), false)],
      manual,
    });
    expect(proj.manualActive).toHaveLength(0);
    expect(proj.exposedNames).not.toContain('custom.chat');
    // 仍被认领（边还在），但不进 auto（且底层已禁用）
    expect(proj.claimedModelIds.has('gpt-x')).toBe(true);
    expect(proj.auto).toHaveLength(0);
  });

  test('deleting claim (no manual edges) releases native to auto', () => {
    const proj = projectExposure({
      access: [access(oauth('codex', 'gpt-x'))],
      manual: [],
    });
    expect(proj.auto.map((r) => r.alias)).toEqual(['gpt-x']);
    expect(proj.exposedNames).toEqual(['gpt-x']);
    expect(proj.nativeHide).toHaveLength(0);
  });

  test('federatedRowsToManualMappings maps suspended to channelEnabled=false', () => {
    const rows: FederatedMappingRow[] = [
      {
        alias: 'custom.chat',
        aliasKey: 'custom.chat',
        targets: [
          {
            source: 'oauth',
            channel: 'codex',
            modelId: 'gpt-x',
            displayName: 'gpt-x',
            providerLabel: 'Codex',
            currentlyEnabled: false,
            suspended: true,
          },
          {
            source: 'oauth',
            channel: 'claude',
            modelId: 'claude-a',
            displayName: 'claude-a',
            providerLabel: 'Claude',
            currentlyEnabled: true,
          },
        ],
      },
    ];
    const manual = federatedRowsToManualMappings(rows);
    expect(manual[0].edges).toHaveLength(2);
    expect(manual[0].edges.find((e) => e.target.modelId === 'gpt-x')?.channelEnabled).toBe(false);
    expect(manual[0].edges.find((e) => e.target.modelId === 'claude-a')?.channelEnabled).toBe(
      true
    );
    expect(collectClaimedModelIds(manual).has('gpt-x')).toBe(true);
    expect(collectNativeHideTargets(manual)).toHaveLength(2);
  });
});
