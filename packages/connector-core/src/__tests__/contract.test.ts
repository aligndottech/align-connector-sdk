import { describe, expect, it } from 'vitest';
import type { ConnectorFetcher, FetcherItem } from '../index.js';

describe('ConnectorFetcher contract', () => {
  it('a fetcher returns normalized items including an optional author', async () => {
    const fixture: FetcherItem = {
      source_url: 'https://example.test/1',
      platform: 'example',
      raw_text: 'decided to ship on friday',
      title: 'ship date',
      author: { name: 'Ada Lovelace', handle: 'ada', email: 'ada@example.test' },
    };

    const fetcher: ConnectorFetcher = {
      async fetch() {
        return [fixture];
      },
    };

    const items = await fetcher.fetch({ token: 'tok', limit: 10 });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ platform: 'example', source_url: 'https://example.test/1' });
    expect(items[0].author?.name).toBe('Ada Lovelace');
  });

  it('options carry scan inputs (cursor + window) alongside the CLI limit', () => {
    const opts = { token: 't', limit: 50, cursor: 'abc', since: '2026-01-01T00:00:00Z' };
    expect(opts.cursor).toBe('abc');
    expect(opts.since).toBe('2026-01-01T00:00:00Z');
  });
});
