import { describe, expect, test } from 'bun:test';
import {
  normalizeOauthModelAlias,
  serializeOauthModelAliases,
} from '../src/services/api/authFiles';

describe('OAuth model alias force mapping', () => {
  test('normalizes and serializes force-mapping without dropping it', () => {
    const normalized = normalizeOauthModelAlias({
      'oauth-model-alias': {
        codex: [
          { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
          { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
        ],
      },
    });

    expect(normalized.codex).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', forceMapping: true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
    ]);
    expect(serializeOauthModelAliases(normalized.codex)).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', 'force-mapping': false },
    ]);
  });

  test('keeps duplicate aliases when model names differ in one OAuth channel', () => {
    const normalized = normalizeOauthModelAlias({
      'oauth-model-alias': {
        claude: [
          { name: 'model-a', alias: 'shared' },
          { name: 'model-b', alias: 'shared' },
          { name: 'model-a', alias: 'shared' },
        ],
      },
    });
    expect(normalized.claude).toEqual([
      { name: 'model-a', alias: 'shared' },
      { name: 'model-b', alias: 'shared' },
    ]);
  });
});
