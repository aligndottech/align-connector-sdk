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

  it('throws FetcherAuthError on 401 carrying Jira\'s words, and a plain error on 403 with the scope hint', async () => {
    mockFetch.mockResolvedValueOnce(res({ errorMessages: ['Client must be authenticated to access this resource.'] }, false, 401));
    const err = await new JiraFetcher().fetch({ token: 't', cloudId: 'c' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/Jira authentication failed \(401\): Client must be authenticated/);
    mockFetch.mockResolvedValueOnce(res({ errorMessages: ['The app is not installed on this instance.'] }, false, 403));
    await expect(new JiraFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toThrow(/^Jira API failed \(403\): The app is not installed on this instance\. .*Jira API permissions/);
  });

  it('a 500 names the status and the body and does not mention the token', async () => {
    mockFetch.mockResolvedValueOnce(res({ errorMessages: ['Internal server error'] }, false, 500));
    await expect(new JiraFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toThrow(/^Jira API failed \(500\): Internal server error\.$/);
  });

  it('paginates via nextPageToken up to the limit', async () => {
    const issue = (key: string) => ({ key, fields: { summary: key, reporter: { displayName: 'A' } } });
    mockFetch
      .mockResolvedValueOnce(res({ issues: [issue('ENG-1')], nextPageToken: 'p2', isLast: false }))
      .mockResolvedValueOnce(res({ issues: [issue('ENG-2')], isLast: true }));

    const items = await new JiraFetcher().fetch({ token: 't', cloudId: 'c', siteBase: 'https://acme.atlassian.net', limit: 200 });

    expect(items.map((i) => i.title)).toEqual(['[ENG-1] ENG-1', '[ENG-2] ENG-2']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  it('throws FetcherAuthError on 401 carrying Confluence\'s words', async () => {
    mockFetch.mockResolvedValueOnce(res({ message: 'Unauthorized; scope does not match' }, false, 401));
    const err = await new ConfluenceFetcher().fetch({ token: 't', cloudId: 'c' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/Confluence authentication failed \(401\): Unauthorized; scope does not match/);
  });

  it('403 carries the body and the Confluence permissions hint; 500 carries the body only', async () => {
    mockFetch.mockResolvedValueOnce(res({ message: 'Current user not permitted to use Confluence' }, false, 403));
    await expect(new ConfluenceFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toThrow(/^Confluence API failed \(403\): Current user not permitted to use Confluence\. .*Confluence API permissions/);
    mockFetch.mockResolvedValueOnce(res({ message: 'Something went wrong' }, false, 500));
    await expect(new ConfluenceFetcher().fetch({ token: 't', cloudId: 'c' })).rejects.toThrow(/^Confluence API failed \(500\): Something went wrong\.$/);
  });
});
