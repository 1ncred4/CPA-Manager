import { describe, expect, test } from 'bun:test';
import { planAccessToggle, type ModelOp } from '../src/features/models/modelOps';
import type {
  ModelAccessEntry,
  ModelManagementState,
  ModelMappingChannel,
  ModelMappingTarget,
} from '../src/features/models/modelManagementState';
import type { MappingTargetRef } from '../src/features/models/modelMapping';
import type { ProviderResource } from '../src/features/providers/types';
import type { ModelAlias, OAuthModelAliasEntry } from '../src/types';

// ---- fixtures -------------------------------------------------------------

function mkResource(
  id: string,
  brand: ProviderResource['brand'],
  raw: { models?: ModelAlias[]; excludedModels?: string[] }
): ProviderResource {
  return { id, brand, raw } as unknown as ProviderResource;
}

function mkOauthRef(channel: string, modelId: string): MappingTargetRef {
  return { source: 'oauth', channel, modelId };
}

function mkApiKeyRef(
  resourceId: string,
  brand: ProviderResource['brand'],
  modelId: string
): MappingTargetRef {
  return { source: 'apiKey', resourceId, brand, modelId };
}

function mkMappingChannel(alias: string, targets: ModelMappingTarget[]): ModelMappingChannel {
  return {
    alias,
    aliasKey: alias.trim().toLowerCase(),
    targets,
    claimedManual: false,
  };
}

function suspendedOauthTarget(
  alias: string,
  channel: string,
  modelId: string
): { channel: ModelMappingChannel; target: ModelMappingTarget } {
  const target: ModelMappingTarget = {
    source: 'oauth',
    channel,
    modelId,
    displayName: modelId,
    providerLabel: channel,
    iconSrc: null,
    suspended: true,
  };
  return { channel: mkMappingChannel(alias, [target]), target };
}

function suspendedApiKeyTarget(
  alias: string,
  resourceId: string,
  brand: ProviderResource['brand'],
  modelId: string
): { channel: ModelMappingChannel; target: ModelMappingTarget } {
  const target: ModelMappingTarget = {
    source: 'apiKey',
    resourceId,
    brand,
    modelId,
    displayName: modelId,
    providerLabel: brand,
    iconSrc: null,
    suspended: true,
  };
  return { channel: mkMappingChannel(alias, [target]), target };
}

function mkState(opts: {
  oauthAliasMap?: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap?: Record<string, string[]>;
  resources?: ProviderResource[];
  mappingChannels?: ModelMappingChannel[];
  managedExcludeKeys?: string[];
  accessEntries?: ModelAccessEntry[];
}): ModelManagementState {
  const mapping = new Map<string, ModelMappingChannel>();
  (opts.mappingChannels ?? []).forEach((ch) => mapping.set(ch.aliasKey, ch));
  const access = new Map<string, ModelAccessEntry>();
  (opts.accessEntries ?? []).forEach((e) => access.set(e.key, e));
  return {
    access: { byKey: access },
    mapping: { byAliasKey: mapping },
    managedExcludeKeys: new Set(opts.managedExcludeKeys ?? []),
    oauthAliasMap: opts.oauthAliasMap ?? {},
    oauthExcludedMap: opts.oauthExcludedMap ?? {},
    catalogs: { oauthModels: {}, resources: opts.resources ?? [] },
  };
}

function accessEntryWithCatalog(key: string, entries: ModelAlias[]): ModelAccessEntry {
  return { key, suspendedCatalogEntries: entries } as unknown as ModelAccessEntry;
}

// ---- op finders -----------------------------------------------------------

const phaseOf = (op: ModelOp) => op.phase;
const kindOf = (op: ModelOp) => op.kind;

function opsOfKind(ops: ModelOp[], kind: ModelOp['kind']): ModelOp[] {
  return ops.filter((o) => o.kind === kind);
}

// ===========================================================================

describe('planAccessToggle', () => {
  test('OAuth disable a mapping target: suspend-merge (before) + prune alias + write exclude', () => {
    const state = mkState({
      oauthAliasMap: {
        claude: [{ name: 'kimi-k3', alias: 'claude-opus-4-8' }],
      },
      oauthExcludedMap: {},
    });
    const ops = planAccessToggle({ state, ref: mkOauthRef('claude', 'kimi-k3'), nextEnabled: false });

    // before-backend: mappingSuspendMerge captures the binding
    const merges = opsOfKind(ops, 'mappingSuspendMerge');
    expect(merges).toHaveLength(1);
    expect(merges[0].phase).toBe('before-backend');
    if (merges[0].kind === 'mappingSuspendMerge') {
      expect(merges[0].targetKey).toBe('oauth:claude:kimi-k3');
      expect(merges[0].entries).toEqual([
        {
          alias: 'claude-opus-4-8',
          target: { source: 'oauth', channel: 'claude', modelId: 'kimi-k3' },
          fork: undefined,
          forceMapping: undefined,
        },
      ]);
    }

    // backend: prune alias (now empty) then write exclude
    const aliasPatches = opsOfKind(ops, 'oauthAliasPatch');
    expect(aliasPatches).toHaveLength(1);
    if (aliasPatches[0].kind === 'oauthAliasPatch') {
      expect(aliasPatches[0].channel).toBe('claude');
      expect(aliasPatches[0].entries).toEqual([]); // pruned
    }
    const excludedPatches = opsOfKind(ops, 'oauthExcludedPatch');
    expect(excludedPatches).toHaveLength(1);
    if (excludedPatches[0].kind === 'oauthExcludedPatch') {
      expect(excludedPatches[0].models).toEqual(['kimi-k3']);
    }
    // prune before exclude (plan rule #2)
    const backendIdx = ops
      .filter((o) => o.phase === 'backend')
      .map((o) => o.kind);
    expect(backendIdx).toEqual(['oauthAliasPatch', 'oauthExcludedPatch']);
  });

  test('OAuth disable a non-mapping model: only exclude write, no suspend/alias op', () => {
    const state = mkState({
      oauthAliasMap: { claude: [] },
      oauthExcludedMap: {},
    });
    const ops = planAccessToggle({ state, ref: mkOauthRef('claude', 'sonnet'), nextEnabled: false });

    expect(opsOfKind(ops, 'mappingSuspendMerge')).toHaveLength(0);
    expect(opsOfKind(ops, 'oauthAliasPatch')).toHaveLength(0);
    const excludedPatches = opsOfKind(ops, 'oauthExcludedPatch');
    expect(excludedPatches).toHaveLength(1);
    if (excludedPatches[0].kind === 'oauthExcludedPatch') {
      expect(excludedPatches[0].models).toEqual(['sonnet']);
    }
  });

  test('OAuth enable with suspended binding: clear exclude + restore alias (backend) then take (after)', () => {
    const { channel } = suspendedOauthTarget('claude-opus-4-8', 'claude', 'kimi-k3');
    const state = mkState({
      oauthAliasMap: { claude: [] }, // alias was pruned when disabled
      oauthExcludedMap: { claude: ['kimi-k3'] },
      mappingChannels: [channel],
    });
    const ops = planAccessToggle({ state, ref: mkOauthRef('claude', 'kimi-k3'), nextEnabled: true });

    const excludedPatches = opsOfKind(ops, 'oauthExcludedPatch');
    expect(excludedPatches).toHaveLength(1);
    if (excludedPatches[0].kind === 'oauthExcludedPatch') {
      expect(excludedPatches[0].models).toEqual([]); // cleared
    }
    const aliasPatches = opsOfKind(ops, 'oauthAliasPatch');
    expect(aliasPatches).toHaveLength(1);
    if (aliasPatches[0].kind === 'oauthAliasPatch') {
      expect(aliasPatches[0].entries).toEqual([{ name: 'kimi-k3', alias: 'claude-opus-4-8' }]);
    }
    // take is after-backend (only clear localStorage after restore PUT succeeds)
    const takes = opsOfKind(ops, 'mappingSuspendTake');
    expect(takes).toHaveLength(1);
    expect(takes[0].phase).toBe('after-backend');
  });

  test('API Key (non-OpenAI) disable a mapping target: suspend-merge + prune models + write excludedModels', () => {
    const resource = mkResource('res1', 'gemini', {
      models: [{ name: 'gemini-2.5-pro', alias: 'my-gemini' }],
      excludedModels: [],
    });
    const state = mkState({ resources: [resource] });
    const ops = planAccessToggle({
      state,
      ref: mkApiKeyRef('res1', 'gemini', 'gemini-2.5-pro'),
      nextEnabled: false,
    });

    const merges = opsOfKind(ops, 'mappingSuspendMerge');
    expect(merges).toHaveLength(1);
    expect(merges[0].phase).toBe('before-backend');
    if (merges[0].kind === 'mappingSuspendMerge') {
      expect(merges[0].targetKey).toBe('apiKey:res1:gemini-2.5-pro');
      expect(merges[0].entries[0].alias).toBe('my-gemini');
    }
    // prune models (alias stripped) before exclude (plan rule #2)
    const modelPuts = opsOfKind(ops, 'apiKeyModelsPut');
    expect(modelPuts).toHaveLength(1);
    if (modelPuts[0].kind === 'apiKeyModelsPut') {
      expect(modelPuts[0].models).toEqual([{ name: 'gemini-2.5-pro' }]); // alias stripped
    }
    const excludedPatches = opsOfKind(ops, 'apiKeyExcludedPatch');
    expect(excludedPatches).toHaveLength(1);
    if (excludedPatches[0].kind === 'apiKeyExcludedPatch') {
      expect(excludedPatches[0].modelsWithoutStar).toEqual(['gemini-2.5-pro']);
    }
    const backendIdx = ops.filter((o) => o.phase === 'backend').map((o) => o.kind);
    expect(backendIdx).toEqual(['apiKeyModelsPut', 'apiKeyExcludedPatch']);
  });

  test('OpenAI disable a mapping target: suspend-merge + catalog-merge (before) + single combined models PUT', () => {
    const resource = mkResource('res2', 'openaiCompatibility', {
      models: [
        { name: 'gpt-4o', alias: 'my-gpt' },
        { name: 'gpt-4o-mini' },
      ],
    });
    const state = mkState({ resources: [resource] });
    const ops = planAccessToggle({
      state,
      ref: mkApiKeyRef('res2', 'openaiCompatibility', 'gpt-4o'),
      nextEnabled: false,
    });

    // before-backend: mapping suspend + catalog suspend
    const merges = opsOfKind(ops, 'mappingSuspendMerge');
    expect(merges).toHaveLength(1);
    if (merges[0].kind === 'mappingSuspendMerge') {
      expect(merges[0].entries[0].alias).toBe('my-gpt');
    }
    const catalogMerges = opsOfKind(ops, 'catalogSuspendMerge');
    expect(catalogMerges).toHaveLength(1);
    expect(catalogMerges[0].phase).toBe('before-backend');
    if (catalogMerges[0].kind === 'catalogSuspendMerge') {
      expect(catalogMerges[0].modelId).toBe('gpt-4o');
      expect(catalogMerges[0].entries).toEqual([{ name: 'gpt-4o' }]); // bare entry
    }
    // backend: ONE combined PUT (alias stripped + entry removed)
    const modelPuts = opsOfKind(ops, 'apiKeyModelsPut');
    expect(modelPuts).toHaveLength(1);
    if (modelPuts[0].kind === 'apiKeyModelsPut') {
      expect(modelPuts[0].models).toEqual([{ name: 'gpt-4o-mini' }]);
    }
    // no excludedModels op for OpenAI catalog disable
    expect(opsOfKind(ops, 'apiKeyExcludedPatch')).toHaveLength(0);
  });

  test('OpenAI enable: combined models PUT restores entry+alias, then catalog/mapping take (after)', () => {
    const resource = mkResource('res2', 'openaiCompatibility', {
      models: [{ name: 'gpt-4o-mini' }], // gpt-4o was removed when disabled
    });
    const { channel } = suspendedApiKeyTarget('my-gpt', 'res2', 'openaiCompatibility', 'gpt-4o');
    const state = mkState({
      resources: [resource],
      mappingChannels: [channel],
      accessEntries: [accessEntryWithCatalog('apiKey:res2:gpt-4o', [{ name: 'gpt-4o' }])],
    });
    const ops = planAccessToggle({
      state,
      ref: mkApiKeyRef('res2', 'openaiCompatibility', 'gpt-4o'),
      nextEnabled: true,
    });

    const modelPuts = opsOfKind(ops, 'apiKeyModelsPut');
    expect(modelPuts).toHaveLength(1);
    if (modelPuts[0].kind === 'apiKeyModelsPut') {
      const names = modelPuts[0].models.map((m) => ({ name: m.name, alias: m.alias }));
      expect(names).toContainEqual({ name: 'gpt-4o', alias: 'my-gpt' });
      expect(names).toContainEqual({ name: 'gpt-4o-mini', alias: undefined });
    }
    const catalogTakes = opsOfKind(ops, 'catalogSuspendTake');
    expect(catalogTakes).toHaveLength(1);
    expect(catalogTakes[0].phase).toBe('after-backend');
    const mappingTakes = opsOfKind(ops, 'mappingSuspendTake');
    expect(mappingTakes).toHaveLength(1);
    expect(mappingTakes[0].phase).toBe('after-backend');
  });

  test('OAuth disable clears managed-exclude mask before backend (user toggle)', () => {
    const state = mkState({
      oauthAliasMap: { claude: [] },
      oauthExcludedMap: {},
      managedExcludeKeys: ['oauth:claude:sonnet'],
    });
    const ops = planAccessToggle({ state, ref: mkOauthRef('claude', 'sonnet'), nextEnabled: false });

    const unmarks = opsOfKind(ops, 'managedExcludeUnmark');
    expect(unmarks).toHaveLength(1);
    expect(unmarks[0].phase).toBe('before-backend');
    // mask clear must precede any backend op
    const beforeBackend = ops.filter((o) => o.phase === 'before-backend').map(kindOf);
    const backend = ops.filter((o) => o.phase === 'backend').map(kindOf);
    expect(beforeBackend).toContain('managedExcludeUnmark');
    expect(backend.length).toBeGreaterThan(0);
    void phaseOf;
  });
});
