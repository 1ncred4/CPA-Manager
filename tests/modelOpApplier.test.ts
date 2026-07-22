import { afterEach, describe, expect, test } from 'bun:test';
import { authFilesApi } from '../src/services/api/authFiles';
import { applyModelOperations } from '../src/features/models/modelOpApplier';

const originalSaveOauthModelAlias = authFilesApi.saveOauthModelAlias;

afterEach(() => {
  authFilesApi.saveOauthModelAlias = originalSaveOauthModelAlias;
});

describe('model operation applier', () => {
  test('serializes saves that touch multiple provider channels', async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    authFilesApi.saveOauthModelAlias = async (channel) => {
      calls.push(`start:${channel}`);
      if (channel === 'first') await firstRequest;
      calls.push(`end:${channel}`);
    };

    const queues = new Map<string, Promise<unknown>>();
    const first = applyModelOperations({
      apiBase: 'http://localhost:8317',
      queues,
      ops: [
        {
          kind: 'oauthAliasPatch',
          phase: 'backend',
          queueKey: 'first',
          channel: 'first',
          entries: [{ name: 'one', alias: 'chat' }],
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = applyModelOperations({
      apiBase: 'http://localhost:8317',
      queues,
      ops: [
        {
          kind: 'oauthAliasPatch',
          phase: 'backend',
          queueKey: 'second',
          channel: 'second',
          entries: [{ name: 'two', alias: 'chat' }],
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['start:first']);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
});
