import { describe, expect, test } from 'bun:test';
import { planAccessToggle, planAliasSave, planProviderFormDeltas, type ModelOp } from '../src/features/models/modelOps';
import type { ModelManagementState } from '../src/features/models/modelManagementState';
import type { MappingTargetRef } from '../src/features/models/modelMapping';
import type { ProviderResource } from '../src/features/providers/types';
import type { ModelAlias, OAuthModelAliasEntry } from '../src/types';

const apiRef = (resourceId: string, brand: ProviderResource['brand'], modelId: string): MappingTargetRef => ({ source: 'apiKey', resourceId, brand, modelId });
const oauthRef = (channel: string, modelId: string): MappingTargetRef => ({ source: 'oauth', channel, modelId });
const resource = (id: string, brand: ProviderResource['brand'], raw: Record<string, unknown>): ProviderResource => ({ id, brand, raw } as unknown as ProviderResource);

function state(input: {
  oauthAliasMap?: Record<string, OAuthModelAliasEntry[]>;
  oauthExcludedMap?: Record<string, string[]>;
  resources?: ProviderResource[];
  modelDisabled?: Map<string, { target: MappingTargetRef; entries: ModelAlias[] }>;
  mapping?: ModelManagementState['mapping'];
}): ModelManagementState {
  return {
    access: { byKey: new Map() },
    mapping: input.mapping ?? { byAliasKey: new Map() },
    explicitIdentityKeys: new Set(),
    modelDisabled: input.modelDisabled ?? new Map(),
    mappingDisabled: new Map(),
    oauthAliasMap: input.oauthAliasMap ?? {},
    oauthExcludedMap: input.oauthExcludedMap ?? {},
    catalogs: { oauthModels: { claude: [{ id: 'a' }, { id: 'b' }] }, resources: input.resources ?? [] },
  };
}

const kinds = (ops: ModelOp[]) => ops.map((op) => op.kind);

describe('v2 model access planner', () => {
  test('exclude-capable model disable changes only excludedModels', () => {
    const ref = oauthRef('claude', 'a');
    const ops = planAccessToggle({ state: state({ oauthAliasMap: { claude: [{ name: 'a', alias: 'chat' }] } }), ref, nextEnabled: false });
    expect(kinds(ops)).toEqual(['oauthExcludedPatch']);
    expect(ops[0]).toMatchObject({ models: ['a'] });
  });

  test('OpenAI model disable snapshots every alias entry and removes the model', () => {
    const ref = apiRef('openai:0', 'openaiCompatibility', 'gpt-4o');
    const item = resource('openai:0', 'openaiCompatibility', { models: [{ name: 'gpt-4o', alias: 'chat' }, { name: 'gpt-4o', alias: 'gpt-4o' }, { name: 'other', alias: 'other' }] });
    const ops = planAccessToggle({ state: state({ resources: [item] }), ref, nextEnabled: false });
    expect(kinds(ops)).toEqual(['modelDisabledPut', 'apiKeyModelsPut']);
    expect(ops[0]).toMatchObject({ snapshot: { entries: [{ alias: 'chat' }, { alias: 'gpt-4o' }] } });
    expect(ops[1]).toMatchObject({ models: [{ name: 'other', alias: 'other' }] });
  });

  test('OpenAI re-enable restores the latest snapshot', () => {
    const ref = apiRef('openai:0', 'openaiCompatibility', 'gpt-4o');
    const snapshot = { target: ref, entries: [{ name: 'gpt-4o', alias: 'chat' }, { name: 'gpt-4o', alias: 'gpt-4o' }] };
    const ops = planAccessToggle({ state: state({ resources: [resource('openai:0', 'openaiCompatibility', { models: [{ name: 'other', alias: 'other' }] })], modelDisabled: new Map([['apiKey:openai:0:gpt-4o', snapshot]]) }), ref, nextEnabled: true });
    expect(kinds(ops)).toEqual(['apiKeyModelsPut', 'modelDisabledTake']);
    expect(ops[0]).toMatchObject({ models: expect.arrayContaining(snapshot.entries.concat([{ name: 'other', alias: 'other' }])) });
  });

  test('same OAuth channel may keep multiple models under one alias', () => {
    const ops = planAliasSave({ state: state({ oauthAliasMap: { claude: [{ name: 'a', alias: 'old' }, { name: 'b', alias: 'old' }] } }), draft: { alias: 'chat', previousAliasKey: null, baselineAlias: '', isEditing: false, selectedTargets: [oauthRef('claude', 'a'), oauthRef('claude', 'b')], disabledTargets: [] } });
    const patch = ops.ops.find((op) => op.kind === 'oauthAliasPatch');
    expect(patch).toMatchObject({ entries: expect.arrayContaining([{ name: 'a', alias: 'chat' }, { name: 'b', alias: 'chat' }]) });
  });

  test('mapping target disable stores exact alias binding and restore removes only that binding', () => {
    const ref = apiRef('gemini:0', 'gemini', 'a');
    const mapping = { byAliasKey: new Map([['chat', { alias: 'chat', aliasKey: 'chat', targets: [{ ...ref, displayName: 'a', providerLabel: 'Gemini', iconSrc: null, suspended: false }] }]]) };
    const item = resource('gemini:0', 'gemini', { models: [{ name: 'a', alias: 'chat' }], excludedModels: [] });
    const disabledOps = planAliasSave({ state: state({ resources: [item], mapping }), draft: { alias: 'chat', previousAliasKey: 'chat', baselineAlias: 'chat', isEditing: true, selectedTargets: [], disabledTargets: [{ alias: 'chat', target: ref }] } }).ops;
    expect(disabledOps.some((op) => op.kind === 'mappingDisabledMerge')).toBe(true);
    const apiKeyPatch = disabledOps.find((op) => op.kind === 'apiKeyModelsPut');
    expect(apiKeyPatch).toMatchObject({ models: [] });

    const oauthTarget = oauthRef('claude', 'a');
    const oauthMapping = {
      byAliasKey: new Map([
        [
          'chat',
          {
            alias: 'chat',
            aliasKey: 'chat',
            targets: [
              {
                ...oauthTarget,
                displayName: 'a',
                providerLabel: 'Claude',
                iconSrc: null,
                suspended: false,
              },
            ],
          },
        ],
      ]),
    };
    const oauthDisabledOps = planAliasSave({
      state: state({
        oauthAliasMap: { claude: [{ name: 'a', alias: 'chat' }] },
        mapping: oauthMapping,
      }),
      draft: {
        alias: 'chat',
        previousAliasKey: 'chat',
        baselineAlias: 'chat',
        isEditing: true,
        selectedTargets: [],
        disabledTargets: [{ alias: 'chat', target: oauthTarget }],
      },
    }).ops;
    const oauthPatch = oauthDisabledOps.find((op) => op.kind === 'oauthAliasPatch');
    expect(oauthPatch).toMatchObject({ entries: expect.not.arrayContaining([{ name: 'a' }]) });

    const restoreOps = planAliasSave({ state: state({ resources: [item], mapping: { byAliasKey: new Map([['chat', { alias: 'chat', aliasKey: 'chat', targets: [{ ...ref, displayName: 'a', providerLabel: 'Gemini', iconSrc: null, suspended: true, disabledReason: 'mapping' }] }]]) } }), draft: { alias: 'chat', previousAliasKey: 'chat', baselineAlias: 'chat', isEditing: true, selectedTargets: [ref], disabledTargets: [] } }).ops;
    expect(restoreOps.some((op) => op.kind === 'mappingDisabledTake')).toBe(true);
  });

  test('editing a disabled model updates its snapshot instead of backend models', () => {
    const ref = apiRef('openai:0', 'openaiCompatibility', 'gpt-4o');
    const snapshot = { target: ref, entries: [{ name: 'gpt-4o', alias: 'old' }] };
    const ops = planAliasSave({ state: state({ resources: [resource('openai:0', 'openaiCompatibility', { models: [] })], modelDisabled: new Map([['apiKey:openai:0:gpt-4o', snapshot]]) }), draft: { alias: 'new', previousAliasKey: 'old', baselineAlias: 'old', isEditing: true, selectedTargets: [ref], disabledTargets: [] } }).ops;
    expect(ops.some((op) => op.kind === 'modelDisabledPut' && op.snapshot.entries.some((entry) => entry.alias === 'new'))).toBe(true);
    expect(ops.some((op) => op.kind === 'apiKeyModelsPut')).toBe(false);
  });

  test('provider form planner only snapshots catalog-disabled sources', () => {
    const ref = apiRef('openai:0', 'openaiCompatibility', 'gpt-4o');
    const item = resource('openai:0', 'openaiCompatibility', { models: [{ name: 'gpt-4o', alias: 'chat' }] });
    expect(planProviderFormDeltas({ state: state({ resources: [item] }), resource: item, deltas: [{ ref, nextEnabled: false }] }).map((op) => op.kind)).toEqual(['modelDisabledPut']);
    const excludeItem = resource('gemini:0', 'gemini', { models: [{ name: 'a', alias: 'chat' }], excludedModels: [] });
    expect(planProviderFormDeltas({ state: state({ resources: [excludeItem] }), resource: excludeItem, deltas: [{ ref: apiRef('gemini:0', 'gemini', 'a'), nextEnabled: false }] })).toEqual([]);
  });
});
