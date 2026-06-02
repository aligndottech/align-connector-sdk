import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { JiraFetcher } from '../fetchers/jira.js';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { FetcherAuthError } from '../fetchers/errors.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<
    ReturnType<typeof fetch>
  >;

describe('JiraFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps OAuth issues to items with a browse URL and author = reporter', async () => {
    mockFetch.mockResolvedValueOnce(
      res({
        issues: [
          {
            key: 'ENG-1',
            fields: {
              summary: 'Adopt Postgres',
              description: { content: [{ content: [{ text: 'we will use postgres' }] }] },
              status: { name: 'Done' },
              reporter: { displayName: 'Ada', emailAddress: 'ada@x.io' },
            },
          },
        ],
      }),
    );

    const items = await new JiraFetcher().fetch({
      token: 'tok',
      cloudId: 'cid',
      siteBase: 'https://acme.atlassian.net',
      limit: 10,
    });

    expect(items[0]).toMatchObject({
      source_url: 'https://acme.atlassian.net/browse/ENG-1',
      platform: 'jira',
      title: '[ENG-1] Adopt Postgres',
      author: { name: 'Ada', email: 'ada@x.io' },
    });
    expect(items[0].raw_text).toContain('we will use postgres');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.atlassian.com/ex/jira/cid/rest/api/3/search/jql');
  });

  it('throws FetcherAuthError on 401 and a plain error on 403', async () => {
    mockFetch.mockResolvedValueOnce(res(null, false, 401));
    await expect(new JiraFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toBeInstanceOf(FetcherAuthError);
    mockFetch.mockResolvedValueOnce(res(null, false, 403));
    await expect(new JiraFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toThrow(/access denied \(403\)/);
  });
});

describe('ConfluenceFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps v2 pages to items, resolving the author from authorId', async () => {
    mockFetch
      .mockResolvedValueOnce(
        res({
          results: [
            { title: 'Arch Decision', authorId: 'acc1', body: { storage: { value: '<p>use kafka</p>' } }, _links: { webui: '/pages/1' } },
          ],
          _links: { base: 'https://acme.atlassian.net/wiki' },
        }),
      ) // pages
      .mockResolvedValueOnce(res({ displayName: 'Grace', email: 'grace@x.io' })); // user resolve

    const items = await new ConfluenceFetcher().fetch({ token: 'tok', cloudId: 'cid' });

    expect(items[0]).toMatchObject({
      source_url: 'https://acme.atlassian.net/wiki/pages/1',
      platform: 'confluence',
      title: 'Arch Decision',
      author: { name: 'Grace', email: 'grace@x.io' },
    });
    expect(items[0].raw_text).toContain('use kafka'); // html stripped
  });

  it('throws FetcherAuthError on 401', async () => {
    mockFetch.mockResolvedValueOnce(res(null, false, 401));
    await expect(new ConfluenceFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toBeInstanceOf(FetcherAuthError);
  });
});
